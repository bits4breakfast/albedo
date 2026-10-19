/**
 * The one diff component.
 *
 * Used by the Edit/Write/MultiEdit renderer (via `diffStrings`) and by the
 * `git diff` renderer (via `parseUnifiedDiff`). There is deliberately no second
 * implementation: every diff in the app looks and behaves the same.
 *
 * Layout is driven by the *container* width through a ResizeObserver, not a
 * media query, because this lives inside a pane the user drags around.
 *
 * Syntax colour and change colour are composed rather than stacked: Shiki gives
 * us tokens, the diff gives us word-level segments, and `composePieces` splits
 * the tokens at the segment boundaries so a single span carries both the
 * token's colour and the segment's changed flag.
 *
 * This file also hosts the shared path-link primitives (`useOpenPath`,
 * `PathLink`, `LinkifiedText`). They live here because it is the only module in
 * the transcript that both the chip and the row renderers import and that knows
 * nothing about `Message` -- putting them in ToolChip.tsx would point the
 * dependency graph backwards.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode, RefObject } from 'react';
import type { DiffHunk, DiffLine, DiffSegment, FileDiff, OpenFileRequest } from '../../types';
import { highlightToTokens, peekTokens, plainTokens } from '../../lib/highlight';
import type { DualToken } from '../../lib/highlight';
import { parsePathRef } from '../../lib/paths';
import { openExternal } from '../../lib/openUrl';
import { splitUrls } from '../../lib/urls';
import { useOpenFile } from '../editor/openFile';
import { anchorBlock, fileLines, type AnchorFailure } from '../../lib/anchor';
import { useReadFile } from '../editor/openFile';
import './transcript.css';

/** Below this container width the side-by-side layout stops being readable. */
const SIDE_BY_SIDE_MIN = 860;

/** Rows rendered before the "show more" break. */
const INITIAL_BUDGET = 320;
const BUDGET_STEP = 800;

/** Lines of surrounding file revealed per click, as GitHub's gutter does it. */
const CONTEXT_STEP = 20;

/** Past this many lines, highlighting a blob costs more than it gives. */
const MAX_HIGHLIGHT_LINES = 6000;

/** Beyond this, scanning every line of a tool result for paths is not worth it. */
const MAX_LINKIFY_LINES = 2000;
const MAX_LINKIFY_CHARS = 400_000;

// ---------------------------------------------------------------------------
// Opening files
// ---------------------------------------------------------------------------

/**
 * Ask the app to open a path seen in the transcript.
 *
 * The raw path goes straight through to `useOpenFile`: resolution against the
 * task's worktree happens in `resolveInWorktree`, which is a security boundary.
 * A transcript is data we render, so nothing here may join a transcript path to
 * a filesystem path or decide that one looks safe.
 *
 * Opening is best-effort. If no provider is mounted, or the editor throws, the
 * link quietly does nothing rather than taking the pane down with it.
 */
export function useOpenPath(): (path: string, line?: number | null) => void {
  let open: ((req: OpenFileRequest) => void) | null = null;
  try {
    open = useOpenFile();
  } catch {
    open = null; // no provider (tests, or the editor not mounted yet)
  }
  return useCallback(
    (path: string, line: number | null = null) => {
      if (typeof open !== 'function') return;
      if (typeof path !== 'string' || path.trim().length === 0) return;
      try {
        open({ path, line });
      } catch {
        /* the editor is not allowed to break rendering */
      }
    },
    [open],
  );
}

/**
 * Click handling that coexists with text selection.
 *
 * The pane re-enables `user-select: text` precisely so people can copy code out
 * of it, so a link must not steal a drag that was a selection gesture. A click
 * only activates when the pointer barely moved and nothing is selected.
 */
export function useActivate(onActivate: () => void): {
  onMouseDown: (e: ReactMouseEvent) => void;
  onClick: (e: ReactMouseEvent) => void;
} {
  const downRef = useRef<{ x: number; y: number } | null>(null);
  return {
    onMouseDown: (e: ReactMouseEvent) => {
      downRef.current = { x: e.clientX, y: e.clientY };
    },
    onClick: (e: ReactMouseEvent) => {
      const down = downRef.current;
      downRef.current = null;
      if (down && (Math.abs(e.clientX - down.x) > 3 || Math.abs(e.clientY - down.y) > 3)) return;
      try {
        const sel = window.getSelection?.();
        if (sel && !sel.isCollapsed && sel.toString().length > 0) return;
      } catch {
        /* selection API unavailable; fall through and treat it as a click */
      }
      e.preventDefault();
      e.stopPropagation();
      onActivate();
    },
  };
}

export interface PathLinkProps {
  /** Path exactly as it appeared in the transcript. Never pre-resolved. */
  path: string;
  line?: number | null;
  className?: string;
  title?: string;
  /** Visible text; defaults to the path itself. */
  children?: ReactNode;
  /**
   * Keyboard-reachable. Off for the per-line affordances inside a diff, which
   * would otherwise add two tab stops per line to a 5000-line diff; the file is
   * still reachable from the diff header link.
   */
  focusable?: boolean;
}

