/**
 * Renaming a task (#152): Albedo's title, and the Claude Code session's name.
 *
 * ## The title
 *
 * `renamedTitle` turns what was typed into the title to save, or null when
 * there is nothing to save: empty or whitespace only (the old title stays),
 * or the same as before. One line, control characters out, trimmed, and at
 * most {@link MAX_TITLE} characters. The branch, the worktree folder and the
 * session id are never touched; `db.renameTask` writes `tasks.title` only.
 *
 * ## The session
 *
 * The session gets the same name through `/rename <title>`, sent the way the
 * ⋯ menu's Remote Control item sends `/remote-control`: through the one send
 * gateway (transcript/send.ts), so it is never typed into a running turn or a
 * dialog.
 *
 *  - **Live, idle:** sent now.
 *  - **Live, a turn running (or messages already held, or offline):** held
 *    in the task's outbox, and sent once the session is idle.
 *  - **Live, a question or permission prompt open:** held in the outbox too.
 *    `sendPrompt` would leave it in the message box instead; a command the
 *    person never typed does not belong in their draft, and the outbox
 *    releases nothing into a prompt.
 *  - **No session yet:** nothing to send. The first spawn passes `--name`
 *    from the task's title (App `sessionNameFor`), which is the new one.
 *  - **A session, not running:** remembered here, and held in the outbox the
 *    moment its pty next goes live -- once, and only the latest title.
 *    Holding it right away would not do: the outbox starts a session that is
 *    not live, and renaming must never start one. Remembered in memory only:
 *    quit Albedo before the session runs again and it keeps its old name.
 *
 * Nothing reads the session's name back into `tasks.title`: the
 * `custom-title` line `/rename` writes is a transcript title only
 * (adapter.ts `titleOf` -> `transcript_files.title`, for History).
 */

import { holdMessage } from './transcript/outbox';
import { promptOpen } from './transcript/outboxRelease';
import { mustHold, sendToSession } from './transcript/send';
import { hasLivePty, onPtyPresenceChange } from './Terminal';
import type { Task } from '../types';
import type { OverflowItem } from './OverflowMenu';
import { displayName } from './text';

/** Longest title a rename saves. A title made from a prompt can be longer; it is kept until edited. */
export const MAX_TITLE = 200;

/** The keys that start a rename (shortcuts.ts `shift+f6`, `f2`), as the ⋯ item shows them. */
export const RENAME_KEYS = '⇧F6';

/** What a rename changes, and what it does not: on the ⋯ item and the field. */
export const RENAME_HINT =
  'Renames the task in Albedo and its Claude Code session (/rename). The branch and the folder stay as they are.';

/** "Rename Task…" for the task bar's ⋯ menu: opens the name for editing in place. */
export function renameMenuItem(onSelect: () => void): OverflowItem {
  return { id: 'rename', label: 'Rename Task…', aside: RENAME_KEYS, title: RENAME_HINT, onSelect };
}

/** One line: every run of whitespace or control characters is one space, trimmed. */
export function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
}

/**
 * The title to save for `raw`, or null for nothing to save: empty, or no
 * different from `old`. Capped at {@link MAX_TITLE} characters (code points,
 * so an emoji is never cut in half).
 */
export function renamedTitle(raw: string, old: string): string | null {
  const line = oneLine(raw);
  if (line === '') return null;
  const chars = Array.from(line);
  const title = chars.length > MAX_TITLE ? chars.slice(0, MAX_TITLE).join('').trimEnd() : line;
  return title === old ? null : title;
}

/**
 * The slash command that names the session `title`; null when it is empty (a
 * bare `/rename` makes one up). Shortened exactly as the first spawn's
 * `--name` is (App `sessionNameFor`, `displayName`), so the session's name is
 * one function of the task title however it was set -- an @-mention's
 * `session` attribute (#154) relies on that.
 */
export function renameCommand(title: string): string | null {
  const line = oneLine(title);
  return line === '' ? null : `/rename ${displayName(line)}`;
}

