/**
 * Diff engine for the transcript pane.
 *
 * Pure, dependency-free and synchronous. Two entry points:
 *
 *  - `diffStrings` computes a diff from the `old_string` / `new_string` pair of
 *    an Edit tool call (line-level Myers, then word-level refinement).
 *  - `parseUnifiedDiff` parses the output of `git diff` captured through the
 *    Bash tool.
 *
 * Nothing in here may import React, Shiki or the DOM: it is the one part of the
 * transcript module that is fully testable in isolation.
 */

import type { DiffHunk, DiffLine, DiffSegment, FileDiff } from '../types';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Lines of unchanged context kept on each side of a change. */
const CONTEXT = 3;

/**
 * Upper bound on the Myers edit-distance search. Past this the two inputs have
 * almost nothing in common and a precise diff is neither cheap nor useful, so
 * we degrade to "delete everything, add everything" rather than spending
 * O(D^2) time and memory on it.
 */
const MAX_EDIT_DISTANCE = 1200;

/** Word-level refinement is skipped for pathologically long lines. */
const MAX_REFINE_LINE = 4000;

/**
 * If less than this fraction of a paired line survives unchanged, the line is
 * treated as a wholesale rewrite instead of being speckled with word spans.
 */
const MIN_SIMILARITY = 0.25;

// ---------------------------------------------------------------------------
// Sequence diff (Myers, O(ND))
// ---------------------------------------------------------------------------

type SeqOpKind = 'eq' | 'del' | 'add';

interface SeqOp {
  kind: SeqOpKind;
  /** Index into the old sequence, or -1 for an insertion. */
  oldIndex: number;
  /** Index into the new sequence, or -1 for a deletion. */
  newIndex: number;
}

/**
 * Greedy Myers diff over the middle of the two sequences, after common prefix
 * and suffix have been trimmed off. Returns `null` when the edit distance
 * exceeds `MAX_EDIT_DISTANCE`.
 */
function myersMiddle(a: readonly string[], b: readonly string[]): SeqOp[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const cap = Math.min(max, MAX_EDIT_DISTANCE);
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  // trace[d] holds the frontier *before* step d, compacted to k in [-d, d].
  const trace: Int32Array[] = [];

  for (let d = 0; d <= cap; d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      const left = v[offset + k - 1] ?? 0;
      const right = v[offset + k + 1] ?? 0;
      let x = k === -d || (k !== d && left < right) ? right : left + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return null;
}

function backtrack(trace: readonly Int32Array[], n: number, m: number): SeqOp[] {
  const rev: SeqOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const row = trace[d];
    if (!row) break;
    // Index of diagonal k inside the compacted row.
    const at = (k: number): number => row[k + d] ?? 0;
    const k = x - y;
    let prevX: number;
    let prevY: number;
    if (d === 0) {
      prevX = 0;
      prevY = 0;
    } else {
      const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
      prevX = at(prevK);
      prevY = prevX - prevK;
    }
    while (x > prevX && y > prevY) {
      x--;
      y--;
      rev.push({ kind: 'eq', oldIndex: x, newIndex: y });
    }
    if (d > 0) {
      if (x === prevX) {
        y--;
        rev.push({ kind: 'add', oldIndex: -1, newIndex: y });
      } else {
        x--;
        rev.push({ kind: 'del', oldIndex: x, newIndex: -1 });
      }
    }
    x = prevX;
    y = prevY;
  }
  rev.reverse();
  return rev;
}

/**
 * Diff two sequences of strings. Trims the common prefix/suffix (which is both
 * a large speed-up and what makes the edit-distance cap rarely bite) and runs
 * Myers on what is left.
 */
