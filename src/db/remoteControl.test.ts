/**
 * `remoteControlUrlSince` on a real SQLite: on means an "is active" row in
 * the session written at or after the pty was spawned (#114).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestDb, type TestDb } from './testkit';

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: { load: async () => harness.db },
}));

import { insertMessages, remoteControlUrlSince, resetDb } from './index';
import { parseLine } from '../capture/adapter';

const URL = 'https://claude.ai/code/session_example';
const SPAWNED = Date.parse('2026-10-28T10:00:00.000Z');

let db: TestDb;

beforeEach(() => {
  resetDb();
  db = createTestDb();
  harness.db = db;
});

function at(ms: number): string {
  return new Date(ms).toISOString();
}

async function seed(lines: Record<string, unknown>[], sessionId = 's1', agentId: string | null = null): Promise<void> {
  await insertMessages(
    lines.flatMap((line, i) =>
      parseLine(JSON.stringify({ sessionId, ...line }), i).map((m) => ({ ...m, agentId, taskId: 1 })),
    ),
  );
}

function active(ms: number, url = URL): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'bridge_status',
    content: `/remote-control is active · Continue here, on your phone, or at ${url}`,
    url,
    timestamp: at(ms),
    uuid: `u${ms}`,
  };
}

describe('remoteControlUrlSince', () => {
  it('is on for a row written after the pty was spawned', async () => {
    await seed([{ type: 'user', message: { role: 'user', content: 'hi' }, timestamp: at(SPAWNED + 500), uuid: 'a' }, active(SPAWNED + 1_000)]);
    expect(await remoteControlUrlSince('s1', SPAWNED)).toBe(URL);
  });

  it('is off for a row from before the spawn: that process is gone', async () => {
    await seed([active(SPAWNED - 60_000)]);
    expect(await remoteControlUrlSince('s1', SPAWNED)).toBeNull();
  });

  it('takes the newest row when it came on more than once', async () => {
    await seed([active(SPAWNED + 1_000, 'https://claude.ai/code/session_old'), active(SPAWNED + 2_000)]);
    expect(await remoteControlUrlSince('s1', SPAWNED)).toBe(URL);
  });

  it("reads the task's session only, and never a subagent's rows", async () => {
    await seed([active(SPAWNED + 1_000)], 's2');
    await seed([active(SPAWNED + 1_000)], 's1', 'agent-1');
    expect(await remoteControlUrlSince('s1', SPAWNED)).toBeNull();
  });

  it('is off with no such row at all', async () => {
    await seed([{ type: 'system', subtype: 'turn_duration', durationMs: 5, timestamp: at(SPAWNED + 1_000), uuid: 't' }]);
    expect(await remoteControlUrlSince('s1', SPAWNED)).toBeNull();
  });
});
