/**
 * getMessages paging semantics.
 *
 * These drive the REAL getMessages and the REAL SQL it builds, against a tiny
 * in-memory engine that understands only the two query shapes getMessages
 * emits. The engine implements generic SQL semantics (WHERE / ORDER BY /
 * LIMIT) and knows nothing about paging, so a wrong sort direction or a
 * missing reversal produces a wrong page and fails the test — which is the
 * point. Asserting on the SQL string instead would pass a query that reads
 * correctly and returns the wrong rows.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ table: [] as Record<string, unknown>[] }));

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: {
    load: async () => ({
      select: async (sql: string, binds: unknown[]) => runQuery(sql, binds, state.table),
      execute: async () => ({ rowsAffected: 0 }),
    }),
  },
}));

import { getMessages, messageOrderKeys, messagePageDirection, resetDb } from './index';

// ---------------------------------------------------------------------------
// A deliberately small SQL engine: WHERE / ORDER BY / LIMIT and one subquery.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function runQuery(rawSql: string, binds: unknown[], table: Row[]): Row[] {
  const sql = rawSql.replace(/\s+/g, ' ').trim();

  let inner = sql;
  let outerOrder: string | null = null;
  const wrapper = ' ) ORDER BY ';
  if (sql.startsWith('SELECT * FROM ( ')) {
    const at = sql.lastIndexOf(wrapper);
    if (at < 0) throw new Error(`unparsed wrapper: ${sql}`);
    inner = sql.slice('SELECT * FROM ( '.length, at);
    outerOrder = sql.slice(at + wrapper.length);
  }

  const m = /^SELECT .+? FROM messages ?(?:WHERE (.+?) )?ORDER BY (.+?) LIMIT \$(\d+)$/.exec(inner);
  if (!m) throw new Error(`fake engine cannot parse: ${inner}`);
  const [, whereSql, orderSql, limitSlot] = m;

  let rows = table.filter((r) => matchesWhere(r, whereSql, binds));
  rows = sortRows(rows, orderSql as string);
  rows = rows.slice(0, Number(binds[Number(limitSlot) - 1]));
  if (outerOrder !== null) rows = sortRows(rows, outerOrder);
  return rows.map((r) => ({ ...r }));
}

function matchesWhere(row: Row, whereSql: string | undefined, binds: unknown[]): boolean {
  if (whereSql === undefined) return true;
  return whereSql.split(' AND ').every((clause) => {
    const m = /^(\w+) (=|>|<|>=|<=) \$(\d+)$/.exec(clause.trim());
    if (!m) throw new Error(`fake engine cannot parse clause: ${clause}`);
    const [, column, op, slot] = m;
    const left = row[column as string] as number;
    const right = binds[Number(slot) - 1] as number;
    switch (op) {
      case '=':
        return left === right;
      case '>':
        return left > right;
      case '<':
        return left < right;
      case '>=':
        return left >= right;
      default:
        return left <= right;
    }
  });
}

function sortRows(rows: Row[], orderSql: string): Row[] {
  const keys = orderSql.split(', ').map((k) => {
    const [column, dir] = k.trim().split(' ');
    return { column: column as string, sign: dir === 'DESC' ? -1 : 1 };
  });
  return [...rows].sort((a, b) => {
    for (const { column, sign } of keys) {
      const av = a[column] as number;
      const bv = b[column] as number;
      if (av < bv) return -1 * sign;
      if (av > bv) return 1 * sign;
    }
    return 0;
  });
}

// ---------------------------------------------------------------------------

function seed(rows: { seq: number; ts: number; sessionId: string; taskId: number | null }[]): void {
  state.table = rows.map((r, i) => ({
    id: i + 1,
    task_id: r.taskId,
    session_id: r.sessionId,
    seq: r.seq,
    role: 'assistant',
    tool_name: null,
    target_path: null,
    body: `row ${r.seq}`,
    raw_json: `{"seq":${r.seq}}`,
    ts: r.ts,
  }));
}

/** 50 rows in one session, seq 0,100,...,4900. */
function seedOneSession(): void {
  seed(
    Array.from({ length: 50 }, (_, i) => ({
      seq: i * 100,
      ts: 1_000 + i,
      sessionId: 's1',
      taskId: 7,
    })),
  );
}

beforeEach(() => {
  resetDb();
  state.table = [];
});

