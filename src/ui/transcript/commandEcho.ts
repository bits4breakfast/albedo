/**
 * The echo of a command Albedo sent from a button (#384), per task, in memory
 * only.
 *
 * Claude Code writes a slash command to the transcript only once it has run
 * it. For `/model` or `/rename` that is a second; for `/compact` it is the
 * whole compaction (measured on 2.1.31x: nothing for 80 s, then the boundary,
 * the summary, the `/compact` envelope stamped at the *start*, and
 * "Compacted"). Until then the task looked as if nothing had been sent. The
 * message box has shown its own sends at once for a long time (the pane's
 * `echo`); this does the same for the buttons.
 *
 * Everything here comes from Albedo's own record of what it sent (send.ts
 * tells every write, and the button that made it) and from the transcript.
 * Nothing is read from the terminal, so a `/compact` typed there, or one
 * Claude Code starts on its own, still shows only when it ends.
 *
 *  - A command sent by a button (`sendToSession(…, from)`) echoes at once,
 *    "from Compact Now". A `/compact` echoes however Albedo sent it -- the
 *    message box, the outbox's release -- because only the echo says it is
 *    running; without a button it has no "from".
 *  - It ends when the transcript has it (`commandLanded`): the `user` row or
 *    the `system` local-command line it writes, the first row of the new
 *    session for `/clear`, and for `/compact` the compaction itself.
 *  - Past `COMMAND_ECHO_MAX_MS` (`COMPACT_MAX_MS` for `/compact`) with
 *    nothing landed it stays, marked `noReply`, rather than vanish as if it
 *    had worked.
 *  - It ends with the task's pty, and when a later echo replaces it.
 *
 * While a `/compact` is echoed and not past its limit the task is
 * compacting (`isCompacting`): the task row says so, and Compact Now and
 * Clear are not offered (ClearContextButton.tsx). UI state only: the task's
 * stored status is the transcript's, as ever.
 */

import { useSyncExternalStore } from 'react';
import type { Message } from '../../types';
import { compactBoundaryOf, endsLocalCommand, isLocalCommandLine, onCaptureUpdate } from '../../capture';
import { mainRowsSince } from '../../db';
import { onPtyPresenceChange } from '../Terminal';
import { isPromptRow } from './compaction';
import { onSessionSubmit, type SendSource } from './send';
import { onTurnChange, sessionOfTask } from './turn';

/** How long a command waits to land before its echo says there was no reply. */
export const COMMAND_ECHO_MAX_MS = 30_000;
/**
 * The same for `/compact`, which writes nothing until it is done: 80 s was
 * measured on a 148k-token session; ten minutes leaves room for a large one.
 */
export const COMPACT_MAX_MS = 10 * 60_000;
/** A row stamped in the same instant as the send still counts as after it. */
const SLACK_MS = 1_000;

export interface CommandEcho {
  /** What was written, as sent. */
  text: string;
  /** The button that sent it; null for a `/compact` sent from elsewhere in Albedo. */
  from: SendSource | null;
  /** When the write finished, ms. */
  at: number;
  /** It is a `/compact`: it lands as a compaction, and runs until then. */
  compact: boolean;
  /** Past its limit with nothing in the transcript. */
  noReply: boolean;
}

/** `/compact`, with or without instructions after it. */
export function isCompactCommand(text: string): boolean {
  return /^\/compact(\s|$)/.test(text.trim());
}

/**
 * Whether the transcript now has the message just sent: a row of the main
 * session written no earlier than the send, with a second of slack for a row
 * stamped in the same instant.
 *
 * A prompt arrives as a `user` row. A slash command Claude Code runs itself
 * (`/rc`, `/rename`) writes none, only `system` lines for the command and its
 * output; without them the echo of `/rc` sat below later rows as "Sending"
 * until it timed out (#113). `isPromptRow` stays "a user row someone sent".
 */
export function echoLanded(echo: { at: number }, messages: readonly Message[]): boolean {
  return messages.some(
    (m) =>
      m.agentId === null &&
      m.ts >= echo.at - SLACK_MS &&
      (isPromptRow(m) || (m.role === 'system' && isLocalCommandLine(m.rawJson))),
  );
}

/**
 * Whether the transcript has the command an echo stands for. Any command but
 * `/compact` as `echoLanded` says.
 *
 * `/compact` lands as a compaction boundary written after the send, or as the
 * line that closes the command (`endsLocalCommand`: "Compacted", or what it
 * printed when it could not compact). Never as its envelope: it is stamped at
 * the start, and something else could carry a time after the send while the
 * compaction runs.
 */
