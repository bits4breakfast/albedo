import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { flagCodec, KEYS, oneOfCodec, usePersisted, type Codec } from '../persisted';

/**
 * The frame's geometry: which panes show and how big they are, and the
 * splitter drags that change it. Everything here is view state remembered per
 * machine, except the live pane-row width and which splitter is being dragged.
 * App.tsx says how the panes are arranged and why.
 */

export type PaneMode = 'pty' | 'split' | 'transcript';
export type Orientation = 'row' | 'column';
/** Tabs of the right-hand reading pane. `editor` and `guide` appear on demand. */
export type RightTab = 'transcript' | 'files' | 'editor' | 'guide';
export type Dragging = null | 'sidebar' | 'split' | 'files' | 'shell';

/**
 * The task list. 300px is the narrowest at which its header shows both tabs
 * whole -- "Building 13" and "Reviewing 2" need 207px of track, and at 300px
 * there are 210px beside New Task and Collapse (#306). A width saved narrower
 * before that opens at 300px.
 */
export const SIDEBAR_MIN = 300;
const SIDEBAR_MAX = 480;
const SIDEBAR_DEFAULT = 300;
/**
 * The pinned files column. Narrow by nature — paths, counts, a status chip —
 * which is why it works where a fourth READING pane does not.
 */
const FILES_MIN = 180;
const FILES_MAX = 420;
const FILES_DEFAULT = 240;
/**
 * What the transcript or editor needs beside it to stay worth reading. Below
 * this the column is not viable and falls back to the tab. Measured: at 1440px
 * in split mode the read pane would be 284px, which is not a diff.
 */
const READ_MIN = 420;

const RATIO_MIN = 0.18;
const RATIO_MAX = 0.86;

const SHELL_MIN = 80;
const SHELL_DEFAULT = 220;
/** Room the panes above always keep, so the drawer can never swallow them. */
const SHELL_PANES_MIN = 160;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// Stored as they always were (see ui/persisted.ts): widths as whole pixels,
// the ratio to three places, flags as '1'/'0'.
export const sidebarCodec: Codec<number> = {
  decode: (raw) => clamp(Number(raw) || SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX),
  encode: (w) => String(Math.round(w)),
};
const ratioCodec: Codec<number> = {
  decode: (raw) => clamp(Number(raw) || 0.55, RATIO_MIN, RATIO_MAX),
  encode: (r) => r.toFixed(3),
};
const filesWidthCodec: Codec<number> = {
  decode: (raw) => clamp(Number(raw) || FILES_DEFAULT, FILES_MIN, FILES_MAX),
  encode: (w) => String(Math.round(w)),
};
const shellHeightCodec: Codec<number> = {
  decode: (raw) => Math.max(SHELL_MIN, Number(raw) || SHELL_DEFAULT),
  encode: (h) => String(Math.round(h)),
};
const modeCodec = oneOfCodec<PaneMode>(['pty', 'split', 'transcript']);
const orientationCodec = oneOfCodec<Orientation>(['row', 'column']);
/** `editor` and `guide` are never remembered: neither is open after a restart. */
const rightTabCodec: Codec<RightTab> = {
  ...oneOfCodec<RightTab>(['transcript', 'files', 'editor']),
  encode: (tab) => (tab === 'editor' || tab === 'guide' ? undefined : tab),
};

/**
 * The styles the resized panes get. App renders them, and a drag writes the
 * same strings straight to the element (#364), so the two never disagree.
 */
export const sidebarStyle = (w: number) => ({ width: w, flexBasis: w });
export const ratioFlex = (ratio: number) => `0 0 ${(ratio * 100).toFixed(2)}%`;
export const filesFlex = (w: number) => `0 0 ${Math.round(w)}px`;
export const shellFlex = (h: number) => `0 0 ${h}px`;

/**
 * Whether the pinned files column shows, beside a terminal (`shown`) and in
 * the project view's read area, which has none (`shownAlone`).
 */
export function columnFits(s: {
  mode: PaneMode;
  orientation: Orientation;
  ratio: number;
  panesWidth: number;
  filesWidth: number;
  filesPinned: boolean;
}): { shown: boolean; shownAlone: boolean } {
  const readAreaWidth =
    s.mode === 'pty'
      ? 0
      : s.mode === 'split' && s.orientation === 'row'
        ? s.panesWidth * (1 - s.ratio)
        : s.panesWidth;
  const fits = readAreaWidth >= s.filesWidth + READ_MIN;
  return {
    shown: s.filesPinned && s.mode !== 'pty' && fits,
    shownAlone: s.filesPinned && s.panesWidth >= s.filesWidth + READ_MIN,
  };
}

