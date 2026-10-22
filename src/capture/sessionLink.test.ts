/**
 * linkTaskSession against a real SQLite on the shipped schema: the one place a
 * task's session changes, so the one place worth checking end to end.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedTranscriptFile, type TestDb } from '../db/testkit';

const harness = vi.hoisted(() => ({
  db: null as unknown,
  files: new Set<string>(),
  dirs: [] as string[],
  reconsidered: [] as string[],
  writes: [] as string[],
}));

vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => harness.db } }));
vi.mock('@tauri-apps/api/path', () => ({ homeDir: async () => '/home/u' }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: async (p: string) => p === '/home/u/.claude/projects' || harness.files.has(p),
  readDir: async () => harness.dirs.map((name) => ({ name, isDirectory: true, isFile: false })),
  mkdir: async () => {},
  writeTextFile: async (_p: string, text: string) => {
    harness.writes.push(text);
  },
}));
vi.mock('./watcher', () => ({
  PROJECTS_SUBPATH: '.claude/projects',
  reconsiderSession: async (id: string) => {
    harness.reconsidered.push(id);
  },
}));
vi.mock('./context', () => ({ contextUsage: async () => null }));
vi.mock('./hookEvents', () => ({ ALBEDO_DIR: '.albedo' }));

import { createTask, getMessages, getTask, insertMessages, resetDb, updateTask } from '../db';
import { linkTaskSession, sessionTranscriptExists } from './sessionLink';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let db: TestDb;
beforeEach(() => {
  resetDb();
  db = createTestDb();
  harness.db = db;
  harness.files.clear();
  harness.dirs = [];
  harness.reconsidered = [];
  harness.writes = [];
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

async function newTask() {
  return createTask({
    title: 't', projectId: null, repoPath: '/repo', baseBranch: 'main', branch: 'b',
    worktreePath: '/repo', ownsWorktree: false, createdBranch: false, kind: 'work',
  });
}

describe('linkTaskSession', () => {
  it('moves the task, claims rows captured before the link, and has capture look again', async () => {
    const t = await newTask();
    await updateTask(t.id, { sessionId: A });
    // A /clear's first line landed before the hook event was read.
    await insertMessages([
      { taskId: null, sessionId: B, seq: 0, role: 'user', toolName: null, targetPath: null,
        body: 'after clear', rawJson: '{}', agentId: null, ts: 5 },
    ]);

    expect(await linkTaskSession(t.id, B, 'hook:clear')).toBe(true);

    expect((await getTask(t.id))?.sessionId).toBe(B);
    expect((await getMessages({ taskId: t.id, limit: 10 })).map((m) => m.body)).toEqual(['after clear']);
    expect(harness.reconsidered).toEqual([B]);
    await vi.waitFor(() => expect(harness.writes.length).toBe(1));
    expect(JSON.parse(harness.writes[0]!)).toMatchObject({ taskId: t.id, from: A, to: B, reason: 'hook:clear' });
  });

  it('is a no-op for the session the task is already on', async () => {
    const t = await newTask();
    await updateTask(t.id, { sessionId: A });
    expect(await linkTaskSession(t.id, A, 'spawn:resume')).toBe(false);
    expect(harness.reconsidered).toEqual([]);
  });

  it('refuses anything that is not a session id', async () => {
    const t = await newTask();
    expect(await linkTaskSession(t.id, '../../etc', 'hook:clear')).toBe(false);
    expect((await getTask(t.id))?.sessionId).toBeNull();
  });

  it('notes when another task already holds the session', async () => {
    const first = await newTask();
    const second = await newTask();
    await updateTask(first.id, { sessionId: A });
    await linkTaskSession(second.id, A, 'hook:resume');
    await vi.waitFor(() => expect(harness.writes.length).toBe(1));
    expect(JSON.parse(harness.writes[0]!)).toMatchObject({ taskId: second.id, alsoHeldBy: first.id });
  });
});

describe('sessionTranscriptExists', () => {
  it('is true when Albedo holds the file', async () => {
    seedTranscriptFile(db, { path: '/p/a.jsonl', sessionId: A });
    expect(await sessionTranscriptExists(A)).toBe(true);
  });

  it('looks in every project folder: a resume elsewhere writes where the session began', async () => {
    harness.dirs = ['-Users-u-www-albedo', '-Users-u-www-albedo-agents-polishing'];
    harness.files.add(`/home/u/.claude/projects/-Users-u-www-albedo-agents-polishing/${B}.jsonl`);
    expect(await sessionTranscriptExists(B)).toBe(true);
  });

  it('is false for an id Claude Code never wrote', async () => {
    harness.dirs = ['-Users-u-www-albedo'];
    expect(await sessionTranscriptExists(A)).toBe(false);
  });
});
