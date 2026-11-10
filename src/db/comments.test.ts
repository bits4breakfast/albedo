import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from './testkit';

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@tauri-apps/plugin-sql', () => ({
  default: { load: async () => harness.db },
}));

import { archiveTask, createTask, deleteTask, resetDb } from './index';
import {
  addComment,
  deleteComment,
  editComment,
  formatForClaude,
  listComments,
  listGithubDrafts,
  markCommentsSent,
  markDraftsPosted,
  setCommentGithub,
  moveComment,
  onCommentsChanged,
  relocate,
  autoResolveComments,
  commentState,
  reopenComment,
  resolveComment,
  resolvedReason,
  shouldAutoResolve,
  type ReviewComment,
} from './comments';

let db: TestDb;
beforeEach(() => {
  resetDb();
  db = createTestDb();
  harness.db = db;
});

async function task(): Promise<number> {
  const t = await createTask({
    title: 't',
    projectId: null,
    repoPath: '/repo',
    baseBranch: 'main',
    branch: 'b',
    worktreePath: `/wt/${Math.random()}`,
    ownsWorktree: true,
    createdBranch: true, kind: 'work',
  });
  return t.id;
}

const comment = (taskId: number, over: Partial<Parameters<typeof addComment>[0]> = {}) =>
  addComment({ taskId, path: 'src/A.php', lineStart: 3, lineEnd: 4, anchorText: 'a\nb', body: 'first line\nsecond line', ...over });

describe('comments, in real SQLite', () => {
  it('keeps a multi-line comment exactly as written', async () => {
    const t = await task();
    const id = await comment(t);
    const [c] = await listComments(t);
    expect(c).toMatchObject({ id, path: 'src/A.php', lineStart: 3, lineEnd: 4, anchorText: 'a\nb', body: 'first line\nsecond line', sentAt: null, resolvedAt: null });
  });

  it('marks sent, makes an edited comment unsent again, moves and resolves', async () => {
    const t = await task();
    const id = await comment(t);
    await markCommentsSent(t, [id]);
    expect((await listComments(t))[0]!.sentAt).not.toBeNull();
    await editComment(t, id, 'changed');
    expect((await listComments(t))[0]).toMatchObject({ body: 'changed', sentAt: null });
    await moveComment(t, id, 10, 11);
    expect((await listComments(t))[0]).toMatchObject({ lineStart: 10, lineEnd: 11 });
    await resolveComment(t, id);
    expect(await listComments(t)).toEqual([]);
    expect(await listComments(t, { includeResolved: true })).toHaveLength(1);
  });

  it('deletes one comment, and tells listeners which task changed', async () => {
    const t = await task();
    const seen: number[] = [];
    const off = onCommentsChanged((id) => seen.push(id));
    const id = await comment(t);
    await deleteComment(t, id);
    off();
    expect(await listComments(t, { includeResolved: true })).toEqual([]);
    expect(seen).toEqual([t, t]);
  });

  it("goes with the task: archive and delete remove its comments, and only its", async () => {
    const a = await task();
    const b = await task();
    const keep = await task();
    await comment(a);
    await comment(b);
    await comment(keep);
    await archiveTask(a);
    await deleteTask(b);
    expect(await listComments(a, { includeResolved: true })).toEqual([]);
    expect(await listComments(b, { includeResolved: true })).toEqual([]);
    expect(await listComments(keep)).toHaveLength(1);
  });
});

describe('relocate', () => {
  const c = { anchorText: 'two\nthree', lineStart: 2 };

  it('finds the lines where they moved', () => {
    expect(relocate(c, 'zero\none\ntwo\nthree\n')).toEqual({ state: 'current', lineStart: 3, lineEnd: 4 });
  });

  it('prefers the copy nearest its last place when the lines repeat', () => {
    expect(relocate(c, 'two\nthree\nx\nx\nx\nx\ntwo\nthree\n')).toEqual({ state: 'current', lineStart: 1, lineEnd: 2 });
  });

  it('is outdated when the lines are gone', () => {
    expect(relocate(c, 'two\nTHREE\n')).toEqual({ state: 'outdated' });
  });
});

describe('formatForClaude', () => {
  const base: ReviewComment = {
    id: 1, taskId: 1, path: 'src/A.php', lineStart: 3, lineEnd: 4, anchorText: 'a\nb',
    body: 'Rename this.\nAnd add a test.', createdAt: 0, updatedAt: 0, sentAt: null, resolvedAt: null, github: null, replyTo: null,
  };

  it('numbers each comment with its place, code and text', () => {
    const text = formatForClaude([base, { ...base, id: 2, path: 'src/B.php', lineStart: 7, lineEnd: 7, anchorText: 'x', body: 'Why?' }]);
    expect(text).toBe(
      [
        'I left some review comments on your changes. Please address each one:',
        '',
        '1. src/A.php:3-4',
        '```',
        'a\nb',
        '```',
        'Rename this.\nAnd add a test.',
        '',
        '2. src/B.php:7',
        '```',
        'x',
        '```',
        'Why?',
      ].join('\n'),
    );
  });

  it('opens with the intro the person wrote, or none at all', () => {
    expect(formatForClaude([base], 'Please fix:').startsWith('Please fix:\n\n1. src/A.php:3-4')).toBe(true);
    expect(formatForClaude([base], '  ').startsWith('1. src/A.php:3-4')).toBe(true);
  });

  it('fences code that itself contains backticks with a longer fence', () => {
    const text = formatForClaude([{ ...base, anchorText: 'echo ```' }]);
    expect(text).toContain('````\necho ```\n````');
  });
});

