/**
 * chromectl HTTP front.
 *
 * Takes a target name plus a command, drives the chrome-devtools daemon that
 * belongs to the browser behind that name and returns the result in one
 * envelope. It runs without any authentication; the local network and the
 * private overlay network are the access boundary.
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
 * A screenshot is written to the network drive and the answer names its
 * location instead of carrying the image bytes. A snapshot may be written there
 * too, under a file name the caller picks; no file a call writes leaves that
 * one directory.
 *
 * Endpoints:
 *   GET  /health          liveness plus the registered target names and commands
 *   GET  /screenshots/<f> the PNG of an earlier take_screenshot call
 *   POST /budget          the same body as /call, answered with the deadline
 *                         that call is granted and the timeout a caller sets
 *   POST /call            {"target": "<name>", "command": "<tool>", "args": {…},
 *                          "full_speed": false}
 */

import {randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';

import {commands as upstreamCommands} from '../build/src/bin/chrome-devtools-cli-options.js';
import {
  handleResponse,
  sendCommand,
  startDaemon,
} from '../build/src/daemon/client.js';
import {getDaemonPid, isDaemonRunning} from '../build/src/daemon/utils.js';
import {queuedCallBudgetMs} from '../build/src/pacing.js';

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

/**
 * Commands a caller may invoke: page selection, page operation and page
 * inspection.
 *
 * `select_page` decides which of the browser's tabs the following commands act
 * on. The selection lives in the daemon of that browser — one MCP server
 * process per session id holds it — so it stays in force for every further call
 * reaching the same browser, under whichever of its names, until another
 * `select_page`, until the selected tab is closed (the daemon then falls back
 * to the first page) or until the daemon is replaced. Without it a caller could
 * list the tabs but never leave the first one.
 */
const ALLOWED_COMMANDS = [
  'list_pages',
  'select_page',
  'navigate_page',
  'click',
  'type_text',
  'fill',
  'take_snapshot',
  'take_screenshot',
];

/**
 * Argument schema per allowed command, taken from upstream's generated command
 * table (`chrome-devtools-cli-options.js`) rather than kept as an own copy, so
 * an upstream change to a tool's arguments arrives with the merge. A name that
 * upstream no longer knows is a startup fault: the front would otherwise offer
 * a command the daemon rejects.
 */
const COMMAND_SCHEMAS = new Map(
  ALLOWED_COMMANDS.map(command => {
    const definition = upstreamCommands[command];
    if (!definition) {
      throw new Error(`unknown upstream tool in the allow-list: ${command}`);
    }
    return [command, definition.args ?? {}];
  }),
);

/**
 * Where every file a call writes lands: `/home/wu/share/screenshots` on the
 * host the front runs on (`CHROMECTL_SCREENSHOT_DIR`), a directory of the house
 * network drive that is served over Samba and exported over NFS, so every
 * machine reaches the file the front only names. It is the single directory the
 * front lets a call write into, and every path the front hands the daemon
 * points inside it.
 */
const OUTPUT_DIR =
  process.env['CHROMECTL_SCREENSHOT_DIR'] ?? '/home/wu/share/screenshots';

/** Root of the network drive, used to name the file share-relative. */
const SHARE_ROOT = process.env['CHROMECTL_SHARE_ROOT'] ?? '/home/wu/share';

/** Path prefix the front serves written screenshots under. */
const SCREENSHOT_ROUTE = '/screenshots/';

/**
 * The daemon writes with mode 0600 and creates directories under the front's
 * umask. Both are widened afterwards: an NFS client arrives under its own uid
 * and would otherwise be handed a file it cannot read.
 */
const OUTPUT_DIR_MODE = 0o775;
const OUTPUT_FILE_MODE = 0o644;

/**
 * The only file name a caller may ask for. It carries no directory separator
 * and does not start with a dot, so such a name can neither leave `OUTPUT_DIR`
 * nor address one of its parents, and `..` cannot be written at all. The `.txt`
 * ending is what the daemon saves a snapshot as in any case
 * (`McpContext.saveFile`), so demanding it keeps the path in the answer the
 * path that lands on disk.
 */
const OUTPUT_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.txt$/;

/** File names the front hands out, and the only ones it serves back. */
const SCREENSHOT_NAME_PATTERN =
  /^chromectl-[A-Za-z0-9-]+-[0-9]{8}T[0-9]{9}Z-[0-9a-f]{8}\.(png|jpeg|webp)$/;

const CONTENT_TYPE_BY_FORMAT = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/** Upper bound for the CDP reachability probe. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * What a caller has to grant on top of the deadline the front sets itself, so
 * that the front's timer is the one that fires and the caller learns the
 * outcome instead of guessing it: the reachability probe, a daemon start or
 * replacement and the writing of the answer all sit outside that deadline. A
 * caller whose own timeout fired first would report a call as failed while it
 * is still typing into the page, and a retry would type the text twice.
 */
const CLIENT_TIMEOUT_HEADROOM_MS = 30_000;

/** Upper bound for one step of taking a daemon down before it is signalled. */
const DAEMON_STOP_TIMEOUT_MS = 2_000;

/** Poll interval while waiting for a daemon process to be gone. */
const DAEMON_STOP_POLL_MS = 25;

/**
 * A daemon-level failure that says the daemon has no link to its browser any
 * more: its MCP client lost the server process that holds the connection, so
 * the command was never sent and every further call to this daemon fails the
 * same way until it is replaced. The first message is the MCP SDK's for a
 * missing transport, the second the daemon's own guard for a client it never
 * got. Both are the daemon's report about itself, not the browser's about an
 * operation — a failure the browser produced comes back as a result.
 */
const BROWSER_LINK_GONE = /^(Not connected|MCP client not initialized)$/;

/**
 * Server flags every daemon is started with. `viaCli` is what makes the daemon
 * register the full tool set, `experimentalStructuredContent` is what makes a
 * result come back as a JSON object rather than rendered text, and
 * `categoryExtensions` is what keeps extension service workers in the page
 * listing, and `allowUnrestrictedPaths` is what lets a written file leave the
 * OS temp directory: the daemon's own MCP client negotiates no roots
 * capability, so without the flag every file-writing tool is confined to
 * `/tmp`. The widening is safe here because the front is the layer that
 * confines the path: no path a caller sends is forwarded, the front fills
 * `filePath` in itself and every file it lets a call write stays in
 * `OUTPUT_DIR`.
 */
const DAEMON_ARGS = [
  '--viaCli',
  '--experimentalStructuredContent',
  '--categoryExtensions',
  '--usageStatistics=false',
  '--allowUnrestrictedPaths',
];

/** HTTP status per failure kind, mirroring the client's exit codes. */
const STATUS_BY_KIND = {
  usage: 400,
  config: 500,
  storage: 500,
  tool: 422,
  unreachable: 503,
};

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
 *
 * Its success is also what licenses replacing a daemon later in the request:
 * the browser answered moments ago, so a daemon without a browser link is the
 * broken part and a new one can restore it. When the browser is the thing that
 * is gone, the request ends here and no daemon is touched — replacing one could
 * not start a Chrome that is not running.
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
 * Which daemon the front last put in place for a browser, counted up on every
 * start. A request notes the generation it sent its command under, so a socket
 * that breaks under it can be told apart: an unchanged generation means the
 * daemon itself failed, a changed one means another request swapped the daemon
 * away beneath the call.
 */
const daemonGenerations = new Map();

/**
 * Daemon starts and replacements in flight, keyed by session id — that is, per
 * browser, whatever the requests called it. Two requests for the same browser
 * that both find no daemon must not spawn two of them — the second one exits on
 * the pid file the first one wrote, and the request that started it would then
 * wait for a daemon that is gone. The same guard covers a replacement, so a
 * browser that fails several requests at once is replaced once and the freshly
 * started daemon is not torn down again by the next one in line. Requests
 * arriving during a start or a replacement wait for it; tool calls themselves
 * stay parallel and serialize inside the daemon on its process-wide tool mutex.
 */
const daemonOperations = new Map();

function daemonGeneration(sessionId) {
  return daemonGenerations.get(sessionId) ?? 0;
}

/** Runs one lifecycle operation per browser at a time; joiners await that one. */
function withDaemonLifecycle(sessionId, operation) {
  const running = daemonOperations.get(sessionId);
  if (running) {
    return running;
  }
  const started = operation().finally(() => {
    daemonOperations.delete(sessionId);
  });
  daemonOperations.set(sessionId, started);
  return started;
}

/** Starts the daemon of one browser; a daemon that came up is a new generation. */
async function startTargetDaemon({browserUrl, sessionId}) {
  try {
    await startDaemon(
      [`--browserUrl=${browserUrl}`, ...DAEMON_ARGS],
      sessionId,
    );
  } catch (error) {
    throw new CallError(
      'unreachable',
      `cannot attach to ${browserUrl}`,
      error.message,
    );
  }
  daemonGenerations.set(sessionId, daemonGeneration(sessionId) + 1);
}

/** Waits until the daemon process of one browser is gone. */
async function waitForDaemonGone(sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isDaemonRunning(sessionId)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, DAEMON_STOP_POLL_MS));
  }
  return true;
}

