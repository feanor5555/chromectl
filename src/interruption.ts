/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What stops a paced stream before it has sent everything it carries.
 *
 * A braked stream reaches the page keystroke by keystroke and press by press,
 * and it lasts far longer than the moment an unpaced one takes, so the page can
 * change under it: an interaction that started a navigation leaves the document
 * the remaining keystrokes were meant for, and a dialog pauses the renderer
 * that would have received them.
 *
 * The two are noticed differently, because they leave the stream in different
 * states. A navigation leaves it running, so it is read between two keystrokes
 * and the stream stops at the next gap. A dialog leaves it stuck: the renderer
 * answers nothing while it is open, and a CDP input command dispatched into it
 * is answered only once someone handles the dialog — so waiting for that
 * command to return means waiting for the connection's protocol timeout, with
 * the browser held all the while. That case therefore needs a signal that
 * arrives while a command is in flight, not a value read between two of them.
 *
 * Both are ambient rather than arguments, because the paced helpers hold a
 * keyboard and a mouse and nothing that could reach the page or its session.
 * Calls serialize on the process-wide tool mutex, so one of each at a time is
 * the whole truth here — the same reason the pace profile is held this way.
 */

/** Why a stream in flight is to stop. */
export type InterruptionReason = 'navigation' | 'dialog';

/**
 * The end of an interaction that was stopped by the page rather than by
 * anything about the element. It carries what happened in its own message, so
 * the tools that report every failure against the element they were given pass
 * it through instead of blaming the element for it.
 */
export class InteractionInterruptedError extends Error {}

/** Reads the current state of the page the stream is typing into. */
export type InterruptionCheck = () => InterruptionReason | undefined;

let activeCheck: InterruptionCheck | undefined;
let activeBlockSignal: Promise<void> | undefined;

/**
 * Puts one check in place and hands back the restore, so the stage that
 * installed it cannot leave it behind for the next one.
 */
export function observeInterruptions(check: InterruptionCheck): () => void {
  const previous = activeCheck;
  activeCheck = check;
  return () => {
    activeCheck = previous;
  };
}

/**
 * The same for the signal that the renderer has stopped answering. It stays in
 * place across everything one action dispatches, the interaction the caller
 * runs last included.
 */
export function observeRendererBlock(blocked: Promise<void>): () => void {
  const previous = activeBlockSignal;
  activeBlockSignal = blocked;
  return () => {
    activeBlockSignal = previous;
  };
}

/**
 * Why the stream in flight is to stop, or nothing while it may go on. Without
 * an installed check nothing is watching and nothing stops.
 */
export function currentInterruption(): InterruptionReason | undefined {
  return activeCheck?.();
}

/**
 * Dispatches one command and gives up on it the moment the renderer stops
 * answering, so a single keystroke cannot hold the browser until the protocol
 * timeout ends it.
 *
 * Nothing can cancel a CDP command, so the abandoned one keeps running: it
 * completes on its own once the dialog is handled, or fails when the connection
 * gives up on it. Either way nobody is waiting for it any more, which is why
 * its failure is caught here — an abandoned command that rejected would
 * otherwise take the process down as an unhandled rejection.
 */
export async function abandonIfBlocked(work: Promise<unknown>): Promise<void> {
  const blocked = activeBlockSignal;
  if (!blocked) {
    await work;
    return;
  }
  let abandoned = false;
  const guarded = work.catch((error: unknown) => {
    if (!abandoned) {
      throw error;
    }
  });
  try {
    await Promise.race([guarded, blocked]);
  } finally {
    abandoned = true;
  }
}
