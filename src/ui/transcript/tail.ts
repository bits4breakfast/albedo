/**
 * The transcript pane's tail follow: which rows are new, and where they go.
 *
 * The cursor is the highest row `id` held, not the highest `seq`. `seq` is
 * numbered per transcript FILE, and a session's subagents write files of their
 * own under the parent's session id: while one ran at seq 108 900 and the
 * parent at 96 800, a seq cursor sat past every parent row still to come, and
 * the pane stopped following until a reload (#104). Ingest assigns ids in
 * insertion order across every file, so `id > cursor` is exactly "what landed
 * since the last read".
 */

import type { Message } from '../../types';

/** The cursor for the next tail read: the highest id held, or null for none. */
export function tailCursor(messages: readonly Message[]): number | null {
  let max: number | null = null;
  for (const m of messages) if (max === null || m.id > max) max = m.id;
  return max;
}

type Key = 'ts' | 'seq' | 'id';

function compareBy(keys: readonly string[]): (a: Message, b: Message) => number {
  const ks = keys.filter((k): k is Key => k === 'ts' || k === 'seq' || k === 'id');
  return (a, b) => {
    for (const k of ks) {
      const d = a[k] - b[k];
      if (d !== 0) return d;
    }
    return 0;
  };
}

/**
 * `prev` with the rows of `page` it does not hold yet, in the window query's
 * order (`keys`, from `messageOrderKeys`), so a followed pane shows what a
 * reload would. Null when there is nothing new.
 *
 * A page comes back in id order, which is insertion order, not reading order:
 * a parent row and a subagent row written in the same second can be ingested
 * either way round. Usually every fresh row still sorts after the last one
 * held, and they are appended as they are; otherwise the whole list is sorted.
 */
export function mergeTail(
  prev: readonly Message[],
  page: readonly Message[],
  keys: readonly string[],
): Message[] | null {
  const held = new Set(prev.map((m) => m.id));
  const fresh = page.filter((r) => !held.has(r.id));
  if (fresh.length === 0) return null;
  const cmp = compareBy(keys);
  const sortedFresh = [...fresh].sort(cmp);
  const last = prev[prev.length - 1];
  const first = sortedFresh[0];
  if (last === undefined || (first !== undefined && cmp(last, first) <= 0)) {
    return [...prev, ...sortedFresh];
  }
  return [...prev, ...fresh].sort(cmp);
}
