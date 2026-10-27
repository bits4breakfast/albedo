// @vitest-environment jsdom
/**
 * The compaction against the real read paths: the window (task scope, ordered
 * by ts) and the tail (session scope, ordered by seq) return the boundary and
 * the summary in opposite orders, and the pane must show the same divider
 * either way -- without the reads' ordering changing for anything else.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestDb, type TestDb } from '../../db/testkit';

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: { load: async () => harness.db },
}));

import fixture from '../../capture/fixtures/compaction.jsonl?raw';
import { parseTranscript } from '../../capture/adapter';
import { getMessages, insertMessages, resetDb } from '../../db';
import { groupRows } from './TranscriptPane';

let db: TestDb;

beforeEach(async () => {
  resetDb();
  db = createTestDb();
  harness.db = db;
  await insertMessages(parseTranscript(fixture).map((r) => ({ ...r, taskId: 1 })));
});

const shape = (rows: Awaited<ReturnType<typeof getMessages>>) =>
  groupRows(rows).map((i) => (i.kind === 'compaction' ? `compaction:${i.compaction.boundary?.seq}+${i.compaction.summary?.seq}+${i.compaction.notice?.seq ?? '-'}` : i.kind === 'row' ? i.message.seq : i.kind));

describe('a compaction read back from SQLite', () => {
  it('comes back summary first from the task-scoped window, as ts orders it', async () => {
    const rows = await getMessages({ taskId: 1 });
    expect(rows.map((r) => r.seq)).toEqual([0, 100, 300, 200, 600, 700, 900, 800]);
    expect(shape(rows)).toEqual([0, 100, 'compaction:200+300+600', 700, 'compaction:800+900+-']);
  });

  it('comes back boundary first from the session-scoped tail, and groups the same', async () => {
    const rows = await getMessages({ sessionId: '22222222-3333-4444-5555-666666666666', afterSeq: 100 });
    expect(rows.map((r) => r.seq)).toEqual([200, 300, 600, 700, 800, 900]);
    expect(shape(rows)).toEqual(['compaction:200+300+600', 700, 'compaction:800+900+-']);
  });
});
