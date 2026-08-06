/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Which calls the chromectl front lets through to a browser.
 *
 * One map holds the calls running per browser, and the three functions below are
 * the only way to it: a call is held against what is already running, noted while
 * it runs and struck off when it ends. The map is this module's alone, so no
 * other part of the front can read a browser as free while a call of it stands.
 */

import {CallError} from './errors.mjs';

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
 * file — `FILE_ARGUMENTS` in `filearguments.mjs` knows it not. Nor is it a
 * second way onto the page: while one exempt call is in flight the next is
 * refused, so at most one caller ever clears the dialog and none drives the page
 * beside it.
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
export function assertAdmissible(resolved, command) {
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
export function registerCall(resolved, command, budgetMs, client) {
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
export function unregisterCall(resolved, entry) {
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