export function commandLanded(echo: Pick<CommandEcho, 'at' | 'compact'>, messages: readonly Message[]): boolean {
  if (!echo.compact) return echoLanded(echo, messages);
  return messages.some(
    (m) =>
      m.agentId === null &&
      m.ts >= echo.at - SLACK_MS &&
      ((m.role === 'system' && compactBoundaryOf(m.rawJson) !== null) || endsLocalCommand(m.rawJson)),
  );
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const echoes = new Map<number, CommandEcho>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<(taskId: number) => void>();

/** The task's echo, or null. */
export function commandEchoFor(taskId: number): CommandEcho | null {
  return echoes.get(taskId) ?? null;
}

/** A `/compact` Albedo sent to the task is running: echoed, and not past its limit. */
export function isCompacting(taskId: number): boolean {
  const e = echoes.get(taskId);
  return e !== undefined && e.compact && !e.noReply;
}

/** Called with the task whose echo changed. */
export function onCommandEchoChange(cb: (taskId: number) => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** {@link commandEchoFor}, re-rendering when it changes. */
export function useCommandEcho(taskId: number | null): CommandEcho | null {
  return useSyncExternalStore(
    onCommandEchoChange,
    () => (taskId === null ? null : commandEchoFor(taskId)),
    () => null,
  );
}

/** {@link isCompacting}, re-rendering when it changes. */
export function useCompacting(taskId: number | null): boolean {
  return useSyncExternalStore(
    onCommandEchoChange,
    () => (taskId === null ? false : isCompacting(taskId)),
    () => false,
  );
}

function set(taskId: number, next: CommandEcho | null): void {
  const t = timers.get(taskId);
  if (t !== undefined) clearTimeout(t);
  timers.delete(taskId);
  if (next === null) {
    if (!echoes.has(taskId)) return;
    echoes.delete(taskId);
  } else {
    echoes.set(taskId, next);
    listen();
    if (!next.noReply) {
      const at = next.at;
      timers.set(
        taskId,
        setTimeout(
          () => {
            timers.delete(taskId);
            const now = echoes.get(taskId);
            if (now && now.at === at) set(taskId, { ...now, noReply: true });
          },
          next.compact ? COMPACT_MAX_MS : COMMAND_ECHO_MAX_MS,
        ),
      );
    }
  }
  for (const cb of [...listeners]) cb(taskId);
}

/**
 * The echo sent at `at` has landed: the pane saw its row. Ignored when a
 * newer echo has replaced it since.
 */
export function commandEchoLanded(taskId: number, at: number): void {
  if (echoes.get(taskId)?.at === at) set(taskId, null);
}

/**
 * Text was written to the task's session. A command a button named, or any
 * `/compact`, echoes from now, replacing whatever echo was there. Anything
 * else is the message box's or the outbox's, which the pane echoes itself:
 * it ends an echo that had no reply, since the session has moved on past
 * it, and leaves one still on its way alone.
 */
function written(taskId: number, text: string, from?: SendSource): void {
  const compact = isCompactCommand(text);
  if (from === undefined && !compact) {
    if (echoes.get(taskId)?.noReply) set(taskId, null);
    return;
  }
  set(taskId, { text, from: from ?? null, at: Date.now(), compact, noReply: false });
}

/** Tasks whose rows are being read, and those to read again once that is done. */
const checking = new Set<number>();
const recheck = new Set<number>();

/**
 * Read the rows written since the echo's send and end it if its command is
 * among them. For a task the pane is not showing, this is the only check;
 * for the one on screen the pane usually gets there first.
 */
async function check(taskId: number): Promise<void> {
  if (checking.has(taskId)) {
    recheck.add(taskId);
    return;
  }
  const echo = echoes.get(taskId);
  if (!echo) return;
  checking.add(taskId);
  try {
    const rows = await mainRowsSince(taskId, sessionOfTask(taskId), echo.at - SLACK_MS);
    if (commandLanded(echo, rows)) commandEchoLanded(taskId, echo.at);
  } catch {
    /* the watcher may be mid-write; the next update asks again */
  } finally {
    checking.delete(taskId);
    if (recheck.delete(taskId)) void check(taskId);
  }
}

let offs: (() => void)[] | null = null;

/** Hear what can end an echo, from the first one on. */
function listen(): void {
  if (offs !== null) return;
  offs = [
    onPtyPresenceChange((taskId, live) => {
      if (!live) set(taskId, null);
    }),
    // Any session: after `/clear` the task's rows come from a new one.
    onCaptureUpdate(() => {
      for (const taskId of echoes.keys()) void check(taskId);
    }),
    // The task moved to that session (turn.ts hears it): its rows may have
    // been read before they were linked, with nothing written since.
    onTurnChange((taskId) => {
      if (echoes.has(taskId)) void check(taskId);
    }),
  ];
}

// Every write to a session, whichever path made it, comes through send.ts.
onSessionSubmit(written);

/** Test seam: put an echo on a task without the send that leads there. */
export function __setCommandEcho(taskId: number, echo: CommandEcho | null): void {
  set(taskId, echo);
}

/** Test seam. */
export function __resetCommandEchoes(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  echoes.clear();
  checking.clear();
  recheck.clear();
  for (const off of offs ?? []) off();
  offs = null;
}
