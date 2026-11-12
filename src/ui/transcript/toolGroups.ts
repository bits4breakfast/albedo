/**
 * Runs of tool calls folded into one line (#358).
 *
 * A long turn is mostly tool rows; reading it meant scrolling past every Read
 * and Bash to find what Claude said. Two or more tool calls in a row, with
 * none of Claude's text between them, become one line that says what was
 * done -- "Read 3 files, edited 2 files, ran 2 commands" -- with the lines
 * added and removed. Opened, it shows the same rows as before.
 *
 * Never folded, and they split a run: what waits on the user or what the user
 * acts on (questions, plans, previews, new-session requests), and background
 * work, which the Background band points at by its row. A thinking block
 * between two calls stays inside the run; one at either end does not.
 *
 * Pure: the pane draws the result (TranscriptPane's ToolRunGroup).
 */

import type { Message } from '../../types';
import { lineChangeCounts } from '../../lib/diff';
import { SHOW_PREVIEW_TOOL } from '../../capture/previewGate';
import { REQUEST_SESSION_TOOL } from '../spinOut';
import { targetOf, toolInput, toolResultIsError } from './ToolChip';
import { DIFF_TOOLS, editPairsOf } from './editPairs';

/** Tools that are never folded: they wait on the user, or run in the background. */
const NEVER_FOLDED = new Set([
  'AskUserQuestion',
  'ExitPlanMode',
  'EnterPlanMode',
  SHOW_PREVIEW_TOOL,
  REQUEST_SESSION_TOOL,
  'mcp__albedo__notify_blocked',
  'Monitor',
  'CronCreate',
  'ScheduleWakeup',
]);

/** Whether this tool call row may be folded into a run. */
export function foldable(m: Message): boolean {
  if (m.role !== 'tool_use') return false;
  const name = m.toolName ?? '';
  if (NEVER_FOLDED.has(name)) return false;
  // A shell or an agent started in the background: the Background band points at its row.
  return toolInput(m).run_in_background !== true;
}

/** A thinking block: glue inside a run, never its start or end. */
export function isThinking(m: Message): boolean {
  return m.role === 'assistant' && m.toolName === 'thinking';
}

// ---------------------------------------------------------------------------
// What the line says
// ---------------------------------------------------------------------------

interface Verb {
  /** For one: "read a file". */
  one: string;
  /** For several: "read 3 files". */
  many: (n: number) => string;
  /** Counted by distinct file, when the call names one. */
  byFile?: boolean;
}

const READ: Verb = { one: 'read a file', many: (n) => `read ${n} files`, byFile: true };
const EDIT: Verb = { one: 'edited a file', many: (n) => `edited ${n} files`, byFile: true };
const WRITE: Verb = { one: 'wrote a file', many: (n) => `wrote ${n} files`, byFile: true };
const RUN: Verb = { one: 'ran a command', many: (n) => `ran ${n} commands` };
const SEARCH: Verb = { one: 'searched once', many: (n) => `searched ${n} times` };
const FETCH: Verb = { one: 'fetched a page', many: (n) => `fetched ${n} pages` };
const WEB: Verb = { one: 'searched the web', many: (n) => `searched the web ${n} times` };
const AGENT: Verb = { one: 'ran an agent', many: (n) => `ran ${n} agents` };
const SKILL: Verb = { one: 'used a skill', many: (n) => `used ${n} skills` };
const TODO: Verb = { one: 'updated the to-dos', many: () => 'updated the to-dos' };
const OTHER: Verb = { one: 'used a tool', many: (n) => `used ${n} tools` };

function verbOf(tool: string): Verb {
  switch (tool) {
    case 'Read':
      return READ;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return EDIT;
    case 'Write':
      return WRITE;
    case 'Bash':
    case 'BashOutput':
      return RUN;
    case 'Grep':
    case 'Glob':
      return SEARCH;
    case 'WebFetch':
      return FETCH;
    case 'WebSearch':
      return WEB;
    case 'Agent':
    case 'Task':
      return AGENT;
    case 'Skill':
      return SKILL;
    case 'TodoWrite':
      return TODO;
    default:
      return OTHER;
  }
}

