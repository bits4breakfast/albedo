import { describe, expect, it, vi } from 'vitest';
import {
  cannotSubmit,
  classifySubmitError,
  inDiff,
  parseDiffRanges,
  planReview,
  reviewBody,
  submitReview,
  type GithubDraft,
  type SubmitIo,
} from './reviewSubmit';

const PR = { host: 'github.com', owner: 'example', repo: 'relay', number: 34 };

const DIFF = [
  'diff --git a/src/retry.ts b/src/retry.ts',
  'index 1111111..2222222 100644',
  '--- a/src/retry.ts',
  '+++ b/src/retry.ts',
  '@@ -10,6 +10,9 @@ export function retry() {',
  ' a',
  '+b',
  '@@ -40 +43,2 @@',
  '+c',
  'diff --git a/old.ts b/old.ts',
  'deleted file mode 100644',
  '--- a/old.ts',
  '+++ /dev/null',
  '@@ -1,3 +0,0 @@',
  '-x',
  'diff --git a/src/cut.ts b/src/cut.ts',
  '--- a/src/cut.ts',
  '+++ b/src/cut.ts',
  '@@ -5,2 +4,0 @@',
  '-gone',
].join('\n');

function draft(over: Partial<GithubDraft> = {}): GithubDraft {
  return { id: 1, path: 'src/retry.ts', lineStart: 12, lineEnd: 12, body: 'Why three?', replyTo: null, ...over };
}

describe('parseDiffRanges', () => {
  it('reads the new side of each hunk, and nothing for deleted files or pure deletions', () => {
    const r = parseDiffRanges(DIFF);
    expect(r.get('src/retry.ts')).toEqual([
      [10, 18],
      [43, 44],
    ]);
    expect(r.has('old.ts')).toBe(false);
    expect(r.has('src/cut.ts')).toBe(false);
  });
});

describe('inDiff', () => {
  const r = parseDiffRanges(DIFF);
  it('takes a line or a range inside one hunk', () => {
    expect(inDiff(r, 'src/retry.ts', 10, 10)).toBe(true);
    expect(inDiff(r, 'src/retry.ts', 12, 18)).toBe(true);
  });
  it('refuses lines outside, ranges across hunks, and files not in the diff', () => {
    expect(inDiff(r, 'src/retry.ts', 25, 25)).toBe(false);
    expect(inDiff(r, 'src/retry.ts', 17, 43)).toBe(false);
    expect(inDiff(r, 'README.md', 1, 1)).toBe(false);
  });
});

describe('planReview', () => {
  const ranges = parseDiffRanges(DIFF);

  it('builds one review: line comments, a range with start_line, on the reviewed commit', () => {
    const plan = planReview({
      drafts: [draft(), draft({ id: 2, lineStart: 43, lineEnd: 44, body: '  Split this.  ' })],
      ranges,
      summary: ' Looks close. ',
      verdict: 'REQUEST_CHANGES',
      commitId: 'abc',
    });
    expect(plan.review).toEqual({
      commit_id: 'abc',
      event: 'REQUEST_CHANGES',
      body: 'Looks close.',
      comments: [
        { path: 'src/retry.ts', line: 12, side: 'RIGHT', body: 'Why three?' },
        { path: 'src/retry.ts', line: 44, side: 'RIGHT', start_line: 43, start_side: 'RIGHT', body: 'Split this.' },
      ],
    });
    expect(plan.inReview).toEqual([1, 2]);
    expect(plan.replies).toEqual([]);
  });

  it('moves a draft outside the diff into the body with its path:line, and keeps it in the review', () => {
    const off = draft({ id: 3, path: 'README.md', lineStart: 4, lineEnd: 6, body: 'Docs?\n**bold**' });
    const plan = planReview({ drafts: [draft(), off], ranges, summary: '', verdict: 'COMMENT', commitId: 'abc' });
    expect(plan.review?.comments).toHaveLength(1);
    expect(plan.review?.body).toBe('**On lines outside the diff:**\n\n`README.md:4-6`\n> Docs?\n> **bold**');
    expect(plan.outside.map((d) => d.id)).toEqual([3]);
    expect(plan.inReview).toEqual([1, 3]);
  });

  it('sends replies apart, and no review at all for replies alone as a plain Comment', () => {
    const reply = draft({ id: 4, replyTo: 9001, body: 'Agreed.' });
    const plan = planReview({ drafts: [reply], ranges, summary: '', verdict: 'COMMENT', commitId: 'abc' });
    expect(plan.review).toBeNull();
    expect(plan.replies).toEqual([reply]);
    expect(plan.inReview).toEqual([]);
  });

  it('still sends an Approve with nothing else', () => {
    const plan = planReview({ drafts: [], ranges, summary: '', verdict: 'APPROVE', commitId: 'abc' });
    expect(plan.review).toEqual({ commit_id: 'abc', event: 'APPROVE', body: '', comments: [] });
  });
});

describe('reviewBody', () => {
  it('is the summary alone when every draft is on the diff', () => {
    expect(reviewBody('  Hi  ', [])).toBe('Hi');
  });
});

describe('cannotSubmit', () => {
  it('asks for a summary on Request Changes, and for something on a Comment', () => {
    expect(cannotSubmit([draft()], '', 'REQUEST_CHANGES')).toMatch(/summary/);
    expect(cannotSubmit([], ' ', 'COMMENT')).toMatch(/Nothing to send/);
    expect(cannotSubmit([draft()], '', 'COMMENT')).toBeNull();
    expect(cannotSubmit([], '', 'APPROVE')).toBeNull();
  });
});