/**
 * Takes the daemon of one browser down. Its own `stop` command goes first, but
 * the daemon being replaced is exactly the one that may no longer be able to
 * carry it out, so an unanswered stop is followed by SIGTERM and finally
 * SIGKILL: a replacement must not hang on the corpse it replaces. A daemon that
 * survives all three is a fault of this service, not of the browser.
 */
async function stopTargetDaemon(sessionId) {
  if (!isDaemonRunning(sessionId)) {
    return;
  }
  try {
    await sendCommand({method: 'stop'}, sessionId, DAEMON_STOP_TIMEOUT_MS);
  } catch {
    // A daemon that cannot take its own stop command is signalled instead.
  }
  if (await waitForDaemonGone(sessionId, DAEMON_STOP_TIMEOUT_MS)) {
    return;
  }
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const pid = getDaemonPid(sessionId);
    if (pid === null) {
      return;
    }
    try {
      process.kill(pid, signal);
    } catch {
      return;
    }
    if (await waitForDaemonGone(sessionId, DAEMON_STOP_TIMEOUT_MS)) {
      return;
    }
  }
  throw new CallError(
    'unreachable',
    `daemon ${getDaemonPid(sessionId)} cannot be stopped`,
  );
}

/**
 * A daemon per browser, started on first use and reused afterwards. It may have
 * died between two calls, so its liveness is checked per call — the check is a
 * pid file read plus a signal 0, not a process start. Returns the generation
 * the caller's command runs under.
 */
