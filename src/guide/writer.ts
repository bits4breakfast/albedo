/**
 * Who writes the Review Guide (#186): a separate, one-shot Claude Code run.
 *
 * THIS IS THE ONLY FILE THAT KNOWS THE SHAPE OF `claude -p`'s OUTPUT. It is a
 * channel of its own, recorded in CLAUDE.md (owner decision 2026-11-02): one
 * `claude -p --model haiku` run, no tools, `--output-format json`, the
 * Anthropic variables stripped, a timeout (src-tauri/src/oneshot.rs fixes the
 * flags). Never the task's own session: its context and its turn are not
 * touched. Its output is one JSON document on stdout, never terminal bytes.
 *
 * Measured on Claude Code 2.1.316 (`claude -p --output-format json`):
 *  - stdout is one line, an object with `type: "result"`, `subtype`,
 *    `is_error`, `result` (the reply text) and, when `--json-schema` was
 *    given, `structured_output` (the reply, parsed and schema-checked);
 *  - on failure (an API error, an unknown model) it is still that one line,
 *    with `is_error: true` and the reason in `result`, and the exit code is 1;
 *  - a login shell's profile may print before it, so the result is the LAST
 *    line that parses, never the whole of stdout;
 *  - `claude` missing is the shell's exit 127 ("command not found").
 *
 * Albedo owns the facts (blocks.ts) and checks the answer against them
 * (validate.ts); the model only proposes groups and words, and (#295, owner
 * decision 2026-11-09) up to MAX_FLAGS files to read carefully, each a path
 * it was given and a one-line reason. Files the guide sets aside (focus.ts)
 * are never sent.
 */

import type { BranchDiff } from './blocks';
import { estimateTokens, groupByFolder, INPUT_BUDGET_TOKENS, planInput, renderBlock } from './budget';
import {
  cleanFlags,
  cleanNotes,
  MAX_FLAGS,
  NOTE_LINE_MAX_CHARS,
  normalizeId,
  notableFiles,
  validateProposal,
  type Guide,
  type GuideGroup,
  type Proposal,
} from './validate';
import { isSetAside, type GuideFocus } from './focus';
import { fileBlockIndex } from './blocks';

/**
 * One call's time limit. Measured on 2.1.316: a tiny call took ~2 s, and a
 * 50-block, 67,000-character guide of this feature's own branch ~16 s.
 */
export const CALL_TIMEOUT_MS = 180_000;

export interface OneshotRequest {
  systemPrompt: string;
  jsonSchema: string;
  prompt: string;
  timeoutMs: number;
}

export interface OneshotOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs one `claude -p`. Throws only when it could not be started at all. */
export type OneshotRunner = (req: OneshotRequest) => Promise<OneshotOutput>;

let runner: OneshotRunner = async (req) => {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<OneshotOutput>('claude_oneshot', {
    systemPrompt: req.systemPrompt,
    jsonSchema: req.jsonSchema,
    prompt: req.prompt,
    timeoutMs: req.timeoutMs,
  });
};

/** Test seam. Returns the previous runner so a test can restore it. */
export function setOneshotRunner(next: OneshotRunner): OneshotRunner {
  const prev = runner;
  runner = next;
  return prev;
}

export type GuideErrorKind = 'missing' | 'timeout' | 'invalid' | 'failed';

export class GuideError extends Error {
  constructor(
    readonly kind: GuideErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'GuideError';
  }
}

// ---------------------------------------------------------------------------
// The output
// ---------------------------------------------------------------------------

interface ResultLine {
  type: 'result';
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
}

/** The `type: "result"` object on stdout: the last line that parses as one. */
export function findResult(stdout: string): ResultLine | null {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim();
    if (!line.startsWith('{')) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (typeof v === 'object' && v !== null && (v as { type?: unknown }).type === 'result') return v as ResultLine;
    } catch {
      /* not this line */
    }
  }
  return null;
}

