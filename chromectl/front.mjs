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

import {randomBytes} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import {pipeline} from 'node:stream/promises';

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
 * Every command the front offers and the argument schema of each, taken whole
 * from upstream's generated command table (`chrome-devtools-cli-options.js`)
 * rather than kept as an own copy. The table is what the daemon registers its
 * tools from, so the front's surface is the daemon's surface, and an upstream
 * change — a new tool, a new argument on an existing one — arrives with the
 * merge instead of being dropped behind a list kept by hand.
 */
const COMMAND_SCHEMAS = new Map(
  Object.entries(upstreamCommands).map(([command, definition]) => [
    command,
    definition.args ?? {},
  ]),
);

/** The command names, sorted, as `/health` reports them. */
const COMMANDS = [...COMMAND_SCHEMAS.keys()].sort();

/**
 * The values upstream declares for one argument of a fixed set, and the one it
 * falls back to when a caller names none. A tool whose output carries the
 * format it was asked for takes its endings from here rather than from a list
 * kept beside it, so a format upstream adds arrives with the merge. An argument
 * that no longer carries such a set stops the front at startup, the same way an
 * unaccounted argument does.
 */
function enumeratedArgument(command, argument) {
  const definition = COMMAND_SCHEMAS.get(command)?.[argument];
  if (definition?.enum === undefined) {
    throw new Error(
      `${command}.${argument} carries no fixed set of values in the command ` +
        `table, so the endings of ${command} cannot be taken from it`,
    );
  }
  return {
    values: definition.enum,
    fallback: definition.default ?? definition.enum[0],
  };
}

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
 * Mode of a directory one call works in. Nothing but the front and the daemon it
 * started ever looks inside one, and both run as the same user, so it is theirs
 * alone; what comes out of it is moved into `OUTPUT_DIR` and made readable
 * there.
 */
const STAGING_DIR_MODE = 0o700;

/**
 * The longest name a caller may pick. A filesystem takes 255 bytes, and this
 * sits well under it, with room for the generated staging name that stands
 * beside a caller's own. The bound is what keeps a mistyped name a mistyped
 * name: without it such a name reaches the drive and comes back as
 * `ENAMETOOLONG`, which is indistinguishable from a drive that is broken.
 */
const MAX_FILE_NAME_LENGTH = 128;

/**
 * The only shape of file name a caller may name, for a file to be written as
 * well as for one to be read. It carries no directory separator and does not
 * start with a dot, so such a name can neither leave `OUTPUT_DIR` nor address
 * one of its parents, and `..` cannot be written at all.
 */
