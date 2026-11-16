/**
 * The GitHub tools (#427) on the app's side, end to end: inbox lines read
 * from a real file, drafts in a real SQLite, answers written to real files,
 * and gh played by a stand-in that records every call. The server's side is
 * tested in src-tauri/mcp (lib.rs, tests/stdio.rs).
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../db/testkit';

const h = vi.hoisted(() => ({ home: '', db: null as unknown }));

vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => h.db } }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/path', () => ({ homeDir: async () => h.home }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: async (p: string) => existsSync(p),
  mkdir: async (p: string) => void mkdirSync(p, { recursive: true }),
  readDir: async (p: string) => readdirSync(p, { withFileTypes: true }).map((e) => ({ name: e.name, isFile: e.isFile() })),
  readFile: async (p: string) => new Uint8Array(readFileSync(p)),
  readTextFile: async (p: string) => readFileSync(p, 'utf8'),
  rename: async (a: string, b: string) => renameSync(a, b),
  stat: async (p: string) => ({ size: statSync(p).size }),
  writeTextFile: async (p: string, d: string) => writeFileSync(p, d),
  watch: async () => () => {},
}));

const { resetDb, createTask } = await import('../db/index');
const { addComment, listComments, listGithubDrafts } = await import('../db/comments');
const { readInbox, startInbox, stopInbox } = await import('./inbox');
const removals = await import('./draftRemovals');
const gate = await import('./githubGate');
const { setGhRunner, resetViewerLoginForTests } = await import('../gh/gh');
const tokens = await import('./mcpToken');
const comments = await import('../db/comments');

const PR_URL = 'https://github.com/acme-labs/widget/pull/412';
const ME = 'sam-reviewer';

let reviewTask = 0;
let workTask = 0;
let ghCalls: string[][] = [];
/** A path whose gh call never ends. */
let ghHang: string | null = null;
/** Who `gh api user` says is signed in now. */
let ghUser = 'sam-reviewer';
/** What the stand-in gh answers, by the API path asked for. */
let ghAnswers: Record<string, { code: number; stdout: string; stderr?: string }> = {};

const inboxFile = (task: number) => join(h.home, '.albedo/inbox', `task-${task}.jsonl`);
const answerFile = (task: number, req: string) => join(h.home, '.albedo/previews', `answer-${task}-${req}.json`);

/** Each task's session token, as Terminal makes one per spawn (mcpToken.ts). */
const tokenOf = (task: number) => `token-of-task-${task}-0000`;

function call(task: number, id: string, tool: string, args: Record<string, unknown> = {}, at = Date.now(), token: string | null = tokenOf(task)): void {
  mkdirSync(join(h.home, '.albedo/inbox'), { recursive: true });
  appendFileSync(inboxFile(task), `${JSON.stringify({ v: 1, task, tool, args, at, id, ...(token ? { token } : {}) })}\n`);
}

async function read(): Promise<void> {
  await readInbox();
  await gate.githubLinesSettled();
}

function answer(task: number, req: string): { text: string; isError?: boolean } | null {
  const f = answerFile(task, req);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as { text: string; isError?: boolean }) : null;
}

function posted(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    author: ME,
    path: 'src/report/daily.ts',
    line: 42,
    original_line: 42,
    side: 'RIGHT',
    body: 'use the account timezone, not the server one',
    created_at: '2026-11-16T08:00:00Z',
    html_url: `${PR_URL}#discussion_r${id}`,
    in_reply_to_id: null,
    pull_request_url: 'https://api.github.com/repos/acme-labs/widget/pulls/412',
    ...over,
  };
}

