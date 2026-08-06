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
 * too, under a file name the caller picks, and a result that outgrows
 * `SPILL_BYTES` is written there as well instead of being answered inline. No
 * file a call writes leaves that one directory, and every one of them is
 * fetchable over `/files/`.
 *
 * Endpoints:
 *   GET  /health          liveness plus the registered target names and commands
 *   GET  /files/<name>    a file an earlier call wrote: screenshot, snapshot or
 *                         spilled result
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
 * A command is on this list only if it grants no capability the list already
 * grants, or clears a state the list cannot leave, and only if it neither
 * executes caller-supplied code nor reads credential material out of a
 * logged-in page. The front is unauthenticated, so everything here is reachable
 * by anyone who reaches the port.
 *
 * `select_page` decides which of the browser's tabs the following commands act
 * on. The selection lives in the daemon of that browser — one MCP server
 * process per session id holds it — so it stays in force for every further call
 * reaching the same browser, under whichever of its names, until another
 * `select_page`, until the selected tab is closed (the daemon then falls back
 * to the first page) or until the daemon is replaced. Without it a caller could
 * list the tabs but never leave the first one.
 *
 * `press_key` types into whatever currently has the focus, which is a strict
 * subset of what `click` and `type_text` already reach, and it is the only way
 * to send an ordinary Escape or Tab: `type_text`'s submit key covers a key
 * pressed straight after typing and nothing else.
 *
 * `wait_for` reads page text that `take_snapshot` returns anyway, so it grants
 * nothing new. Without it the only way to await a condition is a snapshot poll
 * loop — a rapid-fire volley against the page, which the pace rule forbids, at
 * the price of a full snapshot payload per poll.
 *
 * `handle_dialog` is the only way out of an open dialog. Both input and
 * inspection are blocked while one stands, so a single `confirm()` wedges six
 * of these eleven commands, and navigating away throws the page state the
 * caller built up out without answering the prompt the page waits on.
 */
const ALLOWED_COMMANDS = [
  'list_pages',
  'select_page',
  'navigate_page',
  'click',
  'type_text',
  'fill',
  'press_key',
  'take_snapshot',
  'take_screenshot',
  'wait_for',
  'handle_dialog',
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

/** Path prefix the front serves the files of earlier calls under. */
const FILE_ROUTE = '/files/';

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

/** The file names the front builds itself: screenshots and spilled results. */
const GENERATED_FILE_NAME_PATTERN =
  /^chromectl-[A-Za-z0-9-]+-[0-9]{8}T[0-9]{9}Z-[0-9a-f]{8}\.(png|jpeg|webp|json)$/;

const CONTENT_TYPE_BY_EXTENSION = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
};

/**
 * From how many bytes of rendered result on the answer names a file instead of
 * carrying the result: an operator setting, like the pacing figures, not a
 * measurement. It sits well above a routine snapshot, which is the caller's
 * source of uids and has to arrive to be of any use, and bites where an inline
 * answer has stopped being one — the page whose text runs into hundreds of
 * kilobytes.
 *
 * The check is on the rendered result rather than on a per-tool argument
 * because that is the only place every payload passes: `wait_for` and every
 * input command called with `includeSnapshot` end in a snapshot and have no
 * `filePath` argument at all.
 */
const SPILL_BYTES = Number(process.env['CHROMECTL_SPILL_BYTES'] ?? 131_072);
if (!Number.isInteger(SPILL_BYTES) || SPILL_BYTES <= 0) {
  // A typo here would read as "never spills", which is the failure the cap
  // exists to prevent, so it is a startup fault.
  throw new Error(
    `CHROMECTL_SPILL_BYTES must be a positive whole number of bytes, got ${JSON.stringify(process.env['CHROMECTL_SPILL_BYTES'])}`,
  );
}

/** How much of a spilled result the answer still carries, in characters. */
const SPILL_HEAD_CHARS = 2_048;

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
  busy: 409,
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

