/**
 * getMessages paging semantics, against a REAL SQLite.
 *
 * This file used to drive a hand-written mini SQL engine. It now uses the
 * testkit, because the one property that matters most here — what a
 * task-scoped `afterSeq` query returns after a session fork — depends on the
 * interaction between `ORDER BY ts, seq` and `WHERE seq > ?`, which a fake
 * cannot be trusted to reproduce.
 *
 * ### THE THING TO KNOW ABOUT `seq`
 *
 * `seq` is `lineIndex * 100 + blockIndex` WITHIN ONE TRANSCRIPT FILE. It is
 * file-local. Everything else — tasks, the transcript pane, "what is new since
 * I last looked" — is not. A fork or a resume starts a new file, so `seq`
 * RESTARTS, and a task that has been forked contains two runs of seq values
 * that overlap.
 *
 * That has now bitten twice: once in ordering (why `messageOrderKeys` switches
 * to `ts` for task-scoped queries) and once in paging (below). Both live here
 * so the next person to touch paging finds them.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestDb, type TestDb } from './testkit';

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: { load: async () => harness.db },
}));

import { getMessages, insertMessages, messageOrderKeys, messagePageDirection, resetDb } from './index';

let db: TestDb;

beforeEach(() => {
  resetDb();
  db = createTestDb();
  harness.db = db;
});

function row(o: {
  sessionId: string;
  seq: number;
  ts: number;
  taskId?: number | null;
  body?: string;
}) {
  return {
    // `?? 1` would turn an explicit null into 1 — the same undefined-vs-null
    // confusion updateProject had to be guarded against.
    taskId: o.taskId === undefined ? 1 : o.taskId,
    sessionId: o.sessionId,
    seq: o.seq,
    role: 'assistant' as const,
    toolName: null,
    targetPath: null,
    body: o.body ?? `row ${o.seq}`,
    rawJson: '{}',
    agentId: null,
    ts: o.ts,
  };
}

/** 50 rows in one session: seq 0,100,…,4900, ts ascending alongside. */
async function seedOneSession(): Promise<void> {
  await insertMessages(
    Array.from({ length: 50 }, (_, i) => row({ sessionId: 's1', seq: i * 100, ts: 1_000 + i })),
  );
}

// ---------------------------------------------------------------------------

describe('forward paging (afterSeq present) keeps the HEAD', () => {
  it('starts immediately after afterSeq, not at the tail', async () => {
    await seedOneSession();
    // 38 rows exist after seq 1000; asking for 5 must return the FIRST five.
    // Returning the last five would silently drop 33 rows, and a caller
    // appending the page would splice a hole into the transcript.
    const page = await getMessages({ sessionId: 's1', afterSeq: 1000, limit: 5 });
    expect(page.map((m) => m.seq)).toEqual([1100, 1200, 1300, 1400, 1500]);
  });

  it('is exclusive of afterSeq itself', async () => {
    await seedOneSession();
    const page = await getMessages({ sessionId: 's1', afterSeq: 1000, limit: 3 });
    expect(page.map((m) => m.seq)).not.toContain(1000);
    expect(page[0]?.seq).toBe(1100);
  });

  it('produces contiguous pages with no gap, whatever the limit', async () => {
    await seedOneSession();
    for (const limit of [1, 3, 7, 49]) {
      const collected: number[] = [];
      let cursor = -1;
      for (;;) {
        const page = await getMessages({ sessionId: 's1', afterSeq: cursor, limit });
        if (page.length === 0) break;
        collected.push(...page.map((m) => m.seq));
        cursor = page[page.length - 1]?.seq ?? cursor;
      }
      expect(collected, `limit ${limit}`).toEqual(Array.from({ length: 50 }, (_, i) => i * 100));
    }
  });

  it('returns a short final page rather than padding from the tail', async () => {
    await seedOneSession();
    const page = await getMessages({ sessionId: 's1', afterSeq: 4700, limit: 10 });
    expect(page.map((m) => m.seq)).toEqual([4800, 4900]);
  });

  it('returns nothing once the caller is caught up', async () => {
    await seedOneSession();
    expect(await getMessages({ sessionId: 's1', afterSeq: 4900, limit: 10 })).toEqual([]);
  });
});

