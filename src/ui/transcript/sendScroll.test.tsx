/**
 * @vitest-environment jsdom
 *
 * Sending a message takes the transcript to the end and keeps it there (#142).
 *
 * jsdom lays nothing out, so this file gives the pane a small layout model,
 * close enough to a browser for the scroll logic to be exercised:
 *
 *  - every row in `.tx-scroll` has a height (the echo and the working line
 *    are short, transcript rows tall), and the transcript's view is what the
 *    pane leaves after the message box;
 *  - `scrollTop` is clamped to what the content allows, as a browser does on
 *    layout, and a change to it fires `scroll` at the next frame, not at once;
 *  - a frame runs, in the browser's order: scroll events, animation-frame
 *    callbacks, then ResizeObserver for elements whose size changed.
 *
 * The message box measures itself by collapsing to `height: auto` (one line)
 * and reading its scrollHeight; reading that lays the pane out with the taller
 * transcript view, which is when the browser clamps the transcript.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Message } from '../../types';

vi.mock('../Terminal', () => ({
  submitPty: vi.fn(async () => true),
  startPty: vi.fn(() => false),
  hasLivePty: vi.fn(() => true),
  ptyLiveSince: vi.fn(() => null),
  usePtyLiveSince: vi.fn(() => null),
  canResume: vi.fn(() => false),
  onPtyPresenceChange: vi.fn(() => () => {}),
}));
vi.mock('../BackgroundWork', () => ({ useBackgroundWork: () => [], backgroundShown: () => [] }));
vi.mock('./OverlayScrollbar', () => ({ default: () => null }));
vi.mock('../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db')>()),
  getMessages: vi.fn(async () => rows),
}));
vi.mock('../../db/comments', () => ({ markCommentsSent: vi.fn(async () => {}) }));

const { TranscriptPane } = await import('./TranscriptPane');
const { __resetDrafts } = await import('./drafts');

const T0 = new Date('2026-10-30T10:00:00Z').getTime();
const rows: Message[] = Array.from({ length: 20 }, (_, i) => ({
  id: i + 1,
  taskId: 1,
  sessionId: 's1',
  seq: i * 100,
  role: i % 2 === 0 ? 'user' : 'assistant',
  toolName: null,
  targetPath: null,
  body: `row ${i + 1}`,
  rawJson: '{}',
  agentId: null,
  ts: T0 + i * 1000,
}));

/** Room the transcript and the box share. */
const PANE_PX = 600;
/** The box at `height: auto`: one line. */
const COLLAPSED_PX = 28;

function rowHeight(el: Element): number {
  if (el.classList.contains('tx-row-echo')) return 40;
  if (el.classList.contains('tx-row-working')) return 30;
  return 100;
}

// --- frames ------------------------------------------------------------------

let rafQueue: FrameRequestCallback[] = [];
const scrollPending = new Set<HTMLElement>();
const observers: FakeResizeObserver[] = [];

class FakeResizeObserver {
  private seen = new Map<Element, number>();
  constructor(private cb: ResizeObserverCallback) {
    observers.push(this);
  }
  observe(el: Element) {
    this.seen.set(el, (el as HTMLElement).clientHeight);
  }
  unobserve(el: Element) {
    this.seen.delete(el);
  }
  disconnect() {
    this.seen.clear();
  }
  check() {
    const changed: ResizeObserverEntry[] = [];
    for (const [el, h] of this.seen) {
      const now = (el as HTMLElement).clientHeight;
      if (now !== h) {
        this.seen.set(el, now);
        changed.push({ target: el } as ResizeObserverEntry);
      }
    }
    if (changed.length > 0) this.cb(changed, this as unknown as ResizeObserver);
  }
}

/** One browser frame: scroll events, then rAF callbacks, then ResizeObserver. */
function frame() {
  act(() => {
    for (const el of [...scrollPending]) {
      scrollPending.delete(el);
      fireEvent.scroll(el);
    }
    const due = rafQueue;
    rafQueue = [];
    for (const cb of due) cb(performance.now());
    for (const ro of observers) ro.check();
  });
}

// --- layout ------------------------------------------------------------------

const box = () => screen.getByRole('textbox') as HTMLTextAreaElement;
const scroller = () => document.querySelector('.tx-scroll') as HTMLElement;

function boxPx(): number {
  const h = box().style.height;
  return h === '' || h === 'auto' ? COLLAPSED_PX : parseFloat(h);
}

