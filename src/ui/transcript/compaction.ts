/**
 * A compaction, as the pane shows it: one divider where Claude Code compacted
 * the session, the summary folded under it, and the notice it wrote beside it.
 *
 * Claude Code writes three things (capture/adapter.ts knows their shape): a
 * boundary line, the summary as a `user` line right after it, and sometimes,
 * a moment later, a notice ("compacted while idle"). Before this the summary
 * rendered as a You row, thousands of words long, above a "Conversation
 * compacted" Sys row.
 *
 * Paired by position and by `parentUuid`, never by `ts`: the summary is
 * stamped ~8 ms before its boundary, so the task-scoped read (ordered by ts)
 * returns it first, while the tail (ordered by seq) returns it second. Both
 * orders make the same item, so nothing about the read's ordering changes.
 */

import type { Message } from '../../types';
import { compactBoundaryOf, compactSummaryOf, harnessInputOf, isNoticeLine, skillSourceToolUseIdOf, type CompactBoundary } from '../../capture';
import { formatContextTokens } from '../StatusDot';
import { formatDuration } from '../../lib/duration';

export interface Compaction {
  /** The boundary row, or null when only the summary is in the window. */
  boundary: Message | null;
  /** What the boundary recorded; null with it. */
  meta: CompactBoundary | null;
  /** The summary row, or null when it is outside the window. */
  summary: Message | null;
  /** The summary's whole text (the row's body may be truncated). */
  summaryText: string | null;
  /** A notice Claude Code wrote right after the summary, if any. */
  notice: Message | null;
}

/** True for a compaction summary: written by Claude Code, never a prompt. */
export function isCompactSummaryRow(m: Pick<Message, 'role' | 'rawJson'>): boolean {
  return m.role === 'user' && compactSummaryOf(m.rawJson) !== null;
}

/**
 * A `user` row someone sent: what clears the "sending" echo. A compaction
 * summary is a `user` row too, written when Claude Code compacts on its own
 * before taking the next message, and must not count. Nor does input Claude
 * Code wrote itself (`harnessInputOf`): a `/loop` wake-up re-sends its prompt
 * as a `user` row, and one landing while a message is on its way would clear
 * that message's echo as if it had arrived (#138). Nor does a skill's text,
 * which Claude Code writes as a `user` row after Claude's Skill call (#150):
 * it is part of the running turn, never the start of one.
 */
export function isPromptRow(m: Pick<Message, 'role' | 'rawJson'>): boolean {
  return (
    m.role === 'user' &&
    !isCompactSummaryRow(m) &&
    harnessInputOf(m.rawJson) === null &&
    skillSourceToolUseIdOf(m.rawJson) === null
  );
}

/**
 * The compaction starting at `messages[i]`, and the index after it; null when
 * that row is neither a boundary nor a summary.
 *
 * The pair is the boundary and the summary whose `parentUuid` is its `uuid`,
 * adjacent in either order and in the same session. A row on its own (its
 * partner outside the loaded window) is still a compaction, and a summary is
 * never left to render as a message.
 *
 * The notice is the row immediately after the pair, in the same session, when
 * it is a `system` notice line. Claude Code writes the "compacted while idle"
 * note there with only `attachment` lines (never stored) between, and the
 * transcript has no field saying that is what it is: placed by where it is,
 * never by what it says. Any other notice stays the Sys row it was.
 */
export function compactionAt(messages: readonly Message[], i: number): { compaction: Compaction; next: number } | null {
  const m = messages[i];
  if (!m) return null;
  const meta = m.role === 'system' ? compactBoundaryOf(m.rawJson) : null;
  const summaryOf = (r: Message | undefined) => (r && r.role === 'user' ? compactSummaryOf(r.rawJson) : null);
  const own = meta ? null : summaryOf(m);
  if (!meta && !own) return null;

  const after = messages[i + 1];
  const sameSession = after !== undefined && after.sessionId === m.sessionId && after.agentId === m.agentId;
  let compaction: Compaction;
  let next = i + 1;
  if (meta) {
    const partner = sameSession ? summaryOf(after) : null;
    const paired = partner !== null && meta.uuid !== null && partner.parentUuid === meta.uuid;
    compaction = {
      boundary: m,
      meta,
      summary: paired ? (after as Message) : null,
      summaryText: paired ? partner.text : null,
      notice: null,
    };
    if (paired) next++;
  } else {
    const partner = sameSession && after.role === 'system' ? compactBoundaryOf(after.rawJson) : null;
    const paired = partner !== null && partner.uuid !== null && own?.parentUuid === partner.uuid;
    compaction = {
      boundary: paired ? (after as Message) : null,
      meta: paired ? partner : null,
      summary: m,
      summaryText: own?.text ?? null,
      notice: null,
    };
    if (paired) next++;
  }

  const last = messages[next - 1] as Message;
  const n = messages[next];
  if (n && n.role === 'system' && n.sessionId === last.sessionId && n.agentId === last.agentId && isNoticeLine(n.rawJson)) {
    compaction.notice = n;
    next++;
  }
  return { compaction, next };
}

/**
 * "Context Compacted · 285k tokens · took 1m 3s", with "by /compact" when the
 * transcript says it was asked for. Anything the boundary did not record is
 * left out rather than guessed.
 */
export function compactionLabel(meta: CompactBoundary | null): string {
  const parts = ['Context Compacted'];
  if (meta?.trigger === 'manual') parts.push('by /compact');
  if (meta?.preTokens != null && meta.preTokens > 0) parts.push(`${formatContextTokens(meta.preTokens)} tokens`);
  if (meta?.durationMs != null) parts.push(`took ${formatDuration(meta.durationMs)}`);
  return parts.join(' · ');
}

/**
 * A notice's line and its tooltip. Claude Code joins a notice's statement and
 * its hint with a middle dot ("Compacted while idle, before the prompt cache
 * expired ·&nbsp;turn off with …", a no-break space after the dot on 2.1.310),
 * so the statement is the line and the whole notice is the tooltip. Without
 * the separator the whole text is the line: a change of wording costs the
 * split, never the notice.
 */
export function noticeParts(text: string): { line: string; title: string } {
  const whole = text.trim();
  const cut = /\s·\s/.exec(whole);
  return { line: cut && cut.index > 0 ? whole.slice(0, cut.index) : whole, title: whole };
}