export function PathLink({
  path,
  line = null,
  className,
  title,
  children,
  focusable = true,
}: PathLinkProps): ReactNode {
  const openPath = useOpenPath();
  const handlers = useActivate(() => openPath(path, line));
  return (
    <span
      className={`tx-link${className ? ` ${className}` : ''}`}
      role="link"
      tabIndex={focusable ? 0 : -1}
      title={title ?? (line !== null ? `${path}:${line}` : path)}
      onMouseDown={handlers.onMouseDown}
      onClick={handlers.onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openPath(path, line);
        }
      }}
    >
      {children ?? path}
    </span>
  );
}

/**
 * A web link. Opens in the default browser; only http(s) ever reaches here
 * (callers check, and `openExternal` refuses anything else). The visible text
 * is whatever the caller shows, so the real address is always in the tooltip.
 */
export function ExternalLink({
  url,
  className,
  children,
}: {
  url: string;
  className?: string;
  children?: ReactNode;
}): ReactNode {
  const handlers = useActivate(() => void openExternal(url));
  return (
    <span
      className={`tx-url${className ? ` ${className}` : ''}`}
      role="link"
      tabIndex={0}
      title={url}
      onMouseDown={handlers.onMouseDown}
      onClick={handlers.onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          void openExternal(url);
        }
      }}
    >
      {children ?? url}
    </span>
  );
}

/**
 * Render text, turning path references into links.
 *
 * Extraction is delegated to `parsePathRef` -- one line at a time, because that
 * is the shape of a stack trace and the parser answers per fragment. When it
 * returns null the line renders as plain text; being conservative matters more
 * than catching every path, since a false positive makes ordinary prose look
 * broken.
 *
 * Locating the parsed path inside the line with `indexOf` is presentation, not
 * parsing: we only need to know which characters to wrap. If it is not found
 * verbatim, the line stays plain.
 */
export function LinkifiedText({ text, className }: { text: string; className?: string }): ReactNode {
  const nodes = useMemo(() => linkifyLines(text), [text]);
  return <span className={className}>{nodes}</span>;
}