describe('the life of a comment (#222)', () => {
  const at = { anchorText: 'two\nthree', lineStart: 2 };
  const file = 'one\ntwo\nthree\n';
  const changed = 'one\ntwo\nTHREE\n';

  it('a sent comment whose lines are gone resolves itself; an unsent one never does', () => {
    expect(shouldAutoResolve({ ...at, sentAt: 5, resolvedAt: null }, changed)).toBe(true);
    expect(shouldAutoResolve({ ...at, sentAt: 5, resolvedAt: null }, file)).toBe(false);
    expect(shouldAutoResolve({ ...at, sentAt: null, resolvedAt: null }, changed)).toBe(false);
    // Unreadable decides nothing; resolved already, nothing to do.
    expect(shouldAutoResolve({ ...at, sentAt: 5, resolvedAt: null }, null)).toBe(false);
    expect(shouldAutoResolve({ ...at, sentAt: 5, resolvedAt: 9 }, changed)).toBe(false);
  });

  it('states and reasons', () => {
    expect(commentState({ sentAt: null, resolvedAt: null })).toBe('waiting');
    expect(commentState({ sentAt: 1, resolvedAt: null })).toBe('sent');
    expect(commentState({ sentAt: 1, resolvedAt: 2 })).toBe('resolved');
    expect(resolvedReason({ ...at, sentAt: 1, resolvedAt: 2 }, changed)).toBe('changed');
    expect(resolvedReason({ ...at, sentAt: 1, resolvedAt: 2 }, file)).toBe('you');
    expect(resolvedReason({ ...at, sentAt: null, resolvedAt: 2 }, changed)).toBe('you');
    expect(resolvedReason({ ...at, sentAt: 1, resolvedAt: null }, changed)).toBeNull();
  });

  it('autoResolveComments resolves the sent ones whose lines are gone, reading each file once', async () => {
    const t = await task();
    const gone = await comment(t, { path: 'a.ts', anchorText: 'two\nthree' });
    const kept = await comment(t, { path: 'a.ts', anchorText: 'one' });
    const waiting = await comment(t, { path: 'b.ts', anchorText: 'nope' });
    await markCommentsSent(t, [gone, kept]);
    const reads: string[] = [];
    const ids = await autoResolveComments(t, await listComments(t), async (p) => {
      reads.push(p);
      return p === 'a.ts' ? changed : '';
    });
    expect(ids).toEqual([gone]);
    expect(reads).toEqual(['a.ts']);
    expect((await listComments(t)).map((c) => c.id).sort()).toEqual([kept, waiting].sort());
  });

  it('reopening makes it open and unsent: it waits for your next message', async () => {
    const t = await task();
    const id = await comment(t);
    await markCommentsSent(t, [id]);
    await resolveComment(t, id);
    await reopenComment(t, id);
    expect((await listComments(t))[0]).toMatchObject({ id, sentAt: null, resolvedAt: null });
  });
});

describe('drafts for GitHub on a review task (#287, v15)', () => {
  it('a plain comment is for Claude, as every comment before v15', async () => {
    const t = await task();
    await comment(t);
    const [c] = await listComments(t);
    expect(c).toMatchObject({ github: null, replyTo: null });
    expect(await listGithubDrafts(t)).toEqual([]);
  });

  it('keeps a draft and a reply until GitHub takes them; a reply is never on the code', async () => {
    const t = await task();
    const line = await comment(t, { github: 'draft' });
    const reply = await comment(t, { anchorText: '', body: 'Agreed.', replyTo: 9001 });
    await comment(t, { body: 'for Claude' });
    // The code's comments: the draft and Claude's, never the reply.
    expect((await listComments(t)).map((c) => c.id).sort()).not.toContain(reply);
    const drafts = await listGithubDrafts(t);
    expect(drafts.map((d) => [d.id, d.github, d.replyTo])).toEqual([
      [line, 'draft', null],
      [reply, 'draft', 9001],
    ]);

    await markDraftsPosted(t, [line]);
    expect((await listGithubDrafts(t)).map((d) => d.id)).toEqual([reply]);
    const posted = (await listComments(t, { includeResolved: true })).find((c) => c.id === line)!;
    expect(posted.sentAt).not.toBeNull();
    expect(posted.resolvedAt).toBe(posted.sentAt);
  });

  it('a message to Claude delivered late never marks a comment switched to GitHub since as sent', async () => {
    const t = await task();
    const id = await comment(t);
    // Held in the outbox with this comment, then the comment became a draft.
    await setCommentGithub(t, id, 'draft');
    await markCommentsSent(t, [id]);
    expect((await listGithubDrafts(t)).map((d) => d.id)).toEqual([id]);
  });

  it('moves a comment between Ask Claude and Draft for GitHub, as unsent', async () => {
    const t = await task();
    const id = await comment(t);
    await markCommentsSent(t, [id]);
    await setCommentGithub(t, id, 'draft');
    expect((await listGithubDrafts(t)).map((d) => d.id)).toEqual([id]);
    await setCommentGithub(t, id, null);
    expect(await listGithubDrafts(t)).toEqual([]);
    expect((await listComments(t))[0]).toMatchObject({ github: null, sentAt: null });
  });
});