/**
 * The calls running per browser, keyed by session id, each with the command it
 * carries out, when it started, the budget it was granted and the client it
 * answers to.
 *
 * There is no cancellation: a call that has reached the daemon runs to its end
 * whether or not anyone is still listening, because stopping it would have to
 * reach through the daemon socket and the MCP request into the paced loops and
 * puppeteer, and none of that honours a signal. What can be done is not to
 * start a second one behind it. A caller whose own timeout fired sends the same
 * call again, and queueing that retry at the daemon's mutex is how one form
 * gets filled and submitted twice; it is refused instead, told what still runs
 * and how much of its budget is left, so it can wait rather than repeat.
 *
 * Several live callers on one browser stay legitimate — the daemon's mutex
 * serializes them — so the entries are a set per browser and only an abandoned
 * one bars the next call, and it does not bar
 * `ABANDONMENT_EXEMPT_COMMAND`.
 */
const callsInFlight = new Map();

/**
 * The one command a browser takes while it is still carrying out an abandoned
 * call.
 *
 * A standing dialog blocks input and inspection alike, and it is the usual
 * reason a call was abandoned: the caller's own timeout fired while the call sat
 * behind the prompt. `handle_dialog` is the only command that clears it, so
 * refusing it as well would lock the door on the key and leave the browser
 * wedged for the whole budget of a call nobody waits for any more.
 *
 * The exemption is one named command, never a category, and it opens nothing
 * else: `handle_dialog` is admitted only after the name has been checked against
 * the allow-list and its arguments against upstream's schema, it carries nothing
 * but `accept`/`dismiss` and a prompt text, it reads no page state and it writes
 * no file — `planWrittenFile` knows it not. Nor is it a second way onto the
 * page: while one exempt call is in flight the next is refused, so at most one
 * caller ever clears the dialog and none drives the page beside it.
 */
const ABANDONMENT_EXEMPT_COMMAND = 'handle_dialog';

/** The abandoned call of one browser, or nothing while every client is there. */
function abandonedCall(sessionId) {
  for (const entry of callsInFlight.get(sessionId) ?? []) {
    if (entry.client.gone) {
      return entry;
    }
  }
  return undefined;
}

/** The exempt call of one browser, or nothing while none is running. */
function exemptCall(sessionId) {
  for (const entry of callsInFlight.get(sessionId) ?? []) {
    if (entry.command === ABANDONMENT_EXEMPT_COMMAND) {
      return entry;
    }
  }
  return undefined;
}

/**
 * Refuses a call and names the one that stands in its way, its age and the rest
 * of its budget, because the only sound answer to such a refusal is to wait that
 * long: the work cannot be stopped, and what it has already typed stays typed.
 */
function refuseBehind(resolved, entry, standing, reason) {
  const runningMs = Date.now() - entry.startedAtMs;
  const remainingMs = Math.max(0, entry.budgetMs - runningMs);
  throw new CallError(
    'busy',
    `${resolved.target} ${standing}, ` +
      `started ${Math.round(runningMs / 1000)} s ago, ` +
      `up to ${Math.round(remainingMs / 1000)} s of its budget left — ` +
      reason,
    {
      running_command: entry.command,
      running_ms: runningMs,
      budget_ms: entry.budgetMs,
      remaining_ms: remainingMs,
    },
  );
}

/**
 * Decides whether one call is let through to the browser at all.
 *
 * A browser still carrying out a call nobody waits for any more takes no second
 * one; the exempt command is the single exception and is bounded by one of its
 * own kind at a time.
 */
function assertAdmissible(resolved, command) {
  if (command === ABANDONMENT_EXEMPT_COMMAND) {
    const running = exemptCall(resolved.sessionId);
    if (running) {
      refuseBehind(
        resolved,
        running,
        `is already clearing a dialog with a ${running.command}`,
        'a second one would drive the page beside it, so this call is refused',
      );
    }
    return;
  }
  const entry = abandonedCall(resolved.sessionId);
  if (entry) {
    refuseBehind(
      resolved,
      entry,
      `is still carrying out an abandoned ${entry.command}`,
      'nothing can stop it, so this call is refused instead of queueing behind ' +
        `it; ${ABANDONMENT_EXEMPT_COMMAND} is admitted meanwhile and is the way ` +
        'out when a dialog is what it sits behind',
    );
  }
}

