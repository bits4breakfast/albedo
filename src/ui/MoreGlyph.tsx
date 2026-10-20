/**
 * The ⋯ of every overflow button, drawn rather than typed.
 *
 * U+22EF sits wherever the font's metrics put it -- low in its box, wider on
 * one side by its letter-spacing -- so a column of them never lined up, and
 * next to a drawn icon it read as a different kind of thing. Three dots on a
 * 16px grid centre exactly in any square button.
 */

import type { ReactNode } from 'react';

export default function MoreGlyph(): ReactNode {
  return (
    <svg className="more-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="3" cy="8" r="1.5" fill="currentColor" />
      <circle cx="8" cy="8" r="1.5" fill="currentColor" />
      <circle cx="13" cy="8" r="1.5" fill="currentColor" />
    </svg>
  );
}
