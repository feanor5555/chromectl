/**
 * chromectl HTTP front.
 *
 * Takes a target name plus a command, drives the chrome-devtools daemon that
 * belongs to that target and returns the result in one envelope. It runs
 * without any authentication; the local network and the netbird network are the
 * access boundary.
 *
 * The front speaks to the daemon over its unix socket in process, through
 * upstream's own daemon client (`build/src/daemon/client.js`), instead of
 * spawning the `chrome-devtools` CLI per request; a node process start costs
 * ~710 ms, the protocol work costs single-digit milliseconds. Importing the
 * built client keeps the wire format upstream's business.
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

import http from 'node:http';
import process from 'node:process';

import {
  handleResponse,
  sendCommand,
  startDaemon,
} from '../build/src/daemon/client.js';
import {isDaemonRunning} from '../build/src/daemon/utils.js';

import {
  listTargets,
  loadRegistry,
  registryPath,
  RegistryError,
  resolveTarget,
  TargetError,
} from './registry.mjs';

// A daemon is spawned by the imported client and inherits this process's
// environment, so telemetry and the update check are switched off here.
process.env['CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS'] = '1';
process.env['CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS'] = '1';

const HOST = process.env['CHROMECTL_HOST'] ?? '0.0.0.0';
const PORT = Number(process.env['CHROMECTL_PORT'] ?? 8091);

/** Commands a caller may invoke. */
const ALLOWED_COMMANDS = new Set(['list_pages']);

/** Upper bound for one daemon call. */
const CALL_TIMEOUT_MS = 60_000;

/** Upper bound for the CDP reachability probe. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Server flags every daemon is started with. `viaCli` is what makes the daemon
 * register the full tool set, `experimentalStructuredContent` is what makes a
 * result come back as a JSON object rather than rendered text, and
 * `categoryExtensions` is what keeps extension service workers in the page
 * listing.
 */
const DAEMON_ARGS = [
  '--viaCli',
  '--experimentalStructuredContent',
  '--categoryExtensions',
  '--usageStatistics=false',
];

/** HTTP status per failure kind, mirroring the client's exit codes. */
const STATUS_BY_KIND = {usage: 400, config: 500, tool: 422, unreachable: 503};

class CallError extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.kind = kind;
    this.detail = detail;
  }
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

/**
 * Daemon starts in flight, keyed by session id. Two requests for the same
 * target that both find no daemon must not spawn two of them — the second one
 * exits on the pid file the first one wrote, and the request that started it
 * would then wait for a daemon that is gone. Requests arriving during a start
 * wait for that same start; tool calls themselves stay parallel and serialize
 * inside the daemon on its process-wide tool mutex.
 */
const pendingStarts = new Map();

function startDaemonOnce({browserUrl, sessionId}) {
  const running = pendingStarts.get(sessionId);
  if (running) {
    return running;
  }
  const start = startDaemon(
    [`--browserUrl=${browserUrl}`, ...DAEMON_ARGS],
    sessionId,
  )
    .catch(error => {
      throw new CallError(
        'unreachable',
        `cannot attach to ${browserUrl}`,
        error.message,
      );
    })
    .finally(() => {
      pendingStarts.delete(sessionId);
    });
  pendingStarts.set(sessionId, start);
  return start;
}

/**
 * A daemon per target, started on first use and reused afterwards. It may have
 * died between two calls, so its liveness is checked per call — the check is a
 * pid file read plus a signal 0, not a process start.
 */
async function ensureDaemon(resolved) {
  const {sessionId} = resolved;
  // A start in flight has already written the pid file before the daemon
  // answers, so a running pid alone does not mean it is ready yet.
  if (isDaemonRunning(sessionId) && !pendingStarts.has(sessionId)) {
    return;
  }
  await startDaemonOnce(resolved);
}

/**
 * Sends one tool invocation. A daemon that died between the liveness check and
 * this send takes the command with it and cannot have executed it, so exactly
 * that case is retried once against a freshly started daemon. A daemon that is
 * still alive gets no retry: its failure is the tool's failure.
 */
async function invokeTool(resolved, command) {
  const message = {method: 'invoke_tool', tool: command, args: {}};
  try {
    return await sendCommand(message, resolved.sessionId, CALL_TIMEOUT_MS);
  } catch (error) {
    if (isDaemonRunning(resolved.sessionId)) {
      throw new CallError('tool', `${command} failed`, error.message);
    }
    await ensureDaemon(resolved);
    return await sendCommand(message, resolved.sessionId, CALL_TIMEOUT_MS);
  }
}

/**
 * Renders the daemon's stringified `CallToolResult` the way the CLI does with
 * `--output-format json`, and parses it back. A tool-level failure renders as
 * the raw content array, a success as the structured object, so the shape tells
 * the two apart. Anything unrenderable comes back as `undefined` and is treated
 * as a failed call.
 */
async function renderToolResult(result) {
  try {
    return JSON.parse(await handleResponse(JSON.parse(result), 'json'));
  } catch {
    return undefined;
  }
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
  const response = await invokeTool(resolved, command);
  const parsed = response.success
    ? await renderToolResult(response.result)
    : undefined;
  const elapsedMs = Date.now() - started;

  if (!response.success || parsed === undefined) {
    throw new CallError(
      'tool',
      `${command} failed`,
      response.success ? response.result : String(response.error),
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
      send(response, 200, {
        ok: true,
        service: 'chromectl',
        targets: listTargets(),
      });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/call') {
      throw new CallError(
        'usage',
        `no route for ${request.method} ${request.url}`,
      );
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
