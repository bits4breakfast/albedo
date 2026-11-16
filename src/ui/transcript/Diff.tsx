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
 * The shared path-link primitives (`useOpenPath`, `PathLink`,
 * `LinkifiedText`) live in links.tsx.
 */

import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import type { DiffHunk, DiffLine, FileDiff } from '../../types';
import type { DualToken } from '../../lib/highlight';
import { anchorBlock, fileLines, type AnchorFailure } from '../../lib/anchor';
import { useReadFile } from '../editor/openFile';
import { Disclosure } from '../Disclosure';
import { PathLink, useActivate } from './links';
import {
  Code,
  composePieces,
  MAX_HIGHLIGHT_LINES,
  sourceLines,
  useBlockTokens,
  useCodeTokens,
  useLineTokens,
} from './codeTokens';
import './transcript.css';

/** Below this container width the side-by-side layout stops being readable. */
const SIDE_BY_SIDE_MIN = 860;

/** Rows rendered before the "show more" break. */
const INITIAL_BUDGET = 320;
const BUDGET_STEP = 800;

/** Lines of surrounding file revealed per click, as GitHub's gutter does it. */
const CONTEXT_STEP = 20;

// ---------------------------------------------------------------------------
// Render model
// ---------------------------------------------------------------------------

interface Row {
  line: DiffLine;
  /** Index into the side's tokens, or -1: the hunk's own, or the whole text's (see `wholeRows`). */
  oldRow: number;
  newRow: number;
}

interface HunkModel {
  header: string;
  rows: Row[];
  /**
   * This hunk's shown lines on each side, highlighted on their own when the
   * whole texts are not (#412): the grammar's state -- inside a comment, a
   * string -- must not run across the lines hidden between two hunks.
   */
  oldBlob: string;
  newBlob: string;
}

interface Model {
  hunks: HunkModel[];
  /** Lines shown on each side across all hunks, for the highlight size limit. */
  oldCount: number;
  newCount: number;
  added: number;
  removed: number;
  total: number;
}

function buildModel(hunks: readonly DiffHunk[]): Model {
  const out: HunkModel[] = [];
  let oldCount = 0;
  let newCount = 0;
  let added = 0;
  let removed = 0;
  let total = 0;

  for (const h of hunks) {
    const rows: Row[] = [];
    const oldLines: string[] = [];
    const newLines: string[] = [];
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
    oldCount += oldLines.length;
    newCount += newLines.length;
    out.push({ header: h.header, rows, oldBlob: oldLines.join('\n'), newBlob: newLines.join('\n') });
  }

  return { hunks: out, oldCount, newCount, added, removed, total };
}

/**
 * Past this many lines across both whole texts, or this many characters, a
 * diff highlights its hunks instead (#412). The whole texts are tokenized a
 * slice at a time with a yield between slices (`highlightLines`), so no task
 * blocks the main thread for long whatever the size; what the cap bounds is
 * how long the plain first paint waits for its colours. Measured at ~6 lines
 * a millisecond (PHP, both themes), 6,000 lines is about a second at worst --
 * a file of ~3,000 lines on each side -- and 300,000 characters is the
 * editor's own limit (`MAX_HIGHLIGHT_CHARS`). Above either, the hunks are
 * highlighted one by one, which costs what one blob of them did before.
 */
const WHOLE_TEXT_MAX_LINES = 6000;
const WHOLE_TEXT_MAX_CHARS = 300_000;

/**
 * Whether every numbered row reads exactly the whole texts' line at its
 * number. They are the same texts the diff was made from, so this holds; if
 * it ever does not, colouring a row by another line's tokens would be wrong
 * and the hunks are highlighted on their own instead.
 */
function rowsMatch(model: Model, oldSource: readonly string[], newSource: readonly string[]): boolean {
  for (const h of model.hunks) {
    for (const { line } of h.rows) {
      if (line.oldNumber !== null && (line.kind === 'del' || line.kind === 'context')) {
        if (oldSource[line.oldNumber - 1] !== line.content) return false;
      }
      if (line.newNumber !== null && (line.kind === 'add' || line.kind === 'context')) {
        if (newSource[line.newNumber - 1] !== line.content) return false;
      }
    }
  }
  return true;
}

/** Rows re-indexed into the whole texts' tokens: a line's number less one. */
function wholeRows(rows: readonly Row[]): Row[] {
  return rows.map((r) => ({
    line: r.line,
    oldRow: r.oldRow >= 0 && r.line.oldNumber !== null ? r.line.oldNumber - 1 : -1,
    newRow: r.newRow >= 0 && r.line.newNumber !== null ? r.line.newNumber - 1 : -1,
  }));
}

