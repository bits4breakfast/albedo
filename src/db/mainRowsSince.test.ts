/**
 * `mainRowsSince` on a real SQLite: the rows where a command Albedo sent
 * shows up once Claude Code has run it (#384, ui/transcript/commandEcho.ts).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestDb, type TestDb } from './testkit';

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: { load: async () => harness.db },
}));

import { insertMessages, mainRowsSince, resetDb } from './index';
import { parseLine } from '../capture/adapter';

const SENT = Date.parse('2026-11-13T10:00:00.000Z');
const at = (ms: number) => new Date(ms).toISOString();

let db: TestDb;

beforeEach(() => {
  resetDb();
  db = createTestDb();
  harness.db = db;
});

async function seed(
  lines: Record<string, unknown>[],
  { sessionId = 's1', taskId = 1 as number | null, agentId = null as string | null } = {},
): Promise<void> {
  await insertMessages(
    lines.flatMap((line, i) =>
      parseLine(JSON.stringify({ sessionId, uuid: `${sessionId}-${agentId ?? 'm'}-${i}`, ...line }), i).map((m) => ({
        ...m,
        agentId,
        taskId,
      })),
    ),
  );
}

const user = (content: string, ms: number) => ({ type: 'user', message: { role: 'user', content }, timestamp: at(ms) });
const reply = (ms: number) => ({
  type: 'assistant',
  message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }] },
  timestamp: at(ms),
});
const boundary = (ms: number) => ({
  type: 'system',
  subtype: 'compact_boundary',
  content: 'Conversation compacted',
  timestamp: at(ms),
  compactMetadata: { trigger: 'manual' },
});

describe('mainRowsSince', () => {
  it('the main thread’s user and system rows since the time, newest first', async () => {
    await seed([user('before', SENT - 5_000), user('<command-name>/compact</command-name>', SENT + 10), reply(SENT + 20), boundary(SENT + 80_000)]);
    const rows = await mainRowsSince(1, 's1', SENT);
    expect(rows.map((r) => [r.role, r.ts])).toEqual([
      ['system', SENT + 80_000],
      ['user', SENT + 10],
    ]);
  });

  it('not a subagent’s rows, nor another task’s in another session', async () => {
    await seed([user('agent prompt', SENT + 10)], { agentId: 'a-1' });
    await seed([user('elsewhere', SENT + 10)], { sessionId: 's9', taskId: 9 });
    expect(await mainRowsSince(1, 's1', SENT)).toEqual([]);
  });

  it('the session the task is on now, before its rows are linked to the task: /clear starts a new one', async () => {
    await seed([user('<command-name>/clear</command-name>', SENT + 300)], { sessionId: 's2', taskId: null });
    expect(await mainRowsSince(1, null, SENT)).toEqual([]);
    expect((await mainRowsSince(1, 's2', SENT)).map((r) => r.sessionId)).toEqual(['s2']);
  });

  it('caps what it reads', async () => {
    await seed(Array.from({ length: 5 }, (_, i) => user(`m${i}`, SENT + i)));
    expect(await mainRowsSince(1, 's1', SENT, 2)).toHaveLength(2);
  });
});
