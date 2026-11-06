// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { keepEscapeFromLeavingFullscreen } from './escapeKeepsFullscreen';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  document.body.innerHTML = '';
});

function on(handler: (e: KeyboardEvent) => void, capture = false) {
  window.addEventListener('keydown', handler, capture);
  cleanups.push(() => window.removeEventListener('keydown', handler, capture));
}

function press(init: KeyboardEventInit, from: EventTarget = document.body.appendChild(document.createElement('div'))) {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  from.dispatchEvent(e);
  return e;
}

describe('Escape never leaves full screen (#267)', () => {
  it('an Escape nothing handled ends up handled, so AppKit never sees it', () => {
    cleanups.push(keepEscapeFromLeavingFullscreen());
    expect(press({ key: 'Escape' }).defaultPrevented).toBe(true);
  });

  it("only once the app's own window listeners have had it: they still see it unhandled", () => {
    const seen: boolean[] = [];
    on((e) => seen.push(e.defaultPrevented)); // registered before
    cleanups.push(keepEscapeFromLeavingFullscreen());
    on((e) => seen.push(e.defaultPrevented)); // and after
    on((e) => seen.push(e.defaultPrevented), true); // and in capture
    const e = press({ key: 'Escape' });
    expect(seen).toEqual([false, false, false]);
    expect(e.defaultPrevented).toBe(true);
  });

  it('every Escape, not only the first', () => {
    cleanups.push(keepEscapeFromLeavingFullscreen());
    expect(press({ key: 'Escape' }).defaultPrevented).toBe(true);
    expect(press({ key: 'Escape' }).defaultPrevented).toBe(true);
  });

  it('other keys, and an Escape that cancels an input method composition, are left alone', () => {
    cleanups.push(keepEscapeFromLeavingFullscreen());
    expect(press({ key: 'a' }).defaultPrevented).toBe(false);
    expect(press({ key: 'Escape', isComposing: true }).defaultPrevented).toBe(false);
  });

  it('an Escape stopped before the window is left to whoever stopped it, and the next one still works', () => {
    cleanups.push(keepEscapeFromLeavingFullscreen());
    const box = document.body.appendChild(document.createElement('div'));
    const stop = (e: Event) => e.stopPropagation();
    box.addEventListener('keydown', stop);
    expect(press({ key: 'Escape' }, box).defaultPrevented).toBe(false);
    box.removeEventListener('keydown', stop);
    expect(press({ key: 'a' }).defaultPrevented).toBe(false);
    expect(press({ key: 'Escape' }).defaultPrevented).toBe(true);
  });
});
