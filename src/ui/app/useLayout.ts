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
/** Tabs of the right-hand reading pane. `editor` appears on demand. */
export type RightTab = 'transcript' | 'files' | 'editor';
export type Dragging = null | 'sidebar' | 'split' | 'files' | 'shell';

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 480;
const SIDEBAR_DEFAULT = 260;
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
const sidebarCodec: Codec<number> = {
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
/** `editor` is never remembered: no file is open after a restart. */
const rightTabCodec: Codec<RightTab> = {
  ...oneOfCodec<RightTab>(['transcript', 'files', 'editor']),
  encode: (tab) => (tab === 'editor' ? undefined : tab),
};

export default function useLayout() {
  const [sidebarWidth, setSidebarWidth] = usePersisted(KEYS.sidebarWidth, sidebarCodec, SIDEBAR_DEFAULT);
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

  // Measure the pane row, not the read pane: the read pane's width DEPENDS on
  // whether the column is showing, so observing it would feed back on itself.
  useEffect(() => {
    const el = panesRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setPanesWidth(el.clientWidth));
    observer.observe(el);
    setPanesWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  /**
   * Is there room for the column, right now?
   *
   * The preference is NOT changed by the answer. A pinned column that stops
   * fitting falls back to the tab and comes back when the window allows, which
   * is the difference between a layout that adapts and a preference that
   * evaporates on resize and never returns.
   */
  const readAreaWidth =
    mode === 'pty'
      ? 0
      : mode === 'split' && orientation === 'row'
        ? panesWidth * (1 - ratio)
        : panesWidth;
  const filesColumnFits = readAreaWidth >= filesWidth + READ_MIN;
  const filesColumnShown = filesPinned && mode !== 'pty' && filesColumnFits;

  // --- splitter drags ------------------------------------------------------

  const startSidebarDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging('sidebar');
    const move = (ev: PointerEvent) => setSidebarWidth(clamp(ev.clientX, SIDEBAR_MIN, SIDEBAR_MAX));
    const up = () => {
      setDragging(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const startSplitDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rect = panesRef.current?.getBoundingClientRect();
    if (!rect) return;
    setDragging('split');
    const move = (ev: PointerEvent) => {
      const next =
        orientation === 'row'
          ? (ev.clientX - rect.left) / rect.width
          : (ev.clientY - rect.top) / rect.height;
      setRatio(clamp(next, RATIO_MIN, RATIO_MAX));
    };
    const up = () => {
      setDragging(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const startFilesDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rect = panesRef.current?.getBoundingClientRect();
    if (!rect) return;
    setDragging('files');
    const move = (ev: PointerEvent) =>
      setFilesWidth(clamp(rect.right - ev.clientX, FILES_MIN, FILES_MAX));
    const up = () => {
      setDragging(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const startShellDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rect = mainRef.current?.getBoundingClientRect();
    if (!rect) return;
    setDragging('shell');
    const move = (ev: PointerEvent) =>
      setShellHeight(clamp(rect.bottom - ev.clientY, SHELL_MIN, Math.max(SHELL_MIN, rect.height - SHELL_PANES_MIN)));
    const up = () => {
      setDragging(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return {
    sidebarWidth,
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
    dragging,
    shellOpen,
    setShellOpen,
    shellHeight,
    mainRef,
    panesRef,
    startSidebarDrag,
    startSplitDrag,
    startFilesDrag,
    startShellDrag,
  };
}
