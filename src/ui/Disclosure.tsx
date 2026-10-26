/**
 * The disclosure caret, everywhere something opens: transcript chips, thinking,
 * sidechains, diff gaps, the Files tree and the Files sections.
 *
 * One component rather than a glyph typed at each site, so the next collapsible
 * thing inherits the right size instead of the wrong one. It is a control, not
 * decoration: `--muted`, as tall as a capital letter of the label beside it,
 * and a 24x24 hit target regardless of how small the glyph looks.
 *
 * Quiet means subordinate, not invisible -- and that applies to the CONTENT a
 * thing hides, never to the control that reveals it. Thinking blocks and
 * injected context are de-emphasised on purpose; the caret that opens them is
 * not, or nobody finds out the content is there at all.
 *
 * `inline` is for a row that is itself the control (a tree row, a section
 * header): the caret sits in the label's line, on its baseline, with no hit
 * area of its own to push the row apart.
 */

import type { ReactNode } from 'react';
import './disclosure.css';

export function Disclosure({ open, inline = false }: { open: boolean; inline?: boolean }): ReactNode {
  const className = ['disc', open ? 'disc-open' : '', inline ? 'disc-inline' : ''].filter(Boolean).join(' ');
  return (
    <span className={className} aria-hidden="true">
      {/* Drawn, not typed: U+25B8 is a SMALL triangle by definition, and a
          typed chevron sits wherever the font's metrics put it. One stroked
          shape on a 10-unit square, rotated when open. The stroke is inset by
          half its width, so the ink, round caps included, spans the square
          exactly: closed, the full cap height; open, centred on it. */}
      <svg viewBox="0 0 10 10" focusable="false">
        <path
          d="M2.81 0.62 7.19 5 2.81 9.38"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
