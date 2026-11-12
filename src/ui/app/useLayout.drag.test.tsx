/**
 * @vitest-environment jsdom
 *
 * Splitter drags (#364): a pointer move resizes the dragged pane without a
 * render, with the style string a render would write, and the value is
 * committed -- state and localStorage -- once, on release. A move that
 * changes what renders (the files column fitting or not) still renders at
 * once, and so does a move the element cannot stand for (collapsed list,
 * a mode that does not lay the pane out by the value).
 *
 * The harness lays the panes out as App.tsx does, with the same conditions
 * and the same style helpers.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import useLayout, { columnFits, filesFlex, ratioFlex, shellFlex } from './useLayout';
import { KEYS } from '../persisted';

let renders = 0;
let layout: ReturnType<typeof useLayout> | null = null;

function Harness() {
  renders += 1;
  const l = useLayout();
  layout = l;
  const split = l.mode === 'split';
  return (
    <div className="app" data-dragging={l.dragging !== null}>
      <aside
        data-testid="sidebar"
        ref={l.sidebarRef}
        style={l.taskListCollapsed ? undefined : { width: l.sidebarWidth, flexBasis: l.sidebarWidth }}
      />
      {!l.taskListCollapsed && <div data-testid="sidebar-splitter" onPointerDown={l.startSidebarDrag} />}
      <main ref={l.mainRef}>
        <div className="panes" ref={l.panesRef}>
          <section data-testid="pty" ref={l.ptyPaneRef} style={split ? { flex: ratioFlex(l.ratio) } : { flex: '1 1 auto' }} />
          {split && <div data-testid="split-splitter" onPointerDown={l.startSplitDrag} />}
          {l.filesColumnShown && (
            <>
              <div data-testid="files-splitter" onPointerDown={l.startFilesDrag} />
              <section data-testid="files" ref={l.filesPaneRef} style={{ flex: filesFlex(l.filesWidth) }} />
            </>
          )}
        </div>
        <div data-testid="shell-splitter" onPointerDown={l.startShellDrag} />
        <section data-testid="shell" ref={l.shellPaneRef} style={{ flex: shellFlex(l.shellHeight) }} />
      </main>
    </div>
  );
}

// --- jsdom stand-ins: layout it does not do -----------------------------------

let paneRowWidth = 1600;
const observers = new Set<() => void>();
class FakeResizeObserver {
  private cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
  }
  observe() {
    observers.add(this.cb);
  }
  unobserve() {}
  disconnect() {
    observers.delete(this.cb);
  }
}
/** The pane row changes width (a sidebar drag moves it): what the observer reports. */
function resizeRow(w: number) {
  paneRowWidth = w;
  act(() => {
    for (const cb of [...observers]) cb();
  });
}

let store: Map<string, string>;
let writes: string[];
const saved = {
  ro: globalThis.ResizeObserver,
  rect: HTMLElement.prototype.getBoundingClientRect,
};

beforeEach(() => {
  renders = 0;
  layout = null;
  paneRowWidth = 1600;
  observers.clear();
  store = new Map();
  writes = [];
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        writes.push(k);
        store.set(k, String(v));
      },
      removeItem: (k: string) => {
        writes.push(k);
        store.delete(k);
      },
    },
  });
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('panes') ? paneRowWidth : 0;
    },
  });
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const w = this.classList.contains('panes') ? paneRowWidth : 2000;
    return { left: 0, top: 0, right: w, bottom: 1000, width: w, height: 1000, x: 0, y: 0, toJSON() {} } as DOMRect;
  };
});

afterEach(() => {
  cleanup();
  globalThis.ResizeObserver = saved.ro;
  HTMLElement.prototype.getBoundingClientRect = saved.rect;
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
});

const el = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function press(id: string) {
  fireEvent.pointerDown(el(id)!);
}
function moveTo(x: number, y = 0) {
  act(() => void window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y })));
}
function release() {
  act(() => void window.dispatchEvent(new MouseEvent('pointerup')));
}

describe('the split drag (#364)', () => {
  it('paints the terminal pane on each move with no render, and commits once on release', () => {
    render(<Harness />);
    expect(el('pty')!.style.flex).toBe(ratioFlex(0.55));
    press('split-splitter');
    const before = renders;
    writes = [];
    for (const x of [600, 700, 800, 900]) {
      moveTo(x);
      // What a render with this ratio would write, already there.
      expect(el('pty')!.style.flex).toBe(ratioFlex(x / 1600));
    }
    expect(renders).toBe(before);
    expect(writes).toEqual([]);
    expect(layout!.ratio).toBe(0.55);

    release();
    expect(layout!.ratio).toBe(900 / 1600);
    expect(layout!.dragging).toBeNull();
    expect(el('pty')!.style.flex).toBe(ratioFlex(900 / 1600));
    expect(store.get(KEYS.splitRatio)).toBe((900 / 1600).toFixed(3));
    expect(writes.filter((k) => k === KEYS.splitRatio)).toHaveLength(1);
  });

  it('clamps as before', () => {
    render(<Harness />);
    press('split-splitter');
    moveTo(10);
    expect(el('pty')!.style.flex).toBe(ratioFlex(0.18));
    moveTo(1599);
    expect(el('pty')!.style.flex).toBe(ratioFlex(0.86));
    release();
    expect(layout!.ratio).toBe(0.86);
  });

  it('a press with no move commits nothing', () => {
    render(<Harness />);
    press('split-splitter');
    writes = [];
    release();
    expect(layout!.ratio).toBe(0.55);
    expect(writes.filter((k) => k === KEYS.splitRatio)).toEqual([]);
  });

  it('renders at once where the files column stops or starts fitting, as it did', () => {
    store.set(KEYS.filesPinned, '1');
    render(<Harness />);
    // 1600 * (1 - 0.55) = 720 >= 240 + 420: the column shows.
    expect(el('files')).not.toBeNull();
    press('split-splitter');
    moveTo(900); // read area 700: still fits
    expect(el('files')).not.toBeNull();
    const before = renders;
    moveTo(1000); // read area 600 < 660: it no longer fits
    expect(renders).toBeGreaterThan(before);
    expect(el('files')).toBeNull();
    expect(layout!.ratio).toBe(1000 / 1600);
    moveTo(800); // back: it fits again
    expect(el('files')).not.toBeNull();
    for (const x of [700, 900, 1000, 800, 760]) {
      moveTo(x);
      const want = columnFits({ mode: 'split', orientation: 'row', ratio: x / 1600, panesWidth: 1600, filesWidth: 240, filesPinned: true });
      expect(el('files') !== null, `at ${x}`).toBe(want.shown);
    }
    release();
    expect(layout!.ratio).toBe(760 / 1600);
  });

  it('a column orientation measures from the top', () => {
    store.set(KEYS.orientation, 'column');
    render(<Harness />);
    press('split-splitter');
    moveTo(0, 400);
    expect(el('pty')!.style.flex).toBe(ratioFlex(0.4));
    release();
    expect(layout!.ratio).toBe(0.4);
  });
});