async function ensureDaemon(resolved) {
  const {sessionId} = resolved;
  // A start in flight has already written the pid file before the daemon
  // answers, so a running pid alone does not mean it is ready yet: a start or a
  // replacement under way is waited for rather than read off the pid file.
  const running = daemonOperations.get(sessionId);
  if (running) {
    await running;
    return daemonGeneration(sessionId);
  }
  if (isDaemonRunning(sessionId)) {
    return daemonGeneration(sessionId);
  }
  await withDaemonLifecycle(sessionId, () => startTargetDaemon(resolved));
  return daemonGeneration(sessionId);
}

/**
 * Puts a new daemon in the place of the one the caller used, and returns the
 * generation to send under from now on. A replacement another request is
 * already carrying out is joined, and a daemon that has meanwhile been replaced
 * anyway is left alone: a failure is a reason to replace the daemon that
 * produced it, never the one that has since taken its place.
 */
async function replaceDaemon(resolved, generation) {
  const {sessionId} = resolved;
  const running = daemonOperations.get(sessionId);
  if (running) {
    await running;
    return daemonGeneration(sessionId);
  }
  if (daemonGeneration(sessionId) !== generation) {
    return daemonGeneration(sessionId);
  }
  await withDaemonLifecycle(sessionId, async () => {
    await stopTargetDaemon(sessionId);
    await startTargetDaemon(resolved);
  });
  return daemonGeneration(sessionId);
}

