/**
 * Drafts for GitHub on removed lines (#402): posted on the diff's left side
 * at the base's lines, judged against the old side of the PR's hunks, and
 * named as removed lines when they go in the summary. Drafts on the file as
 * it is now are planned exactly as before.
 */
import { describe, expect, it } from 'vitest';
import { inDiff, parseDiffRanges, planReview, type GithubDraft } from './reviewSubmit';

const DIFF = [
  'diff --git a/src/queue.ts b/src/queue.ts',
  '--- a/src/queue.ts',
  '+++ b/src/queue.ts',
  '@@ -20,7 +20,5 @@ export function drain() {',
  ' a',
  '-b',
  '-c',
  ' d',
  '@@ -60,0 +59,2 @@',
  '+e',
  '+f',
  'diff --git a/src/old-name.ts b/src/new-name.ts',
  'similarity index 90%',
  'rename from src/old-name.ts',
  'rename to src/new-name.ts',
  '--- a/src/old-name.ts',
  '+++ b/src/new-name.ts',
  '@@ -3,2 +3 @@',
  '-x',
  ' y',
  'diff --git a/src/gone.ts b/src/gone.ts',
  'deleted file mode 100644',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-p',
  '-q',
].join('\n');

function draft(over: Partial<GithubDraft> = {}): GithubDraft {
  return { id: 1, path: 'src/queue.ts', lineStart: 21, lineEnd: 21, body: 'Why drop b?', replyTo: null, side: 'old', ...over };
}

describe('parseDiffRanges, old side', () => {
  it('reads the old side of each hunk, filed under the name the file has now', () => {
    const r = parseDiffRanges(DIFF);
    expect(r.old.get('src/queue.ts')).toEqual([[20, 26]]);
    expect(r.old.get('src/new-name.ts')).toEqual([[3, 4]]);
    // A deleted file has no name now, and a pure addition no old side.
    expect(r.old.has('src/gone.ts')).toBe(false);
    // The new side is unchanged.
    expect(r.get('src/queue.ts')).toEqual([
      [20, 24],
      [59, 60],
    ]);
  });

  it('judges a removed range by the old side, and lets GitHub decide when that side is not measured', () => {
    const r = parseDiffRanges(DIFF);
    expect(inDiff(r, 'src/queue.ts', 21, 22, 'old')).toBe(true);
    expect(inDiff(r, 'src/queue.ts', 30, 30, 'old')).toBe(false);
    // On the new side, 25 is past the hunk; on the old side it is inside.
    expect(inDiff(r, 'src/queue.ts', 25, 25)).toBe(false);
    expect(inDiff(r, 'src/queue.ts', 25, 25, 'old')).toBe(true);
    expect(inDiff(new Map([['src/queue.ts', [[1, 2] as const]]]), 'src/queue.ts', 90, 90, 'old')).toBe(true);
  });
});

describe('planReview, removed lines', () => {
  const ranges = parseDiffRanges(DIFF);

  it('posts one on the left side at the base line, and a range with start_line on the left too', () => {
    const plan = planReview({
      drafts: [draft(), draft({ id: 2, lineStart: 21, lineEnd: 22, body: 'And c?' }), draft({ id: 3, side: undefined, lineStart: 20, lineEnd: 20, body: 'Here.' })],
      ranges,
      summary: '',
      verdict: 'COMMENT',
      commitId: 'abc',
    });
    expect(plan.review?.comments).toEqual([
      { path: 'src/queue.ts', line: 21, side: 'LEFT', body: 'Why drop b?' },
      { path: 'src/queue.ts', line: 22, side: 'LEFT', start_line: 21, start_side: 'LEFT', body: 'And c?' },
      { path: 'src/queue.ts', line: 20, side: 'RIGHT', body: 'Here.' },
    ]);
    expect(plan.inReview).toEqual([1, 2, 3]);
  });

  it('one outside the old side goes in the summary, named as removed lines', () => {
    const plan = planReview({ drafts: [draft({ lineStart: 40, lineEnd: 41 })], ranges, summary: '', verdict: 'COMMENT', commitId: 'abc' });
    expect(plan.review?.comments).toEqual([]);
    expect(plan.review?.body).toBe('**On lines outside the diff:**\n\n`src/queue.ts: removed lines 40-41`\n> Why drop b?');
  });

  it('one whose text is gone from the base goes in the summary too', () => {
    const plan = planReview({ drafts: [draft({ lost: true })], ranges, summary: '', verdict: 'COMMENT', commitId: 'abc' });
    expect(plan.review?.body).toBe('**On lines outside the diff:**\n\n`src/queue.ts: removed line 21` (this code has changed since)\n> Why drop b?');
  });
});
