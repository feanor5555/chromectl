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
 * This file is the routing and the composition of one call: it reads the
 * request, hands the call to the modules that own its parts — the target to
 * `registry.mjs`, the command and its arguments to `commands.mjs`, admission to
 * `admission.mjs`, the files to `fileplan.mjs` and `fileresult.mjs`, the daemon
 * and the invocation to `daemon.mjs` — and puts their answers into one
 * envelope.
 *
 * The target registry is read from `CHROMECTL_TARGETS`, by default from
 * `~/.claude/chromectl/targets.json`; without it the front refuses to start.
 *
 * Start by hand:
 *   node /home/wu/chromectl/chromectl/front.mjs
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

import {queuedCallBudgetMs} from '../build/src/pacing.js';

import {assertAdmissible, registerCall, unregisterCall} from './admission.mjs';
import {
  assertKnownCommand,
  COMMANDS,
  validateArgs,
  validateFullSpeed,
} from './commands.mjs';
import {assertTargetReachable, runCommand} from './daemon.mjs';
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
  echoedArguments,
  planCall,
  releaseOutputNames,
  removeStagedInputs,
  settleLeftoverFiles,
} from './fileplan.mjs';
import {
  concludeCall,
  describeCallFiles,
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

/**
 * What a caller has to grant on top of the deadline the front sets itself, so
 * that the front's timer is the one that fires and the caller learns the
 * outcome instead of guessing it: the reachability probe, a daemon start or
 * replacement and the writing of the answer all sit outside that deadline. A
 * caller whose own timeout fired first would report a call as failed while it
 * is still typing into the page, and a retry would type the text twice.
 */
const CLIENT_TIMEOUT_HEADROOM_MS = 30_000;

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
  // looked up where every machine can put one.
  const plan = await planCall(command, resolved, toolArgs);
  // What the answer says the call was given: the paths the caller ends up with.
  // What the daemon is handed are the staging paths beside them.
  const echoedArgs = echoedArguments(plan, toolArgs);
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
      described = await describeCallFiles(plan, resolved, publicBase);
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
      args: echoedArgs,
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
    // Whatever the call leaves running is ended where that is known: the front
    // hands the plan over and never learns what a recording is.
    await concludeCall(plan, resolved);
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