/**
 * Sends one tool invocation and keeps three daemon states apart.
 *
 * A target without a daemon gets one. A daemon that is alive and still holds
 * its browser answers, and that is the whole cost of the warm path. A daemon
 * that is alive but has lost its browser link — the process outlived the
 * browser it was attached to and answers every call with the same daemon-level
 * message from then on — is not a failed operation but an unusable daemon: it
 * is replaced and the command is sent once more, so the caller sees a result
 * instead of the corpse. That retry is sound because such a failure means the
 * command never reached the browser. A daemon that died between the liveness
 * check and the send, or that was replaced by another request while this
 * command sat on its socket, is the same case and is retried the same way,
 * while a socket failure of a daemon that is still the current one — a timeout
 * above all — stays the tool's failure and is never repeated.
 *
 * The retry happens once. If the fresh daemon fails the same way, the failure
 * goes to the caller instead of starting another daemon.
 *
 * How long the call may take is derived from the call itself (`src/pacing.ts`)
 * and covers two separate ceilings. The work budget is derived because a
 * command that types character by character lasts as long as its text is long,
 * so a fixed ceiling would cut an honest input off in the middle of a field; at
 * full speed nothing is typed character by character and it falls back to the
 * floor. On top of it comes the fixed ceiling for the wait, because the daemon
 * serializes on one browser and this call may be queued behind another before
 * it does anything.
 *
 * This is the outermost of the three deadlines one call passes through and the
 * shortest of them, so a timeout is reported here rather than by a socket
 * further in. Which of the two ceilings was hit stays legible: the wait ends at
 * its own ceiling inside the daemon and comes back as a failed call, so a
 * timeout reported here is the work. The caller's own timeout is the same
 * figure again, asked for through `/budget` and widened by
 * `CLIENT_TIMEOUT_HEADROOM_MS`, so it can only fire after this one and a caller
 * gets a reported failure instead of a silence.
 */
async function invokeTool(resolved, command, args, fullSpeed) {
  const message = {method: 'invoke_tool', tool: command, args, fullSpeed};
  const budgetMs = queuedCallBudgetMs(command, args, fullSpeed);
  let generation = await ensureDaemon(resolved);

  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await sendCommand(message, resolved.sessionId, budgetMs);
    } catch (error) {
      const lost =
        !isDaemonRunning(resolved.sessionId) ||
        daemonGeneration(resolved.sessionId) !== generation;
      if (attempt > 0 || !lost) {
        throw new CallError('tool', `${command} failed`, error.message);
      }
      generation = await ensureDaemon(resolved);
      continue;
    }

    if (
      attempt === 0 &&
      !response.success &&
      BROWSER_LINK_GONE.test(String(response.error))
    ) {
      generation = await replaceDaemon(resolved, generation);
      continue;
    }
    return response;
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

/**
 * Brings one argument to the type upstream declared for it. A caller that can
 * only send text — the bash client — passes every value as a string, so a
 * declared boolean or number is accepted in its written form as well, but only
 * when the text really is one; a string argument keeps whatever text it carries,
 * spaces, URLs and umlauts included.
 */
function coerceArgument(command, definition, value) {
  const fail = expected => {
    throw new CallError(
      'usage',
      `${command}: argument ${definition.name} must be ${expected}, got ${JSON.stringify(value)}`,
    );
  };

  let coerced = value;
  switch (definition.type) {
    case 'string':
      if (typeof coerced !== 'string') {
        fail('a string');
      }
      break;
    case 'boolean':
      if (coerced === 'true' || coerced === 'false') {
        coerced = coerced === 'true';
      }
      if (typeof coerced !== 'boolean') {
        fail('a boolean');
      }
      break;
    case 'number':
    case 'integer':
      if (typeof coerced === 'string' && coerced.trim() !== '') {
        coerced = Number(coerced);
      }
      if (typeof coerced !== 'number' || !Number.isFinite(coerced)) {
        fail('a number');
      }
      if (definition.type === 'integer' && !Number.isInteger(coerced)) {
        fail('an integer');
      }
      break;
    case 'array':
      if (!Array.isArray(coerced)) {
        fail('an array');
      }
      break;
    default:
      throw new CallError(
        'config',
        `${command}: unsupported argument type ${definition.type} for ${definition.name}`,
      );
  }

  if (definition.enum && !definition.enum.includes(coerced)) {
    fail(`one of ${definition.enum.join(', ')}`);
  }
  return coerced;
}

/**
 * The full-speed switch of one call. It sits beside `args` rather than inside
 * them: no tool declares it, so it has no entry in `COMMAND_SCHEMAS` and must
 * never be handed to the daemon as a tool argument — the tool would reject the
 * call as carrying an unknown one. Its coercion is the one every declared
 * boolean gets, so a caller who can only send text writes `"true"`.
 */
