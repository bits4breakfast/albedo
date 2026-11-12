/**
 * How the transcript's rows become the items the pane draws: tool calls
 * paired with their results, subagent runs and compactions folded, runs of
 * tool calls folded into one line. Pure; the pane and the subagent inspector
 * both read it.
 */

import { harnessInputOf, SEQ_STRIDE, skillSourceToolUseIdOf } from '../../capture';
import type { Message } from '../../types';
import { compactionAt, type Compaction } from './compaction';
import { imageSourceNote, isImagePlaceholder } from './envelopes';
import { isSidechain, toolUseId } from './ToolChip';
import { findRuns } from './toolGroups';

export type Item =
  | { kind: 'row'; key: string; message: Message; result: Message | null; extras?: Message[] }
  | {
      kind: 'sidechain';
      key: string;
      rows: Message[];
      results: Map<number, Message | null>;
      /** A Skill call's text, by the call's row id (#150). */
      extras: Map<number, Message[]>;
    }
  | { kind: 'compaction'; key: string; compaction: Compaction }
  /** Two or more tool calls in a row, folded into one line (#358, toolGroups.ts). */
  | { kind: 'tools'; key: string; rows: RowItem[] };

export type RowItem = Extract<Item, { kind: 'row' }>;

/**
 * Fold each run of tool calls (toolGroups.ts's findRuns) into one `tools`
 * item. Keyed by the run's first call, so a run that grows while Claude
 * works keeps its line, open or closed.
 */
export function foldToolRuns(items: readonly Item[]): Item[] {
  const runs = findRuns(items.map((it) => (it.kind === 'row' ? { kind: 'row', message: it.message } : { kind: it.kind })));
  if (runs.length === 0) return [...items];
  const out: Item[] = [];
  let i = 0;
  for (const [start, end] of runs) {
    while (i < start) out.push(items[i++]!);
    const rows = items.slice(start, end) as RowItem[];
    out.push({ kind: 'tools', key: `t-${rows[0]!.message.id}`, rows });
    i = end;
  }
  while (i < items.length) out.push(items[i++]!);
  return out;
}

/**
 * Pair each `tool_use` with its `tool_result`, and fold runs of sidechain rows
 * into a single collapsible group. Subagent traffic is noise until you go
 * looking for it. A compaction's boundary, summary and notice become one
 * divider (compaction.ts), so the summary is never a "you" band. A skill's
 * text, which Claude Code writes as a `user` row after the Skill call that
 * loaded it, goes with that call as its `extras` (#150); with the call outside
 * the loaded window it stays a row of its own.
 *
 * `foldSidechains: false` is for the subagent inspector, which IS going looking
 * for it: every row it shows is sidechain, so folding would hide the whole run
 * behind one disclosure.
 */
export function groupRows(messages: readonly Message[], { foldSidechains = true } = {}): Item[] {
  const resultByCallId = new Map<string, Message>();
  for (const m of messages) {
    if (m.role !== 'tool_result') continue;
    const id = toolUseId(m);
    if (id) resultByCallId.set(id, m);
  }

  const consumed = new Set<number>();
  const calls = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'tool_use') continue;
    const id = toolUseId(m);
    if (!id) continue;
    calls.add(id);
    const result = resultByCallId.get(id);
    if (result) consumed.add(result.id);
  }

  // A skill's text goes with the call that loaded it, by the line's
  // `sourceToolUseID`, never by what the text says.
  const skillByCallId = new Map<string, Message[]>();
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const id = skillSourceToolUseIdOf(m.rawJson);
    if (id === null || !calls.has(id)) continue;
    const rows = skillByCallId.get(id);
    if (rows) rows.push(m);
    else skillByCallId.set(id, [m]);
    consumed.add(m.id);
  }

  const resultFor = (m: Message): Message | null => {
    if (m.role !== 'tool_use') return null;
    const id = toolUseId(m);
    return id ? (resultByCallId.get(id) ?? null) : null;
  };
  const extrasFor = (m: Message): Message[] | undefined => {
    if (m.role !== 'tool_use') return undefined;
    const id = toolUseId(m);
    return id ? skillByCallId.get(id) : undefined;
  };

  const items: Item[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (!m) break;
    if (foldSidechains && isSidechain(m)) {
      const rows: Message[] = [];
      const results = new Map<number, Message | null>();
      const extras = new Map<number, Message[]>();
      while (i < messages.length) {
        const s = messages[i];
        if (!s || !isSidechain(s)) break;
        if (!consumed.has(s.id)) {
          rows.push(s);
          results.set(s.id, resultFor(s));
          const more = extrasFor(s);
          if (more) extras.set(s.id, more);
        }
        i++;
      }
      if (rows.length > 0) items.push({ kind: 'sidechain', key: `sc-${rows[0]?.id ?? i}`, rows, results, extras });
      continue;
    }
    if (!consumed.has(m.id)) {
      const compacted = compactionAt(messages, i);
      if (compacted) {
        const first = compacted.compaction.boundary ?? m;
        items.push({ kind: 'compaction', key: `c-${first.id}`, compaction: compacted.compaction });
        i = compacted.next;
        continue;
      }
      if (harnessInputOf(m.rawJson) === 'wakeup') {
        // A /loop wake-up is one row: the "resuming" line, with the note and
        // the re-sent prompt Claude Code writes right after it folded in
        // (#138). Not "you": nobody typed them.
        const extras: Message[] = [];
        let j = i + 1;
        while (j < messages.length) {
          const n = messages[j];
          if (!n || consumed.has(n.id) || n.sessionId !== m.sessionId || n.agentId !== m.agentId) break;
          const part = harnessInputOf(n.rawJson);
          if (part !== 'note' && part !== 'scheduled-prompt') break;
          extras.push(n);
          j++;
          if (part === 'scheduled-prompt') break;
        }
        items.push({ kind: 'row', key: `m-${m.id}`, message: m, result: null, extras });
        i = j;
        continue;
      }
      if (m.role === 'user') {
        // One thing you sent is one band. Claude Code writes a message with an
        // attachment as several rows -- your text and the image are blocks of
        // the same line, and the "[Image: source: ...]" note is the line after
        // -- and each used to render as its own "you" band.
        const extras: Message[] = [];
        let hasImage = isImagePlaceholder(m.body);
        let j = i + 1;
        while (j < messages.length) {
          const n = messages[j];
          if (!n || n.role !== 'user' || isSidechain(n) || consumed.has(n.id)) break;
          const sameLine = Math.floor(n.seq / SEQ_STRIDE) === Math.floor(m.seq / SEQ_STRIDE) && n.sessionId === m.sessionId;
          const note = hasImage && imageSourceNote(n.body ?? '') !== null;
          if (!sameLine && !note) break;
          extras.push(n);
          if (isImagePlaceholder(n.body)) hasImage = true;
          j++;
        }
        items.push({ kind: 'row', key: `m-${m.id}`, message: m, result: null, extras });
        i = j;
        continue;
      }
      const more = extrasFor(m);
      items.push({ kind: 'row', key: `m-${m.id}`, message: m, result: resultFor(m), ...(more ? { extras: more } : {}) });
    }
    i++;
  }
  return items;
}