/** Notes one call as running and hands back the note to end it with. */
function registerCall(resolved, command, budgetMs, client) {
  const entry = {
    command,
    startedAtMs: Date.now(),
    budgetMs,
    client,
  };
  const entries = callsInFlight.get(resolved.sessionId);
  if (entries) {
    entries.add(entry);
  } else {
    callsInFlight.set(resolved.sessionId, new Set([entry]));
  }
  return entry;
}

/**
 * Ends the note of one call. A call whose client left is logged as it ends:
 * nothing of it can be sent back and nothing of it was stopped, so the log is
 * the only place the work a caller no longer sees is recorded.
 */
function unregisterCall(resolved, entry) {
  const entries = callsInFlight.get(resolved.sessionId);
  entries?.delete(entry);
  if (entries?.size === 0) {
    callsInFlight.delete(resolved.sessionId);
  }
  if (entry.client.gone) {
    console.warn(
      `chromectl: ${entry.command} on ${resolved.target} ran on for ` +
        `${Date.now() - entry.startedAtMs} ms after its client left; its result is dropped`,
    );
  }
}

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
      // A caller that can only send text cannot write a list at all, so a lone
      // string counts as the one-element list — `wait_for --text "…"` is the
      // whole of the exposed array surface, and without this the command is
      // offered and uncallable from the bash client.
      if (typeof coerced === 'string') {
        coerced = [coerced];
      }
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
 * Builds the name of one file the front writes: the target the call ran on, the
 * UTC moment down to the millisecond and eight random hex characters. Two calls
 * running at the same time therefore cannot land on the same file even within
 * one millisecond. The name carries no colons, so a Windows client reaching the
 * drive over Samba can open it.
 *
 * A target name without a single letter or digit slugs to nothing, and a name
 * with an empty slug is not one `GENERATED_FILE_NAME_PATTERN` matches: the file
 * would sit on the drive while the URL in the answer came back a 400. The
 * registry lets no such name through today (`TARGET_PATTERN` demands a letter or
 * digit first), so the fixed slug is what keeps the two patterns tied to each
 * other rather than to that rule.
 */
function generatedFileName(target, extension) {
  const slug =
    target.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'target';
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  return `chromectl-${slug}-${stamp}-${randomBytes(4).toString('hex')}.${extension}`;
}

/**
 * The address a written file is fetched under. Every name the front hands out
 * is made of letters, digits, dot, underscore and hyphen, so the encoding
 * changes nothing; it is applied so that the answer stays a URL whatever a name
 * ever comes to carry.
 */
