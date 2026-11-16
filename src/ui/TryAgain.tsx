/**
 * A turn that stopped on an API error (#338): what to call it, and the one
 * action it offers.
 *
 * The task list's row (Stopped on an Error) and the transcript's error line
 * both draw {@link TryAgainButton}. It sends "try again" to the session, as
 * you would type it, through the one send gateway (transcript/send.ts) -- the
 * same way Compact Now does, and under the same rules: only while the session
 * is live, and only when a send would go now (`useCommandBlocker`: at rest,
 * nothing held, online). The button is not there without a live session; it
 * is there but disabled, with the reason, while a send would wait.
 */

import type { MouseEvent, ReactNode } from 'react';
import type { ApiErrorKind, Task } from '../types';
import { useCommandBlocker } from './ClearContextButton';
import { usePtyLiveSince } from './Terminal';
import { sendToSession } from './transcript/send';

/** What is sent: the words you would type. */
export const TRY_AGAIN_TEXT = 'try again';

/** The row's short name for each error. Claude Code's own text is the tooltip. */
export const API_ERROR_LABEL: Readonly<Record<ApiErrorKind, string>> = {
  stopped: 'Response stopped arriving',
  slept: 'Computer went to sleep',
  offline: 'Could not reach the API',
  overloaded: 'Overloaded',
  'rate-limited': 'Rate limited',
  'signed-out': 'Not signed in',
  other: 'API error',
};

const HINT = 'Send “try again” to the session';

export function TryAgainButton({ task }: { task: Pick<Task, 'id' | 'status'> }): ReactNode {
  const live = usePtyLiveSince(task.id) !== null;
  const blocker = useCommandBlocker(task);
  if (!live) return null;
  const onClick = (e: MouseEvent) => {
    // On a task row: the click is the button's, not a selection of the row.
    e.stopPropagation();
    if (blocker === null) void sendToSession(task.id, TRY_AGAIN_TEXT);
  };
  return (
    <button type="button" className="btn try-again" disabled={blocker !== null} title={blocker ?? HINT} onClick={onClick}>
      Try Again
    </button>
  );
}