beforeEach(async () => {
  h.home = mkdtempSync(join(tmpdir(), 'albedo-github-'));
  resetDb();
  h.db = createTestDb();
  ghCalls = [];
  ghAnswers = {};
  ghHang = null;
  setGhRunner(async (_program, args) => {
    ghCalls.push(args);
    if (args[1] === 'user') return { code: 0, stdout: `${ghUser}\n`, stderr: '' };
    if (ghHang && args.some((a) => a.includes(ghHang!))) return new Promise(() => {});
    const path = args.find((a) => a.startsWith('repos/')) ?? '';
    return { stderr: '', ...(ghAnswers[`${args.includes('DELETE') ? 'DELETE ' : ''}${path}`] ?? { code: 1, stdout: '', stderr: 'HTTP 404: Not Found' }) };
  });
  resetViewerLoginForTests(ME);
  ghUser = ME;
  const base = { projectId: null, repoPath: '/repo', baseBranch: 'main', ownsWorktree: true, createdBranch: true } as const;
  reviewTask = (await createTask({ ...base, title: 'Review 412', branch: 'review/412', worktreePath: '/wt/review', kind: 'work', reviewUrl: PR_URL })).id;
  workTask = (await createTask({ ...base, title: 'Work', branch: 'feat', worktreePath: '/wt/work', kind: 'work' })).id;
  const tasks = new Map([
    [reviewTask, { id: reviewTask, reviewUrl: PR_URL, worktreePath: '/wt/review', status: 'idle' as const }],
    [workTask, { id: workTask, reviewUrl: null, worktreePath: '/wt/work', status: 'idle' as const }],
  ]);
  gate.__resetGithubGate();
  removals.__resetDraftRemovals();
  tokens.__setTaskTokenForTests(reviewTask, tokenOf(reviewTask));
  tokens.__setTaskTokenForTests(workTask, tokenOf(workTask));
  await stopInbox();
  gate.startGithubGate((id) => tasks.get(id) ?? null);
  await startInbox(() => {});
});

afterEach(async () => {
  await stopInbox();
  gate.__resetGithubGate();
  removals.__resetDraftRemovals();
  resetViewerLoginForTests(null);
  rmSync(h.home, { recursive: true, force: true });
});

async function draft(task: number, over: Partial<Parameters<typeof addComment>[0]> = {}): Promise<number> {
  return addComment({
    taskId: task,
    path: 'src/report/daily.ts',
    lineStart: 58,
    lineEnd: 58,
    anchorText: '  for (const day of days) {',
    body: 'This loop runs a query per day.',
    github: 'draft',
    ...over,
  });
}

describe('list_github_drafts', () => {
  it("answers at once with this task's unsent drafts, code and all", async () => {
    const a = await draft(reviewTask);
    const b = await draft(reviewTask, { path: 'src/report/export.ts', lineStart: 3, lineEnd: 4, anchorText: 'x\ny', body: 'Old', side: 'old' });
    const r = await draft(reviewTask, { anchorText: '', body: 'Agreed.', replyTo: 9001 });
    await draft(reviewTask, { github: null, body: 'For Claude, not GitHub' });
    await draft(workTask, { body: 'Another task' });
    call(reviewTask, 'q-1', 'list_github_drafts');
    await read();
    const got = answer(reviewTask, 'q-1');
    expect(got?.isError).toBeUndefined();
    const body = JSON.parse(got!.text) as { pr: string; drafts: Array<Record<string, unknown>> };
    expect(body.pr).toBe('acme-labs/widget#412');
    expect(body.drafts).toEqual([
      { id: a, path: 'src/report/daily.ts', side: 'new', lines: [58, 58], code: '  for (const day of days) {', body: 'This loop runs a query per day.' },
      { id: r, path: 'src/report/daily.ts', side: 'new', lines: [58, 58], replyTo: 9001, body: 'Agreed.' },
      { id: b, path: 'src/report/export.ts', side: 'old', lines: [3, 4], code: 'x\ny', body: 'Old' },
    ]);
  });

  it('refuses on a task that is not a review', async () => {
    call(workTask, 'q-2', 'list_github_drafts');
    await read();
    expect(answer(workTask, 'q-2')).toMatchObject({ isError: true });
    expect(answer(workTask, 'q-2')!.text).toContain('not a review');
  });

  it('never answers a line the server has stopped waiting for, or one from before launch', async () => {
    call(reviewTask, 'late-1', 'list_github_drafts', {}, Date.now() - gate.ACT_WINDOW_MS - 1_000);
    await read();
    expect(answer(reviewTask, 'late-1')).toBeNull();
  });
});

