/**
 * Inline code's copy icon (#242, #244, #454), kept out of the text.
 *
 * Every chip shows the icon at its right end, always: CSS draws it, as the
 * wrap's `::before` (the segment) and `::after` (the glyph), in the 20px strip
 * the wrap keeps on its right (#452). Nothing of it is in the DOM.
 *
 * That is the point. #243 put a `<button>` and a `role=status` span inside
 * each chip, and a positioned element inside a paragraph ends the paragraph
 * a triple click selects (Blink and WebKit both, measured): triple-clicking
 * "Clarification: `<timestamp>` in the request examples ..." selected only
 * up to the first code span. Generated content is not a node, so the browser
 * never sees it.
 *
 * The button you press is one per Markdown block, rendered outside the prose
 * (a portal to `document.body`, `position: fixed`), and laid exactly over the
 * strip of the chip the pointer is on. It looks the same as the strip under
 * it, with the button's own hover colours, title and "Copied" tick, so
 * nothing looks different from a button in each chip. It copies that chip's
 * text, from the wrap's `data-copy`.
 *
 * It is never a Tab stop, as before (`tabIndex=-1`): keyboard users select the
 * text and press ⌘C. A screen reader hears "Copied" from the live region beside it.
 */

import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { copyText } from '../../lib/clipboard';
import { copyStatus, copyTitle, useCopyDone } from './CopyButton';

/** The chip's wrap: the inline-block holding the code and its icon strip. */
export const WRAP = '.tx-md-code-wrap';
/** The strip on the wrap's right that the icon fills (transcript.css). */
export const STRIP_PX = 20;
/** Where inline code shows no icon at all (promptCard.css). */
const NO_ICON = '.tx-prompt';

interface Place {
  top: number;
  left: number;
  height: number;
  /** `clip-path` for the part a scrolling ancestor hides, or undefined. */
  clip: string | undefined;
}

/** The chip's wrap `target` is in, inside `root`, when that chip shows an icon. */
function wrapOf(target: EventTarget | null, root: Element): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const wrap = target.closest<HTMLElement>(WRAP);
  if (!wrap || !root.contains(wrap) || wrap.closest(NO_ICON) !== null) return null;
  return wrap;
}

/** The chip whose strip (not its code) `e` is on: the wrap itself is hit only there. */
function stripOf(e: { target: EventTarget | null; clientX: number; currentTarget: Element }): HTMLElement | null {
  const w = wrapOf(e.target, e.currentTarget);
  if (w === null || e.target !== w) return null;
  return e.clientX >= w.getBoundingClientRect().right - STRIP_PX ? w : null;
}

/**
 * Where the button goes: over the wrap's strip, in viewport coordinates, cut
 * to what every scrolling ancestor shows. Null when none of it is visible.
 */
export function placeOver(wrap: HTMLElement): Place | null {
  const r = wrap.getBoundingClientRect();
  const left = r.right - STRIP_PX;
  let top = r.top;
  let bottom = r.bottom;
  let l = left;
  let right = r.right;
  for (let el = wrap.parentElement; el && el !== document.body; el = el.parentElement) {
    const s = getComputedStyle(el);
    if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
    const c = el.getBoundingClientRect();
    top = Math.max(top, c.top);
    bottom = Math.min(bottom, c.bottom);
    l = Math.max(l, c.left);
    right = Math.min(right, c.right);
  }
  if (bottom <= top || right <= l) return null;
  // Something drawn over the strip (a sticky header, a popover) keeps it: the
  // button would land on top of that, so the strip stays as CSS draws it.
  if (typeof document.elementFromPoint === 'function') {
    const hit = document.elementFromPoint((l + right) / 2, (top + bottom) / 2);
    if (hit !== null && !wrap.contains(hit) && !hit.closest('.tx-copy-inline')) return null;
  }
  const cut = [top - r.top, r.right - right, r.bottom - bottom, l - left];
  return {
    top: r.top,
    left,
    height: r.height,
    clip: cut.some((n) => n > 0) ? `inset(${cut.map((n) => `${Math.max(0, n)}px`).join(' ')})` : undefined,
  };
}

export interface InlineCodeCopy {
  /** For the Markdown root: they find the chip the pointer is on. */
  onPointerOver: (e: PointerEvent<HTMLElement>) => void;
  onPointerOut: (e: PointerEvent<HTMLElement>) => void;
  /** ...and take a press on a strip before the button is over it. */
  onMouseDown: (e: MouseEvent<HTMLElement>) => void;
  onClick: (e: MouseEvent<HTMLElement>) => void;
  /** The button, rendered into `document.body`; null while no chip is pointed at. */
  overlay: ReactNode;
}