/** Tokens for each whole side, indexed by line number less one. */
interface WholeTokens {
  old: DualToken[][];
  new: DualToken[][];
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

/**
 * A diff's layout: split when its container is wide enough, unless the
 * reader toggled it. {@link Diff} uses it for its own header's toggle; a
 * caller that draws the toggle in its own header (the Review Guide, #264)
 * uses the same rule on the diff's container and passes `layout` and
 * `head={false}`, so the two never disagree on what "auto" means.
 */
export function useDiffLayout(): {
  ref: RefObject<HTMLDivElement | null>;
  resolved: 'split' | 'unified';
  toggle: () => void;
} {
  const [ref, width] = useContainerWidth();
  const [override, setOverride] = useState<'split' | 'unified' | null>(null);
  const resolved = override ?? (width >= SIDE_BY_SIDE_MIN ? 'split' : 'unified');
  const toggle = useCallback(() => setOverride(resolved === 'split' ? 'unified' : 'split'), [resolved]);
  return { ref, resolved, toggle };
}

/**
 * Only one side has lines (#337): a new file, every line added, or a deleted
 * one, every line removed, with no context either way. Side by side would put
 * the whole file in one column beside an empty one, so such a diff is always
 * unified and offers no toggle. A file that only gained lines but kept some
 * as context is an edit, and keeps both.
 */
export function isOneSided(diff: FileDiff): boolean {
  let add = false;
  let del = false;
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'context') return false;
      if (line.kind === 'add') add = true;
      else if (line.kind === 'del') del = true;
    }
  }
  return add !== del;
}

/** The toggle's words: the layout a click switches to. */
export function layoutToggleLabel(resolved: 'split' | 'unified'): string {
  return resolved === 'split' ? 'Unified' : 'Split';
}

function useContainerWidth(): [RefObject<HTMLDivElement | null>, number] {
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
  /**
   * Show the file's path in the header. Off where the path is already on
   * screen -- the editor's title bar -- so it is not said twice. The counts
   * and the layout toggle stay either way.
   */
  showPath?: boolean;
  /**
   * Draw the header row (path, counts, layout toggle). Off where the caller's
   * own header already says the counts and carries the toggle -- the Review
   * Guide (#264), with {@link useDiffLayout} and a forced `layout`.
   */
  head?: boolean;
  /**
   * Set by {@link CollapsibleDiff}: the header gets an open caret, and a click
   * on it closes the diff again.
   */
  onCollapse?: () => void;
  /**
   * Drawn last, inside the diff's frame, while it is open: a Write that
   * replaced a file puts "Show Whole File" here (#387). Nothing by default.
   */
  footer?: ReactNode;
}