/** Model the pane's layout on the elements jsdom renders. */
function layOut() {
  const scroll = scroller();
  let top = 0;
  const contentPx = () => [...scroll.children].reduce((sum, el) => sum + rowHeight(el), 0);
  const viewPx = () => PANE_PX - boxPx();
  const max = () => Math.max(0, contentPx() - viewPx());
  const set = (v: number) => {
    const next = Math.min(Math.max(0, v), max());
    if (next !== top) scrollPending.add(scroll);
    top = next;
  };
  Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: contentPx });
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, get: viewPx });
  Object.defineProperty(scroll, 'scrollTop', {
    configurable: true,
    get: () => {
      set(top); // layout clamps
      return top;
    },
    set,
  });
  const pane = document.querySelector('.tx-pane') as HTMLElement;
  const wrap = document.querySelector('.tx-scroll-wrap') as HTMLElement;
  Object.defineProperty(pane, 'clientHeight', { configurable: true, get: () => PANE_PX });
  Object.defineProperty(wrap, 'offsetHeight', { configurable: true, get: viewPx });
  Object.defineProperty(box(), 'offsetHeight', { configurable: true, get: boxPx });
  // Reading the collapsed box's size lays the pane out with it collapsed.
  Object.defineProperty(box(), 'scrollHeight', {
    configurable: true,
    get: () => {
      set(top);
      return box().value.split('\n').length * 60;
    },
  });
  return { atEnd: () => scroll.scrollTop === max(), max };
}

const jumpShown = () => document.querySelector('.tx-jump') !== null;

async function renderPane(): Promise<ReturnType<typeof layOut>> {
  render(<TranscriptPane taskId={1} sessionId="s1" status="idle" />);
  await waitFor(() => expect(document.querySelectorAll('.tx-scroll .tx-row').length).toBeGreaterThan(0));
  const layout = layOut();
  // Lands at the end, as the window load does on a real layout.
  act(() => {
    scroller().scrollTop = scroller().scrollHeight;
  });
  frame();
  frame();
  expect(layout.atEnd()).toBe(true);
  expect(jumpShown()).toBe(false);
  return layout;
}

async function send(text: string) {
  fireEvent.change(box(), { target: { value: text } });
  frame();
  fireEvent.keyDown(box(), { key: 'Enter' });
  await waitFor(() => expect(box().value).toBe(''));
  await waitFor(() => expect(document.querySelector('.tx-row-echo')).not.toBeNull());
  for (let i = 0; i < 4; i++) frame();
}

beforeEach(() => {
  rafQueue = [];
  scrollPending.clear();
  observers.length = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => rafQueue.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  __resetDrafts();
});

describe('sending a message (#142)', () => {
  it('keeps following with a dragged message box: no "Latest" button', async () => {
    // A dragged box: measuring it collapses it to one line, and back.
    window.localStorage.setItem('albedo.composerPx', '200');
    await renderPane();
    await send('please run the tests');
    expect(jumpShown()).toBe(false);
  });

  it('ends at the end, below the echo and the working line', async () => {
    window.localStorage.setItem('albedo.composerPx', '200');
    const layout = await renderPane();
    await send('please run the tests');
    expect(document.querySelector('.tx-row-working')).not.toBeNull();
    expect(layout.atEnd()).toBe(true);
    expect(jumpShown()).toBe(false);
  });

  it('ends at the end with the auto-growing box too', async () => {
    const layout = await renderPane();
    await send('please run the tests');
    expect(layout.atEnd()).toBe(true);
    expect(jumpShown()).toBe(false);
  });

  it('sent from further up, it still goes to the end', async () => {
    window.localStorage.setItem('albedo.composerPx', '200');
    const layout = await renderPane();
    act(() => {
      scroller().scrollTop = 300;
    });
    frame();
    expect(jumpShown()).toBe(true);
    await send('please run the tests');
    expect(layout.atEnd()).toBe(true);
    expect(jumpShown()).toBe(false);
  });
});

describe('a reader scrolled up who is not sending (#136)', () => {
  it('keeps their place while the box grows and shrinks', async () => {
    window.localStorage.setItem('albedo.composerPx', '200');
    await renderPane();
    act(() => {
      scroller().scrollTop = 300;
    });
    frame();
    expect(jumpShown()).toBe(true);

    fireEvent.change(box(), { target: { value: 'a\nb\nc\nd' } });
    frame();
    frame();
    expect(scroller().scrollTop).toBe(300);
    fireEvent.change(box(), { target: { value: '' } });
    frame();
    frame();
    expect(scroller().scrollTop).toBe(300);
    expect(jumpShown()).toBe(true);
  });
});
