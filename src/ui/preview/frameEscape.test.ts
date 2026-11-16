// @vitest-environment jsdom
/**
 * Esc inside the preview frame (#376): it still reaches the mockup's own
 * listeners unhandled and still tells the viewer, and it ends up marked
 * handled, so WKWebView never hands it back to AppKit -- which would take a
 * full-screen window out of full screen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ESCAPE_TAG, previewSrcdoc } from './frameDoc';

/** Albedo's Esc script, as the srcdoc carries it. */
function escapeScriptSource(): string {
  const scripts = [...previewSrcdoc('', 'light').matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  const s = scripts.find((x) => x.includes(ESCAPE_TAG));
  if (!s) throw new Error('no Esc script in the srcdoc');
  return s;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** Runs the script against this window with a fake parent, keeping its listeners removable. */
function install(post: (data: unknown) => void): void {
  const added: Array<[string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined]> = [];
  const add = (type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => {
    added.push([type, fn, opts]);
    window.addEventListener(type, fn, opts);
  };
  new Function('addEventListener', 'parent', escapeScriptSource())(add, { postMessage: post });
  cleanups.push(() => added.forEach(([t, f, o]) => window.removeEventListener(t, f, o)));
}

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(e);
  return e;
}

describe('the preview frame\'s Esc script', () => {
  it('tells the viewer and marks Escape handled, so full screen is kept', () => {
    const post = vi.fn();
    install(post);
    const e = press('Escape');
    expect(post).toHaveBeenCalledWith({ tag: ESCAPE_TAG }, '*');
    expect(e.defaultPrevented).toBe(true);
  });

  it("lets the mockup's own listeners see Escape unhandled first", () => {
    install(() => {});
    let seen: boolean | null = null;
    const own = (e: KeyboardEvent) => {
      seen = e.defaultPrevented;
    };
    document.addEventListener('keydown', own);
    cleanups.push(() => document.removeEventListener('keydown', own));
    const e = press('Escape');
    expect(seen).toBe(false);
    expect(e.defaultPrevented).toBe(true);
  });

  it('leaves other keys and an Escape that ends a composition alone', () => {
    const post = vi.fn();
    install(post);
    expect(press('a').defaultPrevented).toBe(false);
    expect(press('Escape', { isComposing: true }).defaultPrevented).toBe(false);
    // Ending a composition in a mockup field doesn't close the viewer either.
    expect(post).not.toHaveBeenCalled();
  });

  it('marks only the Escape it was added for', () => {
    install(() => {});
    press('Escape');
    expect(press('a').defaultPrevented).toBe(false);
  });
});
