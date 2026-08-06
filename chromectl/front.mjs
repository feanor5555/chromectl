/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * chromectl HTTP front.
 *
 * Takes a target name plus a command, drives the chrome-devtools daemon that
 * belongs to the browser behind that name and returns the result in one
 * envelope. It runs without any authentication; the local network and the
 * private overlay network are the access boundary.
 *
 * The front is a proxy, not a filter: every tool of the template is callable
 * through it, with the arguments upstream declares for that tool. Both the
 * command list and the argument schemas are read out of upstream's generated
 * command table, so an upstream bump brings its new tools along by itself.
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
 * The daemon of a browser holds that browser's page selection: `select_page`
 * stays in force for every further call reaching the same browser, under
 * whichever of its names, until another `select_page`, until the selected tab
 * is closed or until the daemon is replaced.
 *
 * Every path a tool takes or hands back is a path on the machine the front runs
 * on, so the front owns all of them: a caller names at most the file, the
 * directory is one of the network drive, and the answer names each file's
 * location together with a URL to fetch it under. A file a call reads is looked
 * up in that same directory, which is how a caller on another machine hands one
 * in. A result that outgrows `SPILL_BYTES` is written there as well instead of
 * being answered inline; a spilled result is the one file nobody asked for, so
 * it is also the one that expires: after `SPILL_RETENTION_MS` it is pruned,
 * together with any staging directory a killed front left behind.
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

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import {pipeline} from 'node:stream/promises';

import {
  handleResponse,
  sendCommand,
  startDaemon,
} from '../build/src/daemon/client.js';
import {getDaemonPid, isDaemonRunning} from '../build/src/daemon/utils.js';
import {queuedCallBudgetMs} from '../build/src/pacing.js';

import {assertAdmissible, registerCall, unregisterCall} from './admission.mjs';
import {
  assertKnownCommand,
  COMMANDS,
  validateArgs,
  validateFullSpeed,
} from './commands.mjs';
import {CallError, STATUS_BY_KIND} from './errors.mjs';
import {
  contentTypeFor,
  FILE_ROUTE,
  OUTPUT_DIR,
  SERVED_FILE_NAME_PATTERN,
  SPILL_RETENTION_MS,
} from './filenames.mjs';
import {
  daemonPathArguments,
  planCall,
  releaseOutputNames,
  removeStagedInputs,
  settleLeftoverFiles,
} from './fileplan.mjs';
import {
  describeCallFiles,
  forgetRecording,
  RECORDING_STOP_COMMAND,
  reclassifyFileFailure,
  spillIfTooLarge,
  withFinalPaths,
} from './fileresult.mjs';
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
 * The address the front is reached under when `CHROMECTL_PUBLIC_URL` says
 * nothing. It is built from the configured bind address; the wildcard binds
 * name no single address, so the loopback stands in for them, which is the one
 * address that certainly reaches this process.
 */
function boundPublicBase() {
  const host = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;
  return `http://${host.includes(':') ? `[${host}]` : host}:${PORT}`;
}

/**
 * The base every file URL in an answer is built on. This is configuration, not
 * something a request may decide: taken from the caller's `Host` header, the
 * answer would send its reader to whatever address that header named.
 */
const PUBLIC_BASE = (
  process.env['CHROMECTL_PUBLIC_URL'] ?? boundPublicBase()
).replace(/\/+$/, '');

/**
 * How many bytes of request body the front takes: an operator setting, like the
 * pacing figures and like `SPILL_BYTES` in `fileresult.mjs`, not a measurement.
 * It is a transport bound and nothing else — the front is a proxy, so the figure
 * sits where no legitimate argument reaches it, well above the source of an
 * `evaluate_script` function or the text of a `fill_form`, and only stops a body
 * that is being sent to fill this process's memory.
 */
