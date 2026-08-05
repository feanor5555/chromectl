/**
 * chromectl HTTP front.
 *
 * Takes a target name plus a command, drives the chrome-devtools daemon that
 * belongs to that target and returns the result in one envelope. It runs
 * without any authentication; the local network and the netbird network are the
 * access boundary.
 *
 * The target registry is read from `CHROMECTL_TARGETS`, by default from
 * `~/.claude/chromectl/targets.json`; without it the front refuses to start.
 *
 * Start by hand:
 *   node /home/wu/chromectl/chromectl/front.mjs
 *
 * Endpoints:
 *   GET  /health          liveness plus the registered target names
 *   POST /call            {"target": "<name>", "command": "<tool>"}
 */

import {spawn} from 'node:child_process';
import http from 'node:http';
import {dirname, join} from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

import {
  listTargets,
  loadRegistry,
  registryPath,
  RegistryError,
  resolveTarget,
  TargetError,
} from './registry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'build', 'src', 'bin', 'chrome-devtools.js');

const HOST = process.env['CHROMECTL_HOST'] ?? '0.0.0.0';
const PORT = Number(process.env['CHROMECTL_PORT'] ?? 8091);

/** Commands a caller may invoke. */
const ALLOWED_COMMANDS = new Set(['list_pages']);

/** Upper bound for one daemon call. */
const CALL_TIMEOUT_MS = 60_000;

/** Upper bound for the CDP reachability probe. */
const PROBE_TIMEOUT_MS = 5_000;

const CLI_ENV = {
  ...process.env,
  CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
  CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
};

/** HTTP status per failure kind, mirroring the client's exit codes. */
const STATUS_BY_KIND = {usage: 400, config: 500, tool: 422, unreachable: 503};

class CallError extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.kind = kind;
    this.detail = detail;
  }
}

function runCli(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: CLI_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      stderr += '\nchromectl: CLI call timed out';
    }, CALL_TIMEOUT_MS);

    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', error => {
      clearTimeout(timer);
      resolve({code: -1, stdout, stderr: `${stderr}\n${error.message}`});
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({code, stdout, stderr});
    });
  });
}

/**
 * Asks the target's CDP endpoint for its version. A target that does not answer
 * here is an outage, not a failed operation, and the distinction has to be made
 * before the daemon is involved: the daemon starts happily against a dead
 * address and only reports the failure as a tool error.
 */
async function assertTargetReachable(browserUrl) {
  let response;
  try {
    response = await fetch(new URL('/json/version', browserUrl), {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CallError(
      'unreachable',
      `target Chrome at ${browserUrl} does not answer`,
      error.message,
    );
  }
  if (!response.ok) {
    throw new CallError(
      'unreachable',
      `target Chrome at ${browserUrl} answered ${response.status}`,
    );
  }
}

async function isDaemonRunning(sessionId) {
  const {stdout} = await runCli(['status', '--sessionId', sessionId]);
  return stdout.includes('daemon is running');
}

async function ensureDaemon({browserUrl, sessionId}) {
  if (await isDaemonRunning(sessionId)) {
    return;
  }
  const result = await runCli([
    'start',
    '--browserUrl',
    browserUrl,
    '--sessionId',
    sessionId,
    '--usageStatistics',
    'false',
  ]);
  if (result.code !== 0) {
    throw new CallError(
      'unreachable',
      `cannot attach to ${browserUrl}`,
      (result.stderr || result.stdout).trim(),
    );
  }
}

/**
 * The CLI prints the rendered tool result as the last JSON line. A tool-level
 * failure is rendered as the raw content array, a success as the structured
 * object, so the shape tells the two apart.
 */
function parseCliOutput(stdout) {
  const lines = stdout.split('\n').filter(line => line.trim() !== '');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // Not the JSON line; keep looking backwards.
    }
  }
  return undefined;
}

async function invoke(target, command) {
  if (!ALLOWED_COMMANDS.has(command)) {
    throw new CallError('usage', `unknown command: ${command}`);
  }

  let resolved;
  try {
    resolved = resolveTarget(target);
  } catch (error) {
    if (error instanceof TargetError) {
      throw new CallError('usage', error.message);
    }
    if (error instanceof RegistryError) {
      throw new CallError('config', error.message);
    }
    throw error;
  }

  await assertTargetReachable(resolved.browserUrl);
  await ensureDaemon(resolved);

  const started = Date.now();
  const run = await runCli([
    command,
    '--sessionId',
    resolved.sessionId,
    '--output-format',
    'json',
  ]);
  const elapsedMs = Date.now() - started;
  const parsed = parseCliOutput(run.stdout);

  if (run.code !== 0 || parsed === undefined) {
    throw new CallError(
      'tool',
      `${command} failed`,
      (run.stderr || run.stdout).trim(),
    );
  }
  if (Array.isArray(parsed)) {
    throw new CallError('tool', `${command} failed`, parsed);
  }

  return {
    ok: true,
    target: resolved.target,
    browser_url: resolved.browserUrl,
    command,
    elapsed_ms: elapsedMs,
    title: parsed.pages?.find(page => page.selected)?.title,
    result: parsed,
  };
}

function send(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 64 * 1024) {
        reject(new CallError('usage', 'request body too large'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      send(response, 200, {ok: true, service: 'chromectl', targets: listTargets()});
      return;
    }
    if (request.method !== 'POST' || request.url !== '/call') {
      throw new CallError('usage', `no route for ${request.method} ${request.url}`);
    }

    const raw = await readBody(request);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new CallError('usage', 'request body is not JSON');
    }
    send(response, 200, await invoke(body.target, body.command));
  } catch (error) {
    const kind =
      error instanceof CallError
        ? error.kind
        : error instanceof RegistryError
          ? 'config'
          : 'tool';
    send(response, STATUS_BY_KIND[kind] ?? 500, {
      ok: false,
      kind,
      error: error.message,
      ...(error.detail === undefined ? {} : {detail: error.detail}),
    });
  }
});

// The registry is read at every call, but a missing one is a startup fault:
// the front would otherwise answer requests it can never serve.
try {
  loadRegistry();
} catch (error) {
  console.error(`chromectl: ${error.message}`);
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  console.log(
    `chromectl front listening on http://${HOST}:${PORT}, targets from ${registryPath()}`,
  );
});
