/**
 * A speech bubble and a count (#252): open comments on a file. Shared by the
 * guide's file rows, its diff header and the Map's boxes (#288).
 */

import type { ReactNode } from 'react';

/** ", 2 comments": what a mark adds to its label (#252); nothing for none. */
export function commentsSaid(n: number, sep: string): string {
  return n === 0 ? '' : `${sep}${n} ${n === 1 ? 'comment' : 'comments'}`;
}

/**
 * --accent, the comments' own colour in the editor; measured on every ground
 * a file row or a map box has, the current one included (railContrast.test.ts,
 * mapContrast.test.ts).
 */
export function CommentCount({ n }: { n: number }): ReactNode {
  if (n === 0) return null;
  const said = commentsSaid(n, '');
  return (
    <span className="gd-cmt" title={said} aria-label={said} role="img">
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
        <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" strokeLinejoin="round" />
      </svg>
      {n}
    </span>
  );
}