describe('no afterSeq keeps the TAIL', () => {
  it('returns the most recent rows, ascending', async () => {
    await seedOneSession();
    // deriveStatus depends on this: fed the oldest rows of a long session it
    // would report a stale status forever.
    const page = await getMessages({ sessionId: 's1', limit: 5 });
    expect(page.map((m) => m.seq)).toEqual([4500, 4600, 4700, 4800, 4900]);
  });

  it('returns everything, ascending, when the limit is generous', async () => {
    await seedOneSession();
    const page = await getMessages({ sessionId: 's1', limit: 1000 });
    expect(page).toHaveLength(50);
    expect(page[0]?.seq).toBe(0);
    expect(page[49]?.seq).toBe(4900);
  });
});

// ---------------------------------------------------------------------------

describe('seq is not monotonic across a fork', () => {
  // NOTE FOR WHOEVER CHANGES THIS. The "THE HAZARD" cases below assert that
  // task-scoped `afterSeq` behaves BADLY after a fork. They document a real
  // limitation rather than endorsing it. If you make `afterSeq` fork-aware
  // (a per-session cursor, or a monotonic row id), update these cases to the
  // new contract — do not delete them, because the property they describe is
  // what a caller has to reason about.
  const TAIL_LIMIT = 500; // what the transcript pane asks for

  /**
   * One task, two sessions. Session A ran to `preForkRows`, then the user
   * forked: session B starts a NEW transcript file, so its seq restarts at 0
   * while its timestamps continue after A's.
   */
  async function seedFork(preForkRows: number): Promise<void> {
    await insertMessages(
      Array.from({ length: preForkRows }, (_, i) =>
        row({ sessionId: 'A', seq: i * 100, ts: 1_000 + i, body: `pre-fork ${i}` }),
      ),
    );
    await insertMessages([
      row({ sessionId: 'B', seq: 0, ts: 1_000_000, body: 'post-fork 0' }),
      row({ sessionId: 'B', seq: 100, ts: 1_000_001, body: 'post-fork 1' }),
    ]);
  }

  /** A genuinely new row arriving in the live (forked) session. */
  async function appendToB(): Promise<void> {
    await insertMessages([row({ sessionId: 'B', seq: 200, ts: 1_000_002, body: 'THE NEW ROW' })]);
  }

  it.each([200, 600, 2000])(
    'THE HAZARD: task-scoped afterSeq returns pre-fork rows (%i pre-fork)',
    async (preForkRows) => {
      await seedFork(preForkRows);
      await appendToB();

      // The pane held everything and took its cursor from the last row it saw,
      // which after a fork is in B and therefore has a SMALL seq.
      const page = await getMessages({ taskId: 1, afterSeq: 100, limit: TAIL_LIMIT });

      // `seq > 100` matches almost all of session A, and task-scoped ordering
      // is ts ASC, so the page fills from the OLD session first.
      expect(page.filter((m) => m.sessionId === 'A').length).toBeGreaterThan(0);

      // Past TAIL_LIMIT the new row cannot fit at all: the pane goes
      // permanently silent on a live session. Real sessions run a median
      // ~1,080 JSONL lines and expand to more than one row each, so this is
      // the normal case, not an edge case.
      if (preForkRows - 2 >= TAIL_LIMIT) {
        expect(page.some((m) => m.body === 'THE NEW ROW'), 'new row crowded out').toBe(false);
        expect(page).toHaveLength(TAIL_LIMIT);
        expect(page.every((m) => m.sessionId === 'A')).toBe(true);
      }
    },
  );

  it('wastes almost the whole page on rows the caller already holds', async () => {
    await seedFork(200);
    await appendToB();
    const page = await getMessages({ taskId: 1, afterSeq: 100, limit: TAIL_LIMIT });
    const alreadyHeld = page.filter((m) => m.sessionId === 'A').length;
    expect(alreadyHeld).toBe(198);
    expect(alreadyHeld / page.length).toBeGreaterThan(0.99);
  });

  it.each([200, 600, 2000])(
    'THE FIX: session-scoped afterSeq returns exactly the new row (%i pre-fork)',
    async (preForkRows) => {
      await seedFork(preForkRows);
      await appendToB();

      // Scope the tail to the session being read, and take the cursor as the
      // highest seq WITHIN that scope. Session A's numbering is then simply
      // not in the query.
      const page = await getMessages({ sessionId: 'B', afterSeq: 100, limit: TAIL_LIMIT });
      expect(page.map((m) => m.body)).toEqual(['THE NEW ROW']);
    },
  );

  it('delivers nothing when the forked session has nothing new', async () => {
    await seedFork(2000);
    expect(await getMessages({ sessionId: 'B', afterSeq: 100, limit: TAIL_LIMIT })).toEqual([]);
  });

  it('a task-scoped read with NO afterSeq still shows the fork correctly', async () => {
    // The tail path is unaffected: ts ordering puts B after A regardless of seq.
    await seedFork(600);
    await appendToB();
    const page = await getMessages({ taskId: 1, limit: 5 });
    expect(page.map((m) => m.sessionId)).toEqual(['A', 'A', 'B', 'B', 'B']);
    expect(page[page.length - 1]?.body).toBe('THE NEW ROW');
  });

  it('the two sessions genuinely overlap in seq — that is the whole problem', async () => {
    await seedFork(600);
    const a = await getMessages({ sessionId: 'A', limit: 5000 });
    const b = await getMessages({ sessionId: 'B', limit: 5000 });
    const aSeqs = new Set(a.map((m) => m.seq));
    expect(b.filter((m) => aSeqs.has(m.seq)).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe('task-scoped ordering across a resumed session', () => {
  async function seedResumed(): Promise<void> {
    await insertMessages([
      row({ sessionId: 'old', seq: 0, ts: 1_000 }),
      row({ sessionId: 'old', seq: 100, ts: 2_000 }),
      row({ sessionId: 'old', seq: 200, ts: 3_000 }),
      row({ sessionId: 'new', seq: 0, ts: 4_000 }),
      row({ sessionId: 'new', seq: 100, ts: 5_000 }),
    ]);
  }

  it('orders by ts so the resumed session follows the old one', async () => {
    await seedResumed();
    const rows = await getMessages({ taskId: 1 });
    expect(rows.map((m) => `${m.sessionId}:${m.seq}`)).toEqual([
      'old:0', 'old:100', 'old:200', 'new:0', 'new:100',
    ]);
  });

  it('keeps the tail meaningful across the resume boundary', async () => {
    await seedResumed();
    const rows = await getMessages({ taskId: 1, limit: 2 });
    // seq-led ordering would have returned old:200 and new:100 here
    expect(rows.map((m) => `${m.sessionId}:${m.seq}`)).toEqual(['new:0', 'new:100']);
  });

  it('uses seq for session scope and ts for task scope', () => {
    expect(messageOrderKeys({ sessionId: 's1' })).toEqual(['seq', 'ts', 'id']);
    expect(messageOrderKeys({ taskId: 7 })).toEqual(['ts', 'seq', 'id']);
    expect(messageOrderKeys({ taskId: 7, sessionId: 's1' })).toEqual(['ts', 'seq', 'id']);
    expect(messageOrderKeys({})).toEqual(['ts', 'seq', 'id']);
  });

  it('applies the head/tail rule independently of the sort key', () => {
    expect(messagePageDirection({ sessionId: 's1' })).toBe('tail');
    expect(messagePageDirection({ taskId: 7 })).toBe('tail');
    expect(messagePageDirection({ sessionId: 's1', afterSeq: 0 })).toBe('head');
    expect(messagePageDirection({ taskId: 7, afterSeq: 0 })).toBe('head');
  });
});

describe('filters still apply while paging', () => {
  it('does not page across sessions', async () => {
    await insertMessages([
      row({ sessionId: 's1', seq: 0, ts: 1_000 }),
      row({ sessionId: 's2', seq: 100, ts: 1_100 }),
      row({ sessionId: 's1', seq: 200, ts: 1_200 }),
      row({ sessionId: 's2', seq: 300, ts: 1_300 }),
    ]);
    const page = await getMessages({ sessionId: 's1', afterSeq: -1, limit: 10 });
    expect(page.map((m) => m.seq)).toEqual([0, 200]);
  });

  it('preserves a null task_id rather than dropping the row', async () => {
    await insertMessages([row({ sessionId: 's1', seq: 0, ts: 1_000, taskId: null })]);
    const page = await getMessages({ sessionId: 's1' });
    expect(page).toHaveLength(1);
    expect(page[0]?.taskId).toBeNull();
  });
});