/** The copy button for every inline code chip in one Markdown block. */
export function useInlineCodeCopy(): InlineCodeCopy {
  const [wrap, setWrap] = useState<HTMLElement | null>(null);
  const wrapRef = useRef<HTMLElement | null>(null);
  wrapRef.current = wrap;
  const [place, setPlace] = useState<Place | null>(null);
  /**
   * The pointer came straight onto the strip, so the button appeared under a
   * pointer that has not moved since: the browser leaves `:hover` off until it
   * does. This stands in for it (CSS gives both the same look).
   */
  const [hot, setHot] = useState(false);
  const [done, setDone] = useCopyDone();
  const buttonRef = useRef<HTMLButtonElement>(null);
  /** The pointer is on the chip or the button; when false, the button goes once `done` clears. */
  const overRef = useRef(false);
  /** A press that began on a strip, before the button was there to take it. */
  const pressRef = useRef<HTMLElement | null>(null);

  const show = useCallback(
    (w: HTMLElement, x: number) => {
      const p = placeOver(w);
      if (p === null) return;
      overRef.current = true;
      if (wrapRef.current !== w) setDone(null);
      setWrap(w);
      setPlace(p);
      // On the strip itself (the code ends where it begins).
      setHot(x >= p.left);
    },
    [setDone],
  );
  const hide = useCallback(() => {
    setWrap(null);
    setPlace(null);
  }, []);

  const copy = useCallback(
    (w: HTMLElement) => {
      if (!w.isConnected) {
        hide();
        return;
      }
      void copyText(w.dataset.copy ?? '').then((ok) => {
        // The tick belongs to this chip; the pointer may be on another by now.
        if (wrapRef.current === w) setDone(ok ? 'copied' : 'failed');
      });
    },
    [hide, setDone],
  );

  // The pointer usually reaches a chip before it presses, and the button is
  // there to take the press. When it does not (it pressed without moving, after
  // a scroll brought the chip under it), the press lands on the strip, and the
  // release on the strip or on the button that appeared in between: either
  // way it copies, as a press on the button would.
  const onMouseDown = useCallback(
    (e: MouseEvent<HTMLElement>) => {
      const w = stripOf(e);
      pressRef.current = w;
      if (w === null) return;
      e.preventDefault(); // no text selection starts from the strip, as from a button
      show(w, e.clientX);
    },
    [show],
  );
  const onClick = useCallback(
    (e: MouseEvent<HTMLElement>) => {
      const w = stripOf(e);
      if (w === null || pressRef.current !== w) return;
      pressRef.current = null;
      e.stopPropagation();
      copy(w);
    },
    [copy],
  );

  const onPointerOver = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      const button = buttonRef.current;
      if (button && e.target instanceof Node && button.contains(e.target)) {
        setHot(false); // :hover has it now
        return;
      }
      const w = wrapOf(e.target, e.currentTarget);
      if (w) show(w, e.clientX);
    },
    [show],
  );
  const onPointerOut = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      const to = e.relatedTarget;
      const button = buttonRef.current;
      if (to instanceof Node && button?.contains(to)) return;
      setHot(false);
      if (wrap && to instanceof Node && wrap.contains(to)) return;
      // Onto another chip: its pointerover moves the button there.
      if (wrapOf(to, e.currentTarget) !== null) return;
      overRef.current = false;
      if (done === null) hide();
    },
    [wrap, done, hide],
  );

  // The tick stays for its moment even if the pointer has left; then it goes.
  useEffect(() => {
    if (done === null && !overRef.current) hide();
  }, [done, hide]);

  // Anything can move the chip while the button is over it -- a scroll, a
  // resized pane, a streamed reply growing above it -- and not all of them
  // say so with an event. So while it shows, it checks once a frame: one
  // rect read, and a new place only when that moved. A chip gone from the
  // page takes the button with it.
  useEffect(() => {
    if (wrap === null) return;
    let last = wrap.getBoundingClientRect();
    let frame = requestAnimationFrame(function tick() {
      if (!wrap.isConnected) {
        hide();
        return;
      }
      const r = wrap.getBoundingClientRect();
      if (r.top !== last.top || r.left !== last.left || r.width !== last.width || r.height !== last.height) {
        last = r;
        const p = placeOver(wrap);
        if (p === null) {
          hide();
          return;
        }
        setPlace(p);
      }
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [wrap, hide]);

  const overlay =
    wrap !== null && place !== null
      ? createPortal(
          <>
            <button
              ref={buttonRef}
              type="button"
              className="tx-copy tx-copy-inline"
              tabIndex={-1}
              aria-label="Copy"
              title={copyTitle(done)}
              data-done={done ?? undefined}
              data-hot={hot ? '' : undefined}
              style={{ top: place.top, left: place.left, height: place.height, clipPath: place.clip }}
              // Keep focus and the reader's selection where they are, and
              // never reach the root's own press handling (React bubbles a
              // portal's events through the tree).
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                pressRef.current = null;
              }}
              onMouseUp={(e) => {
                // Pressed on the strip, released here: the click goes to an
                // ancestor of both, so it is taken now.
                if (pressRef.current !== wrap) return;
                pressRef.current = null;
                e.stopPropagation();
                copy(wrap);
              }}
              onClick={(e) => {
                // Never the row's or the passage's click.
                e.stopPropagation();
                copy(wrap);
              }}
            />
            <span className="sr-only tx-copy-status" role="status">
              {copyStatus(done)}
            </span>
          </>,
          document.body,
        )
      : null;

  return { onPointerOver, onPointerOut, onMouseDown, onClick, overlay };
}