describe('the files column drag (#364)', () => {
  it('paints the column with no render and commits on release; past the fit it renders, as before', () => {
    store.set(KEYS.filesPinned, '1');
    paneRowWidth = 2000; // read area 900
    render(<Harness />);
    press('files-splitter');
    const before = renders;
    moveTo(2000 - 300);
    expect(el('files')!.style.flex).toBe(filesFlex(300));
    const w = 2000 - (2000 - 400.4); // as the handler computes it
    moveTo(2000 - 400.4);
    expect(el('files')!.style.flex).toBe(filesFlex(w));
    expect(renders).toBe(before);
    expect(layout!.filesWidth).toBe(240);
    release();
    expect(layout!.filesWidth).toBe(w);
    expect(el('files')!.style.flex).toBe(filesFlex(w));
    expect(store.get(KEYS.filesWidth)).toBe('400');
  });

  it('a width that no longer fits hides the column at that move', () => {
    store.set(KEYS.filesPinned, '1');
    paneRowWidth = 1600; // read area 720: fits up to 300
    render(<Harness />);
    press('files-splitter');
    moveTo(1600 - 290);
    expect(el('files')).not.toBeNull();
    moveTo(1600 - 320);
    expect(el('files')).toBeNull();
    expect(layout!.filesWidth).toBe(320);
    release();
    expect(layout!.filesWidth).toBe(320);
  });
});

describe('the task list drag (#364)', () => {
  it('paints the list with no render, and the pane row resizing renders only when it changes the column', () => {
    store.set(KEYS.filesPinned, '1');
    paneRowWidth = 1600;
    render(<Harness />);
    expect(el('files')).not.toBeNull();
    press('sidebar-splitter');
    const before = renders;
    moveTo(350);
    expect(el('sidebar')!.style.width).toBe('350px');
    expect(el('sidebar')!.style.flexBasis).toBe('350px');
    resizeRow(1550); // read area 697.5: still fits
    moveTo(380.5);
    expect(el('sidebar')!.style.width).toBe('380.5px');
    expect(renders).toBe(before);

    resizeRow(1400); // read area 630 < 660: the column goes, at once
    expect(renders).toBeGreaterThan(before);
    expect(el('files')).toBeNull();

    release();
    expect(layout!.sidebarWidth).toBe(380.5);
    expect(store.get(KEYS.sidebarWidth)).toBe('381');
    expect(el('sidebar')!.style.width).toBe('380.5px');
    // The row's last width is state once the drag ends.
    resizeRow(1400);
    expect(el('files')).toBeNull();
  });

  it('clamps to the list’s minimum and maximum', () => {
    render(<Harness />);
    press('sidebar-splitter');
    moveTo(100);
    expect(el('sidebar')!.style.width).toBe('300px');
    moveTo(900);
    expect(el('sidebar')!.style.width).toBe('480px');
    release();
    expect(layout!.sidebarWidth).toBe(480);
  });
});

describe('the shell drawer drag (#364)', () => {
  it('paints the drawer with no render and commits on release', () => {
    render(<Harness />);
    press('shell-splitter');
    const before = renders;
    moveTo(0, 700);
    expect(el('shell')!.style.flex).toBe(shellFlex(300));
    expect(renders).toBe(before);
    release();
    expect(layout!.shellHeight).toBe(300);
    expect(store.get(KEYS.shellHeight)).toBe('300');
  });
});

describe('a move the element cannot stand for renders, as every move used to', () => {
  it('the task list collapsed mid-drag: its width is stored, the rail is left alone', () => {
    render(<Harness />);
    press('sidebar-splitter');
    act(() => layout!.setTaskListCollapsed(true));
    const before = renders;
    moveTo(400);
    expect(renders).toBeGreaterThan(before);
    expect(layout!.sidebarWidth).toBe(400);
    expect(el('sidebar')!.style.width).toBe('');
    release();
  });

  it('PTY mode mid-drag: the ratio is stored, the terminal pane keeps its own flex', () => {
    render(<Harness />);
    press('split-splitter');
    act(() => layout!.setMode('pty'));
    moveTo(800);
    expect(layout!.ratio).toBe(0.5);
    expect(el('pty')!.style.flex).toBe('1 1 auto');
    release();
    expect(layout!.ratio).toBe(0.5);
  });
});
