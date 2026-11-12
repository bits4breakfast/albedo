/**
 * The status strip's window usage with the closed hours cached (#365), on a
 * real SQLite: every answer must equal the one query over the whole window
 * (`getWindowUsageTotalsExact`, unchanged from main), through rows added in
 * closed, open and partial hours, the window sliding across hours, rows
 * deleted, and two windows read at once.
 *
 * The data has what makes a plain per-hour sum wrong: a subagent's lines
 * share the parent's session id and line numbers, so one (session, line)
 * group has rows in different hours. The query takes each counter's MAX over
 * the group once; adding up hours would count it twice.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestDb, type TestDb } from './testkit';

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: { load: async () => harness.db },
}));

import {
  createTask,
  getWindowUsageTotals,
  getWindowUsageTotalsExact,
  messageDeletions,
  purgeTaskHistory,
  resetDb,
} from './index';

let db: TestDb;

beforeEach(() => {
  resetDb();
  db = createTestDb();
  harness.db = db;
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const FIVE = 5 * HOUR;
/** Not on an hour: the window's first hour is a partial one. */
const T0 = 1_800_000_000_000 + 17 * 60_000 + 4_321;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function raw(rand: () => number, withUsage: boolean): string {
  const message: Record<string, unknown> = { role: 'assistant', content: [] };
  if (withUsage) {
    message['usage'] = {
      input_tokens: Math.floor(rand() * 900),
      output_tokens: Math.floor(rand() * 400),
      cache_creation_input_tokens: Math.floor(rand() * 5_000),
      cache_read_input_tokens: Math.floor(rand() * 90_000),
    };
  }
  return JSON.stringify({ type: 'assistant', message });
}

/** Next line number per session and agent, so later batches add new lines. */
const nextLine = new Map<string, number>();

/**
 * `n` lines spread over `[from, to)`, across sessions, their subagents (same
 * session id, same line numbers), user rows and rows without usage. Each line
 * is several rows with one raw_json, as a transcript line expands. Inserted
 * shuffled, as tailing several transcripts at once interleaves them.
 */
function addLines(rand: () => number, n: number, from: number, to: number, taskOf: (s: number) => number | null = () => null): void {
  const rows: unknown[][] = [];
  for (let i = 0; i < n; i++) {
    const s = Math.floor(rand() * 4);
    const agent = rand() < 0.4 ? (rand() < 0.5 ? 'agent-a' : 'agent-b') : null;
    const k = `${s}/${agent ?? ''}`;
    const line = nextLine.get(k) ?? 0;
    nextLine.set(k, line + 1);
    const ts = from + Math.floor(rand() * (to - from));
    const kind = rand();
    const role = kind < 0.6 ? 'assistant' : kind < 0.8 ? 'tool_use' : 'user';
    const json = role === 'user' ? '{"type":"user"}' : raw(rand, rand() < 0.85);
    const blocks = 1 + Math.floor(rand() * 3);
    for (let b = 0; b < blocks; b++) rows.push([taskOf(s), `s${s}`, line * 100 + b, role, json, agent, ts]);
  }
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [rows[i], rows[j]] = [rows[j]!, rows[i]!];
  }
  const st = db.raw.prepare(
    `INSERT OR IGNORE INTO messages (task_id, session_id, seq, role, body, raw_json, agent_id, ts) VALUES (?, ?, ?, ?, 'b', ?, ?, ?)`,
  );
  for (const r of rows) st.run(...(r as never[]));
}

async function expectSame(start: number, end: number): Promise<void> {
  const want = await getWindowUsageTotalsExact(start, end);
  const got = await getWindowUsageTotals(start, end);
  expect(got).toEqual(want);
}