describe('delete_github_draft', () => {
  it('removes the draft at once, keeps it whole for Undo, and says so', async () => {
    const id = await draft(reviewTask);
    const before = (await listGithubDrafts(reviewTask))[0]!;
    call(reviewTask, 'd-1', 'delete_github_draft', { id, reason: 'Same as the note on line 42' });
    await read();
    expect(answer(reviewTask, 'd-1')).toEqual({ text: expect.stringContaining(`Removed GitHub Draft ${id}`) });
    expect(await listGithubDrafts(reviewTask)).toEqual([]);
    expect(removals.draftRemovalsOf(reviewTask)).toEqual([{ row: before, reason: 'Same as the note on line 42', at: expect.any(Number) }]);
    // Undo: the same row, id and all.
    await removals.undoDraftRemoval(reviewTask, id);
    expect(await listGithubDrafts(reviewTask)).toEqual([before]);
    expect(removals.draftRemovalsOf(reviewTask)).toEqual([]);
  });

  it("refuses another task's draft, a comment for Claude, and a stale line, and removes nothing", async () => {
    const theirs = await draft(workTask);
    const forClaude = await draft(reviewTask, { github: null });
    const mine = await draft(reviewTask);
    call(reviewTask, 'd-2', 'delete_github_draft', { id: theirs });
    call(reviewTask, 'd-3', 'delete_github_draft', { id: forClaude });
    call(reviewTask, 'd-4', 'delete_github_draft', { id: mine }, Date.now() - gate.ACT_WINDOW_MS - 1);
    await read();
    expect(answer(reviewTask, 'd-2')).toMatchObject({ isError: true });
    expect(answer(reviewTask, 'd-3')).toMatchObject({ isError: true });
    expect(answer(reviewTask, 'd-4')).toBeNull();
    expect((await listComments(workTask)).map((c) => c.id)).toEqual([theirs]);
    expect((await listComments(reviewTask)).map((c) => c.id).sort()).toEqual([forClaude, mine].sort());
    expect(removals.draftRemovalsOf(reviewTask)).toEqual([]);
  });
});

describe('delete_github_draft on a draft open for editing', () => {
  it('refuses while an edit box has it open, and removes it once the box closes', async () => {
    const id = await draft(reviewTask);
    const release = removals.holdDraftEdit(id);
    call(reviewTask, 'e-1', 'delete_github_draft', { id });
    await read();
    expect(answer(reviewTask, 'e-1')).toEqual({ text: expect.stringContaining('The owner is editing'), isError: true });
    expect((await listGithubDrafts(reviewTask)).map((d) => d.id)).toEqual([id]);
    expect(removals.draftRemovalsOf(reviewTask)).toEqual([]);
    release();
    release(); // a second release changes nothing
    call(reviewTask, 'e-2', 'delete_github_draft', { id });
    await read();
    expect(answer(reviewTask, 'e-2')?.isError).toBeUndefined();
    expect(await listGithubDrafts(reviewTask)).toEqual([]);
  });

  it('counts two boxes on one draft: it stays held until both close', () => {
    const a = removals.holdDraftEdit(5);
    const b = removals.holdDraftEdit(5);
    a();
    expect(removals.isDraftBeingEdited(5)).toBe(true);
    b();
    expect(removals.isDraftBeingEdited(5)).toBe(false);
  });
});

