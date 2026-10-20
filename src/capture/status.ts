/**
 * src/capture/status.ts
 *
 * Task status derived from PERSISTED TRANSCRIPT ROWS ONLY.
 *
 * The pty channel is opaque (CLAUDE.md): nothing here may look at terminal
 * bytes. Every other workstream trusts this function, so the rules below are
 * spelled out and unit-tested one by one.
 *
 * Rule order, highest priority first:
 *
 *   1. a trailing `tool_use` with no matching `tool_result`  -> 'blocked'
 *      (Claude Code writes no "waiting for permission" line; an unanswered
 *      tool call IS the permission prompt.) This wins over everything below,
 *      whatever stop_reason says.
 *   2. the tail is an assistant row whose line ended the turn
 *      (stop_reason 'end_turn' / 'stop_sequence')            -> 'idle'
 *  2b. the tail (isMeta lines aside) closes a local command
 *      such as `/clear` or `/model`                           -> 'idle'
 *   3. activity newer than RUNNING_WINDOW_MS                 -> 'running'
 *   4. tail is an assistant row (turn ended, just too old)   -> 'idle'
 *   5. no rows at all                                        -> 'idle'
 *
 * Rules 2 and 3 are in that order on purpose. Recency alone cannot tell
 * "still working" from "just finished", so ordering recency first made every
 * completed task read `running` for 90 seconds -- a wrong answer to the
 * question this whole app exists to answer. `stop_reason` is the transcript
 * saying explicitly which one it is, so it is consulted first and the recency
 * window is left as the fallback for lines that do not carry the field.
 *
 * 'done' and 'archived' are lifecycle states owned by the user, never derived.
 */

import type { Message, TaskStatus } from '../types';
import {
  endsLocalCommand,
  isMetaLine,
  stopReasonOf,
  toolCallIdOf,
  TURN_ENDING_STOP_REASONS,
} from './adapter';

/** How recent transcript activity must be for a session to read as running. */
export const RUNNING_WINDOW_MS = 90_000;

/**
 * Roles that count as "the session is doing something".
 *
 * `user` is in here deliberately: Claude Code writes the assistant line only
 * once the response is complete, so during a long thinking phase the newest
 * row IS the human's prompt. Leaving `user` out made a session that is very
 * much working report `idle`. A prompt that has genuinely been abandoned ages
 * out of the window like anything else.
 */
export const ACTIVITY_ROLES: ReadonlySet<Message['role']> = new Set([
  'user',
  'assistant',
  'tool_use',
  'tool_result',
]);

type StatusInput = Pick<Message, 'role' | 'seq' | 'ts' | 'rawJson'>;

/**
 * How long a tool call with no result keeps a task `running` when unanswered
 * calls do not mean `blocked`. Far longer than RUNNING_WINDOW_MS: a test suite
 * or a build can run for minutes with nothing written to the transcript. Past
 * this the call is assumed orphaned (the session died), not still working.
 */
export const UNANSWERED_RUNNING_WINDOW_MS = 15 * 60_000;

export interface DeriveOptions {
  /**
   * Whether a tool call with no result yet means `blocked` (rule 1). Default
   * true. A transcript cannot tell a permission prompt from a tool that is
   * simply still running -- both are a call with no result -- so a long test
   * run reads as "waiting on you". Turn this off where something else reports
   * real prompts (the hook events do, see hookEvents.ts) and the call is then
   * just work in progress.
   */
  unansweredToolUseBlocks?: boolean;
}

/**
 * @param messages rows for ONE session/task. Order does not matter; they are
 *                 sorted here by (ts, seq) so a caller cannot get this wrong.
 * @param now      injectable clock, for tests.
 */
export function deriveStatus(
  messages: Message[],
  now: number = Date.now(),
  opts: DeriveOptions = {},
): TaskStatus {
  if (messages.length === 0) return 'idle'; // rule 4

  const rows: StatusInput[] = [...messages].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  const last = rows[rows.length - 1];
  if (!last) return 'idle';

  // rule 1 — takes precedence over stop_reason and over recency alike. An
  // assistant line can say stop_reason 'tool_use' and still be the thing the
  // user has to click Allow on.
  if (hasUnansweredToolUse(rows)) {
    if (opts.unansweredToolUseBlocks !== false) return 'blocked';
    // Something else reports real prompts, so this is a tool still executing.
    if (now - last.ts <= UNANSWERED_RUNNING_WINDOW_MS) return 'running';
  }

  // rule 2 — the transcript states the turn is over, so say so immediately
  // rather than reporting `running` for another RUNNING_WINDOW_MS.
  if (handedControlBack(last)) return 'idle';

  // rule 2b — a local command (`/clear`, `/model`) finished. Its envelope is a
  // `user` row, so without this the task read `running` for the whole window
  // and the composer's controls stayed disabled after a /clear.
  if (endsLocalCommand(lastNonMeta(rows).rawJson)) return 'idle';

  // rule 3 — fallback for lines with no usable stop_reason.
  if (ACTIVITY_ROLES.has(last.role) && now - last.ts <= RUNNING_WINDOW_MS) {
    return 'running';
  }

  // rule 4 — an assistant tail too old for the window.
  if (last.role === 'assistant') return 'idle';

  return 'idle';
}