export function Diff({
  diff,
  expand = null,
  layout = 'auto',
  absoluteLines = false,
  contextPath,
  showPath = true,
  head = true,
  onCollapse,
  footer = null,
}: DiffProps): ReactNode {
  const auto = useDiffLayout();
  const ref = auto.ref;
  const [budget, setBudget] = useState(INITIAL_BUDGET);
  const [openGaps, setOpenGaps] = useState<Record<number, boolean>>({});

  const model = useMemo(() => buildModel(diff.hunks), [diff]);

  // A forced layout is the caller's call: the Guide judges one-sidedness on
  // the whole file, not on the slice it hands over (#337).
  const oneSided = useMemo(() => layout === 'auto' && isOneSided(diff), [layout, diff]);
  const resolved: 'split' | 'unified' = oneSided ? 'unified' : layout !== 'auto' ? layout : auto.resolved;

  // Per-line links only when the numbers are real file lines (see `absoluteLines`).
  // A rename's destination is the file that exists.
  const linkPath = absoluteLines
    ? (diff.path.includes(' → ') ? (diff.path.split(' → ').pop() ?? diff.path) : diff.path)
    : null;

  // Keyed on the texts: callers pass `expand` as a fresh object every render.
  const expandOldText = expand?.oldText ?? null;
  const expandNewText = expand?.newText ?? null;
  const expandOld = useMemo(() => (expandOldText !== null ? sourceLines(expandOldText) : null), [expandOldText]);
  const expandNew = useMemo(() => (expandNewText !== null ? sourceLines(expandNewText) : null), [expandNewText]);

  /*
   * Syntax colour (#412). With both whole texts, each side is tokenized
   * from its first line, a slice at a time (`useLineTokens`), and every row
   * -- hunk or opened gap -- takes the tokens of its own line: coloured as it
   * is in the file, whatever the hidden lines open or close. Without them,
   * or past the caps, each hunk is highlighted on its own
   * (`useBlockTokens`), so no state crosses a gap.
   */
  const whole = useMemo(() => {
    if (expandOldText === null || expandNewText === null || !expandOld || !expandNew) return null;
    if (expandOld.length + expandNew.length > WHOLE_TEXT_MAX_LINES) return null;
    if (expandOldText.length + expandNewText.length > WHOLE_TEXT_MAX_CHARS) return null;
    if (!rowsMatch(model, expandOld, expandNew)) return null;
    // Joined from `sourceLines`, so token line i is line i + 1 even with `\r\n`.
    return { old: expandOld.join('\n'), new: expandNew.join('\n') };
  }, [expandOldText, expandNewText, expandOld, expandNew, model]);
  const wholeOn = whole !== null;
  // Each side only as far as the last line a hunk shows, until the gap after
  // the last hunk is opened: the lines below it are never seen otherwise.
  const tailOpen = openGaps[model.hunks.length] === true;
  const reach = useMemo(() => lastNumbers(model.hunks[model.hunks.length - 1]), [model]);
  const wholeOldTokens = useLineTokens(whole?.old ?? '', diff.lang, tailOpen ? Infinity : reach.old);
  const wholeNewTokens = useLineTokens(whole?.new ?? '', diff.lang, tailOpen ? Infinity : reach.new);
  const wholeTokens = useMemo<WholeTokens | null>(
    () => (wholeOn ? { old: wholeOldTokens, new: wholeNewTokens } : null),
    [wholeOn, wholeOldTokens, wholeNewTokens],
  );
  // Today's limit, kept for the hunks: past it a side is not highlighted at all.
  const plainOld = model.oldCount > MAX_HIGHLIGHT_LINES;
  const plainNew = model.newCount > MAX_HIGHLIGHT_LINES;
  // Otherwise each hunk on its own, one cache entry a side for the lot.
  const oldBlocks = useMemo(
    () => (wholeOn || plainOld ? [] : model.hunks.map((h) => h.oldBlob)),
    [wholeOn, plainOld, model],
  );
  const newBlocks = useMemo(
    () => (wholeOn || plainNew ? [] : model.hunks.map((h) => h.newBlob)),
    [wholeOn, plainNew, model],
  );
  const hunkOldTokens = useBlockTokens(oldBlocks, diff.lang);
  const hunkNewTokens = useBlockTokens(newBlocks, diff.lang);

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
        {head ? <DiffHeader diff={diff} model={model} resolved={resolved} onToggle={null} showPath={showPath} /> : null}
        <div className="tx-d-empty">No content changes</div>
        {footer}
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
            whole={wholeTokens}
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
        <HunkBody
          rows={rows}
          whole={wholeTokens}
          oldTokens={hunkOldTokens[hi] ?? NO_TOKENS}
          newTokens={hunkNewTokens[hi] ?? NO_TOKENS}
          split={resolved === 'split'}
          linkPath={linkPath}
        />
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
            whole={wholeTokens}
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
    // The path a selection's code comment is for (#222): the file read for
    // context, else the diff's own.
    <div className="tx-d" ref={ref} data-diff-path={readPath ?? diff.path}>
      {head ? (
        <DiffHeader
          diff={diff}
          model={model}
          resolved={resolved}
          onToggle={layout === 'auto' && !oneSided ? auto.toggle : null}
          showPath={showPath}
          disclosure={onCollapse ? { open: true, onToggle: onCollapse } : null}
        />
      ) : null}
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
          <span className="tx-d-more-label">{hidden.toLocaleString()} More Lines</span>
          <button type="button" className="tx-btn" onClick={() => setBudget((b) => b + BUDGET_STEP)}>
            Show {Math.min(BUDGET_STEP, hidden).toLocaleString()} More
          </button>
          <button type="button" className="tx-btn" onClick={() => setBudget(model.total)}>
            Show All
          </button>
        </div>
      ) : null}
      {footer}
      <SelectionComment rootRef={ref} />
    </div>
  );
}

export default Diff;

/**
 * A transcript diff, closed until asked for: the header alone -- caret, path
 * and counts -- and the whole diff on a click. A long session holds hundreds
 * of edits, and reading the conversation means scrolling past them.
 *
 * Closed costs only the line counts: the body, its syntax highlighting and any
 * file read for context wait until it is opened. Closing it again drops what
 * was revealed inside, which reopening shows from the start.
 */
