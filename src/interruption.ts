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
 * A dialog is not the only thing that can leave a command unanswered — a
 * renderer caught in a loop, a native file chooser holding the page and a
 * crashed process all do, and none of them raises an event anyone here is
 * listening for. Every dispatch is therefore raced against
 * `DISPATCH_DEADLINE_MS` as well, which is the bound the connection used to
 * carry for every command of the process. The connection keeps a far wider one,
 * because a tool may legitimately grant a single command a long window; what may
 * not last that long is an interaction dispatched at a page.
 *
 * Both are ambient rather than arguments, because the paced helpers hold a
 * keyboard and a mouse and nothing that could reach the page or its session.
 * Calls serialize on the process-wide tool mutex, so one of each at a time is
 * the whole truth here — the same reason the pace profile is held this way.
 */

import {DISPATCH_DEADLINE_MS} from './pacing.js';

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

/** How one dispatch ended: it was answered, or it was given up on. */
type DispatchOutcome = 'answered' | 'blocked' | 'deadline';

/** What a command nobody answered inside the deadline is reported as. */
const UNANSWERED_COMMAND_MESSAGE = `The page did not answer a command within ${DISPATCH_DEADLINE_MS} ms and it was given up on.`;

/**
 * The deadline one dispatch runs against, and the way to take it down again.
 * The timer is cleared on every way out, so a command that was answered leaves
 * nothing pending behind it.
 */
function dispatchDeadline(): {
  expired: Promise<DispatchOutcome>;
  clear: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<DispatchOutcome>(resolve => {
    timer = setTimeout(() => {
      resolve('deadline');
    }, DISPATCH_DEADLINE_MS);
  });
  return {
    expired,
    clear: (): void => {
      clearTimeout(timer);
    },
  };
}

/**
 * Dispatches one command and gives up on it the moment the renderer stops
 * answering or the deadline passes, so a single keystroke cannot hold the
 * browser until the connection's protocol timeout ends it.
 *
 * Nothing can cancel a CDP command, so the abandoned one keeps running: it
 * completes on its own once the dialog is handled, or fails when the connection
 * gives up on it. Either way nobody is waiting for it any more, which is why
 * its failure is caught here — an abandoned command that rejected would
 * otherwise take the process down as an unhandled rejection.
 *
 * The two ways of giving up end differently. A dialog is reported by the stage
 * that watched for it and stops the stream where it stands, so nothing is
 * raised here; a deadline is reported by nobody else, so it ends the
 * interaction with a statement of its own.
 */
export async function abandonIfBlocked(work: Promise<unknown>): Promise<void> {
  let abandoned = false;
  const guarded: Promise<DispatchOutcome> = work.then(
    () => 'answered',
    (error: unknown) => {
      if (!abandoned) {
        throw error;
      }
      return 'answered';
    },
  );
  const blocked = activeBlockSignal;
  const deadline = dispatchDeadline();
  let outcome: DispatchOutcome;
  try {
    const races: Array<Promise<DispatchOutcome>> = [guarded, deadline.expired];
    if (blocked) {
      races.push(blocked.then((): DispatchOutcome => 'blocked'));
    }
    outcome = await Promise.race(races);
  } finally {
    abandoned = true;
    deadline.clear();
  }
  if (outcome === 'deadline') {
    throw new InteractionInterruptedError(UNANSWERED_COMMAND_MESSAGE);
  }
}

/**
 * The same for a round trip whose answer the interaction needs — what a field
 * holds, what state a toggle is in. Giving up on it leaves nothing to go on, so
 * the interaction ends here instead of continuing against a value nobody read,
 * whichever of the two ended the wait.
 */
export async function answerOrAbandon<T>(work: Promise<T>): Promise<T> {
  let abandoned = false;
  const guarded = work.then(
    value => ({value}),
    (error: unknown) => {
      if (!abandoned) {
        throw error;
      }
      return undefined;
    },
  );
  const blocked = activeBlockSignal;
  const deadline = dispatchDeadline();
  let expired = false;
  let answer: {value: T} | undefined;
  try {
    const races: Array<Promise<{value: T} | undefined>> = [
      guarded,
      deadline.expired.then(() => {
        expired = true;
        return undefined;
      }),
    ];
    if (blocked) {
      races.push(blocked.then(() => undefined));
    }
    answer = await Promise.race(races);
  } finally {
    abandoned = true;
    deadline.clear();
  }
  if (expired) {
    throw new InteractionInterruptedError(UNANSWERED_COMMAND_MESSAGE);
  }
  if (!answer) {
    throw new InteractionInterruptedError(
      'The renderer stopped answering while the interaction was being prepared.',
    );
  }
  return answer.value;
}