describe('window usage with closed hours cached (#365)', () => {
  it('has groups spanning hours in its data, which a per-hour sum would double', () => {
    nextLine.clear();
    addLines(rng(1), 800, T0 - WEEK, T0);
    const r = db.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM (SELECT session_id, seq / 100 FROM messages
           WHERE role IN ('assistant','tool_use') AND json_extract(raw_json, '$.message.usage') IS NOT NULL
           GROUP BY session_id, seq / 100 HAVING COUNT(DISTINCT ts / ${HOUR}) > 1)`,
      )
      .get() as { n: number };
    expect(r.n).toBeGreaterThan(20);
  });

  it('equals the one query as rows arrive and the window slides', async () => {
    for (const seed of [2, 3, 4]) {
      resetDb();
      db = createTestDb();
      harness.db = db;
      nextLine.clear();
      const rand = rng(seed);
      addLines(rand, 1500, T0 - WEEK - DAY, T0);
      let now = T0;
      for (let step = 0; step < 40; step++) {
        await expectSame(now - WEEK, now);
        await expectSame(now - FIVE, now);
        const roll = rand();
        // New lines: mostly now, sometimes into an hour already closed (a
        // transcript caught up late), sometimes into the window's first hour.
        if (roll < 0.5) addLines(rand, 1 + Math.floor(rand() * 20), now - HOUR / 2, now + 1);
        else if (roll < 0.7) addLines(rand, 1 + Math.floor(rand() * 20), now - 3 * DAY, now - 2 * DAY);
        else if (roll < 0.8) addLines(rand, 1 + Math.floor(rand() * 10), now - WEEK - HOUR, now - WEEK + HOUR);
        // The clock: a few seconds, half an hour, or across several hours.
        const tick = rand();
        now += tick < 0.4 ? 30_000 : tick < 0.8 ? 30 * 60_000 : 3 * HOUR + 1234;
      }
    }
  });

  it('equals the one query at the edges: a row exactly at the start, the end, and an hour boundary', async () => {
    nextLine.clear();
    const rand = rng(5);
    addLines(rand, 400, T0 - WEEK, T0);
    const start = T0 - WEEK;
    const hourEdge = Math.ceil(start / HOUR) * HOUR;
    for (const ts of [start, T0, hourEdge, hourEdge - 1, Math.floor(T0 / HOUR) * HOUR]) {
      addLines(rand, 3, ts, ts + 1);
    }
    await expectSame(start, T0);
    await expectSame(T0 - FIVE, T0);
    // An hour-aligned window: no partial first hour.
    await expectSame(Math.floor(T0 / HOUR) * HOUR - WEEK, Math.floor(T0 / HOUR) * HOUR);
  });

  it('starts over when messages are deleted', async () => {
    nextLine.clear();
    const rand = rng(6);
    const task = await createTask({ title: 't', repoPath: '/r', worktreePath: '/r', branch: 'b', baseBranch: 'main' } as never);
    addLines(rand, 600, T0 - WEEK, T0, (s) => (s === 0 ? task.id : null));
    await expectSame(T0 - WEEK, T0);
    const before = await getWindowUsageTotals(T0 - WEEK, T0);
    const deletions = messageDeletions();
    await purgeTaskHistory(task.id);
    expect(messageDeletions()).toBe(deletions + 1);
    const after = await getWindowUsageTotals(T0 - WEEK, T0);
    expect(after).toEqual(await getWindowUsageTotalsExact(T0 - WEEK, T0));
    expect(after.lineCount).toBeLessThan(before.lineCount);
  });

  it('gives each of two windows read at once its own answer', async () => {
    nextLine.clear();
    const rand = rng(7);
    addLines(rand, 800, T0 - WEEK, T0);
    const [five, week] = await Promise.all([getWindowUsageTotals(T0 - FIVE, T0), getWindowUsageTotals(T0 - WEEK, T0)]);
    expect(five).toEqual(await getWindowUsageTotalsExact(T0 - FIVE, T0));
    expect(week).toEqual(await getWindowUsageTotalsExact(T0 - WEEK, T0));
  });

  it('reads only the new rows, the open hour and the first hour once the week is held', async () => {
    nextLine.clear();
    const rand = rng(8);
    addLines(rand, 800, T0 - WEEK, T0);
    await getWindowUsageTotals(T0 - WEEK, T0);
    addLines(rand, 5, T0 - 10_000, T0);
    db.log.length = 0;
    const now = T0 + 60_000;
    await getWindowUsageTotals(now - WEEK, now);
    // Every usage read binds a ts range; none spans more than two hours.
    const spans = db.log
      .filter((q) => q.sql.includes('FROM messages') && q.sql.includes('ts >='))
      .map((q) => (q.binds[1] as number) - (q.binds[0] as number));
    expect(spans.length).toBeGreaterThan(0);
    // The new rows' read is bounded by id, not by a short ts range: leave it out.
    const byTs = db.log.filter((q) => q.sql.includes('ts >=') && !q.sql.includes('id >'));
    for (const q of byTs) expect((q.binds[1] as number) - (q.binds[0] as number)).toBeLessThanOrEqual(HOUR);
    expect(await getWindowUsageTotals(now - WEEK, now)).toEqual(await getWindowUsageTotalsExact(now - WEEK, now));
  });

  it('reads a short window in one query', async () => {
    nextLine.clear();
    addLines(rng(9), 100, T0 - HOUR, T0);
    db.log.length = 0;
    await expectSame(T0 - HOUR, T0);
    expect(db.log.filter((q) => q.sql.includes('FROM messages'))).toHaveLength(2);
  });
});