/**
 * Where the `/rename` went. `on-start`: no session yet, so the first spawn
 * names it. `pending`: sent once the session next runs. `failed`: nothing went.
 */
export type SessionRenameOutcome = 'sent' | 'held' | 'on-start' | 'pending' | 'failed';

export interface SessionRenameDeps {
  live: (taskId: number) => boolean;
  /** The send gateway would hold it (offline, a turn, messages already held). */
  mustHold: (taskId: number) => boolean;
  /** A question or permission prompt is open: typed now, it would answer it. */
  promptOpen: (taskId: number) => boolean;
  send: (taskId: number, text: string) => Promise<'sent' | 'held' | 'failed'>;
  hold: (taskId: number, text: string) => boolean;
  onLive: (cb: (taskId: number) => void) => () => void;
}

const defaultDeps: SessionRenameDeps = {
  live: hasLivePty,
  mustHold,
  promptOpen: (taskId) => promptOpen(taskId),
  send: sendToSession,
  hold: (taskId, text) => holdMessage(taskId, text) !== null,
  onLive: (cb) =>
    onPtyPresenceChange((taskId, live) => {
      if (live) cb(taskId);
    }),
};

/** Per task, the `/rename` waiting for its session to run again. */
const pending = new Map<number, string>();
let stopWatching: (() => void) | null = null;

function deliver(taskId: number, command: string, deps: SessionRenameDeps): Promise<SessionRenameOutcome> {
  if (!deps.mustHold(taskId) && deps.promptOpen(taskId)) {
    return Promise.resolve(deps.hold(taskId, command) ? 'held' : 'failed');
  }
  return deps.send(taskId, command).catch(() => 'failed' as const);
}

function watch(deps: SessionRenameDeps): void {
  if (stopWatching !== null) return;
  stopWatching = deps.onLive((taskId) => {
    const command = pending.get(taskId);
    if (command === undefined) return;
    pending.delete(taskId);
    if (pending.size === 0) {
      stopWatching?.();
      stopWatching = null;
    }
    // Just started: Claude Code may still be drawing, or showing the trust
    // dialog. The outbox sends it once the session is idle, as any message.
    if (!deps.hold(taskId, command)) console.warn(`[rename] could not queue /rename for task ${taskId}`);
  });
}

/** Name the task's Claude Code session `title`. See the module comment for where it goes. */
export function renameSession(
  task: Pick<Task, 'id' | 'sessionId'>,
  title: string,
  deps: SessionRenameDeps = defaultDeps,
): Promise<SessionRenameOutcome> {
  const command = renameCommand(title);
  if (command === null) return Promise.resolve('failed');
  if (deps.live(task.id)) {
    pending.delete(task.id);
    return deliver(task.id, command, deps);
  }
  if (task.sessionId === null) return Promise.resolve('on-start');
  pending.set(task.id, command);
  watch(deps);
  return Promise.resolve('pending');
}

/** The `/rename` waiting for the task's session, or null. For tests and the UI. */
export function pendingSessionRename(taskId: number): string | null {
  return pending.get(taskId) ?? null;
}

/** Tests only. */
export function __resetSessionRename(): void {
  pending.clear();
  stopWatching?.();
  stopWatching = null;
}

/**
 * A rename, end to end: Albedo's title first, and the session's name only
 * once that is saved, so the two never disagree the other way round.
 * `saveTitle` is useTasks' `rename`. Resolves to where the `/rename` went,
 * or `failed` when the title was not saved (and nothing was sent).
 */
export async function renameTaskAndSession(
  task: Pick<Task, 'id' | 'sessionId'>,
  title: string,
  saveTitle: (id: number, title: string) => Promise<boolean>,
  session: typeof renameSession = renameSession,
): Promise<SessionRenameOutcome> {
  if (!(await saveTitle(task.id, title))) return 'failed';
  const outcome = await session(task, title);
  if (outcome === 'failed') console.warn(`[rename] task ${task.id} renamed in Albedo; /rename could not be sent`);
  return outcome;
}
