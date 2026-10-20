/**
 * A scrollbar thumb drawn OVER the transcript, not beside it.
 *
 * The app styles `::-webkit-scrollbar`, and a styled WebKit scrollbar always
 * takes layout width: your message band stopped 9px short of the pane's edge,
 * with the bare panel showing under the track. The transcript hides its native
 * scrollbar and draws this instead, so the band reaches the right edge and the
 * thumb floats on top of it -- what a macOS overlay scrollbar does.
 *
 * It is a real control, not decoration: dragging the thumb scrolls, and a
 * click in the rail pages toward the pointer. Wheel, trackpad and keys scroll
 * the element itself as before.
 */

import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';

const MIN_THUMB = 28;

export interface ThumbGeometry {
  top: number;
  height: number;
}

/** Where the thumb sits for a scroll position, or null when nothing scrolls. */
export function thumbGeometry(scrollTop: number, scrollHeight: number, clientHeight: number): ThumbGeometry | null {
  if (scrollHeight <= clientHeight + 1 || clientHeight <= 0) return null;
  const height = Math.max(MIN_THUMB, (clientHeight * clientHeight) / scrollHeight);
  const travel = clientHeight - height;
  const ratio = Math.min(1, Math.max(0, scrollTop / (scrollHeight - clientHeight)));
  return { top: ratio * travel, height };
}

export default function OverlayScrollbar({ target }: { target: RefObject<HTMLElement | null> }) {
  const [geo, setGeo] = useState<ThumbGeometry | null>(null);
  const drag = useRef<{ pointer: number; startY: number; startTop: number } | null>(null);

  useEffect(() => {
    const el = target.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setGeo(thumbGeometry(el.scrollTop, el.scrollHeight, el.clientHeight)));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    // Messages arriving or a row expanding change the height without a scroll.
    const resize = new ResizeObserver(update);
    resize.observe(el);
    const mutate = new MutationObserver(update);
    mutate.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('scroll', update);
      resize.disconnect();
      mutate.disconnect();
    };
  }, [target]);

  if (!geo) return null;

  const onThumbDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = target.current;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pointer: e.pointerId, startY: e.clientY, startTop: el.scrollTop };
  };
  const onThumbMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const el = target.current;
    if (!d || !el || d.pointer !== e.pointerId) return;
    const travel = el.clientHeight - geo.height;
    if (travel <= 0) return;
    el.scrollTop = d.startTop + ((e.clientY - d.startY) / travel) * (el.scrollHeight - el.clientHeight);
  };
  const onThumbUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer === e.pointerId) drag.current = null;
  };
  const onRailDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = target.current;
    if (!el || e.target !== e.currentTarget) return;
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    el.scrollBy({ top: y < geo.top ? -el.clientHeight * 0.9 : el.clientHeight * 0.9 });
  };

  return (
    <div className="tx-rail" aria-hidden="true" onPointerDown={onRailDown}>
      <div
        className="tx-thumb"
        data-dragging={drag.current !== null || undefined}
        style={{ top: geo.top, height: geo.height }}
        onPointerDown={onThumbDown}
        onPointerMove={onThumbMove}
        onPointerUp={onThumbUp}
        onPointerCancel={onThumbUp}
      />
    </div>
  );
}
