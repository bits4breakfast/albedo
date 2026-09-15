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
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import type { ThemedToken } from 'shiki/core';
import type { DiffHunk, DiffLine, DiffSegment, FileDiff } from '../../types';
import { highlightToTokens, peekTokens, plainTokens, tokenStyle } from '../../lib/highlight';
import './transcript.css';

/** Below this container width the side-by-side layout stops being readable. */
const SIDE_BY_SIDE_MIN = 860;

/** Rows rendered before the "show more" break. */
const INITIAL_BUDGET = 320;
const BUDGET_STEP = 800;

/** Past this many lines, highlighting a blob costs more than it gives. */
const MAX_HIGHLIGHT_LINES = 6000;

// ---------------------------------------------------------------------------
// Token plumbing
// ---------------------------------------------------------------------------

/**
 * Tokenize a blob, re-rendering when the async result lands. Starts from the
 * cache so an already-seen blob paints highlighted on the first frame.
 */
export function useCodeTokens(text: string, lang: string): ThemedToken[][] {
  const tooBig = useMemo(() => text.length > 0 && countLines(text) > MAX_HIGHLIGHT_LINES, [text]);
  const [tokens, setTokens] = useState<ThemedToken[][]>(
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
function normaliseTokens(content: string, tokens: ThemedToken[] | undefined): Array<{ text: string; style: Record<string, string> }> {
  const out: Array<{ text: string; style: Record<string, string> }> = [];
  let used = 0;
  for (const t of tokens ?? []) {
    if (used >= content.length) break;
    const text = t.content.length > content.length - used ? content.slice(used, content.length) : t.content;
    if (text.length === 0) continue;
    out.push({ text, style: tokenStyle(t) });
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
  tokens: ThemedToken[] | undefined,
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
      {pieces.map((p, i) =>
        p.changed ? (
          <span key={i} className="tx-d-word" style={p.style as CSSProperties}>
            {p.text}
          </span>
        ) : (
          <span key={i} style={p.style as CSSProperties}>
            {p.text}
          </span>
        ),
      )}
    </span>
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
}

export function Diff({ diff, expand = null, layout = 'auto' }: DiffProps): ReactNode {
  const [ref, width] = useContainerWidth();
  const [override, setOverride] = useState<'split' | 'unified' | null>(null);
  const [budget, setBudget] = useState(INITIAL_BUDGET);
  const [openGaps, setOpenGaps] = useState<Record<number, boolean>>({});

  const model = useMemo(() => buildModel(diff.hunks), [diff]);
  const oldTokens = useCodeTokens(model.oldBlob, diff.lang);
  const newTokens = useCodeTokens(model.newBlob, diff.lang);

  const resolved: 'split' | 'unified' =
    layout !== 'auto' ? layout : (override ?? (width >= SIDE_BY_SIDE_MIN ? 'split' : 'unified'));

  const expandOld = useMemo(() => (expand ? sourceLines(expand.oldText) : null), [expand]);
  const expandNew = useMemo(() => (expand ? sourceLines(expand.newText) : null), [expand]);

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
          <SplitBody rows={rows} oldTokens={oldTokens} newTokens={newTokens} />
        ) : (
          <UnifiedBody rows={rows} oldTokens={oldTokens} newTokens={newTokens} />
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
          />,
        );
      }
    }
  }

  const shown = spent;
  const hidden = model.total - shown;

  return (
    <div className="tx-d" ref={ref}>
      <DiffHeader
        diff={diff}
        model={model}
        resolved={resolved}
        onToggle={layout === 'auto' ? () => setOverride(resolved === 'split' ? 'unified' : 'split') : null}
      />
      <div className="tx-d-body">{body}</div>
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
  const base = diff.path.split('/').pop() ?? diff.path;
  return (
    <div className="tx-d-head">
      <span className="tx-d-path" title={diff.path}>
        <span className="tx-d-dir">{diff.path.slice(0, diff.path.length - base.length)}</span>
        <span className="tx-d-base">{base}</span>
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

function num(n: number | null): string {
  return n === null ? '' : String(n);
}

function UnifiedBody({
  rows,
  oldTokens,
  newTokens,
}: {
  rows: readonly Row[];
  oldTokens: ThemedToken[][];
  newTokens: ThemedToken[][];
}): ReactNode {
  return (
    <div className="tx-d-rows tx-d-unified">
      {rows.map((r, i) => {
        const tokens = r.line.kind === 'add' ? newTokens[r.newRow] : oldTokens[r.oldRow];
        return (
          <div className={`tx-d-row tx-d-${r.line.kind}`} key={i}>
            <span className="tx-d-n">{num(r.line.oldNumber)}</span>
            <span className="tx-d-n">{num(r.line.newNumber)}</span>
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
}: {
  rows: readonly Row[];
  oldTokens: ThemedToken[][];
  newTokens: ThemedToken[][];
}): ReactNode {
  const pairs = useMemo(() => pairRows(rows), [rows]);
  return (
    <div className="tx-d-rows tx-d-split">
      {pairs.map((p, i) => (
        <div className="tx-d-pair" key={i}>
          <div className={`tx-d-half tx-d-${p.left ? p.left.line.kind : 'blank'}`}>
            {p.left ? (
              <>
                <span className="tx-d-n">{num(p.left.line.oldNumber)}</span>
                <Code pieces={composePieces(p.left.line.content, oldTokens[p.left.oldRow], p.left.line.segments)} />
              </>
            ) : (
              <span className="tx-d-n" />
            )}
          </div>
          <div className={`tx-d-half tx-d-${p.right ? p.right.line.kind : 'blank'}`}>
            {p.right ? (
              <>
                <span className="tx-d-n">{num(p.right.line.newNumber)}</span>
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
  if (!expandable) return <div className="tx-d-gap tx-d-gap-static">⋯ {label}</div>;
  return (
    <button type="button" className="tx-d-gap" onClick={onClick} aria-expanded={open}>
      {open ? '▾' : '⋯'} {label}
    </button>
  );
}

function GapLines({
  gap,
  oldSource,
  newSource,
  lang,
  split,
}: {
  gap: Gap;
  oldSource: readonly string[];
  newSource: readonly string[];
  lang: string;
  split: boolean;
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
    <SplitBody rows={rows} oldTokens={tokens} newTokens={tokens} />
  ) : (
    <UnifiedBody rows={rows} oldTokens={tokens} newTokens={tokens} />
  );
}
