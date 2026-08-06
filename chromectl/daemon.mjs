/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The daemons the chromectl front carries its calls out with.
 *
 * Every browser has one daemon of its own, started on first use and kept for
 * the calls that follow. This module owns them: the two maps below say which
 * daemon is the current one for a browser and which lifecycle operation is in
 * flight, and nothing outside reaches either. What leaves here is one probe of
 * the browser and one call, so the rest of the front never learns that a daemon
 * can be started, replaced or lost.
 *
 * The front speaks to the daemon over its unix socket in process, through
 * upstream's own daemon client (`build/src/daemon/client.js`), instead of
 * spawning the `chrome-devtools` CLI per request; a node process start costs
 * ~710 ms, the protocol work costs single-digit milliseconds. Importing the
 * built client keeps the wire format upstream's business.
 *
 * The daemon of a browser holds that browser's page selection: `select_page`
 * stays in force for every further call reaching the same browser, under
 * whichever of its names, until another `select_page`, until the selected tab
 * is closed or until the daemon is replaced.
 */

import process from 'node:process';

import {
  handleResponse,
  sendCommand,
  startDaemon,
} from '../build/src/daemon/client.js';
import {getDaemonPid, isDaemonRunning} from '../build/src/daemon/utils.js';

import {CallError} from './errors.mjs';
import {forgetRecording} from './fileresult.mjs';

// A daemon is spawned by the imported client and inherits this process's
// environment, so telemetry and the update check are switched off here.
process.env['CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS'] = '1';
process.env['CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS'] = '1';

/** Upper bound for the CDP reachability probe. */
const PROBE_TIMEOUT_MS = 5_000;

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
 * Server flags every daemon is started with.
 *
 * `viaCli` is what makes the daemon register the full tool set, and the flags
 * beside it are what makes the registered tools answer: a tool whose category
 * or whose experimental condition is off is registered under `viaCli` but
 * refuses every call with the flag it wants named. The front offers the whole
 * table, so it starts the daemon with all of them —
 * `categoryExtensions`, `categoryExperimentalThirdParty` and
 * `categoryExperimentalWebmcp` for the three categories that are off by
 * default, `memoryDebugging` for the heap snapshot readers,
 * `experimentalVision` for the coordinate-based click and
 * `experimentalScreencast` for the video recording. `categoryExtensions` is
 * also what keeps extension service workers in the page listing.
 *
 * `experimentalStructuredContent` is what makes a result come back as a JSON
 * object rather than rendered text.
 *
 * `allowUnrestrictedPaths` is what lets a file leave the OS temp directory: the
 * daemon's own MCP client negotiates no roots capability, so without the flag
 * every file-writing tool is confined to `/tmp`. The widening is safe here
 * because the front is the layer that confines the path: no path a caller sends
 * is forwarded, the front fills every path argument in itself and every file it
 * lets a call write or read stays in `OUTPUT_DIR`. `FILE_ARGUMENTS` in
 * `filearguments.mjs` is where that confinement is declared, and the check
 * beside it is what refuses to start the front while one argument of the
 * command table is unaccounted for; `fileplan.mjs` is where it is carried out.
 */
const DAEMON_ARGS = [
  '--viaCli',
  '--experimentalStructuredContent',
  '--categoryExtensions',
  '--categoryExperimentalThirdParty',
  '--categoryExperimentalWebmcp',
  '--memoryDebugging',
  '--experimentalVision',
  '--experimentalScreencast',
  '--usageStatistics=false',
  '--allowUnrestrictedPaths',
];

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
export async function assertTargetReachable(browserUrl) {
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
  // Whatever the daemon before this one was recording is over: ffmpeg was its
  // child. The plan of that recording goes with it, so no later stop describes
  // a file that stopped being written when the daemon did.
  await forgetRecording(sessionId);
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
 * How long the call may take is drawn once per call in `invoke` and handed down
 * (`src/pacing.ts`); it covers two separate ceilings. The work budget is derived
 * because a command that types character by character lasts as long as its text
 * is long, so a fixed ceiling would cut an honest input off in the middle of a
 * field; at full speed nothing is typed character by character and it falls back
 * to the floor. On top of it comes the fixed ceiling for the wait, because the
 * daemon serializes on one browser and this call may be queued behind another
 * before it does anything.
 *
 * This is the outermost of the three deadlines one call passes through and the
 * shortest of them, so a timeout is reported here rather than by a socket
 * further in. Which of the two ceilings was hit stays legible: the wait ends at
 * its own ceiling inside the daemon and comes back as a failed call, so a
 * timeout reported here is the work. The caller's own timeout is the same
 * figure again, asked for through `/budget` and widened by
 * `CLIENT_TIMEOUT_HEADROOM_MS` in `front.mjs`, so it can only fire after this
 * one and a caller gets a reported failure instead of a silence.
 */
async function invokeTool(resolved, command, args, fullSpeed, budgetMs) {
  const message = {method: 'invoke_tool', tool: command, args, fullSpeed};
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

/** Sends one tool invocation and renders its result. */
export async function runCommand(
  resolved,
  command,
  toolArgs,
  fullSpeed,
  budgetMs,
) {
  const started = Date.now();
  const response = await invokeTool(
    resolved,
    command,
    toolArgs,
    fullSpeed,
    budgetMs,
  );
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
