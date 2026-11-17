/**
 * A speech bubble and a count (#252): open comments on a file. Shared by the
 * guide's file rows, its diff header and the Map's boxes (#288).
 *
 * One plain bubble counts every open comment, To Send and GitHub Drafts
 * together (#440); its words say what the number is made of.
 */

import type { ReactNode } from 'react';
import { tallyTotal, type CommentTally } from './commentMarks';

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * "2 comments: 1 To Send, 1 GitHub Draft" (#440): the count, then what it
 * is made of, naming only the kinds there are; empty for none. With `sep`
 * before it, as a label adds it (#252).
 */
export function commentsSaid(t: CommentTally, sep: string): string {
  const n = tallyTotal(t);
  if (n === 0) return '';
  const kinds: string[] = [];
  if (t.toSend > 0) kinds.push(`${t.toSend} To Send`);
  if (t.drafts > 0) kinds.push(plural(t.drafts, 'GitHub Draft', 'GitHub Drafts'));
  return `${sep}${plural(n, 'comment', 'comments')}: ${kinds.join(', ')}`;
}

/**
 * --accent, the comments' own colour in the editor; measured on every ground
 * a file row or a map box has, the current one included (railContrast.test.ts,
 * mapContrast.test.ts).
 */
export function CommentCount({ tally }: { tally: CommentTally }): ReactNode {
  const n = tallyTotal(tally);
  if (n === 0) return null;
  const said = commentsSaid(tally, '');
  return (
    <span className="gd-cmt" title={said} aria-label={said} role="img">
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
        <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" strokeLinejoin="round" />
      </svg>
      {n}
    </span>
  );
}
