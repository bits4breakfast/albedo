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
 * (validate.ts); the model only proposes groups and words.
 */

import type { BranchDiff } from './blocks';
import { estimateTokens, groupByFolder, INPUT_BUDGET_TOKENS, planInput, renderBlock } from './budget';
import { NOTE_MIN_LINES, normalizeId, validateProposal, type Guide, type GuideGroup, type Proposal } from './validate';
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
          notes: {
            type: 'array',
            items: {
              type: 'object',
              properties: { path: { type: 'string' }, note: { type: 'string' } },
              required: ['path', 'note'],
            },
          },
        },
        required: ['title', 'summary', 'blocks'],
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
  'The prompt may end with a list of files to note. For each listed file, in each group that has its',
  'blocks and blocks of at least one other file, add a note: the file path exactly as listed and one line',
  '(under 100 characters) saying what that file does in that group. Describe it; do not judge it.',
  'Write no notes for files not listed, and none in a group whose blocks are all from one file.',
].join(' ');

/**
 * At most this many files are offered for a note, the most changed first, so
 * the notes' share of the answer stays small: about 30 tokens each.
 */
export const MAX_NOTED_FILES = 60;

/**
 * The files the model may write a note on (#202): at least NOTE_MIN_LINES
 * changed lines in all, and lines it is shown (a stat-only file's note would
 * be a guess). Whether a note is shown is settled again per group, from
 * Albedo's counts (validate.ts); the model never judges size.
 */
export function notedFiles(diff: BranchDiff): string[] {
  const eligible = diff.files.filter((f) => f.stat === null && f.added + f.removed >= NOTE_MIN_LINES);
  if (eligible.length < 2) return [];
  const keep = new Set(
    [...eligible]
      .sort((a, b) => b.added + b.removed - (a.added + a.removed))
      .slice(0, MAX_NOTED_FILES)
      .map((f) => f.path),
  );
  return eligible.filter((f) => keep.has(f.path)).map((f) => f.path);
}

function noteList(paths: readonly string[]): string {
  return paths.length === 0 ? '' : `\n\nFiles to note:\n${paths.map((p) => `- ${p}`).join('\n')}`;
}

export const LINES_SYSTEM = [
  'You summarise the blocks of a code change, one line each. Each block starts with its id in square',
  'brackets, then its file path and its changed lines. For every block return its id exactly as given',
  'and one line (under 100 characters) saying what it changes. Do not invent ids.',
].join(' ');

/** Every call's share of the budget besides the blocks: instructions and framing. */
export const CALL_OVERHEAD_TOKENS = estimateTokens(GROUP_SYSTEM) + 200;

function asProposal(v: unknown): Proposal | null {
  if (typeof v !== 'object' || v === null) return null;
  const groups = (v as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return null;
  const out: Proposal['groups'] = [];
  for (const g of groups) {
    if (typeof g !== 'object' || g === null) return null;
    const { title, summary, blocks, notes } = g as { title?: unknown; summary?: unknown; blocks?: unknown; notes?: unknown };
    if (typeof title !== 'string' || !Array.isArray(blocks)) return null;
    out.push({
      title,
      summary: typeof summary === 'string' ? summary : '',
      blocks: blocks.filter((b): b is string => typeof b === 'string'),
      // A malformed note is dropped, never the group.
      notes: Array.isArray(notes)
        ? notes.flatMap((n) => {
            const { path, note } = (typeof n === 'object' && n !== null ? n : {}) as { path?: unknown; note?: unknown };
            return typeof path === 'string' && typeof note === 'string' ? [{ path, note }] : [];
          })
        : [],
    });
  }
  return { groups: out };
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
}

function intro(diff: BranchDiff): string {
  return `The change: ${diff.files.length} file(s), ${diff.order.length} block(s).\n\n`;
}

function guideFrom(diff: BranchDiff, groups: GuideGroup[], o: WriteOptions, fallback: string | null): Guide {
  return {
    diffHash: diff.hash,
    writtenAt: (o.now ?? Date.now)(),
    base: o.base,
    groups,
    files: fileBlockIndex(diff),
    fallback,
  };
}

/** The validated groups, or an error when the reply placed nothing at all. */
function accept(diff: BranchDiff, proposal: Proposal | null): GuideGroup[] {
  if (proposal === null) throw new GuideError('invalid', 'The reply did not have the groups Albedo asked for.');
  const v = validateProposal(proposal, diff.order, new Map([...diff.blocks].map(([id, b]) => [id, b.path])));
  if (v.groups.length === 0) {
    throw new GuideError('invalid', 'The reply named none of the changed blocks, so there is no guide to show.');
  }
  if (v.unknown.length > 0) console.warn('[guide] dropped ids the diff does not have', v.unknown);
  return v.groups;
}

/**
 * Write a guide for `diff`. One call when the change fits the budget, two
 * passes when it does not, and folders (no call) when even that will not fit.
 * Throws a {@link GuideError}; never returns a partial guide.
 */
export async function writeGuide(diff: BranchDiff, o: WriteOptions): Promise<Guide> {
  if (diff.order.length === 0) throw new GuideError('invalid', 'This branch has no changes to guide.');
  const budget = o.budget ?? INPUT_BUDGET_TOKENS;
  const texts = new Map(diff.order.map((id) => [id, renderBlock(diff.blocks.get(id)!, diff)] as const));
  // The files to note go with the grouping call (one call, or pass two),
  // never with pass one's batches, so only those calls count them.
  const notes = noteList(notedFiles(diff));
  const overhead = CALL_OVERHEAD_TOKENS;
  const plan = planInput(diff.order, texts, budget, overhead + estimateTokens(notes));

  if (plan.kind === 'folders') return folderGuide(diff, o, plan.reason);

  if (plan.kind === 'single') {
    o.onProgress?.({ step: 1, of: 1, label: 'Grouping the changes' });
    const prompt = intro(diff) + plan.ids.map((id) => texts.get(id)).join('\n\n') + notes;
    return guideFrom(diff, accept(diff, asProposal(await call(GROUP_SYSTEM, GROUPS_SCHEMA, prompt))), o, null);
  }

  // Pass one: a line per block, batch by batch, sized without the notes.
  // (What fits one call only without them is one batch.)
  const sized = planInput(diff.order, texts, budget, overhead);
  const batches = sized.kind === 'two-pass' ? sized.batches : [[...diff.order]];
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
  const summary = diff.order.map((id) => {
    const b = diff.blocks.get(id)!;
    return `[${id}] ${b.path} +${b.added} -${b.removed}: ${lines.get(id) ?? '(no summary)'}`;
  });
  const prompt = intro(diff) + summary.join('\n') + notes;
  if (estimateTokens(prompt) + overhead > budget) {
    return folderGuide(diff, o, `${diff.order.length} changed blocks are too many to group in one call, even as one line each.`);
  }
  o.onProgress?.({ step: of, of, label: 'Grouping the changes' });
  return guideFrom(diff, accept(diff, asProposal(await call(GROUP_SYSTEM, GROUPS_SCHEMA, prompt))), o, null);
}

/** Albedo's own grouping, by folder, with the reason it was not asked for. */
function folderGuide(diff: BranchDiff, o: WriteOptions, reason: string): Guide {
  const groups = groupByFolder(diff).map((g) => ({ title: g.title, summary: '', blocks: g.blocks }));
  return guideFrom(diff, groups, o, `${reason} Grouped by folder instead, with no summaries.`);
}