/**
 * "Read 3 files, edited 2 files, ran 2 commands": verbs with counts, in the
 * order each first happened. Files are counted once however often they were
 * read or edited.
 */
export function runSummary(calls: readonly Message[]): string {
  const order: Verb[] = [];
  const counts = new Map<Verb, { n: number; files: Set<string> }>();
  for (const m of calls) {
    const verb = verbOf(m.toolName ?? '');
    let c = counts.get(verb);
    if (!c) {
      c = { n: 0, files: new Set() };
      counts.set(verb, c);
      order.push(verb);
    }
    const file = verb.byFile ? targetOf(m) : null;
    if (file !== null) c.files.add(file);
    else c.n++;
  }
  const parts = order.map((verb) => {
    const c = counts.get(verb)!;
    const n = c.n + c.files.size;
    return n === 1 ? verb.one : verb.many(n);
  });
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/*
 * Counted once per call (#362). The run's line re-reads every call in the run
 * on each live append, and counting rebuilt each edit's whole diff, word
 * refinement and all: ~34 ms per append on a 1,000-row window. Kept per row
 * object, which is never changed once captured (MessageRow's memo rests on
 * the same fact): a row that changes arrives as a new object, and a reload
 * keeps the objects of rows it already held (tail.ts, keepRowObjects). Weak,
 * so a count goes when its row does.
 */
const linesCache = new WeakMap<Message, { added: number; removed: number } | null>();

/** Lines added and removed by one call, from its input; null for a call that changes no file. */
export function linesChanged(m: Message): { added: number; removed: number } | null {
  if (!DIFF_TOOLS.has(m.toolName ?? '')) return null;
  const hit = linesCache.get(m);
  if (hit !== undefined) return hit;
  const counted = countLines(m);
  linesCache.set(m, counted);
  return counted;
}

function countLines(m: Message): { added: number; removed: number } | null {
  const edit = editPairsOf(m);
  if (edit === null) return null;
  let added = 0;
  let removed = 0;
  for (const p of edit.pairs) {
    const c = lineChangeCounts(p.oldText, p.newText);
    added += c.added;
    removed += c.removed;
  }
  return Object.freeze({ added, removed });
}

export interface RunFacts {
  summary: string;
  /** Lines added and removed across the run; null when nothing was changed. */
  lines: { added: number; removed: number } | null;
  /** Calls whose result reported failure. */
  failed: number;
  /** Calls with no result yet. */
  pending: number;
}

/** What a run's line says. Only a call that succeeded counts its lines. */
export function runFacts(calls: readonly Message[], results: ReadonlyMap<number, Message | null>): RunFacts {
  let added = 0;
  let removed = 0;
  let changed = false;
  let failed = 0;
  let pending = 0;
  for (const m of calls) {
    const r = results.get(m.id) ?? null;
    if (r === null) pending++;
    else if (toolResultIsError(r)) failed++;
    if (r !== null && toolResultIsError(r)) continue;
    const c = linesChanged(m);
    if (c) {
      changed = true;
      added += c.added;
      removed += c.removed;
    }
  }
  return { summary: runSummary(calls), lines: changed ? { added, removed } : null, failed, pending };
}

// ---------------------------------------------------------------------------
// Finding the runs
// ---------------------------------------------------------------------------

/** The least the folding needs to know about a pane item. */
export interface RowLike {
  kind: string;
  message?: Message;
}

/**
 * Where the runs are: [start, end) index ranges over `items`, each holding at
 * least two foldable calls, starting and ending on one, with only foldable
 * calls and thinking blocks between.
 */
export function findRuns(items: readonly RowLike[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let i = 0;
  while (i < items.length) {
    const it = items[i]!;
    if (it.kind !== 'row' || !it.message || !foldable(it.message)) {
      i++;
      continue;
    }
    let calls = 1;
    let end = i + 1; // one past the last call taken
    let j = i + 1;
    while (j < items.length) {
      const n = items[j]!;
      if (n.kind !== 'row' || !n.message) break;
      if (foldable(n.message)) {
        calls++;
        end = j + 1;
      } else if (!isThinking(n.message)) break;
      j++;
    }
    if (calls >= 2) runs.push([i, end]);
    i = end;
  }
  return runs;
}