export default function useLayout() {
  const [sidebarWidth, setSidebarWidth] = usePersisted(KEYS.sidebarWidth, sidebarCodec, SIDEBAR_DEFAULT);
  /**
   * The task list collapsed to its rail (#266). The width above is kept, so
   * expanding comes back to it.
   */
  const [taskListCollapsed, setTaskListCollapsed] = usePersisted(KEYS.taskListCollapsed, flagCodec, false);
  const [mode, setMode] = usePersisted<PaneMode>(KEYS.paneMode, modeCodec, 'split');
  const [orientation, setOrientation] = usePersisted<Orientation>(KEYS.orientation, orientationCodec, 'row');
  const [ratio, setRatio] = usePersisted(KEYS.splitRatio, ratioCodec, 0.55);

  const [rightTab, setRightTab] = usePersisted<RightTab>(KEYS.rightTab, rightTabCodec, 'transcript');
  /** Files promoted from a tab to a permanent column. Default off. */
  const [filesPinned, setFilesPinned] = usePersisted(KEYS.filesPinned, flagCodec, false);
  const [filesWidth, setFilesWidth] = usePersisted(KEYS.filesWidth, filesWidthCodec, FILES_DEFAULT);
  /** Live width of the pane row, so viability is measured rather than guessed. */
  const [panesWidth, setPanesWidth] = useState(0);

  const [dragging, setDragging] = useState<Dragging>(null);
  /**
   * The shell drawer: a plain login shell in the active project's main
   * checkout, PhpStorm's Terminal tool window. One shell per project, spawned
   * on first open and kept alive after -- closing the drawer hides it, the way
   * the pty pane hides task terminals rather than killing them.
   */
  const [shellOpen, setShellOpen] = usePersisted(KEYS.shellOpen, flagCodec, false);
  const [shellHeight, setShellHeight] = usePersisted(KEYS.shellHeight, shellHeightCodec, SHELL_DEFAULT);
  const mainRef = useRef<HTMLElement | null>(null);

  const panesRef = useRef<HTMLDivElement | null>(null);
  /** The elements a drag resizes; App gives each the style below. */
  const sidebarRef = useRef<HTMLElement | null>(null);
  const ptyPaneRef = useRef<HTMLElement | null>(null);
  const filesPaneRef = useRef<HTMLElement | null>(null);
  const shellPaneRef = useRef<HTMLElement | null>(null);

  /**
   * Is there room for the column, right now?
   *
   * The preference is NOT changed by the answer. A pinned column that stops
   * fitting falls back to the tab and comes back when the window allows, which
   * is the difference between a layout that adapts and a preference that
   * evaporates on resize and never returns.
   */
  const fits = columnFits({ mode, orientation, ratio, panesWidth, filesWidth, filesPinned });
  const filesColumnShown = fits.shown;
  /**
   * The same answer for a read area with no terminal beside it -- the project
   * view's (#181), which takes the whole row whatever the mode.
   */
  const filesColumnShownAlone = fits.shownAlone;

  // --- splitter drags ------------------------------------------------------
  //
  // A drag used to set state on every pointer move, re-rendering the whole
  // app (and writing localStorage) per move (#364). Now the dragged element
  // is given its new size directly, with the very style string a render
  // would write, and the value is committed once, on release. What is drawn
  // is the same at every move: a value that would change what renders --
  // the files column showing or not, at a width or ratio past where it fits
  // -- is committed at once, as before, and so is any move a direct write
  // cannot stand for (the pane not there, or not laid out by that value).

  /** What was last rendered, for the drag handlers. */
  const drawn = useRef({ mode, orientation, ratio, filesWidth, filesPinned, panesWidth, taskListCollapsed, fits });
  drawn.current = { mode, orientation, ratio, filesWidth, filesPinned, panesWidth, taskListCollapsed, fits };
  /** The pane row's latest width; state only when it changes what renders, while a drag is on. */
  const panesWidthRef = useRef(0);
  /** The value being dragged, not yet committed, as it bears on the column. */
  const dragOverride = useRef<{ ratio?: number; filesWidth?: number } | null>(null);

  /** Would the files column show differently from what is drawn, with the drag's value? */
  const columnWouldChange = (override: { ratio?: number; filesWidth?: number }): boolean => {
    const d = drawn.current;
    const next = columnFits({ ...d, ...override, panesWidth: panesWidthRef.current });
    return next.shown !== d.fits.shown || next.shownAlone !== d.fits.shownAlone;
  };

  // Measure the pane row, not the read pane: the read pane's width DEPENDS on
  // whether the column is showing, so observing it would feed back on itself.
  useEffect(() => {
    const el = panesRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      panesWidthRef.current = el.clientWidth;
      // While a drag is on (the task list's moves this row), only a width
      // that changes what renders is state; release commits the rest.
      const override = dragOverride.current;
      if (override === null || columnWouldChange(override)) setPanesWidth(el.clientWidth);
    });
    observer.observe(el);
    panesWidthRef.current = el.clientWidth;
    setPanesWidth(el.clientWidth);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * One drag: `at` turns a pointer position into the value, `paint` writes it
   * to the element and says whether it could, `commit` sets the state, and
   * `override` says what the value means for the files column.
   */
  const drag = (
    kind: Exclude<Dragging, null>,
    at: (ev: PointerEvent) => number,
    paint: (value: number) => boolean,
    commit: (value: number) => void,
    override: (value: number) => { ratio?: number; filesWidth?: number },
  ) => {
    setDragging(kind);
    let last: number | null = null;
    dragOverride.current = {};
    const move = (ev: PointerEvent) => {
      const value = at(ev);
      last = value;
      const o = override(value);
      dragOverride.current = o;
      // Painted first, so the element has the value even when a commit follows.
      const painted = paint(value);
      if (!painted || columnWouldChange(o)) {
        commit(value);
        setPanesWidth(panesWidthRef.current);
      }
    };
    const up = () => {
      if (last !== null) commit(last);
      setPanesWidth(panesWidthRef.current);
      dragOverride.current = null;
      setDragging(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const startSidebarDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    drag(
      'sidebar',
      (ev) => clamp(ev.clientX, SIDEBAR_MIN, SIDEBAR_MAX),
      (w) => {
        const el = sidebarRef.current;
        // Collapsed, the rail has no width of its own to set (App.tsx).
        if (!el || drawn.current.taskListCollapsed) return false;
        const s = sidebarStyle(w);
        el.style.width = `${s.width}px`;
        el.style.flexBasis = `${s.flexBasis}px`;
        return true;
      },
      setSidebarWidth,
      () => ({}),
    );
  };

  const startSplitDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rect = panesRef.current?.getBoundingClientRect();
    if (!rect) return;
    drag(
      'split',
      (ev) =>
        clamp(
          orientation === 'row' ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height,
          RATIO_MIN,
          RATIO_MAX,
        ),
      (r) => {
        const el = ptyPaneRef.current;
        // Only split mode lays the terminal out by the ratio (App.tsx).
        if (!el || drawn.current.mode !== 'split') return false;
        el.style.flex = ratioFlex(r);
        return true;
      },
      setRatio,
      (r) => ({ ratio: r }),
    );
  };

  const startFilesDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rect = panesRef.current?.getBoundingClientRect();
    if (!rect) return;
    drag(
      'files',
      (ev) => clamp(rect.right - ev.clientX, FILES_MIN, FILES_MAX),
      (w) => {
        const el = filesPaneRef.current;
        if (!el) return false;
        el.style.flex = filesFlex(w);
        return true;
      },
      setFilesWidth,
      (w) => ({ filesWidth: w }),
    );
  };

  const startShellDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rect = mainRef.current?.getBoundingClientRect();
    if (!rect) return;
    drag(
      'shell',
      (ev) => clamp(rect.bottom - ev.clientY, SHELL_MIN, Math.max(SHELL_MIN, rect.height - SHELL_PANES_MIN)),
      (h) => {
        const el = shellPaneRef.current;
        if (!el) return false;
        el.style.flex = shellFlex(h);
        return true;
      },
      setShellHeight,
      () => ({}),
    );
  };

  return {
    sidebarWidth,
    taskListCollapsed,
    setTaskListCollapsed,
    mode,
    setMode,
    orientation,
    setOrientation,
    ratio,
    rightTab,
    setRightTab,
    filesPinned,
    setFilesPinned,
    filesWidth,
    filesColumnShown,
    filesColumnShownAlone,
    dragging,
    shellOpen,
    setShellOpen,
    shellHeight,
    mainRef,
    panesRef,
    sidebarRef,
    ptyPaneRef,
    filesPaneRef,
    shellPaneRef,
    startSidebarDrag,
    startSplitDrag,
    startFilesDrag,
    startShellDrag,
  };
}