describe('classifySubmitError', () => {
  it('names the failures the dialog explains', () => {
    expect(classifySubmitError('gh: Unprocessable Entity (HTTP 422)\nLine could not be resolved')).toBe('line');
    expect(classifySubmitError('{"message":"Validation Failed","errors":["pull_request_review_thread.line must be part of the diff"]}')).toBe('line');
    expect(classifySubmitError('No commit found for SHA: abc')).toBe('head');
    expect(classifySubmitError('User can only have one pending review per pull request')).toBe('pending');
    expect(classifySubmitError('HTTP 502')).toBe('other');
  });
});

describe('submitReview', () => {
  function io(results: Array<{ code: number; stdout?: string; stderr?: string } | null>, markFails = false) {
    const calls: string[][] = [];
    const sent: number[][] = [];
    const written: string[] = [];
    const removed: string[] = [];
    const impl: SubmitIo = {
      gh: vi.fn(async (args: string[]) => {
        calls.push(args);
        const r = results.shift();
        return r === null || r === undefined ? null : { stdout: '', stderr: '', ...r };
      }),
      writeInput: async (json) => {
        written.push(json);
        return '/home/me/.albedo/reviews/review-34.json';
      },
      clearInput: async (p) => {
        removed.push(p);
      },
      markSent: async (ids) => {
        if (markFails) throw new Error('database is locked');
        sent.push([...ids]);
      },
    };
    return { impl, calls, sent, written, removed };
  }

  const ranges = parseDiffRanges(DIFF);
  const plan = planReview({
    drafts: [draft(), draft({ id: 5, replyTo: 77, body: '@me sure' }), draft({ id: 6, replyTo: 78, body: 'No.' })],
    ranges,
    summary: 'Thanks',
    verdict: 'APPROVE',
    commitId: 'abc',
  });

  it('posts the review from a file, then each reply, marking each as GitHub accepts it', async () => {
    const t = io([{ code: 0 }, { code: 0 }, { code: 0 }]);
    const out = await submitReview(PR, plan, t.impl);
    expect(out).toEqual({ ok: true, replies: 2 });
    expect(t.calls[0]).toEqual([
      'api',
      '-X',
      'POST',
      'repos/example/relay/pulls/34/reviews',
      '--input',
      '/home/me/.albedo/reviews/review-34.json',
    ]);
    expect(JSON.parse(t.written[0]!)).toEqual(plan.review);
    expect(t.removed).toEqual(['/home/me/.albedo/reviews/review-34.json']);
    // A body that starts with @ goes as a raw field: never read as a file.
    expect(t.calls[1]).toEqual(['api', '-X', 'POST', 'repos/example/relay/pulls/34/comments/77/replies', '-f', 'body=@me sure']);
    expect(t.sent).toEqual([[1], [5], [6]]);
  });

  it('names the host for GitHub Enterprise', async () => {
    const t = io([{ code: 0 }, { code: 0 }, { code: 0 }]);
    await submitReview({ ...PR, host: 'git.example.com' }, plan, t.impl);
    expect(t.calls[0]!.slice(0, 3)).toEqual(['api', '--hostname', 'git.example.com']);
  });

  it('keeps every draft when the review is refused, and removes the request file anyway', async () => {
    const t = io([{ code: 1, stderr: 'gh: Unprocessable Entity (HTTP 422)\nLine could not be resolved' }]);
    const out = await submitReview(PR, plan, t.impl);
    expect(out).toMatchObject({ ok: false, reviewSent: false, repliesSent: 0, kind: 'line' });
    expect(t.sent).toEqual([]);
    expect(t.removed).toHaveLength(1);
    expect(t.calls).toHaveLength(1);
  });

  it('keeps the drafts when gh cannot be run at all', async () => {
    const t = io([null]);
    const out = await submitReview(PR, plan, t.impl);
    expect(out).toMatchObject({ ok: false, reviewSent: false, message: 'GitHub CLI (gh) could not be run.' });
    expect(t.sent).toEqual([]);
  });

  it('stops at a failed reply: what went out is marked, the rest stays a draft', async () => {
    const t = io([{ code: 0 }, { code: 0 }, { code: 1, stderr: 'HTTP 502' }]);
    const out = await submitReview(PR, plan, t.impl);
    expect(out).toMatchObject({ ok: false, reviewSent: true, repliesSent: 1, kind: 'other' });
    expect(t.sent).toEqual([[1], [5]]);
  });

  it('a retry sends only what is left: no second review for replies alone', async () => {
    const left = planReview({ drafts: [draft({ id: 6, replyTo: 78, body: 'No.' })], ranges, summary: '', verdict: 'COMMENT', commitId: 'abc' });
    const t = io([{ code: 0 }]);
    expect(await submitReview(PR, left, t.impl)).toEqual({ ok: true, replies: 1 });
    expect(t.calls).toHaveLength(1);
    expect(t.written).toEqual([]);
  });

  it('says so when a posted review cannot be recorded, and sends nothing more', async () => {
    const t = io([{ code: 0 }], true);
    const out = await submitReview(PR, plan, t.impl);
    expect(out).toMatchObject({ ok: false, reviewSent: true });
    expect(out.ok ? '' : out.message).toMatch(/posted, but/);
    expect(t.calls).toHaveLength(1);
  });
});