export function CollapsibleDiff({
  defaultOpen = false,
  ...props
}: DiffProps & { defaultOpen?: boolean }): ReactNode {
  const [open, setOpen] = useState(defaultOpen);
  const model = useMemo(() => (open ? null : buildModel(props.diff.hunks)), [open, props.diff]);
  if (open || model === null) return <Diff {...props} onCollapse={() => setOpen(false)} />;
  return (
    <div className="tx-d tx-d-closed">
      <DiffHeader
        diff={props.diff}
        model={model}
        resolved="unified"
        onToggle={null}
        showPath={props.showPath ?? true}
        disclosure={{ open: false, onToggle: () => setOpen(true) }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function DiffHeader({
  diff,
  model,
  resolved,
  onToggle,
  showPath,
  disclosure = null,
}: {
  diff: FileDiff;
  model: Model;
  resolved: 'split' | 'unified';
  onToggle: (() => void) | null;
  showPath: boolean;
  /** Present when the diff opens and closes from its header. */
  disclosure?: { open: boolean; onToggle: () => void } | null;
}): ReactNode {
  // As on a tool chip: the whole row toggles, the path opts out and opens the
  // file, and a drag-select over the row is not a click.
  const toggle = useActivate(() => disclosure?.onToggle());
  // A rename header reads "old → new". Both sides stay visible, but only the
  // destination is a link: the source no longer exists to open.
  const renamed = diff.path.includes(' → ');
  const target = renamed ? (diff.path.split(' → ').pop() ?? diff.path) : diff.path;
  const from = renamed ? diff.path.slice(0, diff.path.length - target.length) : '';
  const base = target.split('/').pop() ?? target;
  return (
    <div
      className={disclosure ? 'tx-d-head tx-d-head-toggle' : 'tx-d-head'}
      onMouseDown={disclosure ? toggle.onMouseDown : undefined}
      onClick={disclosure ? toggle.onClick : undefined}
    >
      {disclosure ? (
        <button
          type="button"
          className="tx-d-toggle"
          aria-expanded={disclosure.open}
          aria-label={`${disclosure.open ? 'Collapse' : 'Expand'} diff of ${base}`}
        >
          <Disclosure open={disclosure.open} />
        </button>
      ) : null}
      {showPath ? (
        <span className="tx-d-path" title={diff.path}>
          {renamed ? <span className="tx-d-dir">{from}</span> : null}
          <PathLink path={target} title={target}>
            <span className="tx-d-dir">{target.slice(0, target.length - base.length)}</span>
            <span className="tx-d-base">{base}</span>
          </PathLink>
        </span>
      ) : null}
      <span className="tx-d-stat">
        {model.added > 0 ? <span className="tx-d-plus">+{model.added}</span> : null}
        {model.removed > 0 ? <span className="tx-d-minus">-{model.removed}</span> : null}
      </span>
      {onToggle ? (
        <button
          type="button"
          className="tx-btn tx-d-layout"
          onClick={(e) => {
            // Not a click on the row: that would close the diff too.
            e.stopPropagation();
            onToggle();
          }}
        >
          {layoutToggleLabel(resolved)}
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
// ---------------------------------------------------------------------------
// Review comments (the editor's Diff mode only)
// ---------------------------------------------------------------------------

/**
 * Hooks for review comments, provided by the editor's Diff mode and absent
 * everywhere else, so a transcript diff is unchanged. Lines are NEW-side
 * numbers: a comment points at the file as it is now. Deleted rows take
 * comments only through `removed` (#402), by the base's line numbers;
 * without it a deleted line gets no handle, as before.
 */
export interface DiffAnnotations {
  /** What to show under the row whose new-side line is `line`: cards, a draft. */
  after(line: number): ReactNode;
  /** The lines a drag on the + handles currently covers. */
  picking: { from: number; to: number } | null;
  /** Whether an open comment covers this new-side line: an accent edge, as the editor's File mode marks it (#252). */
  commented?(line: number): boolean;
  /** A drag on the + handles moved (`done` false) or ended (`done` true). */
  pick(from: number, to: number, done: boolean): void;
  /**
   * Comments on deleted rows (#402): the same four, by OLD-side (base) line
   * numbers, for the rows the change removed. Absent: deleted rows take none.
   */
  removed?: RemovedAnnotations;
  /**
   * A selection covering deleted and added lines (#402): one comment per
   * side, written once. Absent: such a selection comments on its new-side
   * lines only, as before.
   */
  pickBoth?(added: { from: number; to: number }, removed: { from: number; to: number }): void;
}

export interface RemovedAnnotations {
  after(line: number): ReactNode;
  picking: { from: number; to: number } | null;
  commented?(line: number): boolean;
  pick(from: number, to: number, done: boolean): void;
}

type Side = 'new' | 'old';

/** The side's hooks: the new side's are the annotations themselves. */
function sideOf(annotate: DiffAnnotations | null, side: Side): RemovedAnnotations | null {
  if (!annotate) return null;
  return side === 'old' ? (annotate.removed ?? null) : annotate;
}

export const DiffAnnotationsContext = createContext<DiffAnnotations | null>(null);

/** The new-side (or, for deleted rows, old-side) line under the pointer, from the row's data attribute. */
function lineAt(x: number, y: number, side: Side = 'new'): number | null {
  const attr = side === 'old' ? 'data-old-line' : 'data-new-line';
  const row = document.elementFromPoint(x, y)?.closest(`[${attr}]`);
  const n = Number(row?.getAttribute(attr));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The last + pressed in each diff, for Shift-click to extend from (#222); only within its side. */
const lastHandle = new WeakMap<Element, { line: number; side: Side }>();

/**
 * The + on a row: press for that line, drag across rows, or Shift-click
 * another + for a range. On a deleted row (#402) it is the base's line, and
 * a drag or a Shift-click stays on deleted rows.
 */
function CommentHandle({ line, side = 'new' }: { line: number; side?: Side }): ReactNode {
  const annotate = useContext(DiffAnnotationsContext);
  const hooks = sideOf(annotate, side);
  if (!hooks) return null;
  return (
    <button
      type="button"
      className="tx-d-cmt-add"
      tabIndex={-1}
      aria-label={side === 'old' ? `Comment on removed line ${line}` : `Comment on line ${line}`}
      title={
        side === 'old'
          ? 'Comment on this removed line (drag, or Shift-click another +, for several)'
          : 'Comment on this line (drag, or Shift-click another +, for several)'
      }
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const root = e.currentTarget.closest('.tx-d');
        const last = root ? lastHandle.get(root) : undefined;
        const from = last && last.side === side ? last.line : undefined;
        if (root) lastHandle.set(root, { line, side });
        if (e.shiftKey && from !== undefined) {
          hooks.pick(Math.min(from, line), Math.max(from, line), true);
          return;
        }
        const start = line;
        let end = line;
        hooks.pick(start, end, false);
        const move = (ev: MouseEvent) => {
          const n = lineAt(ev.clientX, ev.clientY, side);
          if (n === null || n === end) return;
          end = n;
          hooks.pick(Math.min(start, end), Math.max(start, end), false);
        };
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          hooks.pick(Math.min(start, end), Math.max(start, end), true);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }}
    >
      +
    </button>
  );
}

/** The rows a selection covers in a diff: new-side lines with their code, in order. */
export interface SelectedRows {
  /** The diff's root (`.tx-d`), which carries the file's path. */
  root: HTMLElement;
  lines: Array<{ line: number; text: string }>;
  /** It covers rows, but only deleted ones: nothing in the file to point at. */
  deletedOnly: boolean;
  /** The deleted rows it covers (#402), by the base's line numbers, in order. */
  removed: Array<{ line: number; text: string }>;
  /**
   * In a split diff, the column the selection was made in (#402): its range
   * runs through the other column's halves in between, which it does not
   * mean. Null in a unified diff.
   */
  side: 'old' | 'new' | null;
  /**
   * Unchanged rows' left halves it covers (#402), by their line in the file
   * now: what a selection made in a split diff's left column means on them.
   */
  same: Array<{ line: number; text: string }>;
}

/**
 * Which diff rows a DOM selection covers (#222), read from the rows' own
 * `data-new-line`, never from the text selected: a selection that starts
 * halfway through one line still means that line. Null when the selection
 * is empty or not inside one diff's rows.
 */
export function selectedDiffRows(sel: Selection | null): SelectedRows | null {
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const at = (n: Node | null) => (n instanceof Element ? n : (n?.parentElement ?? null));
  const root = at(range.startContainer)?.closest<HTMLElement>('.tx-d') ?? null;
  if (!root || at(range.endContainer)?.closest('.tx-d') !== root) return null;
  const rows = [...root.querySelectorAll<HTMLElement>('.tx-d-row, .tx-d-half')].filter((r) => {
    try {
      return range.intersectsNode(r);
    } catch {
      return false;
    }
  });
  if (rows.length === 0) return null;
  const lines: SelectedRows['lines'] = [];
  const removed: SelectedRows['removed'] = [];
  const same: SelectedRows['same'] = [];
  const take = (into: Array<{ line: number; text: string }>, value: string | null, text: string) => {
    const n = Number(value);
    if (value !== null && Number.isInteger(n) && n > 0 && !into.some((l) => l.line === n)) into.push({ line: n, text });
  };
  for (const r of rows) {
    const text = r.querySelector('.tx-d-code')?.textContent ?? '';
    take(removed, r.getAttribute('data-old-line'), text);
    take(same, r.getAttribute('data-same-line'), text);
    take(lines, r.getAttribute('data-new-line'), text);
  }
  return { root, lines, deletedOnly: lines.length === 0, removed, side: columnOf(range, at), same };
}

/**
 * The column of a split diff a selection was made in: the half it starts in,
 * else the half it ends in, else the column the last press chose. Null in a
 * unified diff.
 */
function columnOf(range: Range, at: (n: Node | null) => Element | null): 'old' | 'new' | null {
  const start = at(range.startContainer);
  if (!start?.closest('.tx-d-split')) return null;
  const half = start.closest('.tx-d-half') ?? at(range.endContainer)?.closest('.tx-d-half') ?? null;
  if (half) return half.previousElementSibling ? 'new' : 'old';
  const chosen = start.closest('.tx-d-split')?.getAttribute('data-select');
  return chosen === 'old' || chosen === 'new' ? chosen : null;
}

/** "Line 4", "Lines 2–4", "Removed Line 3": a range of rows, as a button names it. */
function linesLabel(ls: ReadonlyArray<{ line: number }>, removed: boolean): string {
  const first = ls[0]?.line;
  const last = ls[ls.length - 1]?.line;
  const word = first === last ? `Line ${first}` : `Lines ${first}–${last}`;
  return removed ? `Removed ${word}` : word;
}

/** What a selection's Comment covers, side by side (#402); null when nothing. */
function selectionTargets(
  annotate: DiffAnnotations | null,
  rows: SelectedRows,
): { added: SelectedRows['lines']; removed: SelectedRows['removed'] } | null {
  if (!annotate) return null;
  // Split: only the column the selection was made in, once deleted rows take
  // comments -- the left column's unchanged rows by their line now; before
  // that, as it always was.
  const added = annotate.removed && rows.side === 'old' ? rows.same : rows.lines;
  // Deleted rows count only where they take comments, and alongside added
  // ones only where one comment can go to both sides.
  const removed = annotate.removed && rows.side !== 'new' && (added.length === 0 || annotate.pickBoth) ? rows.removed : [];
  return added.length === 0 && removed.length === 0 ? null : { added, removed };
}

/**
 * Select lines in a diff, then comment (#222): a Comment button at the
 * selection, and ⌥⌘M, both for the new-side lines it covers -- the same
 * `pick` the + handles use. Deleted rows (#402) take a comment of their own
 * where the provider offers `removed`, and a selection over both sides makes
 * one per side; without it a selection only on deleted lines says why it
 * cannot be commented. Only where comments are offered (the editor's Diff
 * mode, the guide); a transcript diff's selection belongs to PassageComments.
 *
 * ⌥⌘M is read from `code` (Option makes `key` µ). It is the File mode's
 * comment key; nothing app-wide binds it (shortcuts.ts), and CodeMirror is
 * not in a diff to take it first.
 */
function SelectionComment({ rootRef }: { rootRef: RefObject<HTMLDivElement | null> }): ReactNode {
  const annotate = useContext(DiffAnnotationsContext);
  const [found, setFound] = useState<{ rows: SelectedRows; top: number; left: number } | null>(null);
  const annotateRef = useRef(annotate);
  annotateRef.current = annotate;
  const foundRef = useRef(found);
  foundRef.current = found;
  const commentNow = useRef<() => boolean>(() => false);

  useEffect(() => {
    if (!annotate) return;
    const look = () => {
      const root = rootRef.current;
      const sel = document.getSelection();
      const rows = selectedDiffRows(sel);
      if (!root || !rows || rows.root !== root) {
        setFound(null);
        return;
      }
      const rect = sel!.getRangeAt(0).getBoundingClientRect?.();
      const box = root.getBoundingClientRect();
      setFound({ rows, top: rect ? rect.bottom - box.top + 4 : 0, left: rect ? Math.max(0, rect.left - box.left) : 0 });
    };
    const comment = () => {
      const f = foundRef.current;
      const a = annotateRef.current;
      const t = f ? selectionTargets(a, f.rows) : null;
      if (!a || !t) return false;
      const span = (ls: ReadonlyArray<{ line: number }>) => {
        const ns = ls.map((l) => l.line);
        return { from: Math.min(...ns), to: Math.max(...ns) };
      };
      if (t.added.length > 0 && t.removed.length > 0 && a.pickBoth) a.pickBoth(span(t.added), span(t.removed));
      else if (t.added.length > 0) a.pick(span(t.added).from, span(t.added).to, true);
      else a.removed?.pick(span(t.removed).from, span(t.removed).to, true);
      document.getSelection()?.removeAllRanges();
      setFound(null);
      return true;
    };
    const key = (e: KeyboardEvent) => {
      if (e.code !== 'KeyM' || !e.metaKey || !e.altKey || e.shiftKey || e.ctrlKey) return;
      if (comment()) e.preventDefault();
    };
    document.addEventListener('selectionchange', look);
    document.addEventListener('keydown', key);
    commentNow.current = comment;
    return () => {
      document.removeEventListener('selectionchange', look);
      document.removeEventListener('keydown', key);
    };
  }, [annotate, rootRef]);

  if (!annotate || !found) return null;
  const { rows } = found;
  const targets = selectionTargets(annotate, rows);
  // Deleted rows take comments here (#402): a selection on none of the rows
  // that do has no button and nothing to explain.
  if (annotate.removed && targets === null) return null;
  const what = targets
    ? [
        targets.removed.length > 0 ? linesLabel(targets.removed, true) : '',
        targets.added.length > 0 ? linesLabel(targets.added, false) : '',
      ]
        .filter((w) => w !== '')
        .join(' and ')
    : '';
  return (
    <div className="tx-d-selcmt" style={{ top: found.top, left: found.left }} role="group" aria-label="Selected lines">
      {targets === null ? (
        <span className="tx-d-selcmt-note">Deleted lines are not in the file now: nothing to comment on</span>
      ) : (
        <button
          type="button"
          className="tx-btn tx-d-selcmt-btn"
          // Keep the selection until the click lands.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => commentNow.current()}
          title="Comment on the selected lines (⌥⌘M)"
        >
          {targets.removed.length === 0 ? `Comment on Selected ${what}` : `Comment on ${what}`}
        </button>
      )}
    </div>
  );
}

function picked(hooks: RemovedAnnotations | null, line: number | null): boolean {
  const p = hooks?.picking;
  return !!p && line !== null && line >= p.from && line <= p.to;
}

/** " tx-d-picking" or " tx-d-commented" (#252): the row's comment edge, if any. */
function edge(annotate: DiffAnnotations | null, line: number | null, side: Side = 'new'): string {
  const hooks = sideOf(annotate, side);
  if (picked(hooks, line)) return ' tx-d-picking';
  return line !== null && hooks?.commented?.(line) ? ' tx-d-commented' : '';
}

/** Whatever belongs under a row: cards and drafts ending on its line (on a deleted row, its base line). */
function Annotation({ line, side = 'new' }: { line: number | null; side?: Side }): ReactNode {
  const annotate = useContext(DiffAnnotationsContext);
  const hooks = sideOf(annotate, side);
  if (!hooks || line === null) return null;
  const content = hooks.after(line);
  return content ? (
    <div className="tx-d-annot" data-side={side === 'old' ? 'old' : undefined}>
      {content}
    </div>
  ) : null;
}

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
  const annotate = useContext(DiffAnnotationsContext);
  return (
    <div className="tx-d-rows tx-d-unified">
      {rows.map((r, i) => {
        const tokens = r.line.kind === 'add' ? newTokens[r.newRow] : oldTokens[r.oldRow];
        const line = r.line.newNumber;
        // A deleted row (#402) is named by its base line, and takes comments on that side.
        const removed = r.line.kind === 'del' ? r.line.oldNumber : null;
        return (
          <Fragment key={i}>
            <div
              className={`tx-d-row tx-d-${r.line.kind}${removed !== null ? edge(annotate, removed, 'old') : edge(annotate, line)}`}
              data-new-line={line ?? undefined}
              data-old-line={removed ?? undefined}
            >
              <LineNo n={r.line.oldNumber} linkPath={null} />
              <LineNo n={line} linkPath={linkPath} />
              <span className="tx-d-mark">{r.line.kind === 'add' ? '+' : r.line.kind === 'del' ? '-' : ' '}</span>
              <Code pieces={composePieces(r.line.content, tokens, r.line.segments)} />
              {line !== null ? <CommentHandle line={line} /> : null}
              {removed !== null ? <CommentHandle line={removed} side="old" /> : null}
            </div>
            <Annotation line={removed} side="old" />
            <Annotation line={line} />
          </Fragment>
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
  const annotate = useContext(DiffAnnotationsContext);
  // A drag that starts on one side selects only that side: the other column
  // is taken out of selection until the next press. Without this a copy
  // interleaves old and new lines, which is never what anyone wanted.
  const [side, setSide] = useState<'old' | 'new' | null>(null);
  return (
    <div
      className="tx-d-rows tx-d-split"
      data-select={side ?? undefined}
      onMouseDown={(e) => {
        const half = (e.target as HTMLElement).closest('.tx-d-half');
        setSide(half ? (half.previousElementSibling ? 'new' : 'old') : null);
      }}
    >
      {pairs.map((p, i) => {
        // The left half of a deleted row (#402): its base line, and a + of its own.
        const removed = p.left?.line.kind === 'del' ? p.left.line.oldNumber : null;
        return (
        <Fragment key={i}>
          <div className="tx-d-pair">
            <div
              className={`tx-d-half tx-d-${p.left ? p.left.line.kind : 'blank'}${removed !== null ? edge(annotate, removed, 'old') : ''}`}
              data-old-line={removed ?? undefined}
              // An unchanged row's left half (#402): its line in the file now,
              // for a selection made in this column.
              data-same-line={p.left?.line.kind === 'context' ? (p.left.line.newNumber ?? undefined) : undefined}
            >
              {p.left ? (
                <>
                  <LineNo n={p.left.line.oldNumber} linkPath={null} />
                  <Code pieces={composePieces(p.left.line.content, oldTokens[p.left.oldRow], p.left.line.segments)} />
                  {removed !== null ? <CommentHandle line={removed} side="old" /> : null}
                </>
              ) : (
                <span className="tx-d-n" />
              )}
            </div>
            <div
              className={`tx-d-half tx-d-${p.right ? p.right.line.kind : 'blank'}${edge(annotate, p.right?.line.newNumber ?? null)}`}
              data-new-line={p.right?.line.newNumber ?? undefined}
            >
              {p.right ? (
                <>
                  <LineNo n={p.right.line.newNumber} linkPath={linkPath} />
                  <Code pieces={composePieces(p.right.line.content, newTokens[p.right.newRow], p.right.line.segments)} />
                  {p.right.line.newNumber !== null ? <CommentHandle line={p.right.line.newNumber} /> : null}
                </>
              ) : (
                <span className="tx-d-n" />
              )}
            </div>
          </div>
          <Annotation line={removed} side="old" />
          <Annotation line={p.right?.line.newNumber ?? null} />
        </Fragment>
        );
      })}
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
  const label = `${gap.count.toLocaleString()} Unchanged Line${gap.count === 1 ? '' : 's'}`;
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
          ? 'Reading File…'
          : remaining === null
            ? 'More Context'
            : `${Math.min(CONTEXT_STEP, remaining)} More Line${Math.min(CONTEXT_STEP, remaining) === 1 ? '' : 's'} (${remaining.toLocaleString()} Left)`}
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
      return '⋯ The file could not be read from this worktree';
    case 'not-found':
      return '⋯ This file has changed since — no surrounding context can be shown';
    case 'ambiguous':
      return '⋯ These lines appear more than once in the file — context would be a guess';
    default:
      return '⋯ No surrounding context available';
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
  whole = null,
}: {
  gap: Gap;
  oldSource: readonly string[];
  newSource: readonly string[];
  lang: string;
  split: boolean;
  linkPath?: string | null;
  /** The whole texts' tokens, when the diff has them: the gap reads its rows from there (#412). */
  whole?: WholeTokens | null;
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

  // Highlighted on its own only when the whole texts are not.
  const blob = useMemo(() => (whole ? '' : lines.map((l) => l.content).join('\n')), [lines, whole]);
  const own = useCodeTokens(blob, lang);
  const rows: Row[] = useMemo(() => lines.map((line, i) => ({ line, oldRow: i, newRow: i })), [lines]);
  /*
   * With the whole texts, each row takes the tokens of the line it shows.
   * Its text is the new side's line, and the old side's line at its old
   * number is usually the same text -- but not where hunks between are
   * hidden (the Guide's `restrictDiff`): there the two numberings drift, and
   * the old number points at another line. So a side's tokens are used only
   * where that side's line IS the row's text, else the other side's.
   */
  const sideTokens = useMemo(() => {
    if (!whole) return null;
    const pick = (line: DiffLine, first: 'old' | 'new'): DualToken[] | undefined => {
      const oldOk = line.oldNumber !== null && oldSource[line.oldNumber - 1] === line.content;
      const newOk = line.newNumber !== null && newSource[line.newNumber - 1] === line.content;
      const fromOld = oldOk ? whole.old[(line.oldNumber ?? 0) - 1] : undefined;
      const fromNew = newOk ? whole.new[(line.newNumber ?? 0) - 1] : undefined;
      return first === 'old' ? (oldOk ? fromOld : fromNew) : newOk ? fromNew : fromOld;
    };
    return {
      old: lines.map((l) => pick(l, 'old') ?? []),
      new: lines.map((l) => pick(l, 'new') ?? []),
    };
  }, [whole, lines, oldSource, newSource]);
  const oldTokens = sideTokens ? sideTokens.old : own;
  const newTokens = sideTokens ? sideTokens.new : own;

  return split ? (
    <SplitBody rows={rows} oldTokens={oldTokens} newTokens={newTokens} linkPath={linkPath} />
  ) : (
    <UnifiedBody rows={rows} oldTokens={oldTokens} newTokens={newTokens} linkPath={linkPath} />
  );
}

/**
 * One hunk's rows. Coloured by the whole texts' tokens when the diff has
 * them, else by this hunk's own lines highlighted alone (#412).
 */
function HunkBody({
  rows,
  whole,
  oldTokens,
  newTokens,
  split,
  linkPath,
}: {
  /** The hunk's rows, or the first of them when the row budget runs out. */
  rows: readonly Row[];
  whole: WholeTokens | null;
  /** This hunk's own tokens, by its rows' indexes; unused with `whole`. */
  oldTokens: DualToken[][];
  newTokens: DualToken[][];
  split: boolean;
  linkPath: string | null;
}): ReactNode {
  const shown = useMemo(() => (whole ? wholeRows(rows) : rows), [whole, rows]);
  const o = whole ? whole.old : oldTokens;
  const n = whole ? whole.new : newTokens;
  return split ? (
    <SplitBody rows={shown} oldTokens={o} newTokens={n} linkPath={linkPath} />
  ) : (
    <UnifiedBody rows={shown} oldTokens={o} newTokens={n} linkPath={linkPath} />
  );
}

const NO_TOKENS: DualToken[][] = [];

/** The last line number on each side of a hunk; 0 for none. */
function lastNumbers(hunk: HunkModel | undefined): { old: number; new: number } {
  let o = 0;
  let n = 0;
  for (const r of hunk?.rows ?? []) {
    if (r.line.oldNumber !== null) o = Math.max(o, r.line.oldNumber);
    if (r.line.newNumber !== null) n = Math.max(n, r.line.newNumber);
  }
  return { old: o, new: n };
}
