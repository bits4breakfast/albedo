/**
 * Pure pieces of the db layer. The query paths need a live Tauri sql plugin,
 * but FTS query escaping does not — and that is the part a user can break from
 * the search box.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  buildMessageInsertBatches,
  emitTasksChanged,
  MESSAGE_INSERT_CHUNK_ROWS,
  onTasksChanged,
  toFtsQuery,
  type InsertableMessage,
} from './index';

describe('toFtsQuery', () => {
  it('quotes each term so FTS5 syntax cannot leak out of the search box', () => {
    expect(toFtsQuery('retry')).toBe('"retry"');
    expect(toFtsQuery('retry uploader')).toBe('"retry" "uploader"');
  });

  it('neutralises FTS5 operators typed as plain text', () => {
    // Unquoted, each of these is real FTS5 syntax and raises a syntax error
    // or silently changes the query's meaning.
    expect(toFtsQuery('foo AND bar')).toBe('"foo" "AND" "bar"');
    expect(toFtsQuery('NEAR(a b)')).toBe('"NEAR(a" "b)"');
    expect(toFtsQuery('col:value')).toBe('"col:value"');
    expect(toFtsQuery('-excluded')).toBe('"-excluded"');
    expect(toFtsQuery('^anchored')).toBe('"^anchored"');
  });

  it('escapes embedded double quotes by doubling them', () => {
    expect(toFtsQuery('say"hi')).toBe('"say""hi"');
    expect(toFtsQuery('"quoted phrase"')).toBe('"""quoted" "phrase"""');
  });

  it('keeps a trailing * outside the quotes so prefix search still works', () => {
    expect(toFtsQuery('upload*')).toBe('"upload"*');
    expect(toFtsQuery('src/up*')).toBe('"src/up"*');
  });

  it('drops terms with nothing tokenisable in them', () => {
    // "---" matches no token; left in an implicitly AND-ed query it would
    // silently zero out every result.
    expect(toFtsQuery('retry ---')).toBe('"retry"');
    expect(toFtsQuery('--- ...')).toBeNull();
    expect(toFtsQuery('*')).toBeNull();
  });

  it('returns null for an empty query rather than matching everything', () => {
    expect(toFtsQuery('')).toBeNull();
    expect(toFtsQuery('   \t ')).toBeNull();
  });

  it('handles punctuation-heavy but real search terms', () => {
    expect(toFtsQuery('src/capture/adapter.ts')).toBe('"src/capture/adapter.ts"');
    expect(toFtsQuery("it's")).toBe('"it\'s"');
    expect(toFtsQuery('user@example.com')).toBe('"user@example.com"');
    expect(toFtsQuery('naïve 日本語')).toBe('"naïve" "日本語"');
  });
});

describe('onTasksChanged', () => {
  it('notifies every subscriber and unsubscribes cleanly', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = onTasksChanged(a);
    const offB = onTasksChanged(b);

    emitTasksChanged();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    offA();
    emitTasksChanged();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);

    offB();
    emitTasksChanged();
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('does not let one broken subscriber stop the others', () => {
    const boom = vi.fn(() => {
      throw new Error('subscriber exploded');
    });
    const ok = vi.fn();
    const offBoom = onTasksChanged(boom);
    const offOk = onTasksChanged(ok);

    expect(() => emitTasksChanged()).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);

    offBoom();
    offOk();
  });

  it('survives a subscriber unsubscribing during the notification', () => {
    const calls: string[] = [];
    const offFirst = onTasksChanged(() => {
      calls.push('first');
      offFirst();
    });
    const offSecond = onTasksChanged(() => calls.push('second'));

    emitTasksChanged();
    expect(calls).toEqual(['first', 'second']);

    emitTasksChanged();
    expect(calls).toEqual(['first', 'second', 'second']);
    offSecond();
  });
});

describe('buildMessageInsertBatches', () => {
  const COLUMNS = 10;

  function row(seq: number, taskId: number | null = 1): InsertableMessage {
    return {
      taskId,
      sessionId: 'sess',
      seq,
      role: 'assistant',
      toolName: null,
      targetPath: null,
      body: `body ${seq}`,
      rawJson: `{"seq":${seq}}`,
      agentId: null,
      ts: 1_000 + seq,
    };
  }

  it('emits nothing for no rows', () => {
    expect(buildMessageInsertBatches([])).toEqual([]);
  });

  it('batches rather than issuing one round-trip per row', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => row(i));
    const batches = buildMessageInsertBatches(rows);
    expect(batches.length).toBe(Math.ceil(1000 / MESSAGE_INSERT_CHUNK_ROWS));
    expect(batches.length).toBeLessThan(rows.length / 10);
  });

  it("stays under SQLite's 999 bind-variable limit", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => row(i));
    for (const batch of buildMessageInsertBatches(rows)) {
      expect(batch.binds.length).toBeLessThanOrEqual(999);
    }
  });

  it('numbers placeholders from $1 with no gaps or repeats', () => {
    const rows = Array.from({ length: 3 }, (_, i) => row(i));
    const batch = buildMessageInsertBatches(rows)[0];
    expect(batch).toBeDefined();
    const placeholders = [...(batch?.sql.matchAll(/\$(\d+)/g) ?? [])].map((m) => Number(m[1]));
    expect(placeholders).toEqual(
      Array.from({ length: 3 * COLUMNS }, (_, i) => i + 1),
    );
    expect(batch?.binds).toHaveLength(3 * COLUMNS);
  });

  it('binds values in the same order as the column list', () => {
    const batch = buildMessageInsertBatches([row(42, null)])[0];
    expect(batch?.sql.startsWith(
      'INSERT OR IGNORE INTO messages (task_id, session_id, seq, role, tool_name, target_path, body, raw_json, agent_id, ts) VALUES ',
    )).toBe(true);
    expect(batch?.binds).toEqual([
      null,
      'sess',
      42,
      'assistant',
      null,
      null,
      'body 42',
      '{"seq":42}',
      null,
      1_042,
    ]);
  });

  it('uses INSERT OR IGNORE so re-ingesting a byte range is a no-op', () => {
    const batch = buildMessageInsertBatches([row(1)])[0];
    expect(batch?.sql).toContain('INSERT OR IGNORE');
  });

  it('accepts a null task_id, so terminal sessions are still captured', () => {
    const batch = buildMessageInsertBatches([row(1, null)])[0];
    expect(batch?.binds[0]).toBeNull();
  });

  it('covers every row exactly once across batches', () => {
    const rows = Array.from({ length: 257 }, (_, i) => row(i));
    const seqs = buildMessageInsertBatches(rows).flatMap((b) =>
      b.binds.filter((_, i) => i % COLUMNS === 2),
    );
    expect(seqs).toEqual(rows.map((r) => r.seq));
  });
});
