/**
 * "Remote": the task's session can be reached through Remote Control, from the
 * phone or claude.ai (#114). On the task row and in the task bar; a click
 * opens the session there.
 *
 * Read from the transcript, never from the terminal (capture/remoteSession.ts):
 * the "Remote Control is active" line `/remote-control` writes, and the link
 * Claude Code writes with the first prompt of each process -- a session
 * resumed with Remote Control on comes back on, and writes only that (#343).
 * Only what was written since the task's live pty was spawned counts: before
 * the first prompt of a resumed process nothing says it is on yet.
 *
 * Between asking for it and either the mark or the menu notice
 * (remoteWait.ts), the same place says "Turning on Remote…" (#343).
 */

import { useEffect, useState, type ReactNode } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { onCaptureUpdate } from '../capture';
import { onRemoteSessionChange, remoteControlSince } from '../capture/remoteSession';
import { openExternal } from '../lib/openUrl';
import { safeHttpUrl } from '../lib/urls';
import type { Task } from '../types';
import type { OverflowItem } from './OverflowMenu';
import { sendPrompt } from './sendPrompt';
import { SEND_FROM } from './transcript/sendFrom';
import { usePtyLiveSince } from './Terminal';
import { noteRemoteAskOutcome, noteRemoteAsked, REMOTE_CONTROL_COMMAND, remoteWaitFor, useRemoteWait } from './remoteWait';
import './remote.css';

export { REMOTE_CONTROL_COMMAND };

export const REMOTE_TITLE = 'Available through Remote Control. Open on claude.ai';

/** While it is asked for and not yet on: the bar's words, and the row's. */
export const REMOTE_PENDING_TEXT = { bar: 'Turning on Remote…', row: 'Remote…' } as const;
export const REMOTE_PENDING_TITLE = 'Turning on Remote Control: sent /remote-control, waiting for Claude Code to say it is on';

/** The shortcut that asks to turn it on (shortcuts.ts, `mod+shift+r`). */
export const REMOTE_CONTROL_KEYS = '⇧⌘R';

/** Bursts of capture events for one session are looked up once (as useTasks does). */
const COALESCE_MS = 250;

/**
 * The session's claude.ai link while Remote Control is on for the task's live
 * pty, else null. Looked up when the pty or session changes and on each
 * capture burst for that session; never while there is no live pty.
 */
export function useRemoteControlUrl(task: Pick<Task, 'id' | 'sessionId'> | null): string | null {
  const taskId = task?.id ?? null;
  const sessionId = task?.sessionId ?? null;
  const liveSince = usePtyLiveSince(taskId);
  const key = taskId === null || sessionId === null || liveSince === null ? null : `${taskId}\n${sessionId}\n${liveSince}`;
  const [found, setFound] = useState<{ key: string; url: string | null } | null>(null);

  useEffect(() => {
    if (key === null || sessionId === null || liveSince === null) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const look = () => {
      remoteControlSince(sessionId, liveSince).then(
        (url) => {
          if (alive) setFound({ key, url: url === null ? null : safeHttpUrl(url) });
        },
        () => {
          /* unknown, which shows nothing */
        },
      );
    };
    look();
    const soon = (sid: string | undefined) => {
      if (sid !== sessionId) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        look();
      }, COALESCE_MS);
    };
    const offs = [onCaptureUpdate((u) => soon(u?.sessionId)), onRemoteSessionChange(soon)];
    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
      for (const off of offs) off();
    };
    // `key` carries everything the lookup reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return key !== null && found?.key === key ? found.url : null;
}

/**
 * The mark itself, or nothing while Remote Control is off. `row` sits in the
 * task row's caption, `bar` in the task bar beside the title.
 */
export default function RemoteMark({ task, variant }: { task: Pick<Task, 'id' | 'sessionId'>; variant: 'row' | 'bar' }): ReactNode {
  return <RemoteLink url={useRemoteControlUrl(task)} variant={variant} pending={useRemotePending(task.id)} />;
}

/** Asked for or sent, and not yet on, nor taken to be the menu (remoteWait.ts). */
export function useRemotePending(taskId: number | null): boolean {
  const wait = useRemoteWait(taskId);
  return wait !== null && wait.phase !== 'menu';
}

/**
 * {@link RemoteMark} for a caller that already looked the link up. While
 * `pending`, with no link yet, a plain word where the mark will be: not a
 * button, there is nothing to open yet.
 */
export function RemoteLink({
  url,
  variant,
  pending = false,
}: {
  url: string | null;
  variant: 'row' | 'bar';
  pending?: boolean;
}): ReactNode {
  if (url === null && pending) {
    return (
      <span className={`remote-mark remote-mark-${variant} remote-mark-pending`} role="status" title={REMOTE_PENDING_TITLE}>
        {REMOTE_PENDING_TEXT[variant]}
      </span>
    );
  }
  if (url === null) return null;
  const open = (e: ReactMouseEvent) => {
    // On the row: opening the session is not selecting the task.
    e.stopPropagation();
    void openExternal(url);
  };
  return (
    <button type="button" className={`remote-mark remote-mark-${variant}`} title={REMOTE_TITLE} aria-label={REMOTE_TITLE} onClick={open}>
      Remote
    </button>
  );
}

/**
 * "Make Available Remotely" for the task's ⋯ menu, or null where it has
 * nothing to do: no live pty (no session to send it to), already on, or
 * already asked for and not settled (`remoteWaitFor`): a second
 * `/remote-control` on a session where it is on opens Claude Code's menu.
 *
 * It sends `/remote-control` the way the buttons send a prompt
 * (`sendPrompt`): through the one send gateway, held in the outbox while a
 * turn runs and released once the session is idle, so the command is never
 * typed into a turn or a dialog. On a waiting prompt with nothing held, it is
 * left in the message box rather than typed into the prompt.
 *
 * ⇧⌘R asks first and then runs this same item (RemoteControlDialog), so it
 * is offered exactly where this is.
 */
export function remoteControlItem(
  task: Pick<Task, 'id' | 'status'>,
  live: boolean,
  url: string | null,
  send: typeof sendPrompt = sendPrompt,
): OverflowItem | null {
  if (!live || url !== null || remoteWaitFor(task.id) !== null) return null;
  return {
    id: 'remote-control',
    label: 'Make Available Remotely',
    aside: REMOTE_CONTROL_KEYS,
    title: 'Send /remote-control: continue this session on your phone or on claude.ai',
    onSelect: () => {
      if (remoteWaitFor(task.id) !== null) return;
      noteRemoteAsked(task.id);
      void send(task, REMOTE_CONTROL_COMMAND, SEND_FROM.remote).then(
        (outcome) => noteRemoteAskOutcome(task.id, outcome),
        () => noteRemoteAskOutcome(task.id, 'failed'),
      );
    },
  };
}