const REQUEST_BYTES = 1_048_576;

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
 * `CLIENT_TIMEOUT_HEADROOM_MS`, so it can only fire after this one and a caller
 * gets a reported failure instead of a silence.
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
async function runCommand(resolved, command, toolArgs, fullSpeed, budgetMs) {
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

  // Drawn once and handed down: the deadline the call actually runs under and
  // the figure a refusal names the caller must be the same one, and a second
  // evaluation of a drawn budget would be a second figure.
  const budgetMs = queuedCallBudgetMs(command, toolArgs, atFullSpeed);

  // Before anything is planned, written or sent: a browser still carrying out a
  // call nobody waits for takes no second one, bar the one that clears a dialog.
  assertAdmissible(resolved, command);
  const entry = registerCall(resolved, command, budgetMs, client);
  try {
    return await carryOutCall(
      resolved,
      command,
      toolArgs,
      atFullSpeed,
      publicBase,
      budgetMs,
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
  budgetMs,
) {
  // A written file takes the place of the payload upstream would attach, so the
  // answer stays small enough for a caller's shell, and a file to be read is
  // looked up where every machine can put one. The echoed arguments are the
  // paths the caller ends up with; what the daemon is handed are the staging
  // paths beside them.
  const plan = await planCall(command, resolved, toolArgs);
  try {
    let outcome;
    try {
      // The probe comes first: it decides between a browser that is gone, which
      // is an outage, and a daemon that is gone, which the call itself repairs.
      await assertTargetReachable(resolved.browserUrl);
      outcome = await runCommand(
        resolved,
        command,
        {...toolArgs, ...daemonPathArguments(plan)},
        atFullSpeed,
        budgetMs,
      );
    } catch (error) {
      // Whatever the call left half-written goes, and so does a call's own
      // directory, whether the browser was never reached or the tool failed.
      await settleLeftoverFiles(plan);
      throw reclassifyFileFailure(error, plan, resolved.sessionId);
    }
    const {parsed, elapsedMs} = outcome;

    let described;
    try {
      described = await describeCallFiles(plan, resolved, command, publicBase);
    } catch (error) {
      // A tool that reported success without the file it was told to write
      // leaves the same half-written state a failed call does: the staging name
      // is one no answer will ever carry and nothing prunes it, so it goes here
      // together with the call's own directory.
      await settleLeftoverFiles(plan);
      throw error;
    }
    const {descriptors, replacements} = described;

    // What the answer would carry, measured before it is sent: a result past the
    // cap is written out and named instead, so no call can put hundreds of
    // kilobytes into a caller's context that it cannot take back.
    const rendered = withFinalPaths(JSON.stringify(parsed), replacements);
    const spill = await spillIfTooLarge(resolved.target, rendered, publicBase);
    const result = spill ?? JSON.parse(rendered);

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
      ...descriptors,
      result,
    };
  } finally {
    // The copy a call was handed to read is the call's own and outlives it by
    // nothing, and so is the name it took.
    await removeStagedInputs(plan);
    releaseOutputNames(plan);
    // A stop ends the recording whether the call succeeded or failed: the
    // browser is not recording afterwards either way, and a plan kept beyond it
    // would be described by the next stop as a file this one already took.
    if (command === RECORDING_STOP_COMMAND) {
      await forgetRecording(resolved.sessionId);
    }
  }
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
 * Serves a file an earlier call left behind — screenshot, snapshot, trace, heap
 * snapshot, recording, report or spilled result — for a caller that does not
 * have the network drive mounted. The client is bash and curl by design, so this
 * route, not the share path, is what a caller on another machine actually
 * reaches the file through.
 *
 * The front is unauthenticated, so this is a read path into `OUTPUT_DIR` and
 * must be nothing beyond it. Four things hold that, and the last three hold it
 * without relying on the first: the name has to be a plain name with an ending
 * the front knows, made of letters, digits, dot, underscore and hyphen, and can
 * therefore carry neither a directory separator nor a leading dot nor a `..`;
 * the path built from it must still lie directly in `OUTPUT_DIR`; the file is
 * opened `O_NOFOLLOW`, so a symlink placed in the guest-writable share cannot
 * carry the read out of the directory; and it must be the only name its inode
 * has, because a hardlink is a regular file with nothing to follow and would
 * otherwise serve whatever the front's uid can read. Only a regular file is
 * answered.
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
  if (!SERVED_FILE_NAME_PATTERN.test(fileName)) {
    throw new CallError('usage', `not a chromectl file name: ${fileName}`);
  }
  const filePath = path.resolve(OUTPUT_DIR, fileName);
  if (path.dirname(filePath) !== path.resolve(OUTPUT_DIR)) {
    throw new CallError('usage', `not a file of ${OUTPUT_DIR}: ${fileName}`);
  }

  let handle;
  let stats;
  try {
    handle = await fs.open(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error('not a regular file');
    }
    if (stats.nlink !== 1) {
      throw new Error('a hardlink, not a file of this directory');
    }
  } catch (error) {
    await handle?.close();
    // A name that is not on the drive is the caller's business, not a fault of
    // the front, and only that case is a 404: everything else the open can hit
    // — a symlink, a hardlink, an entry that is no regular file, a drive that
    // does not answer — is the storage failure it looks like. The retention is
    // named because it is the difference between a file that never existed and
    // one that expired, and nothing else in the answer tells the two apart.
    throw new CallError(
      error.code === 'ENOENT' ? 'notfound' : 'storage',
      `no file ${fileName} — spilled results are kept for ` +
        `${Math.round(SPILL_RETENTION_MS / 3_600_000)} h`,
      error.message,
    );
  }

  // The directory is writable over a password-less share, so a file served here
  // may be one nobody of this service wrote. It is handed over as a download
  // with the ending it carries taken at face value, so nothing planted there is
  // ever rendered as a page in the fetching browser.
  //
  // The bytes go from the handle the checks were made on straight to the socket
  // and are never held whole: a heap snapshot is hundreds of megabytes, and a
  // single fetch of one would otherwise carry that much beside every daemon
  // registration, call and recording plan this process keeps, all of which live
  // in its memory alone. The length comes from the `stat` of that same handle,
  // so it is the size of the file that was checked.
  response.writeHead(200, {
    'content-type': contentTypeFor(fileName),
    'content-length': stats.size,
    'x-content-type-options': 'nosniff',
    'content-disposition': `attachment; filename="${fileName}"`,
  });
  try {
    // The handle stays this function's to close, on every way out of it, which
    // is why the stream is told not to close it: a stream that closes its own
    // source would leave the `finally` closing a handle that is already gone.
    await pipeline(handle.createReadStream({autoClose: false}), response);
  } catch {
    // The head is out, so nothing can be said on this socket any more: a caller
    // that walked away mid-download and a read that stopped delivering both end
    // as a transfer the fetching side sees break off against the announced
    // length.
    response.destroy();
  } finally {
    await handle.close();
  }
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

/**
 * Reads one request body.
 *
 * The chunks are kept as buffers and decoded once, at the end: a chunk boundary
 * falls wherever TCP put it, and a UTF-8 sequence split across two of them would
 * decode to replacement characters on both sides if each chunk were decoded on
 * its own. The body carries the text that gets typed into pages and the source
 * of `evaluate_script`, so a silently altered character is a call that types
 * something other than what was sent. The size is counted in bytes for the same
 * reason, which is also the unit `REQUEST_BYTES` is named in.
 *
 * A body past the cap ends the reading, not the connection: the socket carries
 * the answer that says so, and a caller that is told the limit and the figure
 * can act on it, while a reset connection is a caller guessing why. What is
 * still on the way is dropped unread.
 */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > REQUEST_BYTES) {
        chunks.length = 0;
        request.pause();
        reject(
          new CallError(
            'usage',
            `request body is larger than the ${REQUEST_BYTES} bytes the front takes`,
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
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
        commands: COMMANDS,
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
    send(
      response,
      200,
      await invoke(
        body.target,
        body.command,
        body.args,
        body.full_speed,
        PUBLIC_BASE,
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