/**
 * When `deriveStatus` over these same rows would give a different answer with
 * no new row arriving, or null if it never will.
 *
 * The recency windows make the status a function of the clock as well as of
 * the rows, and nothing else re-asks: a session killed mid-turn writes no
 * further line, so without a timer at this instant it reads `running` forever.
 * Only the window edges can flip the answer, so each is probed in order.
 */
export function statusExpiresAt(
  messages: Message[],
  now: number = Date.now(),
  opts: DeriveOptions = {},
): number | null {
  if (messages.length === 0) return null;
  let lastTs = -Infinity;
  for (const m of messages) if (m.ts > lastTs) lastTs = m.ts;
  const current = deriveStatus(messages, now, opts);
  for (const window of [RUNNING_WINDOW_MS, UNANSWERED_RUNNING_WINDOW_MS]) {
    const edge = lastTs + window + 1; // the windows are inclusive (<=)
    if (edge > now && deriveStatus(messages, edge, opts) !== current) return edge;
  }
  return null;
}

/**
 * Whether the session handed control back with a question for the user: the
 * turn ended (rule 2) and its closing text asks something.
 *
 * A plain-text question is not `blocked`: nothing waits on it, and the user
 * may answer whenever they like. It is still worth marking, because with
 * several sessions the one that asked you something is the one to read next.
 * Answering writes a `user` row, so the mark clears by itself.
 */
export function endsOnQuestion(messages: Pick<Message, 'role' | 'seq' | 'ts' | 'rawJson' | 'body'>[]): boolean {
  return pendingQuestion(messages) !== null;
}

/** The question {@link endsOnQuestion} found, as written, or null. */
export function pendingQuestion(
  messages: Pick<Message, 'role' | 'seq' | 'ts' | 'rawJson' | 'body'>[],
): string | null {
  let last: (typeof messages)[number] | null = null;
  for (const m of messages) {
    if (last === null || m.ts > last.ts || (m.ts === last.ts && m.seq > last.seq)) last = m;
  }
  if (last === null || !handedControlBack(last)) return null;
  return questionIn(last.body ?? '');
}

/**
 * A line of prose that ends in `?`. Code blocks and quotes are someone else's
 * words; trailing emphasis, quotes and brackets are looked through. A question
 * anywhere in the closing message counts, not only in its last line: the ask
 * is often followed by a list of sources or links.
 */
export function asksAQuestion(text: string): boolean {
  return questionIn(text) !== null;
}

/** The first line {@link asksAQuestion} accepts, markdown emphasis removed. */
export function questionIn(text: string): string | null {
  let fenced = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```') || line.startsWith('~~~')) {
      fenced = !fenced;
      continue;
    }
    if (fenced || line.startsWith('>')) continue;
    if (/\?[\s*_"'\u201d\u2019)\]]*$/u.test(line)) return line.replace(/[*_`]+/g, '').trim();
  }
  return null;
}

/** The newest row that is not an `isMeta` line Claude Code added on its own. */
function lastNonMeta(rows: StatusInput[]): StatusInput {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i] as StatusInput;
    if (!isMetaLine(r.rawJson)) return r;
  }
  return rows[rows.length - 1] as StatusInput;
}

/**
 * True when the newest row is an assistant row whose JSONL line finished the
 * turn. Any other role, a missing stop_reason, or an unreadable raw_json
 * returns false so the caller falls through to the recency window -- never
 * guess "finished" from absent data, or a session mid-thought goes grey.
 */
function handedControlBack(last: StatusInput): boolean {
  if (last.role !== 'assistant') return false;
  const reason = stopReasonOf(last.rawJson);
  return reason !== null && TURN_ENDING_STOP_REASONS.has(reason);
}

/**
 * True when a tool call issued after the last human turn never got a result.
 *
 * Scoping to "after the last human turn" is what keeps an interrupted turn
 * from wedging a session at `blocked` forever: pressing Esc orphans a
 * `tool_use`, but Claude Code then writes a `user` row, which moves the
 * scope past the orphan.
 */
function hasUnansweredToolUse(rows: StatusInput[]): boolean {
  // Fast path: the tail is a tool call, so by construction nothing answered it.
  const last = rows[rows.length - 1];
  if (last && last.role === 'tool_use') return true;

  let lastHumanIdx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r && r.role === 'user') {
      lastHumanIdx = i;
      break;
    }
  }

  const answered = new Set<string>();
  for (const r of rows) {
    if (r.role !== 'tool_result') continue;
    const id = toolCallIdOf(r);
    if (id) answered.add(id);
  }

  for (let i = lastHumanIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.role !== 'tool_use') continue;
    const id = toolCallIdOf(r);
    // An unidentifiable tool_use (raw_json unparseable) is NOT treated as
    // blocked; guessing "blocked" on missing data would stick a red badge on
    // a healthy session.
    if (id && !answered.has(id)) return true;
  }
  return false;
}
