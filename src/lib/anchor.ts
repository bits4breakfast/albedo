/**
 * Locating a diff hunk inside the file as it exists now.
 *
 * ## Why this is not simply "read lines 40-60"
 *
 * A diff in the transcript is HISTORY. The file in the worktree is the present.
 * Between the two the agent may have edited the same file again, a later hunk
 * may have shifted every line below it, or the user may have hand-edited it.
 * Splicing current file content around a historical hunk and presenting the
 * result as "the context" would be inventing a file that never existed -- the
 * kind of plausible-looking wrong answer this app's honesty rules exist to
 * prevent, and one nothing in the UI could show you was wrong.
 *
 * So context is offered only when it can be PROVEN to line up: the hunk's own
 * new-side lines must still appear verbatim in the file. If they do, the lines
 * around them are genuinely the lines around them. If they do not, the caller
 * says the file has moved on rather than showing something misleading.
 *
 * Exact comparison, deliberately. A fuzzy match (trimmed, whitespace-collapsed)
 * would "succeed" on a file that had been reformatted since, which is exactly
 * the case where the offsets are least trustworthy.
 */

export type Anchor =
  /** The block sits at `offset` (0-based) in the file, verbatim. */
  | { ok: true; offset: number }
  | { ok: false; reason: AnchorFailure };

export type AnchorFailure =
  /** Nothing to look for. */
  | 'empty'
  /** The file no longer contains these lines: it changed after this diff. */
  | 'not-found'
  /** Several identical candidates and no way to tell which one this was. */
  | 'ambiguous';

/**
 * Split file text into lines the way the diff model does.
 *
 * A file ending in a newline yields a final empty element that is not a line;
 * dropping it keeps line NUMBERS aligned with every editor and with `git diff`.
 */
export function fileLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Every offset at which `block` occurs in `file`, up to `limit` of them. */
function matches(file: readonly string[], block: readonly string[], limit: number): number[] {
  const found: number[] = [];
  const last = file.length - block.length;
  for (let i = 0; i <= last; i++) {
    let hit = true;
    for (let j = 0; j < block.length; j++) {
      if (file[i + j] !== block[j]) {
        hit = false;
        break;
      }
    }
    if (hit) {
      found.push(i);
      if (found.length >= limit) break;
    }
  }
  return found;
}

/**
 * Find `block` in `file`.
 *
 * @param hint 1-based line where the block is expected, when the caller knows
 *             (a `git diff` hunk header carries it; an Edit fragment does not).
 *             Used only to break a tie between identical candidates -- never to
 *             accept a position that did not match.
 *
 * Two identical candidates with no hint is reported as ambiguous rather than
 * guessed: the blocks are by definition indistinguishable, so the thing that
 * differs between them is precisely the context we would be about to show.
 */
export function anchorBlock(
  file: readonly string[],
  block: readonly string[],
  hint: number | null = null,
): Anchor {
  if (block.length === 0 || file.length === 0) return { ok: false, reason: 'empty' };
  if (block.length > file.length) return { ok: false, reason: 'not-found' };

  const found = matches(file, block, 64);
  if (found.length === 0) return { ok: false, reason: 'not-found' };
  if (found.length === 1) return { ok: true, offset: found[0] as number };

  if (hint === null) return { ok: false, reason: 'ambiguous' };
  const want = hint - 1;
  let best = found[0] as number;
  let bestDistance = Math.abs(best - want);
  let tied = false;
  for (const offset of found.slice(1)) {
    const d = Math.abs(offset - want);
    if (d < bestDistance) {
      best = offset;
      bestDistance = d;
      tied = false;
    } else if (d === bestDistance) {
      tied = true;
    }
  }
  return tied ? { ok: false, reason: 'ambiguous' } : { ok: true, offset: best };
}