const PLAIN_FILE_NAME_PATTERN = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,${MAX_FILE_NAME_LENGTH - 1}}$`,
);

/**
 * The endings a file of this service carries. Every tool that writes one
 * enforces its own ending on the path it was handed (`McpContext.saveFile`
 * replaces whatever extension arrives), so this is that set, plus the one a
 * spilled result gets. Demanding the ending on a name a caller picks keeps the
 * path in the answer the path that lands on disk.
 *
 * The screenshot endings are the formats upstream declares for `take_screenshot`
 * rather than a copy of them. The rest a tool decides inside its own code, which
 * is nowhere declared, so those stay a list — one `assertExtensionsAccountedFor`
 * holds against what the tables can actually produce.
 */
const FILE_EXTENSIONS = [
  ...enumeratedArgument('take_screenshot', 'format').values,
  'txt',
  'json',
  'json.gz',
  'spill.json',
  'heapsnapshot',
  'network-request',
  'network-response',
  'mp4',
  'webm',
  'html',
];

const EXTENSION_ALTERNATION = FILE_EXTENSIONS.map(extension =>
  extension.replaceAll('.', '\\.'),
).join('|');

/** The stem of every name the front builds itself: target, moment, randomness. */
const GENERATED_NAME_STEM =
  'chromectl-[A-Za-z0-9-]+-[0-9]{8}T[0-9]{9}Z-[0-9a-f]{8}';

/**
 * The longest name a file of this service can carry: what a filesystem takes,
 * so nothing that exists on the drive is excluded. A generated name carries the
 * name of its target, and a tighter bound would tie fetchability to how long
 * that name is. Beyond it a name only reaches the drive to come back as
 * `ENAMETOOLONG`, which is indistinguishable from a drive that is broken.
 */
const MAX_SERVED_FILE_NAME_LENGTH = 255;

/** A file of this service: a plain name with an ending the front knows. */
const SERVED_FILE_NAME_PATTERN = new RegExp(
  `^(?=.{1,${MAX_SERVED_FILE_NAME_LENGTH}}$)` +
    `[A-Za-z0-9][A-Za-z0-9._-]*\\.(?:${EXTENSION_ALTERNATION})$`,
);

/** The file names the front builds itself. */
const GENERATED_FILE_NAME_PATTERN = new RegExp(
  `^${GENERATED_NAME_STEM}\\.(?:${EXTENSION_ALTERNATION})$`,
);

/**
 * The directory names the front builds itself: the same stem without an ending,
 * which is what a call's staging directory carries and no file of the front does.
 */
const GENERATED_DIRECTORY_NAME_PATTERN = new RegExp(`^${GENERATED_NAME_STEM}$`);

const CONTENT_TYPE_BY_EXTENSION = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  'json.gz': 'application/gzip',
  'spill.json': 'application/json; charset=utf-8',
  heapsnapshot: 'application/json; charset=utf-8',
  'network-request': 'application/octet-stream',
  'network-response': 'application/octet-stream',
  mp4: 'video/mp4',
  webm: 'video/webm',
  html: 'text/html; charset=utf-8',
};

/**
 * What a file is served as. The longest known ending a name carries decides, so
 * `.json.gz` is not read as the `.json` it also ends in.
 */
function contentTypeFor(fileName) {
  const extension = FILE_EXTENSIONS.filter(candidate =>
    fileName.endsWith(`.${candidate}`),
  ).sort((left, right) => right.length - left.length)[0];
  return CONTENT_TYPE_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

/** The ending a spilled result carries, which is what the pruning goes by. */
const SPILL_EXTENSION = 'spill.json';

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

/**
 * How many bytes of request body the front takes: an operator setting, like the
 * pacing figures and like `SPILL_BYTES`, not a measurement. It is a transport
 * bound and nothing else — the front is a proxy, so the figure sits where no
 * legitimate argument reaches it, well above the source of an
 * `evaluate_script` function or the text of a `fill_form`, and only stops a body
 * that is being sent to fill this process's memory.
 */
const REQUEST_BYTES = 1_048_576;

/**
 * How long a spilled result stays on the drive.
 *
 * A spilled file is the only one nobody asked for: the caller wanted the result
 * in its answer, and the file exists because the answer could not carry it — the
 * text of a permanently logged-in page among them, as a world-readable file on a
 * password-less share. It therefore expires, while a screenshot and a
 * caller-named snapshot are artifacts someone asked for and stay until someone
 * removes them.
 */
const SPILL_RETENTION_MS = Number(
  process.env['CHROMECTL_SPILL_RETENTION_MS'] ?? 86_400_000,
);
if (!Number.isInteger(SPILL_RETENTION_MS) || SPILL_RETENTION_MS <= 0) {
  // A typo here would read as "keeps them forever", which is the exposure the
  // retention exists to end, so it is a startup fault.
  throw new Error(
    `CHROMECTL_SPILL_RETENTION_MS must be a positive whole number of milliseconds, got ${JSON.stringify(process.env['CHROMECTL_SPILL_RETENTION_MS'])}`,
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
 * lets a call write or read stays in `OUTPUT_DIR`.
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
 * HTTP status per failure kind, mirroring the client's exit codes. `notfound`
 * belongs to the file route alone — a call never produces it, so it is the one
 * status the client's mapping does not have to carry.
 */
const STATUS_BY_KIND = {
  usage: 400,
  notfound: 404,
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
 * The exemption is one named command, never a category: `handle_dialog` is
 * admitted only after the name has been checked against the command table and
 * its arguments against upstream's schema, it carries nothing but
 * `accept`/`dismiss` and a prompt text, it reads no page state and it touches no
 * file — `FILE_ARGUMENTS` knows it not. Nor is it a second way onto the page:
 * while one exempt call is in flight the next is refused, so at most one caller
 * ever clears the dialog and none drives the page beside it.
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

/** A name upstream does not know never reaches the daemon. */
function assertKnownCommand(command) {
  if (typeof command !== 'string' || !COMMAND_SCHEMAS.has(command)) {
    throw new CallError(
      'usage',
      `unknown command: ${JSON.stringify(command)} — GET /health names the ` +
        `${COMMANDS.length} commands this front offers`,
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
    // Asked for the schema's own names only: `constructor` and its like are
    // truthy on every object and would slip past this refusal to fail later as
    // a fault of the service.
    const definition = Object.hasOwn(schema, name) ? schema[name] : undefined;
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
 * Builds the name of one entry the front creates: the target the call ran on,
 * the UTC moment down to the millisecond and eight random hex characters. Two
 * calls running at the same time therefore cannot land on the same name even
 * within one millisecond. The name carries no colons, so a Windows client
 * reaching the drive over Samba can open it.
 *
 * A target name without a single letter or digit slugs to nothing, and a name
 * with an empty slug is not one `GENERATED_FILE_NAME_PATTERN` matches: the file
 * would sit on the drive while the URL in the answer came back a 400. The
 * registry lets no such name through today (`TARGET_PATTERN` demands a letter or
 * digit first), so the fixed slug is what keeps the two patterns tied to each
 * other rather than to that rule.
 */
function generatedName(target) {
  const slug =
    target.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'target';
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  return `chromectl-${slug}-${stamp}-${randomBytes(4).toString('hex')}`;
}

/** The same name with the ending the file it stands for carries. */
function generatedFileName(target, extension) {
  return `${generatedName(target)}.${extension}`;
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

/**
 * Removes what the front left behind and has outlived `SPILL_RETENTION_MS`:
 * spilled results and staging directories.
 *
 * Only those two are touched, and both have to carry a name the front built
 * itself — a spill additionally the `spill.json` ending only a spill gets, a
 * staging directory the bare stem no file of the front carries. A screenshot, a
 * trace, a caller-named file and anything else lying in the directory are left
 * where they are. The entry has to be of the kind its name claims: a file for
 * the one, a directory for the other, decided on an `lstat` that follows
 * nothing, so a symlink planted under either shape in the guest-writable share
 * matches neither and stays.
 *
 * Every path that creates a staging directory removes it again, so this catches
 * the one case none of them can: a front killed between the creation and the
 * removal. The retention is a day and a call lasts at most minutes, so a
 * directory old enough to be swept here belongs to no call that is still
 * running.
 *
 * Best effort throughout: this runs beside a caller's call, and neither an
 * unreadable directory nor an entry that vanished between the listing and the
 * `lstat` is that caller's business.
 *
 * The residual is accepted rather than solved with a scheduler: a front nobody
 * calls again prunes nothing and keeps its last spills, because the prune hangs
 * off the next call rather than off a timer of its own.
 */
async function pruneExpiredEntries() {
  const deadline = Date.now() - SPILL_RETENTION_MS;
  let names;
  try {
    names = await fs.readdir(OUTPUT_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    const isSpill =
      GENERATED_FILE_NAME_PATTERN.test(name) &&
      name.endsWith(`.${SPILL_EXTENSION}`);
    const isStaging = GENERATED_DIRECTORY_NAME_PATTERN.test(name);
    if (!isSpill && !isStaging) {
      continue;
    }
    const entryPath = path.join(OUTPUT_DIR, name);
    try {
      const stats = await fs.lstat(entryPath);
      if (stats.mtimeMs >= deadline) {
        continue;
      }
      if (isSpill && stats.isFile()) {
        await fs.unlink(entryPath);
      } else if (isStaging && stats.isDirectory()) {
        await fs.rm(entryPath, {recursive: true, force: true});
      }
    } catch {
      // Gone already, or not this process's to remove.
    }
  }
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
  // Every write passes here, which is the only moment the front is awake for
  // sure: the expiry rides along with it instead of on a timer.
  await pruneExpiredEntries();
}

/** The heap snapshot a reader tool is pointed at: written by an earlier call. */
const HEAP_SNAPSHOT_INPUT = {direction: 'in', extensions: ['heapsnapshot']};

/**
 * The path arguments of every command, and what the front does with each.
 *
 * `out` is a file the daemon writes. The directory is the front's decision and a
 * caller names at most the file, so the answer can hand back a location the
 * caller actually reaches; the name lands in the answer under `kind`, with a
 * fetch URL beside it. `always` marks an argument the front fills in whether or
 * not the caller named one, because the payload would otherwise travel inline or
 * into a temp directory nobody can reach — the image of a screenshot, the video
 * of a recording. `optional` marks a file a tool writes only when the page had
 * the content it would hold, so its absence is a result and not a failure.
 * `deferred` marks the one whose file is finished by a later call; that one is
 * never optional, since the call finishing it is the call that promised it.
 *
 * `extensions` are the endings a tool enforces, the first of them the one a name
 * the front builds itself carries. `extensionsFrom` stands in its place where
 * the ending is the format the caller asked for: it names the argument that
 * carries it, and both the ending and the fallback come out of the command
 * table instead of being written down here a second time.
 *
 * `out-dir` is a directory a tool fills with files of its own naming. The front
 * hands it one of its own, takes the files named in `reports` out of it
 * afterwards and removes it.
 *
 * `in` is a file the daemon reads, `in-dir` a directory it reads. Both are
 * looked up in `OUTPUT_DIR`: that directory lies on the network drive every
 * machine reaches, so a caller on another machine puts the file there — or an
 * earlier call of its own wrote it — and names it here.
 *
 * The heap snapshot readers are derived from the command table instead of being
 * listed, so an upstream bump brings its new ones along.
 */
const FILE_ARGUMENTS = {
  take_screenshot: {
    filePath: {
      direction: 'out',
      kind: 'screenshot',
      always: true,
      extensionsFrom: 'format',
    },
  },
  take_snapshot: {
    filePath: {direction: 'out', kind: 'snapshot', extensions: ['txt']},
  },
  evaluate_script: {
    filePath: {direction: 'out', kind: 'output', extensions: ['json']},
  },
  take_heapsnapshot: {
    filePath: {
      direction: 'out',
      kind: 'heapsnapshot',
      extensions: ['heapsnapshot'],
    },
  },
  performance_start_trace: {
    filePath: {
      direction: 'out',
      kind: 'trace',
      extensions: ['json', 'json.gz'],
      optional: true,
    },
  },
  performance_stop_trace: {
    filePath: {
      direction: 'out',
      kind: 'trace',
      extensions: ['json', 'json.gz'],
      optional: true,
    },
  },
  get_network_request: {
    requestFilePath: {
      direction: 'out',
      kind: 'request_body',
      extensions: ['network-request'],
      optional: true,
    },
    responseFilePath: {
      direction: 'out',
      kind: 'response_body',
      extensions: ['network-response'],
      optional: true,
    },
  },
  screencast_start: {
    filePath: {
      direction: 'out',
      kind: 'recording',
      always: true,
      deferred: true,
      extensions: ['mp4', 'webm'],
    },
  },
  lighthouse_audit: {
    outputDirPath: {
      direction: 'out-dir',
      always: true,
      reports: {'report.json': 'report_json', 'report.html': 'report_html'},
    },
  },
  upload_file: {filePath: {direction: 'in', staged: true}},
  install_extension: {path: {direction: 'in-dir'}},
  close_heapsnapshot: {filePath: HEAP_SNAPSHOT_INPUT},
  compare_heapsnapshots: {
    baseFilePath: HEAP_SNAPSHOT_INPUT,
    currentFilePath: HEAP_SNAPSHOT_INPUT,
  },
};

for (const command of COMMANDS) {
  if (command.startsWith('get_heapsnapshot_')) {
    FILE_ARGUMENTS[command] = {filePath: HEAP_SNAPSHOT_INPUT};
  }
}

/**
 * The endings one path argument may carry in one call: the format the caller
 * asked for where the tool names its output by one, the fixed set otherwise. The
 * first is the ending a name the front builds itself gets.
 */
function extensionsOf(command, spec, toolArgs) {
  if (spec.extensionsFrom === undefined) {
    return spec.extensions ?? [];
  }
  const {fallback} = enumeratedArgument(command, spec.extensionsFrom);
  return [toolArgs[spec.extensionsFrom] ?? fallback];
}

/** Every ending one path argument can carry, over all calls a caller can make. */
function possibleExtensionsOf(command, spec) {
  if (spec.extensionsFrom === undefined) {
    return spec.extensions ?? [];
  }
  return enumeratedArgument(command, spec.extensionsFrom).values;
}

/** The ending a report of an output directory carries: `report.json` is a json. */
function reportExtension(name) {
  return name.slice(name.indexOf('.') + 1);
}

/**
 * Every argument of the command table that carries no path on the machine the
 * front runs on: a uid, a page index, a key, the text to type, the source of a
 * script. It is the counterpart of `FILE_ARGUMENTS`, and between the two every
 * argument upstream declares is accounted for.
 *
 * The list is by argument name, and an upstream bump that gives an existing name
 * a new meaning is the one case it does not catch; the names here all carry
 * page-side data today and none of them is a filesystem path anywhere in the
 * table.
 */
const NON_PATH_ARGUMENTS = new Set([
  'action',
  'args',
  'autoStop',
  'background',
  'bringToFront',
  'classIndex',
  'colorScheme',
  'cpuThrottlingRate',
  'dblClick',
  'device',
  'dialogAction',
  'extraHttpHeaders',
  'filterName',
  'format',
  'from_uid',
  'fullPage',
  'function',
  'geolocation',
  'handleBeforeUnload',
  'height',
  'id',
  'ignoreCache',
  'includePreservedMessages',
  'includePreservedRequests',
  'includeSnapshot',
  'initScript',
  'input',
  'insightName',
  'insightSetId',
  'isolatedContext',
  'key',
  'maxDepth',
  'maxNodes',
  'maxSiblings',
  'mode',
  'msgid',
  'networkConditions',
  'nodeId',
  'objectId',
  'pageId',
  'pageIdx',
  'pageSize',
  'params',
  'promptText',
  'quality',
  'reload',
  'reqid',
  'resourceTypes',
  'serviceWorkerId',
  'submitKey',
  'text',
  'timeout',
  'to_uid',
  'toolName',
  'type',
  'types',
  'uid',
  'url',
  'userAgent',
  'value',
  'verbose',
  'viewport',
  'width',
  'x',
  'y',
]);

/**
 * Refuses to start while one argument of the command table is unaccounted for.
 *
 * The daemon runs with `--allowUnrestrictedPaths`, so a path that travelled
 * through as the caller wrote it would read and write wherever the front's user
 * can, from an endpoint that asks for no authentication. Every path argument the
 * front knows is filled in by the front itself, and the question is what happens
 * to the one it does not know yet: an upstream bump adds a tool, its arguments
 * pass `validateArgs` because they are in the schema, and nothing else stands
 * between them and the daemon.
 *
 * The check is therefore against the two tables rather than against how an
 * argument is spelled — upstream names its path arguments `…Path` today, but
 * that is upstream's habit and not a property this fork may rest on. An argument
 * that is in neither table stops the front at startup, which is the loud failure
 * a merge is looked at again after; the alternative is a silent path escape at
 * the moment nobody is looking. Clearing it is one entry: into `FILE_ARGUMENTS`
 * when the argument carries a path, into `NON_PATH_ARGUMENTS` when it does not.
 */
function assertArgumentsAccountedFor() {
  const unaccounted = [];
  for (const [command, schema] of COMMAND_SCHEMAS) {
    for (const argument of Object.keys(schema)) {
      if (
        FILE_ARGUMENTS[command]?.[argument] ||
        NON_PATH_ARGUMENTS.has(argument)
      ) {
        continue;
      }
      unaccounted.push(`${command}.${argument}`);
    }
  }
  if (unaccounted.length > 0) {
    throw new Error(
      `unknown tool arguments, each has to be entered into FILE_ARGUMENTS or ` +
        `into NON_PATH_ARGUMENTS before the front can serve them: ${unaccounted.join(', ')}`,
    );
  }
}

assertArgumentsAccountedFor();

/**
 * Refuses to start while one ending a call can produce is unknown to the front.
 *
 * `FILE_EXTENSIONS` decides which names the file route hands out again and
 * `CONTENT_TYPE_BY_EXTENSION` what such a file is served as. A media type is
 * declared nowhere upstream, so that table stays one kept here, and the endings
 * a call can produce are held against it: the values of the argument a tool
 * names its output by, the fixed endings of every other path argument, the
 * reports taken out of an output directory and the ending a spilled result
 * carries.
 *
 * Left unchecked, a file with such an ending is written, named in the answer and
 * then refused by the front's own file route with 400, or handed over as a
 * stream of bytes — both only at the moment a caller fetches it, long after the
 * merge that brought it. Clearing it is one entry per table.
 */
function assertExtensionsAccountedFor() {
  const unknown = new Map();
  const note = (extension, source) => {
    if (
      FILE_EXTENSIONS.includes(extension) &&
      CONTENT_TYPE_BY_EXTENSION[extension] !== undefined
    ) {
      return;
    }
    unknown.set(extension, source);
  };
  for (const [command, specs] of Object.entries(FILE_ARGUMENTS)) {
    for (const [argument, spec] of Object.entries(specs)) {
      for (const extension of possibleExtensionsOf(command, spec)) {
        note(extension, `${command}.${argument}`);
      }
      for (const report of Object.keys(spec.reports ?? {})) {
        note(reportExtension(report), `${command}.${argument}`);
      }
    }
  }
  note(SPILL_EXTENSION, 'a spilled result');
  if (unknown.size > 0) {
    const named = [...unknown]
      .map(([extension, source]) => `.${extension} (${source})`)
      .join(', ');
    throw new Error(
      `unknown file endings, each has to be entered into FILE_EXTENSIONS and ` +
        `into CONTENT_TYPE_BY_EXTENSION before the front can serve them: ${named}`,
    );
  }
}

assertExtensionsAccountedFor();

/**
 * The caller-chosen output names in flight, each with the browser that took it
 * and how many of its calls hold it. `OUTPUT_DIR` is flat and its names carry no
 * target, so two browsers writing `page.txt` at the same time would both stage
 * under their own random name and then both rename onto that one file: nothing
 * is corrupted, the loser's answer merely names a file that holds the other
 * browser's page, with its own byte count beside it and no way for either caller
 * to notice. Two calls of the same browser are the caller's own sequence and
 * keep the last one, as any two writes to one name do.
 */
const claimedOutputNames = new Map();

/**
 * Takes one caller-chosen name for the browser that is about to write it, or
 * refuses the call while another browser holds it. The refusal is a `busy`, the
 * same kind a call queued behind another gets: the name is free again as soon as
 * that call has ended, and picking another one is the caller's other way on.
 */
function claimOutputName(command, argument, fileName, resolved) {
  const claim = claimedOutputNames.get(fileName);
  if (claim === undefined) {
    claimedOutputNames.set(fileName, {
      sessionId: resolved.sessionId,
      holders: 1,
    });
    return;
  }
  if (claim.sessionId !== resolved.sessionId) {
    throw new CallError(
      'busy',
      `${command}: ${argument} ${fileName} is being written by another browser ` +
        'right now — name another file, or wait for that call to end',
    );
  }
  claim.holders += 1;
}

/** Gives one name back. */
function releaseOutputName(file) {
  if (!file.claimed) {
    return;
  }
  file.claimed = false;
  const claim = claimedOutputNames.get(file.fileName);
  if (claim === undefined) {
    return;
  }
  claim.holders -= 1;
  if (claim.holders <= 0) {
    claimedOutputNames.delete(file.fileName);
  }
}

/**
 * Gives the names of one finished call back. The name of a recording is not one
 * of them: its file is written until the stopping call renames it, so the claim
 * stays with the plan in `recordings` and is given back when that plan is.
 */
function releaseOutputNames(plan) {
  for (const file of plan.files) {
    if (!file.retained) {
      releaseOutputName(file);
    }
  }
}

/**
 * Plans one file a call writes.
 *
 * The front runs without authentication, so a path taken from the caller would
 * write anywhere the front's user can write, with page-controlled content. The
 * directory is therefore the front's decision and the caller names at most the
 * file: a name that is not a plain file name with the ending the tool enforces
 * is refused rather than bent into one, so nobody believes their path was
 * honoured. A caller that names none gets a name of the front's own.
 *
 * A caller's name never reaches the daemon. The daemon writes to `writePath`, a
 * name the front builds itself with eight random characters, and the written
 * file is renamed onto the caller's name afterwards. That is what keeps the
 * write inside the directory: the drive is writable over Samba and NFS, so
 * anyone reaching it can put a symlink or a hardlink under a name a caller
 * announced, and a check the front makes here says nothing about the entry the
 * daemon meets a moment later, in another process. Against the random name there
 * is nothing to plant, and `rename` replaces the name rather than writing
 * through what sits under it, so no interleaving reaches an inode outside
 * `OUTPUT_DIR`. A file the front names itself is written straight where the
 * answer points, since there is nothing to plant under that name either.
 *
 * The checks below are pre-flight only: they turn the ordinary mistake — a name
 * that is a directory today, a name someone hardlinked — into a clear 400 before
 * the browser is driven at all. They are no longer the boundary, and an entry
 * planted after them is replaced by the rename rather than refused.
 */
async function planOutputFile(command, argument, spec, resolved, toolArgs) {
  const extensions = extensionsOf(command, spec, toolArgs);
  const requested = toolArgs[argument];

  if (requested === undefined) {
    const fileName = generatedFileName(resolved.target, extensions[0]);
    const filePath = path.join(OUTPUT_DIR, fileName);
    return {
      ...spec,
      argument,
      fileName,
      filePath,
      writePath: filePath,
    };
  }

  const extension = extensions.find(candidate =>
    requested.endsWith(`.${candidate}`),
  );
  if (!PLAIN_FILE_NAME_PATTERN.test(requested) || extension === undefined) {
    throw new CallError(
      'usage',
      `${command}: ${argument} must be a plain file name of at most ` +
        `${MAX_FILE_NAME_LENGTH} characters ending in ` +
        `${extensions.map(candidate => `.${candidate}`).join(' or ')} — the ` +
        `front writes it to ${OUTPUT_DIR} and no path leaves that directory`,
    );
  }

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
  claimOutputName(command, argument, requested, resolved);

  return {
    ...spec,
    argument,
    fileName: requested,
    filePath,
    claimed: true,
    writePath: path.join(
      OUTPUT_DIR,
      generatedFileName(resolved.target, extension),
    ),
  };
}

/**
 * Plans the directory a call fills with files it names itself.
 *
 * The names inside are the tool's, not the front's, so two calls sharing one
 * directory would write over each other and neither file would be one the fetch
 * route recognises. Each call therefore gets a directory of its own, whose name
 * carries the same eight random characters every generated name does, and the
 * files are taken out of it afterwards. The whole location is the front's
 * business here: a caller-named directory would be a location the caller may not
 * reach, so the argument is refused instead of being silently overwritten.
 */
async function planOutputDirectory(command, argument, spec, target, toolArgs) {
  if (toolArgs[argument] !== undefined) {
    throw new CallError(
      'usage',
      `${command}: ${argument} is not a caller argument — the front collects ` +
        `the files into ${OUTPUT_DIR} and returns their locations`,
    );
  }
  const directoryPath = path.join(OUTPUT_DIR, generatedName(target));
  try {
    await fs.mkdir(directoryPath, {mode: STAGING_DIR_MODE});
  } catch (error) {
    throw new CallError(
      'storage',
      `cannot create ${directoryPath}`,
      error.message,
    );
  }
  return {argument, path: directoryPath, reports: spec.reports, target};
}

/**
 * Plans one file or directory a call reads.
 *
 * It has to lie directly in `OUTPUT_DIR`, so the caller names it and nothing
 * else: the directory is the network drive every machine reaches, which is how a
 * file gets to the front's machine at all, and a path from the caller would
 * otherwise read anything the front's user can read.
 *
 * A file that is uploaded into a page is copied to a staging name first and the
 * daemon is handed the copy. That is the same reasoning as for a written file,
 * in the other direction: an entry someone plants under the announced name
 * between this check and the daemon's open would otherwise be followed out of
 * the directory, and what a page then receives is whatever that entry pointed
 * at. The copy is read through a handle this process opened itself, with
 * symlinks refused by the open and a hardlink refused by the count on the open
 * handle, so what is uploaded is the file this check saw.
 *
 * A directory and a heap snapshot are read in place: a snapshot is hundreds of
 * megabytes and is addressed by its path again by every following reader call,
 * so the check here is pre-flight and stays what it is — it catches the ordinary
 * mistake, not someone with write access to the share swapping the entry
 * underneath the call.
 */
async function planInputFile(command, argument, spec, target, toolArgs) {
  const requested = toolArgs[argument];
  const endings = extensionsOf(command, spec, toolArgs);
  if (
    !PLAIN_FILE_NAME_PATTERN.test(requested) ||
    (endings.length > 0 &&
      !endings.some(candidate => requested.endsWith(`.${candidate}`)))
  ) {
    throw new CallError(
      'usage',
      `${command}: ${argument} must be a plain name of at most ` +
        `${MAX_FILE_NAME_LENGTH} characters` +
        (endings.length > 0
          ? ` ending in ${endings.map(candidate => `.${candidate}`).join(' or ')}`
          : '') +
        ` of an entry in ${OUTPUT_DIR} — that directory is the drive every ` +
        'machine reaches, and no path leaves it',
    );
  }

  const filePath = path.join(OUTPUT_DIR, requested);
  let stats;
  try {
    stats = await fs.lstat(filePath);
  } catch (error) {
    throw new CallError(
      'usage',
      `${command}: there is no ${requested} in ${OUTPUT_DIR}`,
      error.message,
    );
  }
  if (spec.direction === 'in-dir') {
    if (!stats.isDirectory()) {
      throw new CallError(
        'usage',
        `${command}: ${requested} in ${OUTPUT_DIR} is not a directory`,
      );
    }
    return {argument, filePath, readPath: filePath};
  }
  if (!stats.isFile()) {
    throw new CallError(
      'usage',
      `${command}: ${requested} in ${OUTPUT_DIR} is not a regular file`,
    );
  }
  if (stats.nlink !== 1) {
    throw new CallError(
      'usage',
      `${command}: ${requested} in ${OUTPUT_DIR} exists under more than one name`,
    );
  }
  if (!spec.staged) {
    return {argument, filePath, readPath: filePath};
  }
  return await stageInputFile(command, argument, target, requested, filePath);
}

/**
 * Copies the file a call is to read into a directory of its own and hands back
 * the copy. The name inside the directory stays the caller's, because that is
 * the name a page receiving an upload is shown.
 */
async function stageInputFile(command, argument, target, fileName, filePath) {
  const directoryPath = path.join(OUTPUT_DIR, generatedName(target));
  const readPath = path.join(directoryPath, fileName);
  let handle;
  try {
    await fs.mkdir(directoryPath, {mode: STAGING_DIR_MODE});
    handle = await fs.open(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1) {
      throw new Error('not a single-named regular file of this directory');
    }
    await pipeline(
      handle.createReadStream(),
      createWriteStream(readPath, {flags: 'wx', mode: OUTPUT_FILE_MODE}),
    );
  } catch (error) {
    await removeStagingDirectory(directoryPath);
    throw new CallError(
      'usage',
      `${command}: ${argument} ${fileName} cannot be read from ${OUTPUT_DIR}`,
      error.message,
    );
  } finally {
    await handle?.close();
  }
  return {argument, filePath, readPath, directoryPath};
}

/** Removes a staging directory and everything left in it; best effort. */
async function removeStagingDirectory(directoryPath) {
  try {
    await fs.rm(directoryPath, {recursive: true, force: true});
  } catch {
    // Not this process's to remove: the call's own outcome is what counts.
  }
}

/** What one call writes and reads, from its arguments and the table above. */
async function planCall(command, resolved, toolArgs) {
  const specs = FILE_ARGUMENTS[command];
  const plan = {command, files: [], inputs: [], directory: undefined};
  if (!specs) {
    return plan;
  }

  await ensureOutputDir();
  try {
    for (const [argument, spec] of Object.entries(specs)) {
      const named = toolArgs[argument] !== undefined;
      if (spec.direction === 'out-dir') {
        plan.directory = await planOutputDirectory(
          command,
          argument,
          spec,
          resolved.target,
          toolArgs,
        );
      } else if (spec.direction === 'out') {
        if (named || spec.always) {
          plan.files.push(
            await planOutputFile(command, argument, spec, resolved, toolArgs),
          );
        }
      } else if (named) {
        plan.inputs.push(
          await planInputFile(
            command,
            argument,
            spec,
            resolved.target,
            toolArgs,
          ),
        );
      }
    }
  } catch (error) {
    // A call whose plan does not come together drives nothing, so what an
    // earlier argument of it already put on the drive goes again, and the names
    // it had taken are free for the next call.
    await settleLeftoverFiles(plan);
    await removeStagedInputs(plan);
    releaseOutputNames(plan);
    throw error;
  }

  // The echoed argument is the path the caller ends up with; what the daemon is
  // handed is the staging path beside it. The directory of a call is gone by the
  // time the answer is written, so it is echoed to nobody.
  for (const entry of [...plan.files, ...plan.inputs]) {
    toolArgs[entry.argument] = entry.filePath;
  }
  return plan;
}

/** The paths the daemon is handed in place of the echoed ones. */
function daemonPathArguments(plan) {
  const paths = {};
  for (const file of plan.files) {
    paths[file.argument] = file.writePath;
  }
  for (const input of plan.inputs) {
    paths[input.argument] = input.readPath;
  }
  if (plan.directory) {
    paths[plan.directory.argument] = plan.directory.path;
  }
  return paths;
}

/**
 * Every path of one call that exists for this process only, each with the path
 * the answer names in its place: the staging name a file is written under, the
 * copy an upload is read from, and the recording of that browser, whose staging
 * file is still being written while other calls run.
 */
function stagingReplacements(plan, sessionId) {
  const pairs = plan.files.map(file => [file.writePath, file.filePath]);
  for (const input of plan.inputs) {
    pairs.push([input.readPath, input.filePath]);
  }
  const recording = recordings.get(sessionId);
  if (recording) {
    pairs.push([recording.writePath, recording.filePath]);
  }
  return pairs;
}

/**
 * Turns a failed call into a storage failure when the daemon choked on a file
 * rather than on the page. A write that fails is an outage of the network drive
 * and must not read as a browser that could not carry the command out.
 *
 * The reason a failure carries is the daemon's own text, and the daemon only
 * ever saw the staging paths, so it is the text that names them; they are
 * exchanged for the paths the answer names, here as everywhere else.
 */
function reclassifyFileFailure(error, plan, sessionId) {
  if (!(error instanceof CallError) || error.kind !== 'tool') {
    return error;
  }
  const written = [
    ...plan.files,
    ...(plan.directory
      ? [
          {
            kind: 'report directory',
            writePath: plan.directory.path,
            filePath: plan.directory.path,
          },
        ]
      : []),
  ];
  const detail =
    typeof error.detail === 'string'
      ? error.detail
      : JSON.stringify(error.detail ?? '');
  const clean = withFinalPaths(detail, stagingReplacements(plan, sessionId));
  const hit = written.find(file => detail.includes(file.writePath));
  if (hit) {
    return new CallError(
      'storage',
      `${hit.kind} could not be written to ${hit.filePath}`,
      clean,
    );
  }
  if (detail.includes(OUTPUT_DIR)) {
    return new CallError(
      'storage',
      `${plan.command} could not write below ${OUTPUT_DIR}`,
      clean,
    );
  }
  if (clean === detail) {
    return error;
  }
  return new CallError(error.kind, error.message, clean);
}

/**
 * Deals with what a failed call left behind. A call that hits its deadline or
 * fails after a write still leaves the daemon's 0600 file on the drive.
 *
 * A file the front named itself is written straight under the name the answer
 * would have carried, so a partial one stays and is only made readable: a file
 * only the front's uid can read is of no use to an NFS client arriving under its
 * own. A caller-named file is written under a name of the front's own that is
 * renamed onto the caller's only on success; a failed one therefore sits under a
 * name no answer mentioned and no route serves, and is removed instead of left
 * on the drive for good. A directory of a call is removed with what is in it,
 * since none of it was ever named in an answer.
 *
 * Best effort by design: a call that failed before the write leaves nothing
 * here, and neither a chmod nor an unlink that fails must displace the failure
 * being reported to the caller.
 */
async function settleLeftoverFile(file) {
  try {
    if (file.writePath === file.filePath) {
      await fs.chmod(file.writePath, OUTPUT_FILE_MODE);
    } else {
      await fs.unlink(file.writePath);
    }
  } catch {
    // No file written, or one this process cannot touch.
  }
}

async function settleLeftoverFiles(plan) {
  for (const file of plan.files) {
    await settleLeftoverFile(file);
  }
  if (plan.directory) {
    await removeStagingDirectory(plan.directory.path);
  }
}

/** Removes the copies a call was handed to read. */
async function removeStagedInputs(plan) {
  for (const input of plan.inputs) {
    if (input.directoryPath) {
      await removeStagingDirectory(input.directoryPath);
    }
  }
}

/**
 * Where a file is to be found. Every file carries a fetch URL: the client is
 * bash and curl, so the share path presumes a mount it may not have while the
 * URL is reachable wherever the call itself was sent from.
 */
function fileLocation(fileName, filePath, publicBase) {
  return {
    file: fileName,
    path: filePath,
    share_path: path.relative(SHARE_ROOT, filePath),
    url: fileUrl(publicBase, fileName),
  };
}

/**
 * Confirms the file the daemon was told to write really is there and makes it
 * readable for everyone reaching the drive, puts it under the name the answer
 * carries and describes it. A tool call that reports success without a file on
 * disk is a storage failure, not a result — unless the tool writes that file
 * only when the page had the content for it, in which case its absence is
 * reported as no file at all.
 *
 * The rename is what a caller-named file arrives through, and it is the last
 * step: an entry someone put under that name meanwhile is replaced, since
 * `rename` acts on the name and not on what it points at.
 */
async function describeWrittenFile(file, publicBase) {
  let stats;
  try {
    stats = await fs.stat(file.writePath);
    if (!stats.isFile() || stats.size === 0) {
      throw new Error(`${stats.size} bytes`);
    }
    await fs.chmod(file.writePath, OUTPUT_FILE_MODE);
    if (file.writePath !== file.filePath) {
      await fs.rename(file.writePath, file.filePath);
    }
  } catch (error) {
    if (file.optional) {
      await settleLeftoverFile(file);
      return undefined;
    }
    throw new CallError(
      'storage',
      `${file.kind} was not written to ${file.filePath}`,
      // The staging name is this process's business and names nothing a caller
      // can fetch, so it does not travel out in the reason either.
      withFinalPaths(String(error.message), [[file.writePath, file.filePath]]),
    );
  }

  return {
    ...fileLocation(file.fileName, file.filePath, publicBase),
    bytes: stats.size,
  };
}

/**
 * Takes the files a call left in its own directory out of it, under names the
 * fetch route serves, and removes the directory. A report the tool did not write
 * is not one the answer names.
 */
async function collectDirectoryFiles(directory, publicBase) {
  const collected = [];
  for (const [name, kind] of Object.entries(directory.reports)) {
    const source = path.join(directory.path, name);
    const fileName = generatedFileName(directory.target, reportExtension(name));
    const filePath = path.join(OUTPUT_DIR, fileName);
    let stats;
    try {
      stats = await fs.stat(source);
      await fs.chmod(source, OUTPUT_FILE_MODE);
      await fs.rename(source, filePath);
    } catch {
      continue;
    }
    collected.push({
      kind,
      source,
      descriptor: {
        ...fileLocation(fileName, filePath, publicBase),
        bytes: stats.size,
      },
    });
  }
  await removeStagingDirectory(directory.path);
  return collected;
}

/**
 * The recording each browser has running, keyed by session id. A screencast is
 * the one file that is not there when the call that names it returns: ffmpeg
 * writes it until `screencast_stop`, which takes no path of its own. The plan is
 * therefore kept until then, so the stopping call can put the file under the
 * name the starting call announced and describe it.
 *
 * One plan belongs to one recording, and it goes when that recording can no
 * longer be running: with every `screencast_stop`, whether the stop succeeded or
 * failed, and with every new daemon generation, since ffmpeg is the daemon's
 * child and dies with it. A plan that outlived its recording would otherwise be
 * described by the next stop — a file that nobody wrote, under the name of a
 * recording that had ended long before.
 *
 * A start the daemon refuses because one is already running comes back as a
 * successful call carrying an error line. Nothing will be written to the plan of
 * that call, so the entry already there is kept and it is that entry the answer
 * names: the file the running recording goes to is the one this caller will get.
 */
const recordings = new Map();

/** The command that finishes a recording. */
const RECORDING_STOP_COMMAND = 'screencast_stop';

/**
 * Drops the plan of a recording that can no longer be running and settles what
 * it left: on the ordinary path the stopping call has already renamed the file
 * onto the caller's name and there is nothing under the staging one, on every
 * other path the staging file is what a recording nobody will ever be told about
 * would sit in.
 */
async function forgetRecording(sessionId) {
  const recording = recordings.get(sessionId);
  if (recording === undefined) {
    return;
  }
  recordings.delete(sessionId);
  recording.retained = false;
  releaseOutputName(recording);
  await settleLeftoverFile(recording);
}

/**
 * Describes the files one finished call left behind and says which staging path
 * in its result is which final one.
 *
 * Every path of the call is exchanged, whether or not a file was written under
 * it: the staging name is this process's business, a caller can neither fetch it
 * nor do anything with it, and a tool that names back the path it was handed
 * must not be quoted naming it. The two exchanges the plan alone does not say
 * come first — the file a call's own directory is emptied into, and the
 * recording a refused start is told about, which is the one already running and
 * not the one this call planned.
 */
async function describeCallFiles(plan, resolved, command, publicBase) {
  const descriptors = {};
  const replacements = [];

  for (const file of plan.files) {
    if (file.deferred) {
      const running = recordings.get(resolved.sessionId);
      const started = running ?? file;
      if (running === undefined) {
        file.retained = true;
        recordings.set(resolved.sessionId, file);
      }
      descriptors[file.kind] = {
        ...fileLocation(started.fileName, started.filePath, publicBase),
        pending: true,
      };
      replacements.push([file.writePath, started.filePath]);
      continue;
    }
    const described = await describeWrittenFile(file, publicBase);
    if (described) {
      descriptors[file.kind] = described;
    }
  }

  if (plan.directory) {
    for (const collected of await collectDirectoryFiles(
      plan.directory,
      publicBase,
    )) {
      descriptors[collected.kind] = collected.descriptor;
      replacements.push([collected.source, collected.descriptor.path]);
    }
  }

  if (command === RECORDING_STOP_COMMAND) {
    const recording = recordings.get(resolved.sessionId);
    if (recording) {
      // A recording the front promised and that is not on disk, or is on disk
      // with nothing in it, fails the call: the caller asked for that file, and
      // the answer would otherwise report a success for a name leading nowhere.
      descriptors[recording.kind] = await describeWrittenFile(
        recording,
        publicBase,
      );
    }
  }

  replacements.push(...stagingReplacements(plan, resolved.sessionId));
  return {descriptors, replacements};
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
  const fileName = generatedFileName(target, SPILL_EXTENSION);
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
    ...fileLocation(fileName, filePath, publicBase),
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

/**
 * Puts the paths of the answer right. A tool names back the path it was handed,
 * which is the front's staging name and is gone a moment later; it names it in
 * its structured fields and in its own response lines alike, so the exchange is
 * made on the rendered result rather than field by field. Every path the front
 * builds is made of the output directory and a generated name, so neither side
 * of the exchange carries anything JSON escapes.
 */
function withFinalPaths(rendered, replacements) {
  let result = rendered;
  for (const [writePath, filePath] of replacements) {
    if (writePath !== filePath) {
      result = result.split(writePath).join(filePath);
    }
  }
  return result;
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
    const spill =
      Buffer.byteLength(rendered) > SPILL_BYTES
        ? await spillResult(resolved.target, rendered, publicBase)
        : undefined;
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