describe('list_posted_comments', () => {
  it("lists only the signed-in user's comments on this task's PR", async () => {
    ghAnswers['repos/acme-labs/widget/pulls/412/comments?per_page=100'] = {
      code: 0,
      stdout: [posted(11), posted(12, { author: 'someone-else' }), posted(13, { author: 'SAM-REVIEWER', in_reply_to_id: 11, line: null })]
        .map((c) => JSON.stringify(c))
        .join('\n'),
    };
    call(reviewTask, 'p-1', 'list_posted_comments');
    await read();
    const body = JSON.parse(answer(reviewTask, 'p-1')!.text) as { author: string; comments: Array<Record<string, unknown>> };
    expect(body.author).toBe(ME);
    expect(body.comments.map((c) => c.id)).toEqual([11, 13]);
    expect(body.comments[1]).toMatchObject({ inReplyTo: 11, line: 42, outdated: true });
    expect(ghCalls[0]).toContain('--paginate');
  });
});

describe('delete_posted_comment', () => {
  const single = 'repos/acme-labs/widget/pulls/comments/11';

  it('waits on the user, and Keep It deletes nothing', async () => {
    ghAnswers[single] = { code: 0, stdout: JSON.stringify(posted(11)) };
    call(reviewTask, 'x-1', 'delete_posted_comment', { id: 11, reason: 'Already fixed' });
    await read();
    const d = gate.pendingDeletion(reviewTask);
    expect(d).toMatchObject({ requestId: 'x-1', reason: 'Already fixed', comment: { id: 11, path: 'src/report/daily.ts' } });
    expect(answer(reviewTask, 'x-1')).toBeNull();
    expect(await gate.answerDeletion(d!, 'keep')).toBe('kept');
    expect(answer(reviewTask, 'x-1')!.text).toContain('kept');
    expect(ghCalls.some((a) => a.includes('DELETE'))).toBe(false);
    expect(gate.pendingDeletion(reviewTask)).toBeNull();
  });

  it('deletes on GitHub only from the click, after checking the author again', async () => {
    ghAnswers[single] = { code: 0, stdout: JSON.stringify(posted(11)) };
    ghAnswers[`DELETE ${single}`] = { code: 0, stdout: '' };
    call(reviewTask, 'x-2', 'delete_posted_comment', { id: 11 });
    await read();
    expect(ghCalls.some((a) => a.includes('DELETE'))).toBe(false);
    const asked = ghCalls.length;
    expect(await gate.answerDeletion(gate.pendingDeletion(reviewTask)!, 'delete')).toBe('deleted');
    // Asked who is signed in and whose the comment is, again, then deleted.
    expect(ghCalls.slice(asked).map((a) => (a.includes('DELETE') ? 'delete' : a[1] === 'user' ? 'user' : 'comment'))).toEqual([
      'user',
      'comment',
      'delete',
    ]);
    expect(answer(reviewTask, 'x-2')).toEqual({ text: expect.stringContaining('Deleted comment 11') });
  });

  it('does not delete when the comment changed hands or PR between the card and the click', async () => {
    ghAnswers[single] = { code: 0, stdout: JSON.stringify(posted(11)) };
    call(reviewTask, 'x-3', 'delete_posted_comment', { id: 11 });
    await read();
    ghAnswers[single] = { code: 0, stdout: JSON.stringify(posted(11, { author: 'someone-else' })) };
    expect(await gate.answerDeletion(gate.pendingDeletion(reviewTask)!, 'delete')).toBe('failed');
    expect(ghCalls.some((a) => a.includes('DELETE'))).toBe(false);
    expect(answer(reviewTask, 'x-3')).toMatchObject({ isError: true });
  });

  it("refuses at once, with no card, someone else's comment or one on another PR", async () => {
    ghAnswers[single] = { code: 0, stdout: JSON.stringify(posted(11, { author: 'someone-else' })) };
    ghAnswers['repos/acme-labs/widget/pulls/comments/12'] = {
      code: 0,
      stdout: JSON.stringify(posted(12, { pull_request_url: 'https://api.github.com/repos/acme-labs/widget/pulls/77' })),
    };
    call(reviewTask, 'x-4', 'delete_posted_comment', { id: 11 });
    call(reviewTask, 'x-5', 'delete_posted_comment', { id: 12 });
    call(reviewTask, 'x-6', 'delete_posted_comment', { id: 99 });
    await read();
    expect(gate.pendingDeletion(reviewTask)).toBeNull();
    expect(answer(reviewTask, 'x-4')!.text).toContain('someone-else');
    expect(answer(reviewTask, 'x-5')!.text).toContain('not on this task');
    expect(answer(reviewTask, 'x-6')!.text).toContain('no review comment 99');
    expect(ghCalls.some((a) => a.includes('DELETE'))).toBe(false);
  });

  it('retires the card when the call is cancelled, and a late click deletes nothing', async () => {
    ghAnswers[single] = { code: 0, stdout: JSON.stringify(posted(11)) };
    ghAnswers[`DELETE ${single}`] = { code: 0, stdout: '' };
    call(reviewTask, 'x-7', 'delete_posted_comment', { id: 11 });
    await read();
    const d = gate.pendingDeletion(reviewTask)!;
    call(reviewTask, 'x-8', 'github_cancelled', { request: 'x-7', reason: 'AbortError: user-cancel' });
    await read();
    expect(gate.pendingDeletion(reviewTask)).toBeNull();
    expect(await gate.answerDeletion(d, 'delete')).toBe('refused');
    expect(ghCalls.some((a) => a.includes('DELETE'))).toBe(false);
    expect(answer(reviewTask, 'x-7')).toBeNull();
  });

  it('ends with the session, and a deletion asked by an earlier run never shows', async () => {
    ghAnswers[single] = { code: 0, stdout: JSON.stringify(posted(11)) };
    call(reviewTask, 'x-9', 'delete_posted_comment', { id: 11 });
    call(reviewTask, 'x-0', 'delete_posted_comment', { id: 11 }, 1_000);
    await read();
    expect(gate.pendingDeletion(reviewTask)?.requestId).toBe('x-9');
    gate.endTaskDeletions(reviewTask);
    expect(gate.pendingDeletion(reviewTask)).toBeNull();
    expect(answer(reviewTask, 'x-0')).toBeNull();
  });
});