const FULL_SPEED_DEFINITION = {
  name: 'full_speed',
  type: 'boolean',
  description: 'Lifts human pacing for this call.',
  required: false,
};

function validateFullSpeed(value) {
  if (value === undefined || value === null) {
    return false;
  }
  return coerceArgument('call', FULL_SPEED_DEFINITION, value);
}

/** A command the front does not offer never reaches the daemon. */
function assertKnownCommand(command) {
  if (typeof command !== 'string' || !COMMAND_SCHEMAS.has(command)) {
    throw new CallError(
      'usage',
      `unknown command: ${JSON.stringify(command)} (allowed: ${ALLOWED_COMMANDS.join(', ')})`,
    );
  }
}

/**
 * Checks the caller's arguments against the command's schema and returns them
 * typed. Unknown names and missing required ones are rejected here, before the
 * daemon is involved, so they come back as a usage error rather than as a tool
 * failure.
 */
function validateArgs(command, args) {
  if (args === undefined || args === null) {
    args = {};
  }
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new CallError('usage', `${command}: args must be a JSON object`);
  }

  const schema = COMMAND_SCHEMAS.get(command);
  const validated = {};
  for (const [name, value] of Object.entries(args)) {
    const definition = schema[name];
    if (!definition) {
      const known = Object.keys(schema).join(', ') || 'none';
      throw new CallError(
        'usage',
        `${command}: unknown argument ${name} (known: ${known})`,
      );
    }
    if (value === undefined) {
      continue;
    }
    if (value === null) {
      throw new CallError('usage', `${command}: argument ${name} is null`);
    }
    validated[name] = coerceArgument(command, definition, value);
  }

  for (const [name, definition] of Object.entries(schema)) {
    if (definition.required && validated[name] === undefined) {
      throw new CallError(
        'usage',
        `${command}: required argument ${name} is missing`,
      );
    }
  }
  return validated;
}

/**
 * Builds the name of one screenshot file: the target it was taken on, the UTC
 * moment down to the millisecond and eight random hex characters. Two calls
 * running at the same time therefore cannot land on the same file even within
 * one millisecond. The name carries no colons, so a Windows client reaching the
 * drive over Samba can open it.
 */
function screenshotFileName(target, format) {
  const slug = target.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  return `chromectl-${slug}-${stamp}-${randomBytes(4).toString('hex')}.${format}`;
}

/** Makes sure the output directory exists and this process can write into it. */
async function ensureOutputDir() {
  try {
    const created = await fs.mkdir(OUTPUT_DIR, {
      recursive: true,
      mode: OUTPUT_DIR_MODE,
    });
    if (created !== undefined) {
      await fs.chmod(OUTPUT_DIR, OUTPUT_DIR_MODE);
    }
    await fs.access(OUTPUT_DIR, fs.constants.W_OK | fs.constants.X_OK);
  } catch (error) {
    throw new CallError(
      'storage',
      `output directory ${OUTPUT_DIR} is not writable`,
      error.message,
    );
  }
}

/**
 * Plans the screenshot file and takes the caller's own path out of the picture.
 *
 * The whole location is the front's business here, not the caller's: a
 * caller-chosen path would hand back a location the caller may not be able to
 * reach, and the name is what the fetch route recognises. A `filePath` argument
 * is therefore rejected as a usage error instead of being silently overwritten,
 * so nobody believes their path was honoured.
 */
async function planScreenshot(target, toolArgs) {
  if (toolArgs.filePath !== undefined) {
    throw new CallError(
      'usage',
      'take_screenshot: filePath is not a caller argument — the front writes ' +
        `the file to ${OUTPUT_DIR} and returns its location`,
    );
  }

  const format = toolArgs.format ?? 'png';
  const fileName = screenshotFileName(target, format);
  await ensureOutputDir();
  return {
    kind: 'screenshot',
    fileName,
    filePath: path.join(OUTPUT_DIR, fileName),
    format,
  };
}

/**
 * Plans the file a caller asked a snapshot to be written to.
 *
 * The front runs without authentication, so a path taken from the caller would
 * write anywhere the front's user can write, with page-controlled content. The
 * directory is therefore the front's decision and the caller names at most the
 * file: a name that is not a plain `*.txt` file name is refused rather than
 * bent into one, so nobody believes their path was honoured.
 *
 * An entry of that name that already exists is only accepted when it is a
 * regular file. The drive is writable over Samba and NFS, so a symlink placed
 * in the directory would otherwise carry the write straight out of it again.
 */
