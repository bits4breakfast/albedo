/**
 * A copy icon for a code block (#242), always at its right end. A click copies
 * the exact text; the icon turns into a tick for a moment and a polite live
 * region says so. A sibling of the code it copies, never inside it.
 *
 * Inline code's icon is not this button (#454): see `InlineCodeCopy.tsx`.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { copyText } from '../../lib/clipboard';

/** How long the tick (or the failure) shows. */
export const COPIED_MS = 1500;

export type CopyDone = 'copied' | 'failed' | null;

/** Whether the last copy worked, for COPIED_MS after it; then null again. */
export function useCopyDone(): [CopyDone, (done: CopyDone) => void] {
  const [done, setDone] = useState<CopyDone>(null);
  useEffect(() => {
    if (done === null) return;
    const t = window.setTimeout(() => setDone(null), COPIED_MS);
    return () => window.clearTimeout(t);
  }, [done]);
  return [done, setDone];
}

/** The button's tooltip, and what its live region says. */
export const copyTitle = (done: CopyDone): string => (done === 'copied' ? 'Copied' : done === 'failed' ? 'Couldn’t copy' : 'Copy');
export const copyStatus = (done: CopyDone): string => (done === null ? '' : copyTitle(done));

export function CopyButton({ text }: { text: string }): ReactNode {
  const [done, setDone] = useCopyDone();
  return (
    <>
      <button
        type="button"
        className="tx-copy tx-copy-block"
        aria-label="Copy"
        title={copyTitle(done)}
        data-done={done ?? undefined}
        onClick={(e) => {
          // Never the row's or the passage's click.
          e.stopPropagation();
          void copyText(text).then((ok) => setDone(ok ? 'copied' : 'failed'));
        }}
      >
        {done === 'copied' ? <TickGlyph /> : <CopyGlyph />}
      </button>
      <span className="sr-only tx-copy-status" role="status">
        {copyStatus(done)}
      </span>
    </>
  );
}

/**
 * The classic copy icon: two overlapping rounded squares. Inline code draws
 * the same shapes, and the tick's, from CSS (`--tx-copy-glyph` and
 * `--tx-tick-glyph` in transcript.css); `inlineCodeCopy.test.tsx` checks they agree.
 */
export const COPY_GLYPH_RECT = { width: 14, height: 14, x: 8, y: 8, rx: 2 } as const;
export const COPY_GLYPH_PATH = 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2';

function CopyGlyph(): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect {...COPY_GLYPH_RECT} />
      <path d={COPY_GLYPH_PATH} />
    </svg>
  );
}

export const TICK_GLYPH_PATH = 'M3.5 8.5l3 3 6-7';

function TickGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={1.6}>
      <path d={TICK_GLYPH_PATH} />
    </svg>
  );
}
