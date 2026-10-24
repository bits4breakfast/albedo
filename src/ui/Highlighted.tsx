/**
 * A fuzzy match drawn as text with its matched characters marked. Shared by
 * Quick Open and the New Task dialog's branch picker; each list styles its own
 * `<mark>` through `className`, against its own row grounds.
 */

import type { ReactNode } from 'react';

/** Split `text` into runs, marking the characters at `hits`. */
export function Highlighted({ text, hits, className }: { text: string; hits: number[]; className: string }) {
  if (hits.length === 0) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  let i = 0;
  while (i < hits.length) {
    const start = hits[i]!;
    let end = start + 1;
    while (i + 1 < hits.length && hits[i + 1] === end) {
      i++;
      end++;
    }
    i++;
    if (start > at) out.push(text.slice(at, start));
    out.push(
      <mark className={className} key={start}>
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}
