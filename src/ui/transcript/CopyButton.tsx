/**
 * A copy icon for text in backticks (#242): always at the right end of a code
 * block, and after inline code while it is hovered. A click copies the exact
 * text; the icon turns into a tick for a moment and a polite live region says
 * so. A sibling of the code it copies, never inside it, so a path chip or a
 * link keeps its own click.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { copyText } from '../../lib/clipboard';

/** How long the tick (or the failure) shows. */
export const COPIED_MS = 1500;

export function CopyButton({ text, inline = false }: { text: string; inline?: boolean }): ReactNode {
  const [done, setDone] = useState<'copied' | 'failed' | null>(null);
  useEffect(() => {
    if (done === null) return;
    const t = window.setTimeout(() => setDone(null), COPIED_MS);
    return () => window.clearTimeout(t);
  }, [done]);
  return (
    <>
      <button
        type="button"
        className={inline ? 'tx-copy tx-copy-inline' : 'tx-copy tx-copy-block'}
        // Inline code is everywhere in a transcript: not a Tab stop each time.
        // Keyboard users select the text and press ⌘C, as before.
        tabIndex={inline ? -1 : undefined}
        aria-label="Copy"
        title={done === 'copied' ? 'Copied' : done === 'failed' ? 'Couldn’t copy' : 'Copy'}
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
        {done === 'copied' ? 'Copied' : done === 'failed' ? 'Couldn’t copy' : ''}
      </span>
    </>
  );
}

/** The classic copy icon: two overlapping rounded squares. */
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
      <rect width="14" height="14" x="8" y="8" rx="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

function TickGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={1.6}>
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}