function linkifyLines(text: string): ReactNode[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const lines = text.split('\n');
  if (lines.length > MAX_LINKIFY_LINES || text.length > MAX_LINKIFY_CHARS) return [text];

  const out: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const suffix = i < lines.length - 1 ? '\n' : '';
    // A line with a web URL is linked as URLs; path detection would otherwise
    // read `//host/path` out of it.
    const parts = line.includes('://') ? splitUrls(line) : null;
    if (parts && parts.some((p) => typeof p !== 'string')) {
      parts.forEach((p, k) => {
        out.push(typeof p === 'string' ? p : <ExternalLink key={`${i}-u${k}`} url={p.url} />);
      });
      if (suffix) out.push(suffix);
      continue;
    }
    let ref: { path: string; line: number | null } | null = null;
    try {
      ref = parsePathRef(line);
    } catch {
      ref = null;
    }
    const at = ref && ref.path.length > 0 ? line.indexOf(ref.path) : -1;
    if (!ref || at < 0) {
      out.push(line + suffix);
      continue;
    }
    // Extend the link over a trailing :line[:col] so the whole reference is one target.
    let end = at + ref.path.length;
    const trailing = /^:\d+(?::\d+)?/.exec(line.slice(end));
    if (ref.line !== null && trailing) end += trailing[0].length;

    if (at > 0) out.push(line.slice(0, at));
    out.push(
      <PathLink key={`${i}-${at}`} path={ref.path} line={ref.line}>
        {line.slice(at, end)}
      </PathLink>,
    );
    out.push(line.slice(end) + suffix);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Token plumbing
// ---------------------------------------------------------------------------

/**
 * Tokenize a blob, re-rendering when the async result lands. Starts from the
 * cache so an already-seen blob paints highlighted on the first frame.
 */
export function useCodeTokens(text: string, lang: string): DualToken[][] {
  const tooBig = useMemo(() => text.length > 0 && countLines(text) > MAX_HIGHLIGHT_LINES, [text]);
  const [tokens, setTokens] = useState<DualToken[][]>(
    () => (tooBig ? plainTokens(text) : peekTokens(text, lang)) ?? plainTokens(text),
  );

  useEffect(() => {
    if (tooBig) {
      setTokens(plainTokens(text));
      return;
    }
    const cached = peekTokens(text, lang);
    if (cached) {
      setTokens(cached);
      return;
    }
    let live = true;
    setTokens(plainTokens(text));
    void highlightToTokens(text, lang).then((t) => {
      if (live) setTokens(t);
    });
    return () => {
      live = false;
    };
  }, [text, lang, tooBig]);

  return tokens;
}

/** Split a source text the same way `diffStrings` does, so line numbers agree. */
function sourceLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.replace(/\r\n/g, '\n').split('\n');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function countLines(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

interface Piece {
  text: string;
  style: Record<string, string>;
  changed: boolean;
}

/** Normalise a token line so its text covers exactly `content`. */
function normaliseTokens(content: string, tokens: DualToken[] | undefined): Array<{ text: string; style: Record<string, string> }> {
  const out: Array<{ text: string; style: Record<string, string> }> = [];
  let used = 0;
  for (const t of tokens ?? []) {
    if (used >= content.length) break;
    const text = t.content.length > content.length - used ? content.slice(used, content.length) : t.content;
    if (text.length === 0) continue;
    out.push({ text, style: t.style });
    used += text.length;
  }
  if (used < content.length) out.push({ text: content.slice(used), style: {} });
  return out;
}

/**
 * Split syntax tokens at word-level change boundaries.
 *
 * Both layers survive: each returned piece keeps the colour of the token it
 * came from and the changed flag of the segment it falls in. Without this split
 * the two would fight -- either the change background would swallow the syntax
 * colours, or the word highlight would have to be a sibling element that cannot
 * line up with token boundaries.
 */
export function composePieces(
  content: string,
  tokens: DualToken[] | undefined,
  segments: DiffSegment[] | undefined,
): Piece[] {
  const toks = normaliseTokens(content, tokens);
  if (!segments || segments.length === 0) {
    return toks.map((t) => ({ text: t.text, style: t.style, changed: false }));
  }

  const flags = new Uint8Array(content.length);
  let off = 0;
  for (const s of segments) {
    const end = Math.min(content.length, off + s.text.length);
    if (s.changed && end > off) flags.fill(1, off, end);
    off = end;
    if (off >= content.length) break;
  }

  const out: Piece[] = [];
  let pos = 0;
  for (const t of toks) {
    let start = 0;
    while (start < t.text.length) {
      const flag = flags[pos + start] ?? 0;
      let end = start + 1;
      while (end < t.text.length && (flags[pos + end] ?? 0) === flag) end++;
      out.push({ text: t.text.slice(start, end), style: t.style, changed: flag === 1 });
      start = end;
    }
    pos += t.text.length;
  }
  return out;
}

export function Code({ pieces }: { pieces: Piece[] }): ReactNode {
  if (pieces.length === 0) return <span className="tx-d-code" />;
  return (
    <span className="tx-d-code">
      {pieces.map((p, i) => (
        <span key={i} className={p.changed ? 'tx-tok tx-d-word' : 'tx-tok'} style={p.style as CSSProperties}>
          {p.text}
        </span>
      ))}
    </span>
  );
}

/**
 * The disclosure caret, everywhere something in the pane opens.
 *
 * One component rather than a glyph typed at each site, so the next collapsible
 * thing inherits the right size instead of the wrong one. It is a control, not
 * decoration: `--muted`, a size ABOVE the text it sits beside, and a 24x24 hit
 * target regardless of how small the glyph looks.
 *
 * Quiet means subordinate, not invisible -- and that applies to the CONTENT a
 * thing hides, never to the control that reveals it. Thinking blocks and
 * injected context are de-emphasised on purpose; the caret that opens them is
 * not, or nobody finds out the content is there at all.
 */
export function Disclosure({ open }: { open: boolean }): ReactNode {
  return (
    <span className="tx-disc" aria-hidden="true">
      {open ? '▾' : '▸'}
    </span>
  );
}

/**
 * A block of code, highlighted, one element per line. Shared by the markdown
 * renderer and the tool chip so every code surface in the pane looks the same.
 */
export function CodeLines({ code, lang, className }: { code: string; lang: string; className?: string }): ReactNode {
  const tokens = useCodeTokens(code, lang);
  const lines = useMemo(() => code.split('\n'), [code]);
  return (
    <pre className={`tx-pre tx-pre-code${className ? ` ${className}` : ''}`}>
      {lines.map((line, i) => (
        <div className="tx-md-pre-line" key={i}>
          <Code pieces={composePieces(line, tokens[i], undefined)} />
        </div>
      ))}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Render model
// ---------------------------------------------------------------------------

interface Row {
  line: DiffLine;
  /** Index into the old-side / new-side token blob, or -1. */
  oldRow: number;
  newRow: number;
}

interface HunkModel {
  header: string;
  rows: Row[];
}

interface Model {
  hunks: HunkModel[];
  oldBlob: string;
  newBlob: string;
  added: number;
  removed: number;
  total: number;
}

function buildModel(hunks: readonly DiffHunk[]): Model {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const out: HunkModel[] = [];
  let added = 0;
  let removed = 0;
  let total = 0;

  for (const h of hunks) {
    const rows: Row[] = [];
    for (const line of h.lines) {
      let oldRow = -1;
      let newRow = -1;
      if (line.kind === 'del' || line.kind === 'context') {
        oldRow = oldLines.length;
        oldLines.push(line.content);
      }
      if (line.kind === 'add' || line.kind === 'context') {
        newRow = newLines.length;
        newLines.push(line.content);
      }
      if (line.kind === 'add') added++;
      if (line.kind === 'del') removed++;
      rows.push({ line, oldRow, newRow });
      total++;
    }
    out.push({ header: h.header, rows });
  }

  return { hunks: out, oldBlob: oldLines.join('\n'), newBlob: newLines.join('\n'), added, removed, total };
}

/** Pair a del-run with the following add-run so side-by-side lines up. */
interface PairRow {
  left: Row | null;
  right: Row | null;
}

function pairRows(rows: readonly Row[]): PairRow[] {
  const out: PairRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (!row) break;
    if (row.line.kind === 'context' || row.line.kind === 'meta') {
      out.push({ left: row, right: row.line.kind === 'meta' ? null : row });
      i++;
      continue;
    }
    let d = i;
    while (rows[d]?.line.kind === 'del') d++;
    let a = d;
    while (rows[a]?.line.kind === 'add') a++;
    const dels = rows.slice(i, d);
    const adds = rows.slice(d, a);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) out.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    i = a > i ? a : i + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Collapsed unchanged regions
// ---------------------------------------------------------------------------

interface Gap {
  /** First hidden line, 1-based, on each side. */
  oldStart: number;
  newStart: number;
  count: number;
}

function gapBefore(hunk: HunkModel | undefined, prev: HunkModel | undefined): Gap | null {
  if (!hunk) return null;
  const firstOld = hunk.rows.find((r) => r.line.oldNumber !== null)?.line.oldNumber ?? null;
  const firstNew = hunk.rows.find((r) => r.line.newNumber !== null)?.line.newNumber ?? null;
  if (firstOld === null || firstNew === null) return null;

  let prevOld = 0;
  let prevNew = 0;
  if (prev) {
    for (const r of prev.rows) {
      if (r.line.oldNumber !== null) prevOld = Math.max(prevOld, r.line.oldNumber);
      if (r.line.newNumber !== null) prevNew = Math.max(prevNew, r.line.newNumber);
    }
  }
  const count = firstNew - prevNew - 1;
  if (count <= 0) return null;
  return { oldStart: prevOld + 1, newStart: prevNew + 1, count };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function useContainerWidth(): [RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof ResizeObserver === 'undefined') {
      setWidth(el.clientWidth);
      return;
    }
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface DiffProps {
  diff: FileDiff;
  /**
   * Both full texts, when the caller has them (an Edit tool call does). Without
   * them a collapsed region can still be shown, but not expanded -- the hidden
   * lines simply are not in a `git diff`.
   */
  expand?: { oldText: string; newText: string } | null;
  /** Forces a layout instead of deriving it from the container width. */
  layout?: 'auto' | 'split' | 'unified';
  /**
   * True when the diff's line numbers are real file lines, which makes them
   * safe to open at. A `git diff` qualifies; an Edit tool call does NOT -- its
   * `old_string`/`new_string` are fragments, so line 1 is the first line of the
   * fragment, not of the file. Opening at a fragment offset would land the user
   * somewhere arbitrary, so per-line links stay off unless the caller says so.
   */
  absoluteLines?: boolean;
  /**
   * Path to read for context BEYOND the diff, or null to offer none.
   *
   * Passed to `useReadFile`, which resolves it: this component never joins a
   * transcript path to a filesystem path (see `useOpenPath`).
   *
   * Omitted means "the diff's own path". Explicit null is honoured as none: the
   * editor's Diff mode passes it, because it hands over both WHOLE files in
   * `expand` and the gaps already reach every line there is -- a "more
   * context" bar on top would read the file only to find nothing left.
   */
  contextPath?: string | null;
}

export function Diff({
  diff,
  expand = null,
  layout = 'auto',
  absoluteLines = false,
  contextPath,
}: DiffProps): ReactNode {
  const [ref, width] = useContainerWidth();
  const [override, setOverride] = useState<'split' | 'unified' | null>(null);
  const [budget, setBudget] = useState(INITIAL_BUDGET);
  const [openGaps, setOpenGaps] = useState<Record<number, boolean>>({});

  const model = useMemo(() => buildModel(diff.hunks), [diff]);
  const oldTokens = useCodeTokens(model.oldBlob, diff.lang);
  const newTokens = useCodeTokens(model.newBlob, diff.lang);

  const resolved: 'split' | 'unified' =
    layout !== 'auto' ? layout : (override ?? (width >= SIDE_BY_SIDE_MIN ? 'split' : 'unified'));

  // Per-line links only when the numbers are real file lines (see `absoluteLines`).
  // A rename's destination is the file that exists.
  const linkPath = absoluteLines
    ? (diff.path.includes(' → ') ? (diff.path.split(' → ').pop() ?? diff.path) : diff.path)
    : null;

  const expandOld = useMemo(() => (expand ? sourceLines(expand.oldText) : null), [expand]);
  const expandNew = useMemo(() => (expand ? sourceLines(expand.newText) : null), [expand]);

  /*
   * ---------------------------------------------------------------------
   * Context beyond the diff, read from the file as it is NOW
   * ---------------------------------------------------------------------
   *
   * The gaps above use `expand`, which is the Edit call's own old/new strings
   * -- so they can only ever reveal what is already inside the fragment. To
   * see what surrounds the fragment there is exactly one source: the file.
   *
   * That file is the present and the diff is history, so the lines are offered
   * only once the hunk's own content has been FOUND VERBATIM in it (see
   * lib/anchor.ts). Anchoring proves the lines we are about to show really do
   * sit next to the lines in the hunk. It does not prove they were there when
   * the edit was made, which is why the revealed rows are numbered by the
   * current file and the bar says where they came from.
   */
  const readFile = useReadFile();
  const [file, setFile] = useState<readonly string[] | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [loading, setLoading] = useState(false);
  const [leadShown, setLeadShown] = useState(0);
  const [trailShown, setTrailShown] = useState(0);

  // A rename's destination is the file that exists to be read.
  const readPath =
    contextPath !== undefined
      ? contextPath
      : diff.path.includes(' → ')
        ? (diff.path.split(' → ').pop() ?? null)
        : diff.path;

  /**
   * Where the diff's content sits in the current file.
   *
   * Two modes, because the two diff sources have different extents. An Edit
   * call carries its whole fragment, so the fragment is anchored as one block
   * and the existing in-fragment gaps keep doing their job untouched. A `git
   * diff` carries only hunks, so each hunk is anchored on its own -- a file
   * that shifted between them still resolves.
   */
  const covered = useMemo((): { start: number; end: number } | AnchorFailure | null => {
    if (file === null) return null;
    if (expandNew !== null) {
      const a = anchorBlock(file, expandNew);
      return a.ok ? { start: a.offset, end: a.offset + expandNew.length } : a.reason;
    }
    let start: number | null = null;
    let end = 0;
    for (const h of model.hunks) {
      const block = h.rows.filter((r) => r.newRow >= 0).map((r) => r.line.content);
      if (block.length === 0) continue;
      const hint = absoluteLines
        ? (h.rows.find((r) => r.line.newNumber !== null)?.line.newNumber ?? null)
        : null;
      const a = anchorBlock(file, block, hint);
      if (!a.ok) return a.reason;
      if (start === null) start = a.offset;
      end = a.offset + block.length;
    }
    return start === null ? 'empty' : { start, end };
  }, [file, expandNew, model, absoluteLines]);

  const span = typeof covered === 'object' && covered !== null ? covered : null;
  const anchorFailure = typeof covered === 'string' ? covered : null;
  const leadAvailable = span ? span.start : 0;
  const trailAvailable = span && file ? file.length - span.end : 0;

  const revealContext = useCallback(
    async (side: 'lead' | 'trail') => {
      const grow = side === 'lead' ? setLeadShown : setTrailShown;
      if (file !== null) {
        grow((n) => n + CONTEXT_STEP);
        return;
      }
      if (loading || readPath === null) return;
      setLoading(true);
      try {
        const text = await readFile(readPath);
        if (text === null) setUnreadable(true);
        else {
          setFile(fileLines(text));
          grow((n) => n + CONTEXT_STEP);
        }
      } catch {
        setUnreadable(true);
      } finally {
        setLoading(false);
      }
    },
    [file, loading, readFile, readPath],
  );

  const toggleGap = useCallback((i: number) => {
    setOpenGaps((prev) => ({ ...prev, [i]: !prev[i] }));
  }, []);

  if (diff.hunks.length === 0) {
    return (
      <div className="tx-d" ref={ref}>
        <DiffHeader diff={diff} model={model} resolved={resolved} onToggle={null} />
        <div className="tx-d-empty">No content changes</div>
      </div>
    );
  }

  // Budgeted rendering: a 5000-line `git diff` must not lock the webview.
  let spent = 0;
  const body: ReactNode[] = [];

  for (let hi = 0; hi < model.hunks.length; hi++) {
    const hunk = model.hunks[hi];
    if (!hunk) continue;
    if (spent >= budget) break;

    const gap = gapBefore(hunk, model.hunks[hi - 1]);
    if (gap) {
      const open = openGaps[hi] === true;
      body.push(
        <GapBar
          key={`gap-${hi}`}
          gap={gap}
          open={open}
          expandable={expandNew !== null}
          onClick={() => toggleGap(hi)}
        />,
      );
      if (open && expandOld && expandNew) {
        body.push(
          <GapLines
            key={`gaplines-${hi}`}
            gap={gap}
            oldSource={expandOld}
            newSource={expandNew}
            lang={diff.lang}
            split={resolved === 'split'}
            linkPath={linkPath}
          />,
        );
      }
    }

    const remaining = budget - spent;
    const rows = hunk.rows.length > remaining ? hunk.rows.slice(0, remaining) : hunk.rows;
    spent += rows.length;

    body.push(
      <div className="tx-d-hunk" key={`h-${hi}`}>
        {hunk.header ? <div className="tx-d-hunk-head">{hunk.header}</div> : null}
        {resolved === 'split' ? (
          <SplitBody rows={rows} oldTokens={oldTokens} newTokens={newTokens} linkPath={linkPath} />
        ) : (
          <UnifiedBody rows={rows} oldTokens={oldTokens} newTokens={newTokens} linkPath={linkPath} />
        )}
      </div>,
    );
  }

  // Trailing unchanged region, when we know how long the file actually is.
  if (spent < budget && expandNew && expandOld) {
    const last = model.hunks[model.hunks.length - 1];
    let lastOld = 0;
    let lastNew = 0;
    for (const r of last?.rows ?? []) {
      if (r.line.oldNumber !== null) lastOld = Math.max(lastOld, r.line.oldNumber);
      if (r.line.newNumber !== null) lastNew = Math.max(lastNew, r.line.newNumber);
    }
    const count = expandNew.length - lastNew;
    if (count > 0) {
      const key = model.hunks.length;
      const open = openGaps[key] === true;
      body.push(
        <GapBar
          key="gap-tail"
          gap={{ oldStart: lastOld + 1, newStart: lastNew + 1, count }}
          open={open}
          expandable
          onClick={() => toggleGap(key)}
        />,
      );
      if (open) {
        body.push(
          <GapLines
            key="gaplines-tail"
            gap={{ oldStart: lastOld + 1, newStart: lastNew + 1, count }}
            oldSource={expandOld}
            newSource={expandNew}
            lang={diff.lang}
            split={resolved === 'split'}
            linkPath={linkPath}
          />,
        );
      }
    }
  }

  const shown = spent;
  const hidden = model.total - shown;

  /*
   * Offered optimistically, before the file is read. Whether there is anything
   * above or below cannot be known without reading it, and reading a file for
   * every diff in a long transcript to decide whether to draw a bar is the
   * wrong trade -- a transcript can hold hundreds. The bar reports honestly
   * once clicked, including when the answer is "this file has changed since".
   */
  const offerContext = readPath !== null;

  return (
    <div className="tx-d" ref={ref}>
      <DiffHeader
        diff={diff}
        model={model}
        resolved={resolved}
        onToggle={layout === 'auto' ? () => setOverride(resolved === 'split' ? 'unified' : 'split') : null}
      />
      <div className="tx-d-body">
        {offerContext ? (
          <ContextRegion
            side="lead"
            shown={Math.min(leadShown, leadAvailable)}
            available={leadAvailable}
            loaded={file !== null}
            loading={loading}
            failure={unreadable ? 'unreadable' : anchorFailure}
            file={file}
            from={span ? span.start - Math.min(leadShown, leadAvailable) : 0}
            lang={diff.lang}
            split={resolved === 'split'}
            linkPath={linkPath}
            onExpand={() => void revealContext('lead')}
          />
        ) : null}
        {body}
        {offerContext ? (
          <ContextRegion
            side="trail"
            shown={Math.min(trailShown, trailAvailable)}
            available={trailAvailable}
            loaded={file !== null}
            loading={loading}
            failure={unreadable ? 'unreadable' : anchorFailure}
            file={file}
            from={span ? span.end : 0}
            lang={diff.lang}
            split={resolved === 'split'}
            linkPath={linkPath}
            onExpand={() => void revealContext('trail')}
          />
        ) : null}
      </div>
      {hidden > 0 ? (
        <div className="tx-d-more">
          <span className="tx-d-more-label">{hidden.toLocaleString()} more lines</span>
          <button type="button" className="tx-btn" onClick={() => setBudget((b) => b + BUDGET_STEP)}>
            Show {Math.min(BUDGET_STEP, hidden).toLocaleString()} more
          </button>
          <button type="button" className="tx-btn" onClick={() => setBudget(model.total)}>
            Show all
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default Diff;

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function DiffHeader({
  diff,
  model,
  resolved,
  onToggle,
}: {
  diff: FileDiff;
  model: Model;
  resolved: 'split' | 'unified';
  onToggle: (() => void) | null;
}): ReactNode {
  // A rename header reads "old → new". Both sides stay visible, but only the
  // destination is a link: the source no longer exists to open.
  const renamed = diff.path.includes(' → ');
  const target = renamed ? (diff.path.split(' → ').pop() ?? diff.path) : diff.path;
  const from = renamed ? diff.path.slice(0, diff.path.length - target.length) : '';
  const base = target.split('/').pop() ?? target;
  return (
    <div className="tx-d-head">
      <span className="tx-d-path" title={diff.path}>
        {renamed ? <span className="tx-d-dir">{from}</span> : null}
        <PathLink path={target} title={target}>
          <span className="tx-d-dir">{target.slice(0, target.length - base.length)}</span>
          <span className="tx-d-base">{base}</span>
        </PathLink>
      </span>
      <span className="tx-d-stat">
        {model.added > 0 ? <span className="tx-d-plus">+{model.added}</span> : null}
        {model.removed > 0 ? <span className="tx-d-minus">-{model.removed}</span> : null}
      </span>
      {onToggle ? (
        <button type="button" className="tx-btn tx-d-layout" onClick={onToggle}>
          {resolved === 'split' ? 'unified' : 'split'}
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

/**
 * A line number, clickable when it refers to a real line of a real file.
 * `focusable={false}`: two tab stops per line would make a large diff
 * unnavigable by keyboard, and the file is already reachable from the header.
 */
function LineNo({ n, linkPath }: { n: number | null; linkPath: string | null }): ReactNode {
  if (n === null) return <span className="tx-d-n" />;
  if (linkPath === null) return <span className="tx-d-n">{n}</span>;
  return (
    <PathLink path={linkPath} line={n} className="tx-d-n tx-d-n-link" title={`${linkPath}:${n}`} focusable={false}>
      {n}
    </PathLink>
  );
}

function UnifiedBody({
  rows,
  oldTokens,
  newTokens,
  linkPath = null,
}: {
  rows: readonly Row[];
  oldTokens: DualToken[][];
  newTokens: DualToken[][];
  linkPath?: string | null;
}): ReactNode {
  return (
    <div className="tx-d-rows tx-d-unified">
      {rows.map((r, i) => {
        const tokens = r.line.kind === 'add' ? newTokens[r.newRow] : oldTokens[r.oldRow];
        return (
          <div className={`tx-d-row tx-d-${r.line.kind}`} key={i}>
            <LineNo n={r.line.oldNumber} linkPath={null} />
            <LineNo n={r.line.newNumber} linkPath={linkPath} />
            <span className="tx-d-mark">{r.line.kind === 'add' ? '+' : r.line.kind === 'del' ? '-' : ' '}</span>
            <Code pieces={composePieces(r.line.content, tokens, r.line.segments)} />
          </div>
        );
      })}
    </div>
  );
}

function SplitBody({
  rows,
  oldTokens,
  newTokens,
  linkPath = null,
}: {
  rows: readonly Row[];
  oldTokens: DualToken[][];
  newTokens: DualToken[][];
  linkPath?: string | null;
}): ReactNode {
  const pairs = useMemo(() => pairRows(rows), [rows]);
  return (
    <div className="tx-d-rows tx-d-split">
      {pairs.map((p, i) => (
        <div className="tx-d-pair" key={i}>
          <div className={`tx-d-half tx-d-${p.left ? p.left.line.kind : 'blank'}`}>
            {p.left ? (
              <>
                <LineNo n={p.left.line.oldNumber} linkPath={null} />
                <Code pieces={composePieces(p.left.line.content, oldTokens[p.left.oldRow], p.left.line.segments)} />
              </>
            ) : (
              <span className="tx-d-n" />
            )}
          </div>
          <div className={`tx-d-half tx-d-${p.right ? p.right.line.kind : 'blank'}`}>
            {p.right ? (
              <>
                <LineNo n={p.right.line.newNumber} linkPath={linkPath} />
                <Code pieces={composePieces(p.right.line.content, newTokens[p.right.newRow], p.right.line.segments)} />
              </>
            ) : (
              <span className="tx-d-n" />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collapsed regions
// ---------------------------------------------------------------------------

function GapBar({
  gap,
  open,
  expandable,
  onClick,
}: {
  gap: Gap;
  open: boolean;
  expandable: boolean;
  onClick: () => void;
}): ReactNode {
  const label = `${gap.count.toLocaleString()} unchanged line${gap.count === 1 ? '' : 's'}`;
  /*
     Two different glyphs, on purpose. A caret means "you can open this", so the
     expandable bar uses the pane's one disclosure vocabulary. The static bar is
     NOT a control -- a `git diff` simply does not carry the hidden lines, and
     nothing will reveal them -- so it keeps the ellipsis, which says "there is
     more here" without promising a click will do anything.
  */
  if (!expandable) return <div className="tx-d-gap tx-d-gap-static">⋯ {label}</div>;
  return (
    <button type="button" className="tx-d-gap" onClick={onClick} aria-expanded={open}>
      <Disclosure open={open} /> {label}
    </button>
  );
}

/**
 * Context above or below the diff, taken from the file as it is now.
 *
 * Three states, and the interesting one is the third:
 *
 *  - not yet read: a live bar, because whether anything surrounds the hunk is
 *    not knowable without reading the file;
 *  - read and anchored: a bar that reveals `CONTEXT_STEP` more lines a click,
 *    reporting how many are left;
 *  - read and NOT anchored: a static note saying why. The hunk's own lines are
 *    no longer in the file, so anything shown around them would be a file that
 *    never existed. Saying "this file has changed since" is the whole point --
 *    it is also the more useful fact.
 */
function ContextRegion({
  side,
  shown,
  available,
  loaded,
  loading,
  failure,
  file,
  from,
  lang,
  split,
  linkPath,
  onExpand,
}: {
  side: 'lead' | 'trail';
  shown: number;
  available: number;
  loaded: boolean;
  loading: boolean;
  failure: AnchorFailure | 'unreadable' | null;
  file: readonly string[] | null;
  from: number;
  lang: string;
  split: boolean;
  linkPath: string | null;
  onExpand: () => void;
}): ReactNode {
  if (failure !== null) {
    /*
     * Not gated on `loaded`: an unreadable file never sets `file`, so gating
     * on it swallowed the one message the user most needs. Both failures are
     * reachable only after a read was attempted -- `unreadable` by definition,
     * and an anchor failure because it is derived from loaded content.
     */
    if (side === 'trail') return null;
    return <div className="tx-d-gap tx-d-gap-static">{contextFailureText(failure)}</div>;
  }

  const lines = loaded && file !== null && shown > 0 ? file.slice(from, from + shown) : [];
  const remaining = loaded ? available - shown : null;
  if (loaded && remaining !== null && remaining <= 0 && lines.length === 0) return null;

  const bar =
    remaining !== null && remaining <= 0 ? null : (
      <button
        type="button"
        className="tx-d-gap tx-d-gap-context"
        onClick={onExpand}
        disabled={loading}
        title="Lines from the file as it is now, shown only where they still match this diff"
      >
        {side === 'lead' ? '↑' : '↓'}{' '}
        {loading
          ? 'reading file…'
          : remaining === null
            ? 'more context'
            : `${Math.min(CONTEXT_STEP, remaining)} more line${Math.min(CONTEXT_STEP, remaining) === 1 ? '' : 's'} (${remaining.toLocaleString()} left)`}
      </button>
    );

  const body = lines.length > 0 ? (
    <ContextLines lines={lines} firstNumber={from + 1} lang={lang} split={split} linkPath={linkPath} />
  ) : null;

  return side === 'lead' ? (
    <>
      {bar}
      {body}
    </>
  ) : (
    <>
      {body}
      {bar}
    </>
  );
}

function contextFailureText(failure: AnchorFailure | 'unreadable'): string {
  switch (failure) {
    case 'unreadable':
      return '⋯ the file could not be read from this worktree';
    case 'not-found':
      return '⋯ this file has changed since — no surrounding context can be shown';
    case 'ambiguous':
      return '⋯ these lines appear more than once in the file — context would be a guess';
    default:
      return '⋯ no surrounding context available';
  }
}

/**
 * Unchanged rows read from the current file.
 *
 * Numbered by the CURRENT file, which is what they are. When the file has not
 * moved since the diff these run continuously into the hunk, which is the
 * common case; when it has, the numbers disagree with the hunk's and that
 * disagreement is true and worth seeing.
 */
function ContextLines({
  lines,
  firstNumber,
  lang,
  split,
  linkPath,
}: {
  lines: readonly string[];
  firstNumber: number;
  lang: string;
  split: boolean;
  linkPath: string | null;
}): ReactNode {
  const diffLines = useMemo<DiffLine[]>(
    () =>
      lines.map((content, i) => ({
        kind: 'context',
        oldNumber: firstNumber + i,
        newNumber: firstNumber + i,
        content,
      })),
    [lines, firstNumber],
  );
  const blob = useMemo(() => diffLines.map((l) => l.content).join('\n'), [diffLines]);
  const tokens = useCodeTokens(blob, lang);
  const rows: Row[] = useMemo(
    () => diffLines.map((line, i) => ({ line, oldRow: i, newRow: i })),
    [diffLines],
  );

  return (
    <div className="tx-d-context">
      {split ? (
        <SplitBody rows={rows} oldTokens={tokens} newTokens={tokens} linkPath={linkPath} />
      ) : (
        <UnifiedBody rows={rows} oldTokens={tokens} newTokens={tokens} linkPath={linkPath} />
      )}
    </div>
  );
}

function GapLines({
  gap,
  oldSource,
  newSource,
  lang,
  split,
  linkPath = null,
}: {
  gap: Gap;
  oldSource: readonly string[];
  newSource: readonly string[];
  lang: string;
  split: boolean;
  linkPath?: string | null;
}): ReactNode {
  const lines = useMemo(() => {
    const out: DiffLine[] = [];
    for (let i = 0; i < gap.count; i++) {
      const newNumber = gap.newStart + i;
      const oldNumber = gap.oldStart + i;
      out.push({
        kind: 'context',
        oldNumber,
        newNumber,
        content: newSource[newNumber - 1] ?? oldSource[oldNumber - 1] ?? '',
      });
    }
    return out;
  }, [gap, oldSource, newSource]);

  const blob = useMemo(() => lines.map((l) => l.content).join('\n'), [lines]);
  const tokens = useCodeTokens(blob, lang);
  const rows: Row[] = useMemo(() => lines.map((line, i) => ({ line, oldRow: i, newRow: i })), [lines]);

  return split ? (
    <SplitBody rows={rows} oldTokens={tokens} newTokens={tokens} linkPath={linkPath} />
  ) : (
    <UnifiedBody rows={rows} oldTokens={tokens} newTokens={tokens} linkPath={linkPath} />
  );
}
