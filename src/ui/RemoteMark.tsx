/**
 * "Remote": the task's session can be reached through Remote Control, from the
 * phone or claude.ai (#114). On the task row and in the task bar; a click
 * opens the session there.
 *
 * Read from the transcript, never from the terminal: turning it on writes a
 * "Remote Control is active" line carrying the session's link
 * (`remoteControlUrlOf`, capture/adapter.ts). Nothing is written when it goes
 * off; it ends with the claude process. So it counts as on only while the
 * task has a live pty and that line was written in the task's current session
 * at or after the pty was spawned. Not measured: whether a second
 * `/remote-control` inside the session turns it off. If it does, the mark
 * stays until the session ends.
 */

import { useEffect, useState, type ReactNode } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { onCaptureUpdate } from '../capture';
import { remoteControlUrlSince } from '../db';
import { openExternal } from '../lib/openUrl';
import { safeHttpUrl } from '../lib/urls';
import type { Task } from '../types';
import type { OverflowItem } from './OverflowMenu';
import { sendPrompt } from './sendPrompt';
import { usePtyLiveSince } from './Terminal';
import './remote.css';

/** What the ⋯ item sends: the command as typed in Claude Code. */
export const REMOTE_CONTROL_COMMAND = '/remote-control';

export const REMOTE_TITLE = 'Available through Remote Control. Open on claude.ai';

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
      remoteControlUrlSince(sessionId, liveSince).then(
        (url) => {
          if (alive) setFound({ key, url: url === null ? null : safeHttpUrl(url) });
        },
        () => {
          /* unknown, which shows nothing */
        },
      );
    };
    look();
    const off = onCaptureUpdate((u) => {
      if (u?.sessionId !== sessionId) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        look();
      }, COALESCE_MS);
    });
    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
      off();
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
  return <RemoteLink url={useRemoteControlUrl(task)} variant={variant} />;
}

/** {@link RemoteMark} for a caller that already looked the link up. */
export function RemoteLink({ url, variant }: { url: string | null; variant: 'row' | 'bar' }): ReactNode {
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
 * nothing to do: no live pty (no session to send it to), or already on.
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
  if (!live || url !== null) return null;
  return {
    id: 'remote-control',
    label: 'Make Available Remotely',
    aside: REMOTE_CONTROL_KEYS,
    title: 'Send /remote-control: continue this session on your phone or on claude.ai',
    onSelect: () => void send(task, REMOTE_CONTROL_COMMAND),
  };
}
