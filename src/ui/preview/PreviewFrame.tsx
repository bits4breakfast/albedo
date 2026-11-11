/**
 * A preview's page, in a sandboxed iframe (#348), with the pins on top.
 *
 * The page is model-written. See frameDoc.ts for how it is held apart: the
 * sandbox is `allow-scripts` only, never `allow-same-origin`; it is loaded
 * from the stored copy through `srcdoc`, never from a path; and its CSP
 * forbids every kind of network access.
 *
 * Comment on a Spot lays a transparent layer over the frame: a click there
 * drops a numbered pin instead of reaching the page. A wheel on the layer
 * lets the page scroll for a moment. Pins are placed in page coordinates,
 * from the scroll position the page reports (frameDoc.ts); the only message
 * taken from the page is that one, as plain numbers, from this frame alone.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { PREVIEW_SANDBOX, parseGeometry, previewSrcdoc, type Geometry, type PreviewScheme } from './frameDoc';

export interface FramePin {
  /** The number shown on it; null for the one being written. */
  n: number | null;
  /** Percent of the page's width and height. */
  x: number;
  y: number;
}

/** How long a wheel on the click layer lets the page take the wheel. */
const SCROLL_THROUGH_MS = 450;

export function PreviewFrame({
  html,
  title,
  scheme,
  large,
  commentMode,
  pins,
  onPlace,
}: {
  html: string;
  /** For the iframe's accessible name. */
  title: string;
  scheme: PreviewScheme;
  large: boolean;
  commentMode: boolean;
  pins: readonly FramePin[];
  /** A click on the layer: where on the page, in percent. */
  onPlace: (x: number, y: number) => void;
}): ReactNode {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const [geom, setGeom] = useState<Geometry | null>(null);
  const [through, setThrough] = useState(false);
  const throughTimer = useRef<number | null>(null);

  // A new page or scheme is a new document: its scroll starts at the top.
  const srcdoc = useMemo(() => previewSrcdoc(html, scheme), [html, scheme]);
  useEffect(() => setGeom(null), [srcdoc]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Only this frame's own window, and only numbers.
      if (frameRef.current === null || e.source !== frameRef.current.contentWindow) return;
      const g = parseGeometry(e.data);
      if (g) {
        setGeom(g);
        if (throughTimer.current !== null) holdThrough();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      if (throughTimer.current !== null) window.clearTimeout(throughTimer.current);
    },
    [],
  );

  const holdThrough = () => {
    setThrough(true);
    if (throughTimer.current !== null) window.clearTimeout(throughTimer.current);
    throughTimer.current = window.setTimeout(() => {
      throughTimer.current = null;
      setThrough(false);
    }, SCROLL_THROUGH_MS);
  };

  /** The page's geometry, or the frame's own box until the page reports. */
  const box = (): Geometry => {
    const el = layerRef.current ?? frameRef.current;
    const w = el?.clientWidth || 1;
    const h = el?.clientHeight || 1;
    return geom ?? { x: 0, y: 0, w, h, vw: w, vh: h };
  };

  const place = (e: ReactMouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const g = box();
    const sx = g.vw / (r.width || 1);
    const sy = g.vh / (r.height || 1);
    const px = g.x + (e.clientX - r.left) * sx;
    const py = g.y + (e.clientY - r.top) * sy;
    onPlace((px / g.w) * 100, (py / g.h) * 100);
  };

  const g = geom;
  return (
    <div className={large ? 'pv-frame pv-frame-large' : 'pv-frame'} data-commenting={commentMode || undefined}>
      <iframe
        ref={frameRef}
        className="pv-iframe"
        title={`Preview: ${title}`}
        sandbox={PREVIEW_SANDBOX}
        srcDoc={srcdoc}
        referrerPolicy="no-referrer"
        // The page's own prefers-color-scheme follows this, where the engine
        // supports it; frameDoc's script covers the rest.
        style={{ colorScheme: scheme }}
      />
      {commentMode ? (
        <div
          ref={layerRef}
          className="pv-layer"
          data-through={through || undefined}
          role="button"
          tabIndex={-1}
          aria-label="Click the page to drop a pin"
          onClick={place}
          onWheel={holdThrough}
        />
      ) : null}
      {/* What holds the page apart, said once, out of the page's way. */}
      <span className="pv-badge" aria-hidden="true">
        Sandboxed: no network, no access to Albedo
      </span>
      {pins.map((p, i) => {
        // Page percent to a spot in the frame, scrolled as the page is.
        const left = g ? (p.x / 100) * g.w - g.x : null;
        const top = g ? (p.y / 100) * g.h - g.y : null;
        if (g && (left! < -12 || top! < -12 || left! > g.vw + 12 || top! > g.vh + 12)) return null;
        const style =
          g && left !== null && top !== null
            ? { left: `${(left / g.vw) * 100}%`, top: `${(top / g.vh) * 100}%` }
            : { left: `${p.x}%`, top: `${p.y}%` };
        return (
          <span key={p.n ?? `draft-${i}`} className={p.n === null ? 'pv-pin pv-pin-draft' : 'pv-pin'} style={style} aria-hidden="true">
            <span className="pv-pin-n">{p.n ?? '+'}</span>
          </span>
        );
      })}
    </div>
  );
}