function fileUrl(publicBase, fileName) {
  return `${publicBase}${FILE_ROUTE}${encodeURIComponent(fileName)}`;
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
  const fileName = generatedFileName(target, format);
  await ensureOutputDir();
  const filePath = path.join(OUTPUT_DIR, fileName);
  // The name is the front's own and carries eight random characters, so there is
  // nothing to write past: the daemon writes where the answer points, and
  // `writePath` is that same path rather than a stage it is renamed from.
  return {kind: 'screenshot', fileName, filePath, writePath: filePath, format};
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
 * The caller's name never reaches the daemon. The daemon writes to `writePath`,
 * a name the front builds itself with eight random characters, and the written
 * file is renamed onto the caller's name afterwards. That is what keeps the
 * write inside the directory: the drive is writable over Samba and NFS, so
 * anyone reaching it can put a symlink or a hardlink under a name a caller
 * announced, and a check the front makes here says nothing about the entry the
 * daemon meets a moment later, in another process. Against the random name there
 * is nothing to plant, and `rename` replaces the name rather than writing
 * through what sits under it, so no interleaving reaches an inode outside
 * `OUTPUT_DIR`.
 *
 * The checks below are pre-flight only: they turn the ordinary mistake — a name
 * that is a directory today, a name someone hardlinked — into a clear 400 before
 * the browser is driven at all. They are no longer the boundary, and an entry
 * planted after them is replaced by the rename rather than refused.
 */
async function planSnapshotFile(command, target, toolArgs) {
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
  if (existing !== undefined && existing.nlink !== 1) {
    throw new CallError(
      'usage',
      `${command}: ${requested} exists in ${OUTPUT_DIR} under more than one name`,
    );
  }

  return {
    kind: 'snapshot',
    fileName: requested,
    filePath,
    writePath: path.join(OUTPUT_DIR, generatedFileName(target, 'txt')),
  };
}

/** The file one call writes, or nothing when it writes none. */
async function planWrittenFile(command, target, toolArgs) {
  if (command === 'take_screenshot') {
    return await planScreenshot(target, toolArgs);
  }
  if (command === 'take_snapshot' && toolArgs.filePath !== undefined) {
    return await planSnapshotFile(command, target, toolArgs);
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
  // The daemon only ever saw `writePath`, so that is the path its message can
  // name.
  if (!detail.includes(plan.writePath) && !detail.includes(OUTPUT_DIR)) {
    return error;
  }
  return new CallError(
    'storage',
    `${plan.kind} could not be written to ${plan.filePath}`,
    error.detail,
  );
}

/**
 * Deals with the file a failed call left at `writePath`. A call that hits its
 * deadline or fails after the write still leaves the daemon's 0600 file on the
 * drive.
 *
 * A screenshot is written straight under the name the answer would have carried,
 * so a partial one stays and is only made readable: a file only the front's uid
 * can read is of no use to an NFS client arriving under its own. A snapshot is
 * written under a name of the front's own that is renamed onto the caller's only
 * on success; a failed one therefore sits under a name no answer mentioned and
 * no route serves, and is removed instead of left on the drive for good.
 *
 * Best effort by design: a call that failed before the write leaves nothing
 * here, and neither a chmod nor an unlink that fails must displace the failure
 * being reported to the caller.
 */
async function settleLeftoverFile(plan) {
  try {
    if (plan.writePath === plan.filePath) {
      await fs.chmod(plan.writePath, OUTPUT_FILE_MODE);
    } else {
      await fs.unlink(plan.writePath);
    }
  } catch {
    // No file written, or one this process cannot touch: the call's own
    // failure is what the caller gets.
  }
}

/**
 * Confirms the file the daemon was told to write really is there and makes it
 * readable for everyone reaching the drive, puts it under the name the answer
 * carries and describes it. A tool call that reports success without a file on
 * disk is a storage failure, not a result. Every file carries a fetch URL: the
 * client is bash and curl, so the share path presumes a mount it may not have
 * while the URL is reachable wherever the call itself was sent from.
 *
 * The rename is what a caller-named snapshot arrives through, and it is the last
 * step: an entry someone put under that name meanwhile is replaced, since
 * `rename` acts on the name and not on what it points at. A screenshot names its
 * own file and is already where it belongs.
 */
async function describeWrittenFile(plan, publicBase) {
  let stats;
  try {
    stats = await fs.stat(plan.writePath);
    if (!stats.isFile() || stats.size === 0) {
      throw new Error(`${stats.size} bytes`);
    }
    await fs.chmod(plan.writePath, OUTPUT_FILE_MODE);
    if (plan.writePath !== plan.filePath) {
      await fs.rename(plan.writePath, plan.filePath);
    }
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
    url: fileUrl(publicBase, plan.fileName),
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
  // A success renders as the structured object. A tool-level failure renders as
  // the raw content array, and anything else that is not a plain object is no
  // result either: the answer reads properties off it, and `null` would pass an
  // array check only to throw at the first one.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CallError('tool', `${command} failed`, parsed);
  }
  return {parsed, elapsedMs};
}

/**
 * The opening of a spilled result, so the answer still says what was found.
 * A slice must not end inside a surrogate pair: half a pair is not a character
 * and would travel as a replacement.
 */
function spillHead(rendered) {
  const head = rendered.slice(0, SPILL_HEAD_CHARS);
  const last = head.charCodeAt(head.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}

/**
 * Writes a result that is too large to answer with and describes it in its
 * place: path, share path, fetch URL, byte count and the first lines.
 *
 * The file is created exclusively: its name is the front's own and carries
 * eight random hex characters, so an entry already sitting there is not this
 * call's file and is never written through — a symlink someone dropped into the
 * guest-writable share least of all.
 */
async function spillResult(target, rendered, publicBase) {
  await ensureOutputDir();
  const fileName = generatedFileName(target, 'json');
  const filePath = path.join(OUTPUT_DIR, fileName);
  try {
    await fs.writeFile(filePath, rendered, {
      flag: 'wx',
      mode: OUTPUT_FILE_MODE,
    });
    // The write runs under this process's umask, so the mode is set again.
    await fs.chmod(filePath, OUTPUT_FILE_MODE);
  } catch (error) {
    throw new CallError(
      'storage',
      `the result could not be written to ${filePath}`,
      error.message,
    );
  }

  return {
    spilled: true,
    file: fileName,
    path: filePath,
    share_path: path.relative(SHARE_ROOT, filePath),
    url: fileUrl(publicBase, fileName),
    bytes: Buffer.byteLength(rendered),
    head: spillHead(rendered),
  };
}

async function invoke(target, command, args, fullSpeed, publicBase, client) {
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

  // Before anything is planned, written or sent: a browser still carrying out a
  // call nobody waits for takes no second one, bar the one that clears a dialog.
  assertAdmissible(resolved, command);
  const entry = registerCall(
    resolved,
    command,
    queuedCallBudgetMs(command, toolArgs, atFullSpeed),
    client,
  );
  try {
    return await carryOutCall(
      resolved,
      command,
      toolArgs,
      atFullSpeed,
      publicBase,
    );
  } finally {
    unregisterCall(resolved, entry);
  }
}

/** Carries out one call that has been admitted, from the file plan to the answer. */
async function carryOutCall(
  resolved,
  command,
  toolArgs,
  atFullSpeed,
  publicBase,
) {
  // The written file takes the place of the payload upstream would attach, so
  // the answer stays small enough for a caller's shell. Where it lands is the
  // front's decision in either case. The echoed argument is the path the caller
  // ends up with; what the daemon is handed is `plan.writePath`.
  const plan = await planWrittenFile(command, resolved.target, toolArgs);
  if (plan) {
    toolArgs.filePath = plan.filePath;
  }

  // The probe comes first: it decides between a browser that is gone, which is
  // an outage, and a daemon that is gone, which the call itself repairs.
  await assertTargetReachable(resolved.browserUrl);

  let outcome;
  try {
    outcome = await runCommand(
      resolved,
      command,
      plan ? {...toolArgs, filePath: plan.writePath} : toolArgs,
      atFullSpeed,
    );
  } catch (error) {
    if (!plan) {
      throw error;
    }
    await settleLeftoverFile(plan);
    throw reclassifyFileFailure(error, plan);
  }
  const {parsed, elapsedMs} = outcome;

  // The tool reports back the path it was handed, which is the front's staging
  // name and is gone a moment later. Every path in the answer names the file the
  // caller can actually fetch.
  if (plan && parsed.snapshotFilePath === plan.writePath) {
    parsed.snapshotFilePath = plan.filePath;
  }

  // What the answer would carry, measured before it is sent: a result past the
  // cap is written out and named instead, so no call can put hundreds of
  // kilobytes into a caller's context that it cannot take back.
  const rendered = JSON.stringify(parsed);
  const spill =
    Buffer.byteLength(rendered) > SPILL_BYTES
      ? await spillResult(resolved.target, rendered, publicBase)
      : undefined;

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
    result: spill ?? parsed,
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
  // A client that left before its answer was ready gets nothing: its socket is
  // gone, and the call it abandoned is logged where it ran.
  if (response.writableEnded || response.destroyed) {
    return;
  }
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

/**
 * Serves a file an earlier call left behind — screenshot, snapshot or spilled
 * result — for a caller that does not have the network drive mounted. The
 * client is bash and curl by design, so this route, not the share path, is what
 * a caller on another machine actually reaches the file through.
 *
 * The front is unauthenticated, so this is a read path into `OUTPUT_DIR` and
 * must be nothing beyond it. Four things hold that, and the last three hold it
 * without relying on the first: the name has to be one the front hands out or
 * one it accepted as a snapshot file name, both of which are made of letters,
 * digits, dot, underscore and hyphen and can therefore carry neither a
 * directory separator nor a leading dot nor a `..`; the path built from it must
 * still lie directly in `OUTPUT_DIR`; the file is opened `O_NOFOLLOW`, so a
 * symlink placed in the guest-writable share cannot carry the read out of the
 * directory; and it must be the only name its inode has, because a hardlink is a
 * regular file with nothing to follow and would otherwise serve whatever the
 * front's uid can read. Only a regular file is answered.
 */
async function sendFile(response, pathname) {
  const requested = pathname.slice(FILE_ROUTE.length);
  let fileName;
  try {
    fileName = decodeURIComponent(requested);
  } catch {
    // A stray `%` is the caller's mistake, not the tool's: decoded here so the
    // `URIError` cannot travel out as a 422 with a JavaScript message.
    throw new CallError('usage', `not a usable file name: ${requested}`);
  }
  if (
    !GENERATED_FILE_NAME_PATTERN.test(fileName) &&
    !OUTPUT_FILE_NAME_PATTERN.test(fileName)
  ) {
    throw new CallError('usage', `not a chromectl file name: ${fileName}`);
  }
  const filePath = path.resolve(OUTPUT_DIR, fileName);
  if (path.dirname(filePath) !== path.resolve(OUTPUT_DIR)) {
    throw new CallError('usage', `not a file of ${OUTPUT_DIR}: ${fileName}`);
  }

  let data;
  let handle;
  try {
    handle = await fs.open(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error('not a regular file');
    }
    if (stats.nlink !== 1) {
      throw new Error('a hardlink, not a file of this directory');
    }
    data = await handle.readFile();
  } catch (error) {
    throw new CallError('storage', `no file ${fileName}`, error.message);
  } finally {
    await handle?.close();
  }

  const extension = path.extname(fileName).slice(1);
  response.writeHead(200, {
    'content-type':
      CONTENT_TYPE_BY_EXTENSION[extension] ?? 'application/octet-stream',
    'content-length': data.length,
  });
  response.end(data);
}

/**
 * The path one request addresses, without what follows it. `request.url` carries
 * the query string, and a file name with `?v=1` appended is not a file name the
 * front hands out — the route is decided on the path alone.
 */
function requestPathname(url) {
  try {
    return new URL(url, 'http://chromectl.invalid').pathname;
  } catch {
    throw new CallError('usage', `not a usable request path: ${url}`);
  }
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
  // Whether the caller is still there. A closed response that never finished is
  // a client that gave up — on its own timeout above all — and the call it left
  // behind keeps running, so the loss is recorded here, where the socket is,
  // and read again when the next call for that browser arrives.
  const client = {gone: false};
  response.on('close', () => {
    client.gone = !response.writableFinished;
  });

  try {
    const pathname = requestPathname(request.url);
    if (request.method === 'GET' && pathname === '/health') {
      send(response, 200, {
        ok: true,
        service: 'chromectl',
        targets: listTargets(),
        commands: ALLOWED_COMMANDS,
      });
      return;
    }
    if (request.method === 'GET' && pathname.startsWith(FILE_ROUTE)) {
      await sendFile(response, pathname);
      return;
    }
    if (
      request.method !== 'POST' ||
      (pathname !== '/call' && pathname !== '/budget')
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
    if (pathname === '/budget') {
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
        client,
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
