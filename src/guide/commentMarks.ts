/**
 * Where the guide's open comments are (#252, #440): a count per file in each
 * group, so a comment left on a file can be found again from the file list,
 * the rail and the Map, not only from the transcript. Open means still
 * waiting to go: To Send's code comments (`useToSend`, for Claude) and, on a
 * review task, its GitHub Drafts (`useGithubDrafts`, for the PR), counted
 * apart so a bubble can say what it is made of. A sent, resolved or posted
 * comment is in neither list, and a draft the session removed is a deleted
 * row, so none of them counts. Pure.
 *
 * Each open comment counts once, in one group: the one showing its file, or
 * -- for a file split across groups -- the one whose hunks are nearest its
 * line, the lines it is on when they are still there. A comment whose lines
 * are gone (outdated) still counts: its card is in the bar above that file.
 */

import { placeRemoved, relocate, sideOf, type ReviewComment } from '../db/comments';
import type { BranchDiff } from './blocks';
import type { GroupView } from './validate';

/** Open comments in one place, by where they go (#440). */
export interface CommentTally {
  /** To Send: for Claude, with the next message. */
  toSend: number;
  /** GitHub Drafts: for the PR, with Submit Review. */
  drafts: number;
}

export const NO_COMMENTS: CommentTally = Object.freeze({ toSend: 0, drafts: 0 });

/** Every open comment a tally counts: the number its bubble shows. */
export function tallyTotal(t: CommentTally): number {
  return t.toSend + t.drafts;
}

/** group key -> path -> open comments there. */
export type CommentMarks = ReadonlyMap<string, ReadonlyMap<string, CommentTally>>;

type Placed = Pick<ReviewComment, 'path' | 'lineStart' | 'anchorText' | 'resolvedAt'> & Partial<Pick<ReviewComment, 'side'>>;

export function commentMarks(
  groups: readonly GroupView[],
  diff: BranchDiff,
  toSend: readonly Placed[],
  drafts: readonly Placed[] = [],
): CommentMarks {
  const out = new Map<string, Map<string, CommentTally>>();
  const all = [...toSend.map((c) => ({ c, kind: 'toSend' as const })), ...drafts.map((c) => ({ c, kind: 'drafts' as const }))];
  for (const { c, kind } of all) {
    if (c.resolvedAt !== null) continue;
    const holders = groups.flatMap((g) => g.files.filter((f) => f.path === c.path).map((f) => ({ g, f })));
    if (holders.length === 0) continue;
    let pick = holders[0]!;
    if (holders.length > 1) {
      const file = diff.files.find((f) => f.path === c.path);
      const r = file?.result;
      const text = r && r.kind === 'diff' && r.change !== 'deleted' ? r.newText : null;
      // On removed lines (#402): its base lines, measured against the hunks' old side.
      const old = sideOf(c) === 'old';
      let line = c.lineStart;
      if (old) {
        const at = r && r.kind === 'diff' && text !== null ? placeRemoved(c, r.oldText, text) : null;
        if (at && at.state === 'removed') line = at.lineStart;
      } else {
        const at = text === null ? null : relocate(c, text);
        if (at && at.state === 'current') line = at.lineStart;
      }
      const hunks = r && r.kind === 'diff' ? r.diff.hunks : [];
      let best = Infinity;
      for (const h of holders) {
        for (const id of h.f.blocks) {
          const i = diff.blocks.get(id)?.hunk;
          const nums =
            i === null || i === undefined
              ? []
              : (hunks[i]?.lines ?? []).map((l) => (old ? l.oldNumber : l.newNumber)).filter((n): n is number => n !== null);
          if (nums.length === 0) continue;
          const lo = Math.min(...nums);
          const hi = Math.max(...nums);
          const d = line < lo ? lo - line : line > hi ? line - hi : 0;
          if (d < best) {
            best = d;
            pick = h;
          }
        }
      }
    }
    const byPath = out.get(pick.g.key) ?? new Map<string, CommentTally>();
    const had = byPath.get(c.path) ?? NO_COMMENTS;
    byPath.set(c.path, { ...had, [kind]: had[kind] + 1 });
    out.set(pick.g.key, byPath);
  }
  return out;
}

/** Two tallies together: a file in two groups, a folder on the Map, a group. */
export function addTally(a: CommentTally, b: CommentTally): CommentTally {
  return { toSend: a.toSend + b.toSend, drafts: a.drafts + b.drafts };
}

/** Open comments in one group: what its mark in the rail says. */
export function groupComments(marks: CommentMarks, groupKey: string): CommentTally {
  let t = NO_COMMENTS;
  for (const v of marks.get(groupKey)?.values() ?? []) t = addTally(t, v);
  return t;
}
