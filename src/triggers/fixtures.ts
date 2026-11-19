/** Hand-built PR answers for the trigger tests (#448). Neutral sample data only. */

import type { CheckLine, PrReview, PrStatus } from '../gh/prStatus';
import { summarizeChecks } from '../gh/prStatus';

export const SHA_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
export const SHA_B = 'b2c3d4e5f60718293a4b5c6d7e8f901234567890';
export const MERGE_SHA = '3f9c2e1aa0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5';

export interface PrOpts {
  state?: PrStatus['state'];
  sha?: string;
  lines?: CheckLine[];
  reviews?: PrReview[];
  review?: PrStatus['review'];
  threads?: number | null;
  mergeable?: PrStatus['mergeable'];
  mergeState?: PrStatus['mergeState'];
  mergeCommit?: string | null;
  number?: number;
}

export const pass = (name: string): CheckLine => ({ name, bucket: 'pass', url: `https://ci.example.com/${name}` });
export const fail = (name: string): CheckLine => ({ name, bucket: 'fail', url: `https://ci.example.com/${name}` });
export const pending = (name: string): CheckLine => ({ name, bucket: 'pending', url: null });

export function prOf(o: PrOpts = {}): PrStatus {
  const lines = o.lines ?? [pass('build'), pass('test')];
  const state = o.state ?? 'open';
  return {
    number: o.number ?? 412,
    url: `https://github.com/example/shop/pull/${o.number ?? 412}`,
    title: 'Send the confirmation once per order',
    state,
    headRefName: 'checkout-retry',
    baseRefName: 'main',
    headSha: o.sha ?? SHA_A,
    mergedAt: state === 'merged' ? '2026-11-19T14:02:00Z' : null,
    ...(state === 'merged' ? { mergeCommit: o.mergeCommit === undefined ? MERGE_SHA : o.mergeCommit } : {}),
    review: o.review ?? null,
    reviews: o.reviews ?? [],
    reviewRequests: [],
    author: 'me',
    mergeable: o.mergeable ?? 'mergeable',
    mergeState: o.mergeState ?? 'clean',
    checks: summarizeChecks(lines),
    lines,
    reviewThreads: o.threads === undefined ? { total: 0, unresolved: 0 } : o.threads === null ? null : { total: o.threads, unresolved: o.threads },
  };
}

export const approvedBy = (author: string, at = '2026-11-19T10:00:00Z'): PrReview => ({ author, state: 'approved', submittedAt: at });
export const changesBy = (author: string, at = '2026-11-19T10:00:00Z'): PrReview => ({
  author,
  state: 'changes-requested',
  submittedAt: at,
});

/** Ready to merge as the task bar sees it. */
export const readyPr = (o: PrOpts = {}) => prOf({ review: 'approved', reviews: [approvedBy('alice')], ...o });