describe('after the independent review (#427)', () => {
  const single = 'repos/acme-labs/widget/pulls/comments/11';

  it("acts only on lines carrying the task's current session token", async () => {
    const id = await draft(reviewTask);
    call(reviewTask, 't-1', 'delete_github_draft', { id }, Date.now(), null);
    call(reviewTask, 't-2', 'delete_github_draft', { id }, Date.now(), tokenOf(workTask));
    call(reviewTask, 't-3', 'list_github_drafts', {}, Date.now(), 'an-old-spawns-token-0000');
    await read();
    expect(answer(reviewTask, 't-1')).toBeNull();
    expect(answer(reviewTask, 't-2')).toBeNull();
    expect(answer(reviewTask, 't-3')).toBeNull();
    expect((await listGithubDrafts(reviewTask)).map((d) => d.id)).toEqual([id]);
  });

  it('refuses to remove a draft while Submit Review is open or sending', async () => {
    const id = await draft(reviewTask);
    const release = removals.holdSubmitReview(reviewTask);
    call(reviewTask, 's-1', 'delete_github_draft', { id });
    await read();
    expect(answer(reviewTask, 's-1')).toEqual({ text: expect.stringContaining('submitting this review'), isError: true });
    expect((await listGithubDrafts(reviewTask)).map((d) => d.id)).toEqual([id]);
    release();
    call(reviewTask, 's-2', 'delete_github_draft', { id });
    await read();
    expect(await listGithubDrafts(reviewTask)).toEqual([]);
  });

  it('removes only a draft still unsent, in the same statement', async () => {
    const id = await draft(reviewTask);
    await comments.markDraftsPosted(reviewTask, [id]);
    expect(await comments.deleteUnsentDraft(reviewTask, id)).toBe(false);
    const other = await draft(workTask);
    expect(await comments.deleteUnsentDraft(reviewTask, other)).toBe(false);
    const forClaude = await draft(reviewTask, { github: null });
    expect(await comments.deleteUnsentDraft(reviewTask, forClaude)).toBe(false);
    expect((await listComments(reviewTask, { includeResolved: true })).map((c) => c.id).sort()).toEqual([id, forClaude].sort());
    const live = await draft(reviewTask);
    expect(await comments.deleteUnsentDraft(reviewTask, live)).toBe(true);
  });

  it('takes a cancel at once, even while another call waits on gh, and never acts on the cancelled call', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      ghAnswers[single] = { code: 0, stdout: JSON.stringify(posted(11)) };
      call(reviewTask, 'c-1', 'delete_posted_comment', { id: 11 });
      await readInbox();
      await vi.waitFor(() => expect(gate.pendingDeletion(reviewTask)).not.toBeNull());
      const d = gate.pendingDeletion(reviewTask)!;
      // A list stuck on gh holds the queue; a draft removal waits behind it.
      ghHang = '/pulls/412/comments';
      const id = await draft(reviewTask);
      call(reviewTask, 'c-2', 'list_posted_comments');
      call(reviewTask, 'c-3', 'delete_github_draft', { id });
      call(reviewTask, 'c-4', 'github_cancelled', { request: 'c-1', reason: 'AbortError: user-cancel' });
      call(reviewTask, 'c-5', 'github_cancelled', { request: 'c-3', reason: 'AbortError: user-cancel' });
      await readInbox();
      // The cancel is in, though the list still waits on gh.
      expect(gate.pendingDeletion(reviewTask)).toBeNull();
      expect(await gate.answerDeletion(d, 'delete')).toBe('refused');
      expect(ghCalls.some((a) => a.includes('DELETE'))).toBe(false);
      // The stuck call gives up after 20 s, and the cancelled removal never runs.
      await vi.advanceTimersByTimeAsync(gate.GH_TIMEOUT_MS);
      await gate.githubLinesSettled();
      expect(answer(reviewTask, 'c-2')).toEqual({ text: expect.stringContaining('did not answer within 20 s'), isError: true });
      expect(answer(reviewTask, 'c-3')).toBeNull();
      expect((await listGithubDrafts(reviewTask)).map((x) => x.id)).toEqual([id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks gh who is signed in on the click, not the cached login', async () => {
    ghAnswers[single] = { code: 0, stdout: JSON.stringify(posted(11)) };
    ghAnswers[`DELETE ${single}`] = { code: 0, stdout: '' };
    call(reviewTask, 'l-1', 'delete_posted_comment', { id: 11 });
    await read();
    ghUser = 'another-account';
    expect(await gate.answerDeletion(gate.pendingDeletion(reviewTask)!, 'delete')).toBe('failed');
    expect(ghCalls.some((a) => a.includes('DELETE'))).toBe(false);
    expect(answer(reviewTask, 'l-1')!.text).toContain('another-account');
  });

  it('retires the card when the transcript records the call’s result', async () => {
    ghAnswers[single] = { code: 0, stdout: JSON.stringify(posted(11)) };
    call(reviewTask, 'r-1', 'delete_posted_comment', { id: 11, toolUseId: 'toolu_01DEL' });
    await read();
    expect(gate.pendingDeletion(reviewTask)?.toolUseId).toBe('toolu_01DEL');
    gate.retireFinishedDeletions(reviewTask, new Set(['toolu_other']));
    expect(gate.pendingDeletion(reviewTask)).not.toBeNull();
    gate.retireFinishedDeletions(reviewTask, new Set(['toolu_01DEL']));
    expect(gate.pendingDeletion(reviewTask)).toBeNull();
  });
});
