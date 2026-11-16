/**
 * Where the guide's comments To Send are (#252, #404): a count per file in
 * each group, so a comment left on a file can be found again from the file
 * list and the rail, not only from the transcript. The guide passes To Send's
 * code comments (`useToSend`): a sent one or a GitHub draft is not counted,
 * so the bubbles add up to the code comments Send N sends. Pure.
 *
 * Each open comment counts once, in one group: the one showing its file, or
 * -- for a file split across groups -- the one whose hunks are nearest its
 * line, the lines it is on when they are still there. A comment whose lines
 * are gone (outdated) still counts: its card is in the bar above that file.
 */

import { placeRemoved, relocate, sideOf, type ReviewComment } from '../db/comments';
import type { BranchDiff } from './blocks';
import type { GroupView } from './validate';

/** group key -> path -> open comments there. */
export type CommentMarks = ReadonlyMap<string, ReadonlyMap<string, number>>;

export function commentMarks(
  groups: readonly GroupView[],
  diff: BranchDiff,
  comments: readonly (Pick<ReviewComment, 'path' | 'lineStart' | 'anchorText' | 'resolvedAt'> & Partial<Pick<ReviewComment, 'side'>>)[],
): CommentMarks {
  const out = new Map<string, Map<string, number>>();
  for (const c of comments) {
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
    const byPath = out.get(pick.g.key) ?? new Map<string, number>();
    byPath.set(c.path, (byPath.get(c.path) ?? 0) + 1);
    out.set(pick.g.key, byPath);
  }
  return out;
}

/** Open comments in one group: what its mark in the rail says. */
export function groupCommentCount(marks: CommentMarks, groupKey: string): number {
  let n = 0;
  for (const v of marks.get(groupKey)?.values() ?? []) n += v;
  return n;
}