/** A reply's JSON: the schema-checked object, else the text, fences and all. */
function replyJson(r: ResultLine): unknown {
  if (r.structured_output !== undefined && r.structured_output !== null) return r.structured_output;
  if (typeof r.result !== 'string') return undefined;
  const text = r.result.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function tail(text: string): string {
  const t = text.trim();
  return t.length > 300 ? `…${t.slice(-300)}` : t;
}

/** One call: its reply's JSON, or a GuideError that says what went wrong. */
async function call(systemPrompt: string, schema: object, prompt: string): Promise<unknown> {
  let out: OneshotOutput;
  try {
    out = await runner({ systemPrompt, jsonSchema: JSON.stringify(schema), prompt, timeoutMs: CALL_TIMEOUT_MS });
  } catch (err) {
    throw new GuideError('failed', `Could not start Claude Code: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (out.timedOut) {
    throw new GuideError('timeout', `Claude Code did not answer within ${Math.round(CALL_TIMEOUT_MS / 60_000)} minutes.`);
  }
  if (out.code === 127 || /command not found: claude|claude: (command )?not found/.test(out.stderr)) {
    throw new GuideError('missing', 'Claude Code was not found. Install it, or check that `claude` runs in a terminal.');
  }
  const r = findResult(out.stdout);
  if (r === null) {
    if (out.code !== 0) {
      throw new GuideError('failed', `Claude Code exited with ${out.code ?? 'a signal'}. ${tail(out.stderr)}`.trim());
    }
    throw new GuideError('invalid', 'Claude Code answered, but not with the JSON result Albedo asked for.');
  }
  if (r.is_error === true) {
    throw new GuideError('failed', typeof r.result === 'string' && r.result ? r.result : 'Claude Code reported an error.');
  }
  const json = replyJson(r);
  if (json === undefined) throw new GuideError('invalid', 'The reply was not valid JSON.');
  return json;
}

// ---------------------------------------------------------------------------
// The shapes asked for
// ---------------------------------------------------------------------------

const GROUPS_SCHEMA = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          summary: { type: 'string' },
          blocks: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'summary', 'blocks'],
      },
    },
    // #295: optional, so a reply without it is still a guide.
    careful: {
      type: 'array',
      maxItems: MAX_FLAGS,
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, reason: { type: 'string' } },
        required: ['path', 'reason'],
      },
    },
  },
  required: ['groups'],
};

const LINES_SCHEMA = {
  type: 'object',
  properties: {
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, line: { type: 'string' } },
        required: ['id', 'line'],
      },
    },
  },
  required: ['blocks'],
};

export const GROUP_SYSTEM = [
  'You write a review guide for a code change on a branch. The change is given as blocks.',
  'Each block starts with its id in square brackets, then its file path and its changed lines.',
  'Group the blocks by what they do (one intent per group), and order the groups so a reviewer reads',
  'foundations before what builds on them. For each group write a short title (under 60 characters,',
  'sentence case) and a summary of one or two sentences saying what the group changes and why.',
  'Put every block id in exactly one group. Use the ids exactly as given, bare (for example "a1b2"),',
  'with nothing added. Do not invent ids. Write plainly; do not praise or judge the code.',
  `Then, under "careful", list at most ${MAX_FLAGS} files a reviewer should read with extra care because a`,
  'mistake there would be costly or easy to miss: stored data or its shape, security or permissions,',
  'money, concurrency, a contract other code relies on. For each give its file path exactly as shown',
  'and a reason of one short line (under 80 characters) saying what makes it risky, for example',
  '"changes the session id written on restart". Do not list a file just because it is large or new.',
  'Leave "careful" empty when nothing stands out.',
].join(' ');

const NOTES_SCHEMA = {
  type: 'object',
  properties: {
    notes: {
      type: 'array',
      items: {
        type: 'object',
        // The note first, then the line: the line is the note condensed (#264).
        properties: { path: { type: 'string' }, note: { type: 'string' }, line: { type: 'string' } },
        required: ['path', 'note', 'line'],
      },
    },
  },
  required: ['notes'],
};

/**
 * The notes call (#224). The owner's ask: a note says why the file changes in
 * this group, not what changed -- the diff is beside it and says that. Since
 * #264 the same call also writes each file's short line for the group's file
 * list: the note condensed to its gist (about 45 characters fit the list), so
 * the list scans. Never the note cut down.
 */
export const NOTES_SYSTEM = [
  'You help a reviewer read one group of a code change. You are given the titles of all the change\'s',
  'groups (for context), this group\'s title and summary, a list of files to note, and the group\'s changed blocks: each block starts with its id in square',
  'brackets, then its file path and its changed lines.',
  'For each file to note, write two texts.',
  'First, "note": one or two short sentences (under 220 characters in all) on WHY this file',
  'changes as part of this group: the part it plays in what the group sets out to do, the reason the change',
  'is needed in this file, or what it enables, protects or keeps working.',
  'Do not restate what changed: the reviewer reads the diff right beside your note. Mention what changed',
  'only when the reason cannot be told without it. If the reason is not evident from the lines, the title',
  'or the summary, state the file\'s role in the group plainly rather than guess at intent.',
  'Then "line": the same thing as the note in a few words, for a list of the group\'s files: its gist,',
  'rewritten shorter, never its first words cut off. At most 50 characters, no trailing period.',
  'Do not restate the group\'s title.',
  'Use each file path exactly as listed, and write nothing for files not listed.',
  'Write plainly; describe, do not praise or judge the code.',
].join(' ');

export const LINES_SYSTEM = [
  'You summarise the blocks of a code change, one line each. Each block starts with its id in square',
  'brackets, then its file path and its changed lines. For every block return its id exactly as given',
  'and one line (under 100 characters) saying what it changes. Do not invent ids.',
].join(' ');

/** Every call's share of the budget besides the blocks: instructions and framing. */
export const CALL_OVERHEAD_TOKENS = estimateTokens(GROUP_SYSTEM) + 200;
const NOTES_OVERHEAD_TOKENS = estimateTokens(NOTES_SYSTEM) + 200;

/** The reply's "careful" entries (#295); anything not in the shape asked for is skipped. */
function asCareful(v: unknown): Array<{ path: string; reason: string }> {
  if (!Array.isArray(v)) return [];
  const out: Array<{ path: string; reason: string }> = [];
  for (const c of v) {
    const { path, reason } = (typeof c === 'object' && c !== null ? c : {}) as { path?: unknown; reason?: unknown };
    if (typeof path === 'string' && typeof reason === 'string') out.push({ path, reason });
  }
  return out;
}

export function asProposal(v: unknown): Proposal | null {
  if (typeof v !== 'object' || v === null) return null;
  const groups = (v as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return null;
  const out: Proposal['groups'] = [];
  for (const g of groups) {
    if (typeof g !== 'object' || g === null) return null;
    const { title, summary, blocks } = g as { title?: unknown; summary?: unknown; blocks?: unknown };
    if (typeof title !== 'string' || !Array.isArray(blocks)) return null;
    out.push({
      title,
      summary: typeof summary === 'string' ? summary : '',
      blocks: blocks.filter((b): b is string => typeof b === 'string'),
    });
  }
  return { groups: out, careful: asCareful((v as { careful?: unknown }).careful) };
}

function asLines(v: unknown): Map<string, string> | null {
  if (typeof v !== 'object' || v === null) return null;
  const blocks = (v as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks)) return null;
  const out = new Map<string, string>();
  for (const b of blocks) {
    if (typeof b !== 'object' || b === null) continue;
    const { id, line } = b as { id?: unknown; line?: unknown };
    if (typeof id === 'string' && typeof line === 'string') out.set(normalizeId(id), line.trim());
  }
  return out;
}

/**
 * The notes and short lines in a reply, or null when it is not the shape
 * asked for. An entry missing its line keeps its note, and the other way
 * round (#264); one with neither, or no path, is dropped.
 */
export function asNotes(v: unknown): { notes: Array<{ path: string; note: string }>; lines: Array<{ path: string; note: string }> } | null {
  if (typeof v !== 'object' || v === null) return null;
  const raw = (v as { notes?: unknown }).notes;
  if (!Array.isArray(raw)) return null;
  const notes: Array<{ path: string; note: string }> = [];
  const lines: Array<{ path: string; note: string }> = [];
  for (const n of raw) {
    const { path, note, line } = (typeof n === 'object' && n !== null ? n : {}) as { path?: unknown; note?: unknown; line?: unknown };
    if (typeof path !== 'string') continue;
    if (typeof note === 'string') notes.push({ path, note });
    if (typeof line === 'string') lines.push({ path, note: line });
  }
  return { notes, lines };
}

/** One group's answer: path -> why (`notes`), and path -> short line (`lines`), #264. */
export interface GroupNotes {
  notes: Record<string, string>;
  lines: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Writing a guide
// ---------------------------------------------------------------------------

export interface Progress {
  /** 1-based. */
  step: number;
  of: number;
  label: string;
}

export interface WriteOptions {
  /** What the branch is compared with, for the header. */
  base: string;
  onProgress?: (p: Progress) => void;
  now?: () => number;
  budget?: number;
  /** What to set aside and mark (#295); none when absent. Kept with the guide. */
  focus?: GuideFocus;
}

function intro(files: number, blocks: number): string {
  return `The change: ${files} file(s), ${blocks} block(s).\n\n`;
}

function guideFrom(
  diff: BranchDiff,
  groups: GuideGroup[],
  o: WriteOptions,
  fallback: string | null,
  flags: Record<string, string> = {},
): Guide {
  return {
    diffHash: diff.hash,
    writtenAt: (o.now ?? Date.now)(),
    base: o.base,
    groups,
    files: fileBlockIndex(diff),
    fallback,
    ...(o.focus ? { focus: { setAside: [...o.focus.setAside], careful: [...o.focus.careful] } } : {}),
    ...(Object.keys(flags).length > 0 ? { flags } : {}),
  };
}

/**
 * The validated groups and flags, or an error when the reply placed nothing
 * at all. `sent` is what the writer was given: the only ids a group may hold
 * and the only files a flag may name (#295).
 */
function accept(diff: BranchDiff, sent: readonly string[], proposal: Proposal | null): { groups: GuideGroup[]; flags: Record<string, string> } {
  if (proposal === null) throw new GuideError('invalid', 'The reply did not have the groups Albedo asked for.');
  const v = validateProposal(proposal, sent, new Map([...diff.blocks].map(([id, b]) => [id, b.path])));
  if (v.groups.length === 0) {
    throw new GuideError('invalid', 'The reply named none of the changed blocks, so there is no guide to show.');
  }
  if (v.unknown.length > 0) console.warn('[guide] dropped ids the diff does not have', v.unknown);
  const paths = new Set(sent.map((id) => diff.blocks.get(id)!.path));
  const flags = cleanFlags(proposal.careful ?? [], paths);
  const dropped = (proposal.careful ?? []).filter((c) => !Object.hasOwn(flags, c.path.trim()));
  if (dropped.length > 0) console.warn('[guide] dropped flags on files it was not sent, or past the limit', dropped.map((c) => c.path));
  return { groups: v.groups, flags };
}

/**
 * Write a guide for `diff`. One call when the change fits the budget, two
 * passes when it does not, and folders (no call) when even that will not fit.
 * Throws a {@link GuideError}; never returns a partial guide.
 */
export async function writeGuide(diff: BranchDiff, o: WriteOptions): Promise<Guide> {
  if (diff.order.length === 0) throw new GuideError('invalid', 'This branch has no changes to guide.');
  const budget = o.budget ?? INPUT_BUDGET_TOKENS;
  // Set aside (#295): never sent, so the budget goes to the files that matter.
  const focus = o.focus;
  const sent = focus ? diff.order.filter((id) => !isSetAside(focus, diff.blocks.get(id)!.path)) : diff.order;
  if (sent.length === 0) {
    // Nothing to send, so no call. The pane says so in the group's count row.
    return guideFrom(diff, [], o, null);
  }
  const sentFiles = new Set(sent.map((id) => diff.blocks.get(id)!.path)).size;
  const texts = new Map(sent.map((id) => [id, renderBlock(diff.blocks.get(id)!, diff)] as const));
  // Groups only: the notes come after, a call per group (writeNotes, #224).
  const overhead = CALL_OVERHEAD_TOKENS;
  const plan = planInput(sent, texts, budget, overhead);

  if (plan.kind === 'folders') return folderGuide(diff, sent, o, plan.reason);

  if (plan.kind === 'single') {
    o.onProgress?.({ step: 1, of: 1, label: 'Grouping the changes' });
    const prompt = intro(sentFiles, sent.length) + plan.ids.map((id) => texts.get(id)).join('\n\n');
    const got = accept(diff, sent, asProposal(await call(GROUP_SYSTEM, GROUPS_SCHEMA, prompt)));
    return guideFrom(diff, got.groups, o, null, got.flags);
  }

  // Pass one: a line per block, batch by batch.
  const batches = plan.batches;
  const of = batches.length + 1;
  const lines = new Map<string, string>();
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i] ?? [];
    o.onProgress?.({ step: i + 1, of, label: `Summarising batch ${i + 1} of ${batches.length}` });
    const got = asLines(await call(LINES_SYSTEM, LINES_SCHEMA, batch.map((id) => texts.get(id)).join('\n\n')));
    if (got === null) throw new GuideError('invalid', `The summaries for batch ${i + 1} were not in the shape asked for.`);
    for (const id of batch) {
      const line = got.get(id);
      if (line) lines.set(id, line);
    }
  }

  // Pass two: group from the lines. A block without one is still listed.
  const summary = sent.map((id) => {
    const b = diff.blocks.get(id)!;
    return `[${id}] ${b.path} +${b.added} -${b.removed}: ${lines.get(id) ?? '(no summary)'}`;
  });
  const prompt = intro(sentFiles, sent.length) + summary.join('\n');
  if (estimateTokens(prompt) + overhead > budget) {
    return folderGuide(diff, sent, o, `${sent.length} changed blocks are too many to group in one call, even as one line each.`);
  }
  o.onProgress?.({ step: of, of, label: 'Grouping the changes' });
  const got = accept(diff, sent, asProposal(await call(GROUP_SYSTEM, GROUPS_SCHEMA, prompt)));
  return guideFrom(diff, got.groups, o, null, got.flags);
}

/** Albedo's own grouping of the `sent` blocks, by folder, with the reason it was not asked for. */
function folderGuide(diff: BranchDiff, sent: readonly string[], o: WriteOptions, reason: string): Guide {
  const keep = new Set(sent);
  const groups = groupByFolder(diff)
    .map((g) => ({ title: g.title, summary: '', blocks: g.blocks.filter((id) => keep.has(id)) }))
    .filter((g) => g.blocks.length > 0);
  return guideFrom(diff, groups, o, `${reason} Grouped by folder instead, with no summaries.`);
}

// ---------------------------------------------------------------------------
// Notes, a group at a time (#224)
// ---------------------------------------------------------------------------

/**
 * The notes for one group: path -> why the file changes in it, and path -> a
 * short line on what it does there (#264). One call, given
 * the group's title, summary and blocks in full, so a note is written from the
 * lines. Null when no call is made: nothing in the group may have a note, or
 * the group will not fit the budget (it is skipped, never split). Throws a
 * {@link GuideError} when the call fails.
 */
export async function writeNotes(
  diff: BranchDiff,
  group: Pick<GuideGroup, 'title' | 'summary' | 'blocks'>,
  o: { budget?: number; groupTitles?: readonly string[] } = {},
): Promise<GroupNotes | null> {
  const blocks = group.blocks.filter((id) => diff.blocks.has(id));
  const paths = notableFiles(blocks, diff);
  if (paths.length === 0) return null;
  // The whole change, by its groups' titles: what a file's why is measured against.
  const others = (o.groupTitles ?? []).filter((t) => t !== group.title);
  const head = [
    others.length > 0 ? `The change's other groups:\n${others.map((t) => `- ${t}`).join('\n')}\n` : null,
    `Group: ${group.title}`,
    group.summary ? `Summary: ${group.summary}` : null,
    `Files to note:\n${paths.map((p) => `- ${p}`).join('\n')}`,
  ]
    .filter((x) => x !== null)
    .join('\n');
  const prompt = `${head}\n\nThe group's blocks:\n\n${blocks.map((id) => renderBlock(diff.blocks.get(id)!, diff)).join('\n\n')}`;
  if (estimateTokens(prompt) + NOTES_OVERHEAD_TOKENS > (o.budget ?? INPUT_BUDGET_TOKENS)) return null;
  const reply = asNotes(await call(NOTES_SYSTEM, NOTES_SCHEMA, prompt));
  if (reply === null) throw new GuideError('invalid', 'The notes were not in the shape asked for.');
  const allowed = new Set(paths);
  return { notes: cleanNotes(reply.notes, allowed), lines: cleanNotes(reply.lines, allowed, NOTE_LINE_MAX_CHARS) };
}
