/**
 * The previews table (migration 0018, #348) on a real SQLite: versions
 * numbered per task and title, settled once, and gone with the task's history.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from './testkit';

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => harness.db } }));

const { purgeTaskHistory, resetDb } = await import('./index');
const { insertPreview, previewByRequest, previewByToolUse, previewVersions, settlePreview } = await import('./previews');

let db: TestDb;
beforeEach(() => {
  resetDb();
  db = createTestDb();
  harness.db = db;
});

const record = (taskId: number, requestId: string, title = 'Proposed row') => ({
  taskId,
  requestId,
  toolUseId: `toolu_${requestId}`,
  title,
  html: `<p>${requestId}</p>`,
  question: null,
  note: null,
  createdAt: 1_000,
  outcome: 'pending' as const,
});

describe('previews', () => {
  it('numbers versions per task and title, and keeps a request once', async () => {
    expect((await insertPreview(record(1, 'a'))).version).toBe(1);
    expect((await insertPreview(record(1, 'b'))).version).toBe(2);
    expect((await insertPreview(record(2, 'c'))).version).toBe(1);
    expect((await insertPreview(record(1, 'd', 'Other'))).version).toBe(1);
    // The inbox read twice: the same request is not a new version.
    expect((await insertPreview(record(1, 'b'))).version).toBe(2);
    expect((await previewVersions(1, 'Proposed row')).map((p) => p.requestId)).toEqual(['a', 'b']);
    expect((await previewByToolUse('toolu_b'))?.version).toBe(2);
  });

  it('settles a version once', async () => {
    await insertPreview(record(1, 'a'));
    expect(await settlePreview('a', 'approved', 'approved', 5)).toBe(true);
    expect(await settlePreview('a', 'cancelled', null, 6)).toBe(false);
    expect(await previewByRequest('a')).toMatchObject({ outcome: 'approved', answer: 'approved', answeredAt: 5 });
  });

  it('goes with the task’s history, and only that task’s', async () => {
    await insertPreview(record(1, 'a'));
    await insertPreview(record(2, 'b'));
    await purgeTaskHistory(1);
    expect(await previewByRequest('a')).toBeNull();
    expect(await previewByRequest('b')).not.toBeNull();
  });
});
