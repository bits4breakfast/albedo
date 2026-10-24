/**
 * What the New Task dialog's branch picker lists, and in which order. Pure, so
 * the ordering is tested without a DOM; `BranchPicker.tsx` only renders it.
 *
 * With no query the list is in the order a base is usually picked: the
 * project's default, the branch the repository is on, `main`/`master`, the
 * other local branches by their latest commit, then the remote ones. With a
 * query it is ranked by the app's fuzzy matcher (the one Quick Open uses), and
 * equal scores keep that same order -- so a local branch beats its remote copy.
 */

import { fuzzyMatch, normaliseQuery, TopK } from '../lib/fuzzy';
import type { BranchList } from '../git/worktree';

export interface BranchRow {
  name: string;
  /** Indices into `name` to emphasise. */
  hits: number[];
}

export interface BranchResult {
  rows: BranchRow[];
  /** Every match, before the cap. */
  total: number;
}

/** Rendered rows. Past this, typing narrows faster than scrolling. */
export const BRANCH_LIMIT = 50;

/** The branches a base is commonly cut from, when the project names none. */
const USUAL_BASES = ['main', 'master'];

/**
 * `candidates` in the no-query order. Only candidates are returned, each once;
 * a candidate that is neither local nor named above keeps its given place
 * among the remote ones.
 */
export function orderBranches(
  candidates: readonly string[],
  list: Pick<BranchList, 'current' | 'recentLocals'>,
  projectDefault: string | null,
): string[] {
  const listed = new Set(candidates);
  const out: string[] = [];
  const seen = new Set<string>();
  const take = (b: string | null) => {
    if (b && listed.has(b) && !seen.has(b)) {
      seen.add(b);
      out.push(b);
    }
  };
  take(projectDefault);
  take(list.current);
  USUAL_BASES.forEach(take);
  list.recentLocals.forEach(take);
  candidates.forEach(take);
  return out;
}

/** `ordered` filtered and ranked by `query`, at most `limit` rows. */
export function filterBranches(ordered: readonly string[], query: string, limit = BRANCH_LIMIT): BranchResult {
  const q = normaliseQuery(query);
  if (q === '') {
    return { rows: ordered.slice(0, limit).map((name) => ({ name, hits: [] })), total: ordered.length };
  }
  const top = new TopK<BranchRow & { score: number; at: number }>(limit, (a, b) => b.score - a.score || a.at - b.at);
  ordered.forEach((name, at) => {
    const hit = fuzzyMatch(q, name, name.toLowerCase());
    if (hit) top.push({ name, hits: hit.indices, score: hit.score, at });
  });
  return { rows: top.items.map(({ name, hits }) => ({ name, hits })), total: top.seen };
}