async function planSnapshotFile(command, toolArgs) {
  const requested = toolArgs.filePath;
  if (!OUTPUT_FILE_NAME_PATTERN.test(requested)) {
    throw new CallError(
      'usage',
      `${command}: filePath must be a plain file name ending in .txt — the ` +
        `front writes it to ${OUTPUT_DIR} and no path leaves that directory`,
    );
  }

  await ensureOutputDir();
  const filePath = path.join(OUTPUT_DIR, requested);
  let existing;
  try {
    existing = await fs.lstat(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new CallError('storage', `cannot write ${filePath}`, error.message);
    }
  }
  if (existing !== undefined && !existing.isFile()) {
    throw new CallError(
      'usage',
      `${command}: ${requested} exists in ${OUTPUT_DIR} and is not a regular file`,
    );
  }

  return {kind: 'snapshot', fileName: requested, filePath};
}

/** The file one call writes, or nothing when it writes none. */
async function planWrittenFile(command, target, toolArgs) {
  if (command === 'take_screenshot') {
    return await planScreenshot(target, toolArgs);
  }
  if (command === 'take_snapshot' && toolArgs.filePath !== undefined) {
    return await planSnapshotFile(command, toolArgs);
  }
  return undefined;
}

/**
 * Turns a failed call into a storage failure when the daemon choked on the file
 * rather than on the page. A write that fails is an outage of the network drive
 * and must not read as a browser that could not carry the command out.
 */
function reclassifyFileFailure(error, plan) {
  if (!(error instanceof CallError) || error.kind !== 'tool') {
    return error;
  }
  const detail =
    typeof error.detail === 'string'
      ? error.detail
      : JSON.stringify(error.detail ?? '');
  if (!detail.includes(plan.filePath) && !detail.includes(OUTPUT_DIR)) {
    return error;
  }
  return new CallError(
    'storage',
    `${plan.kind} could not be written to ${plan.filePath}`,
    error.detail,
  );
}

/**
 * Widens a file a failed call left behind. A call that hits its deadline or
 * fails after the write still leaves the daemon's 0600 file on the drive, and a
 * file only the front's uid can read is of no use to an NFS client arriving
 * under its own. It is therefore made readable exactly like the file of a
 * successful call.
 *
 * Best effort by design: a call that failed before the write leaves nothing to
 * widen, and a chmod that fails here must not displace the failure being
 * reported to the caller.
 */
async function widenLeftoverFile(plan) {
  try {
    await fs.chmod(plan.filePath, OUTPUT_FILE_MODE);
  } catch {
    // No file written, or one this process cannot chmod: the call's own
    // failure is what the caller gets.
  }
}

/**
 * Confirms the file the daemon was told to write really is there and makes it
 * readable for everyone reaching the drive, then describes it. A tool call that
 * reports success without a file on disk is a storage failure, not a result.
 * Only a screenshot carries a fetch URL: it is the one the front serves back.
 */
async function describeWrittenFile(plan, publicBase) {
  let stats;
  try {
    stats = await fs.stat(plan.filePath);
    if (!stats.isFile() || stats.size === 0) {
      throw new Error(`${stats.size} bytes`);
    }
    await fs.chmod(plan.filePath, OUTPUT_FILE_MODE);
  } catch (error) {
    throw new CallError(
      'storage',
      `${plan.kind} was not written to ${plan.filePath}`,
      error.message,
    );
  }

  return {
    file: plan.fileName,
    path: plan.filePath,
    share_path: path.relative(SHARE_ROOT, plan.filePath),
    ...(plan.kind === 'screenshot'
      ? {url: `${publicBase}${SCREENSHOT_ROUTE}${plan.fileName}`}
      : {}),
    bytes: stats.size,
  };
}

/** Sends one tool invocation and renders its result. */
async function runCommand(resolved, command, toolArgs, fullSpeed) {
  const started = Date.now();
  const response = await invokeTool(resolved, command, toolArgs, fullSpeed);
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
  return {parsed, elapsedMs};
}