describe('forward paging (afterSeq present) keeps the HEAD', () => {
  it('starts immediately after afterSeq, not at the tail', async () => {
    seedOneSession();
    // 38 rows exist after seq 1000; asking for 5 must return the FIRST five of
    // them. Returning the last five would silently drop 33 rows, and a caller
    // appending the page would splice a hole into the middle of the
    // transcript — a defect that surfaces far from its cause.
    const page = await getMessages({ sessionId: 's1', afterSeq: 1000, limit: 5 });
    expect(page.map((m) => m.seq)).toEqual([1100, 1200, 1300, 1400, 1500]);
  });

  it('is exclusive of afterSeq itself', async () => {
    seedOneSession();
    const page = await getMessages({ sessionId: 's1', afterSeq: 1000, limit: 3 });
    expect(page.map((m) => m.seq)).not.toContain(1000);
    expect(page[0]?.seq).toBe(1100);
  });

  it('produces contiguous pages with no gap, whatever the limit', async () => {
    seedOneSession();
    for (const limit of [1, 3, 7, 49]) {
      const collected: number[] = [];
      let cursor = -1;
      for (;;) {
        const page = await getMessages({ sessionId: 's1', afterSeq: cursor, limit });
        if (page.length === 0) break;
        collected.push(...page.map((m) => m.seq));
        cursor = page[page.length - 1]?.seq ?? cursor;
      }
      expect(collected, `limit ${limit}`).toEqual(
        Array.from({ length: 50 }, (_, i) => i * 100),
      );
    }
  });

  it('returns a short final page rather than padding from the tail', async () => {
    seedOneSession();
    const page = await getMessages({ sessionId: 's1', afterSeq: 4700, limit: 10 });
    expect(page.map((m) => m.seq)).toEqual([4800, 4900]);
  });

  it('returns nothing once the caller is caught up', async () => {
    seedOneSession();
    expect(await getMessages({ sessionId: 's1', afterSeq: 4900, limit: 10 })).toEqual([]);
  });
});

describe('no afterSeq keeps the TAIL', () => {
  it('returns the most recent rows, ascending', async () => {
    seedOneSession();
    // deriveStatus depends on this: fed the oldest rows of a long session it
    // would report a stale status forever.
    const page = await getMessages({ sessionId: 's1', limit: 5 });
    expect(page.map((m) => m.seq)).toEqual([4500, 4600, 4700, 4800, 4900]);
  });

  it('returns everything, ascending, when the limit is generous', async () => {
    seedOneSession();
    const page = await getMessages({ sessionId: 's1', limit: 1000 });
    expect(page).toHaveLength(50);
    expect(page[0]?.seq).toBe(0);
    expect(page[49]?.seq).toBe(4900);
  });
});

describe('task-scoped ordering across a resumed session', () => {
  /** Same task, two transcript files; the resumed file restarts seq at 0. */
  function seedResumed(): void {
    seed([
      { seq: 0, ts: 1_000, sessionId: 'old', taskId: 7 },
      { seq: 100, ts: 2_000, sessionId: 'old', taskId: 7 },
      { seq: 200, ts: 3_000, sessionId: 'old', taskId: 7 },
      { seq: 0, ts: 4_000, sessionId: 'new', taskId: 7 },
      { seq: 100, ts: 5_000, sessionId: 'new', taskId: 7 },
    ]);
  }

  it('orders by ts so the resumed session follows the old one', async () => {
    seedResumed();
    const rows = await getMessages({ taskId: 7 });
    expect(rows.map((m) => `${m.sessionId}:${m.seq}`)).toEqual([
      'old:0',
      'old:100',
      'old:200',
      'new:0',
      'new:100',
    ]);
  });

  it('keeps the tail meaningful across the resume boundary', async () => {
    seedResumed();
    const rows = await getMessages({ taskId: 7, limit: 2 });
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
    seed([
      { seq: 0, ts: 1_000, sessionId: 's1', taskId: 7 },
      { seq: 100, ts: 1_100, sessionId: 's2', taskId: 7 },
      { seq: 200, ts: 1_200, sessionId: 's1', taskId: 7 },
      { seq: 300, ts: 1_300, sessionId: 's2', taskId: 7 },
    ]);
    const page = await getMessages({ sessionId: 's1', afterSeq: -1, limit: 10 });
    expect(page.map((m) => m.seq)).toEqual([0, 200]);
  });

  it('preserves a null task_id rather than dropping the row', async () => {
    seed([{ seq: 0, ts: 1_000, sessionId: 's1', taskId: null }]);
    const page = await getMessages({ sessionId: 's1' });
    expect(page).toHaveLength(1);
    expect(page[0]?.taskId).toBeNull();
  });
});
