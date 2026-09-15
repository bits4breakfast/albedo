/**
 * Past-session browsing.
 *
 * The aggregate runs in SQLite, so these tests drive the real query builder
 * against a recording fake and assert the STRUCTURAL properties that would
 * silently produce wrong numbers if they regressed — plus the pure mapping and
 * short-circuit behaviour. What a fake cannot check is noted in the report.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  calls: [] as { sql: string; binds: unknown[] }[],
  rows: [] as Record<string, unknown>[],
}));

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: {
    load: async () => ({
      select: async (sql: string, binds: unknown[]) => {
        state.calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), binds: binds ?? [] });
        return state.rows;
      },
      execute: async () => ({ rowsAffected: 0 }),
    }),
  },
}));

import { fallbackSessionLabel, listPastSessions, listSessionCwds } from './sessions';
import { resetDb } from './index';

const ROW = {
  session_id: 'sess-1',
  cwd: '/Users/x/www/acme',
  title: 'Fix the uploader retry',
  branch: 'ACME-2346',
  first_prompt: 'fix the uploader retry logic',
  top_files: '3\tsrc/uploader.ts\n1\tsrc/config.ts',
  first_ts: 1_000,
  last_ts: 9_000,
  message_count: 412,
  task_id: null,
};

beforeEach(() => {
  resetDb();
  state.calls = [];
  state.rows = [];
});

describe('listPastSessions — mapping', () => {
  it('maps every column to its camelCase field', async () => {
    state.rows = [ROW];
    const [s] = await listPastSessions();
    expect(s).toEqual({
      sessionId: 'sess-1',
      cwd: '/Users/x/www/acme',
      title: 'Fix the uploader retry',
      branch: 'ACME-2346',
      firstPrompt: 'fix the uploader retry logic',
      topFiles: ['uploader.ts', 'config.ts'],
      firstTs: 1_000,
      lastTs: 9_000,
      messageCount: 412,
      taskId: null,
      cwdExists: null,
    });
  });

  it('reports taskId when a task already adopted the session', async () => {
    state.rows = [{ ...ROW, task_id: 7 }];
    expect((await listPastSessions())[0]?.taskId).toBe(7);
  });

  it('leaves cwdExists null — the db layer does not touch the filesystem', async () => {
    state.rows = [ROW, { ...ROW, session_id: 'sess-2', cwd: null }];
    for (const s of await listPastSessions()) expect(s.cwdExists).toBeNull();
  });

  it('carries a null title through rather than inventing one', async () => {
    state.rows = [{ ...ROW, title: null }];
    expect((await listPastSessions())[0]?.title).toBeNull();
  });

  it('does not crash when the driver omits a column entirely', async () => {
    state.rows = [{ session_id: 'bare', first_ts: 1, last_ts: 2, message_count: 3 }];
    const [s] = await listPastSessions();
    expect(s?.branch).toBeNull();
    expect(s?.firstPrompt).toBeNull();
    expect(s?.topFiles).toEqual([]);
  });
});

describe('listPastSessions — query construction', () => {
  it('orders by most recent activity first', async () => {
    await listPastSessions();
    expect(state.calls[0]?.sql).toContain('ORDER BY last_ts DESC');
  });

  it('aggregates in SQL rather than counting rows in JS', async () => {
    await listPastSessions();
    const sql = state.calls[0]?.sql ?? '';
    expect(sql).toContain('COUNT(*)');
    expect(sql).toContain('MIN(m.ts)');
    expect(sql).toContain('MAX(m.ts)');
    expect(sql).toContain('GROUP BY m.session_id');
  });

  it('counts the whole session, not just the rows that matched the query', async () => {
    await listPastSessions({ query: 'retry' });
    const sql = state.calls[0]?.sql ?? '';
    // The FTS filter must narrow which SESSIONS are listed. Narrowing which
    // ROWS are counted would report "3 messages" for a 400-message session
    // that mentions the term three times.
    expect(sql).toContain('m.session_id IN');
    expect(sql).not.toContain('m.id IN');
    expect(sql).toContain('COUNT(*)');
  });

  it('joins transcript_files through a per-session subquery', async () => {
    await listPastSessions();
    const sql = state.calls[0]?.sql ?? '';
    // A session id can appear in several transcript files (resume,
    // compaction). Joining the table directly would multiply every count by
    // the number of files carrying that session.
    expect(sql).toContain('GROUP BY session_id');
    expect(sql).toContain('MAX(updated_at)');
  });

  it('escapes the query through the shared FTS helper', async () => {
    await listPastSessions({ query: `it's broken: NEAR(a b)` });
    // quoted terms, not raw FTS5 syntax
    expect(state.calls[0]?.binds[0]).toBe('"it\'s" "broken:" "NEAR(a" "b)"');
  });

  it('returns nothing, and asks the database nothing, for an unsearchable query', async () => {
    expect(await listPastSessions({ query: '--- ...' })).toEqual([]);
    expect(state.calls).toHaveLength(0);
  });

  it('treats a blank query as no query at all', async () => {
    await listPastSessions({ query: '   ' });
    const sql = state.calls[0]?.sql ?? '';
    expect(sql).not.toContain('messages_fts');
  });

  it('filters by cwd', async () => {
    await listPastSessions({ cwd: '/Users/x/www/acme' });
    expect(state.calls[0]?.sql).toContain('tf.cwd = $1');
    expect(state.calls[0]?.binds[0]).toBe('/Users/x/www/acme');
  });

  it('applies `since` to the session, not to individual rows', async () => {
    await listPastSessions({ since: 5_000 });
    // HAVING, so a long-running session counts as recent if its LAST message
    // is recent, rather than being filtered down to its recent rows.
    expect(state.calls[0]?.sql).toContain('HAVING MAX(m.ts) >= $1');
  });

  it('numbers binds correctly when filters combine', async () => {
    await listPastSessions({ query: 'retry', cwd: '/r', since: 42, limit: 9 });
    const { sql, binds } = state.calls[0] ?? { sql: '', binds: [] };
    expect(binds).toEqual(['"retry"', '/r', 42, 9]);
    expect(sql).toContain('MATCH $1');
    expect(sql).toContain('tf.cwd = $2');
    expect(sql).toContain('HAVING MAX(m.ts) >= $3');
    expect(sql).toContain('LIMIT $4');
    // every placeholder present exactly once, none skipped
    const slots = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])).sort();
    expect(slots).toEqual([1, 2, 3, 4]);
  });

  it('defaults to a bounded limit', async () => {
    await listPastSessions();
    expect(state.calls[0]?.binds[0]).toBe(200);
  });

  it('never accepts a limit below 1', async () => {
    await listPastSessions({ limit: 0 });
    expect(state.calls[0]?.binds[0]).toBe(1);
  });
});

describe('fallbackSessionLabel', () => {
  it('collapses a multi-line prompt to one line', () => {
    expect(fallbackSessionLabel({ body: 'add a retry\n\nto the  uploader' })).toBe(
      'add a retry to the uploader',
    );
  });

  it('truncates with an ellipsis', () => {
    const label = fallbackSessionLabel({ body: 'x'.repeat(200) });
    expect(label).toHaveLength(60);
    expect(label?.endsWith('…')).toBe(true);
  });

  it('does not truncate something that already fits', () => {
    expect(fallbackSessionLabel({ body: 'short prompt' })).toBe('short prompt');
  });

  it('returns null rather than an empty label', () => {
    expect(fallbackSessionLabel(null)).toBeNull();
    expect(fallbackSessionLabel({ body: null })).toBeNull();
    expect(fallbackSessionLabel({ body: '   \n ' })).toBeNull();
  });
});

describe('listSessionCwds', () => {
  it('lists distinct cwds, newest activity first, dropping nulls', async () => {
    state.rows = [{ cwd: '/a' }, { cwd: null }, { cwd: '/b' }];
    expect(await listSessionCwds()).toEqual(['/a', '/b']);
    expect(state.calls[0]?.sql).toContain('GROUP BY cwd');
    expect(state.calls[0]?.sql).toContain('ORDER BY newest DESC');
  });
});