async function invoke(target, command, args, fullSpeed, publicBase) {
  assertKnownCommand(command);
  const toolArgs = validateArgs(command, args);
  const atFullSpeed = validateFullSpeed(fullSpeed);

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

  // The written file takes the place of the payload upstream would attach, so
  // the answer stays small enough for a caller's shell. Where it lands is the
  // front's decision in either case.
  const plan = await planWrittenFile(command, resolved.target, toolArgs);
  if (plan) {
    toolArgs.filePath = plan.filePath;
  }

  // The probe comes first: it decides between a browser that is gone, which is
  // an outage, and a daemon that is gone, which the call itself repairs.
  await assertTargetReachable(resolved.browserUrl);

  let outcome;
  try {
    outcome = await runCommand(resolved, command, toolArgs, atFullSpeed);
  } catch (error) {
    if (!plan) {
      throw error;
    }
    await widenLeftoverFile(plan);
    throw reclassifyFileFailure(error, plan);
  }
  const {parsed, elapsedMs} = outcome;

  return {
    ok: true,
    target: resolved.target,
    browser_url: resolved.browserUrl,
    command,
    args: toolArgs,
    // Which profile ran, on every answer, so a log shows plainly whether the
    // brake was off.
    pace: atFullSpeed ? 'full' : 'human',
    elapsed_ms: elapsedMs,
    title: parsed.pages?.find(page => page.selected)?.title,
    ...(plan ? {[plan.kind]: await describeWrittenFile(plan, publicBase)} : {}),
    result: parsed,
  };
}

/**
 * How long one call may take, without carrying it out.
 *
 * A caller asks for this before it sends the call, so its own timeout can be
 * set from the same source the front's deadline comes from (`src/pacing.ts`)
 * instead of from a constant that knows nothing about the text being typed.
 * `client_timeout_ms` is the figure to use: the front's deadline plus the
 * headroom that keeps the front's timer the first one to fire.
 */
function budgetFor(body) {
  assertKnownCommand(body.command);
  const budgetMs = queuedCallBudgetMs(
    body.command,
    validateArgs(body.command, body.args),
    validateFullSpeed(body.full_speed),
  );
  return {
    ok: true,
    command: body.command,
    budget_ms: budgetMs,
    client_timeout_ms: budgetMs + CLIENT_TIMEOUT_HEADROOM_MS,
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

/**
 * Serves a written screenshot back, for a caller that does not have the network
 * drive mounted. Only names the front itself hands out are accepted, so the
 * route cannot be walked out of the screenshot directory.
 */
async function sendScreenshot(response, url) {
  const fileName = decodeURIComponent(url.slice(SCREENSHOT_ROUTE.length));
  if (!SCREENSHOT_NAME_PATTERN.test(fileName)) {
    throw new CallError(
      'usage',
      `not a chromectl screenshot name: ${fileName}`,
    );
  }
  let data;
  try {
    data = await fs.readFile(path.join(OUTPUT_DIR, fileName));
  } catch (error) {
    throw new CallError('storage', `no screenshot ${fileName}`, error.message);
  }
  const format = path.extname(fileName).slice(1);
  response.writeHead(200, {
    'content-type':
      CONTENT_TYPE_BY_FORMAT[format] ?? 'application/octet-stream',
    'content-length': data.length,
  });
  response.end(data);
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
        commands: ALLOWED_COMMANDS,
      });
      return;
    }
    if (request.method === 'GET' && request.url.startsWith(SCREENSHOT_ROUTE)) {
      await sendScreenshot(response, request.url);
      return;
    }
    if (
      request.method !== 'POST' ||
      (request.url !== '/call' && request.url !== '/budget')
    ) {
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
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new CallError('usage', 'request body is not a JSON object');
    }
    // The budget of a call is asked for with the body of that call, so the
    // figure covers the very text the following request types.
    if (request.url === '/budget') {
      send(response, 200, budgetFor(body));
      return;
    }
    // The fetch URL is built from the address the caller just reached, so it is
    // by construction one the caller can come back to.
    const publicBase =
      process.env['CHROMECTL_PUBLIC_URL'] ??
      `http://${request.headers.host ?? `${HOST}:${PORT}`}`;
    send(
      response,
      200,
      await invoke(
        body.target,
        body.command,
        body.args,
        body.full_speed,
        publicBase,
      ),
    );
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