export function diffSequences(a: readonly string[], b: readonly string[]): SeqOp[] {
  const ops: SeqOp[] = [];
  const limit = Math.min(a.length, b.length);
  let pre = 0;
  while (pre < limit && a[pre] === b[pre]) pre++;
  let endA = a.length;
  let endB = b.length;
  while (endA > pre && endB > pre && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  for (let i = 0; i < pre; i++) ops.push({ kind: 'eq', oldIndex: i, newIndex: i });

  const midA = a.slice(pre, endA);
  const midB = b.slice(pre, endB);
  if (midA.length === 0) {
    for (let j = 0; j < midB.length; j++) ops.push({ kind: 'add', oldIndex: -1, newIndex: pre + j });
  } else if (midB.length === 0) {
    for (let i = 0; i < midA.length; i++) ops.push({ kind: 'del', oldIndex: pre + i, newIndex: -1 });
  } else {
    const mid = myersMiddle(midA, midB);
    if (mid) {
      for (const op of mid) {
        ops.push({
          kind: op.kind,
          oldIndex: op.oldIndex >= 0 ? op.oldIndex + pre : -1,
          newIndex: op.newIndex >= 0 ? op.newIndex + pre : -1,
        });
      }
    } else {
      // Too different to diff cheaply: replace the whole middle region.
      for (let i = 0; i < midA.length; i++) ops.push({ kind: 'del', oldIndex: pre + i, newIndex: -1 });
      for (let j = 0; j < midB.length; j++) ops.push({ kind: 'add', oldIndex: -1, newIndex: pre + j });
    }
  }

  for (let i = 0; i < a.length - endA; i++) {
    ops.push({ kind: 'eq', oldIndex: endA + i, newIndex: endB + i });
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Word-level refinement
// ---------------------------------------------------------------------------

/** Identifier runs, whitespace runs and single punctuation characters. */
const WORD_RE = /[A-Za-z0-9_$]+|\s+|[\s\S]/g;

function tokenizeWords(line: string): string[] {
  WORD_RE.lastIndex = 0;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = WORD_RE.exec(line)) !== null) {
    out.push(m[0]);
    if (m[0].length === 0) break; // defensive: never loop forever
  }
  return out;
}

function pushSegment(into: DiffSegment[], text: string, changed: boolean): void {
  if (text.length === 0) return;
  const last = into[into.length - 1];
  if (last && last.changed === changed) last.text += text;
  else into.push({ text, changed });
}

/**
 * Fill `segments` on a paired deletion/insertion so the UI can highlight the
 * words that actually moved rather than the whole line.
 */
function refinePair(del: DiffLine, add: DiffLine): void {
  const oldText = del.content;
  const newText = add.content;
  if (oldText.length === 0 || newText.length === 0) return;
  if (oldText.length > MAX_REFINE_LINE || newText.length > MAX_REFINE_LINE) return;

  const at = tokenizeWords(oldText);
  const bt = tokenizeWords(newText);
  const ops = diffSequences(at, bt);

  const delSegs: DiffSegment[] = [];
  const addSegs: DiffSegment[] = [];
  let commonChars = 0;
  for (const op of ops) {
    if (op.kind === 'eq') {
      const t = at[op.oldIndex] ?? '';
      pushSegment(delSegs, t, false);
      pushSegment(addSegs, bt[op.newIndex] ?? '', false);
      if (t.trim().length > 0) commonChars += t.length;
    } else if (op.kind === 'del') {
      pushSegment(delSegs, at[op.oldIndex] ?? '', true);
    } else {
      pushSegment(addSegs, bt[op.newIndex] ?? '', true);
    }
  }

  const scale = Math.max(oldText.trim().length, newText.trim().length) || 1;
  if (commonChars / scale < MIN_SIMILARITY) {
    // Effectively a rewrite -- one solid highlight reads better than confetti.
    del.segments = [{ text: oldText, changed: true }];
    add.segments = [{ text: newText, changed: true }];
    return;
  }
  del.segments = delSegs;
  add.segments = addSegs;
}

/**
 * Walk a line list and refine every del-run immediately followed by an add-run.
 * Exported for `parseUnifiedDiff`, which reuses it on parsed hunks.
 */
function refineLines(lines: DiffLine[]): void {
  let i = 0;
  while (i < lines.length) {
    if (lines[i]?.kind !== 'del') {
      i++;
      continue;
    }
    let d = i;
    while (lines[d]?.kind === 'del') d++;
    let a = d;
    while (lines[a]?.kind === 'add') a++;
    const dels = d - i;
    const adds = a - d;
    const pairs = Math.min(dels, adds);
    for (let p = 0; p < pairs; p++) {
      const del = lines[i + p];
      const add = lines[d + p];
      if (del && add) refinePair(del, add);
    }
    i = a > i ? a : i + 1;
  }
}

// ---------------------------------------------------------------------------
// Hunk grouping
// ---------------------------------------------------------------------------

function formatRange(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

function hunkHeader(lines: readonly DiffLine[], fallbackOld: number, fallbackNew: number): string {
  let oldStart = 0;
  let newStart = 0;
  let oldCount = 0;
  let newCount = 0;
  for (const l of lines) {
    if (l.oldNumber !== null) {
      if (oldCount === 0) oldStart = l.oldNumber;
      oldCount++;
    }
    if (l.newNumber !== null) {
      if (newCount === 0) newStart = l.newNumber;
      newCount++;
    }
  }
  if (oldCount === 0) oldStart = fallbackOld;
  if (newCount === 0) newStart = fallbackNew;
  return `@@ -${formatRange(oldStart, oldCount)} +${formatRange(newStart, newCount)} @@`;
}

/**
 * Collect changed lines into hunks with `CONTEXT` lines of context on each
 * side, merging hunks whose context would otherwise overlap. Lines outside any
 * hunk are unchanged context the pane renders as a collapsed gap.
 */
function buildHunks(lines: readonly DiffLine[], context = CONTEXT): DiffHunk[] {
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    const kind = lines[i]?.kind;
    if (kind !== 'add' && kind !== 'del') continue;
    const start = Math.max(0, i - context);
    const end = Math.min(lines.length - 1, i + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }

  return ranges.map(([start, end]) => {
    const slice = lines.slice(start, end + 1);
    // Fallback anchors for an all-add or all-del hunk, git-style.
    let fallbackOld = 0;
    let fallbackNew = 0;
    for (let i = start - 1; i >= 0; i--) {
      const l = lines[i];
      if (l?.oldNumber !== null && l?.oldNumber !== undefined) {
        fallbackOld = l.oldNumber;
        break;
      }
    }
    for (let i = start - 1; i >= 0; i--) {
      const l = lines[i];
      if (l?.newNumber !== null && l?.newNumber !== undefined) {
        fallbackNew = l.newNumber;
        break;
      }
    }
    return { header: hunkHeader(slice, fallbackOld, fallbackNew), lines: slice };
  });
}

// ---------------------------------------------------------------------------
// diffStrings
// ---------------------------------------------------------------------------

function splitLines(text: string): string[] {
  if (text === '') return [];
  const normalized = text.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n');
  // A trailing newline denotes "file ends with a newline", not a final empty line.
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/**
 * Line-level diff of two strings, refined down to the word level inside paired
 * changed lines, grouped into hunks with three lines of context.
 */
export function diffStrings(oldText: string, newText: string, path: string): FileDiff {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = diffSequences(a, b);

  const lines: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (const op of ops) {
    if (op.kind === 'eq') {
      lines.push({
        kind: 'context',
        oldNumber: oldNo++,
        newNumber: newNo++,
        content: a[op.oldIndex] ?? '',
      });
    } else if (op.kind === 'del') {
      lines.push({ kind: 'del', oldNumber: oldNo++, newNumber: null, content: a[op.oldIndex] ?? '' });
    } else {
      lines.push({ kind: 'add', oldNumber: null, newNumber: newNo++, content: b[op.newIndex] ?? '' });
    }
  }

  refineLines(lines);
  return { path, lang: langForPath(path), hunks: buildHunks(lines) };
}

// ---------------------------------------------------------------------------
// Unified diff parsing
// ---------------------------------------------------------------------------

const HUNK_RE = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@+(.*)$/;

const GIT_HEADER_PREFIXES = [
  'old mode ',
  'new mode ',
  'deleted file mode ',
  'new file mode ',
  'copy from ',
  'copy to ',
  'rename from ',
  'rename to ',
  'similarity index ',
  'dissimilarity index ',
  'index ',
  '--- ',
  '+++ ',
  'Binary files ',
  'GIT binary patch',
];

/** `"a/src/some file.ts"` -> `src/some file.ts`; also drops `diff -u` timestamps. */
function normalizeHeaderPath(raw: string): string | null {
  let s = raw.trim();
  if (s.length === 0) return null;
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab).trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    s = s.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  else if (s.startsWith('./')) s = s.slice(2);
  return s.length > 0 ? s : null;
}

/** Best-effort split of `a/foo b/foo` from the `diff --git` line. */
function splitGitPaths(rest: string): [string | null, string | null] {
  const idx = rest.indexOf(' b/');
  if (idx > 0) {
    return [normalizeHeaderPath(rest.slice(0, idx)), normalizeHeaderPath(rest.slice(idx + 1))];
  }
  const parts = rest.split(' ');
  if (parts.length === 2) return [normalizeHeaderPath(parts[0] ?? ''), normalizeHeaderPath(parts[1] ?? '')];
  return [null, null];
}

interface HunkParse {
  hunks: DiffHunk[];
  next: number;
}

function parseHunks(lines: readonly string[], start: number): HunkParse {
  const hunks: DiffHunk[] = [];
  let i = start;
  while (i < lines.length) {
    const head = lines[i];
    if (head === undefined) break;
    const m = HUNK_RE.exec(head);
    if (!m) break;
    let oldNo = Number(m[1]);
    let newNo = Number(m[3]);
    let oldRemain = m[2] === undefined ? 1 : Number(m[2]);
    let newRemain = m[4] === undefined ? 1 : Number(m[4]);
    if (!Number.isFinite(oldNo) || !Number.isFinite(newNo)) break;
    i++;

    const body: DiffLine[] = [];
    while (i < lines.length && (oldRemain > 0 || newRemain > 0)) {
      const l = lines[i];
      if (l === undefined) break;
      const c = l.charAt(0);
      if (c === '\\') {
        // "\ No newline at end of file" -- metadata, not a content line.
        i++;
        continue;
      }
      if (c === '+') {
        body.push({ kind: 'add', oldNumber: null, newNumber: newNo++, content: l.slice(1) });
        newRemain--;
        i++;
        continue;
      }
      if (c === '-') {
        body.push({ kind: 'del', oldNumber: oldNo++, newNumber: null, content: l.slice(1) });
        oldRemain--;
        i++;
        continue;
      }
      if (c === ' ' || l === '') {
        body.push({ kind: 'context', oldNumber: oldNo++, newNumber: newNo++, content: l.slice(1) });
        oldRemain--;
        newRemain--;
        i++;
        continue;
      }
      break; // next hunk, next file, or trailing noise
    }
    refineLines(body);
    hunks.push({ header: head, lines: body });
  }
  return { hunks, next: i };
}

interface FileParse {
  file: FileDiff | null;
  next: number;
}

function parseGitFile(lines: readonly string[], start: number): FileParse {
  const first = lines[start] ?? '';
  const [aPath, bPath] = splitGitPaths(first.slice('diff --git '.length));
  let oldPath = aPath;
  let newPath = bPath;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let binary = false;
  let i = start + 1;

  while (i < lines.length) {
    const l = lines[i];
    if (l === undefined) break;
    if (l.startsWith('@@') || l.startsWith('diff --git ')) break;
    if (!GIT_HEADER_PREFIXES.some((p) => l.startsWith(p))) break;

    if (l.startsWith('--- ')) oldPath = normalizeHeaderPath(l.slice(4)) ?? oldPath;
    else if (l.startsWith('+++ ')) newPath = normalizeHeaderPath(l.slice(4)) ?? newPath;
    else if (l.startsWith('rename from ')) renameFrom = normalizeHeaderPath(l.slice('rename from '.length));
    else if (l.startsWith('rename to ')) renameTo = normalizeHeaderPath(l.slice('rename to '.length));
    else if (l.startsWith('Binary files ') || l.startsWith('GIT binary patch')) {
      binary = true;
      i++;
      while (i < lines.length && !(lines[i] ?? '').startsWith('diff --git ')) i++;
      break;
    }
    i++;
  }

  let hunks: DiffHunk[] = [];
  if (!binary) {
    const parsed = parseHunks(lines, i);
    hunks = parsed.hunks;
    i = parsed.next;
  } else {
    hunks = [
      {
        header: '',
        lines: [{ kind: 'meta', oldNumber: null, newNumber: null, content: 'Binary file not shown' }],
      },
    ];
  }

  const displayPath = renderPath(oldPath, newPath, renameFrom, renameTo);
  if (!displayPath) return { file: null, next: Math.max(i, start + 1) };
  const langPath = renameTo ?? newPath ?? oldPath ?? displayPath;
  return { file: { path: displayPath, lang: langForPath(langPath), hunks }, next: Math.max(i, start + 1) };
}

function renderPath(
  oldPath: string | null,
  newPath: string | null,
  renameFrom: string | null,
  renameTo: string | null,
): string | null {
  if (renameFrom && renameTo) return `${renameFrom} → ${renameTo}`;
  return newPath ?? oldPath ?? renameTo ?? renameFrom;
}

function parsePlainFile(lines: readonly string[], start: number): FileParse {
  const minus = lines[start] ?? '';
  const plus = lines[start + 1] ?? '';
  const oldPath = normalizeHeaderPath(minus.slice(4));
  const newPath = normalizeHeaderPath(plus.slice(4));
  const parsed = parseHunks(lines, start + 2);
  const displayPath = renderPath(oldPath, newPath, null, null);
  if (!displayPath || parsed.hunks.length === 0) {
    return { file: null, next: Math.max(parsed.next, start + 1) };
  }
  return {
    file: { path: displayPath, lang: langForPath(newPath ?? oldPath ?? displayPath), hunks: parsed.hunks },
    next: parsed.next,
  };
}

/**
 * Parse unified diff text -- typically `git diff` run through the Bash tool,
 * so the input may be surrounded by unrelated shell output.
 *
 * This never throws. Anything it cannot make sense of is skipped, and a wholly
 * unparseable input yields `[]`, because a malformed diff must not be able to
 * take the transcript pane down.
 */
export function parseUnifiedDiff(text: string): FileDiff[] {
  try {
    if (typeof text !== 'string' || text.length === 0) return [];
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const out: FileDiff[] = [];
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (l === undefined) break;
      if (l.startsWith('diff --git ')) {
        const r = parseGitFile(lines, i);
        if (r.file) out.push(r.file);
        i = r.next > i ? r.next : i + 1;
        continue;
      }
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        const r = parsePlainFile(lines, i);
        if (r.file) out.push(r.file);
        i = r.next > i ? r.next : i + 1;
        continue;
      }
      i++;
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Language mapping
// ---------------------------------------------------------------------------

const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  vue: 'vue',
  svelte: 'svelte',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  py: 'python',
  pyi: 'python',
  rs: 'rust',
  go: 'go',
  rb: 'ruby',
  php: 'php',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  cs: 'csharp',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  fish: 'shellscript',
  ps1: 'powershell',
  sql: 'sql',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  xml: 'xml',
  svg: 'xml',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'proto',
  lua: 'lua',
  r: 'r',
  ex: 'elixir',
  exs: 'elixir',
  dart: 'dart',
  diff: 'diff',
  patch: 'diff',
  txt: 'text',
  log: 'text',
};

const NAME_LANG: Record<string, string> = {
  dockerfile: 'docker',
  containerfile: 'docker',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  cargo: 'toml',
  '.gitignore': 'ini',
  '.gitattributes': 'ini',
  '.env': 'ini',
  '.bashrc': 'shellscript',
  '.zshrc': 'shellscript',
};

/** Map a file path to a Shiki language id, falling back to `text`. */
export function langForPath(path: string): string {
  if (typeof path !== 'string' || path.length === 0) return 'text';
  // Rename headers carry both sides; language follows the destination.
  const single = path.includes(' → ') ? (path.split(' → ').pop() ?? path) : path;
  const base = (single.split(/[\\/]/).pop() ?? single).trim();
  const lower = base.toLowerCase();
  const byName = NAME_LANG[lower];
  if (byName) return byName;
  const dot = lower.lastIndexOf('.');
  if (dot <= 0) {
    // Dotfiles (".env") and extensionless names ("Makefile").
    return NAME_LANG[lower] ?? 'text';
  }
  const ext = lower.slice(dot + 1);
  return EXT_LANG[ext] ?? 'text';
}
