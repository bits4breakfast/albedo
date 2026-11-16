/**
 * Comments on removed lines (#402, migration v20): the `side` column, and
 * the rules that read it -- where such a comment stands, when it resolves
 * itself, and what Claude is told. Every comment from before v20, and every
 * one made without a side, is on the file as it is now and behaves exactly
 * as it did.
 */
import BetterSqlite3 from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schemaSql from './schema.sql?raw';
import { createTestDb, migrationsInOrder, type TestDb } from './testkit';

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@tauri-apps/plugin-sql', () => ({
  default: { load: async () => harness.db },
}));

import { createTask, resetDb } from './index';
import {
  addComment,
  commentLocation,
  formatForClaude,
  listComments,
  listGithubDrafts,
  placeRemoved,
  resolvedReason,
  shouldAutoResolve,
  sideOf,
  type ReviewComment,
} from './comments';

let db: TestDb;
beforeEach(() => {
  resetDb();
  db = createTestDb();
  harness.db = db;
});

async function task(): Promise<number> {
  const t = await createTask({
    title: 't',
    projectId: null,
    repoPath: '/repo',
    baseBranch: 'main',
    branch: 'b',
    worktreePath: `/wt/${Math.random()}`,
    ownsWorktree: true,
    createdBranch: true,
    kind: 'work',
  });
  return t.id;
}

describe('the side column (v20)', () => {
  it('a row written before v20 reads as on the file now', () => {
    // The schema as it was at v19, a row as v15's INSERT wrote it, then v20.
    const raw = new BetterSqlite3(':memory:');
    raw.pragma('foreign_keys = OFF'); // as the shipped driver (testkit.ts)
    raw.exec(schemaSql);
    const all = migrationsInOrder();
    const v20 = all.findIndex((m) => m.name.includes('0020_comment_side'));
    expect(v20).toBeGreaterThan(0);
    for (const m of all.slice(0, v20)) raw.exec(m.sql);
    raw
      .prepare(
        `INSERT INTO comments (task_id, path, line_start, line_end, anchor_text, body, created_at, updated_at, github, reply_to)
         VALUES (1, 'src/a.ts', 2, 2, 'x', 'Why?', 1, 1, NULL, NULL)`,
      )
      .run();
    raw.exec(all[v20]!.sql);
    expect(raw.prepare('SELECT side FROM comments').all()).toEqual([{ side: 'new' }]);
    raw.close();
  });

  it('a comment made without a side is on the file now; one on removed lines keeps its side', async () => {
    const t = await task();
    await addComment({ taskId: t, path: 'src/a.ts', lineStart: 2, lineEnd: 2, anchorText: 'kept', body: 'New side.' });
    await addComment({ taskId: t, path: 'src/a.ts', lineStart: 5, lineEnd: 6, anchorText: 'gone\nalso gone', body: 'Why drop it?', side: 'old' });
    const rows = await listComments(t);
    expect(rows.map((c) => [c.body, c.side, c.lineStart, c.lineEnd, c.anchorText])).toEqual([
      ['New side.', 'new', 2, 2, 'kept'],
      ['Why drop it?', 'old', 5, 6, 'gone\nalso gone'],
    ]);
    expect(db.raw.prepare('SELECT side FROM comments ORDER BY id').all()).toEqual([{ side: 'new' }, { side: 'old' }]);
  });

  it('a draft for GitHub on removed lines is a draft like any other', async () => {
    const t = await task();
    await addComment({ taskId: t, path: 'src/a.ts', lineStart: 5, lineEnd: 5, anchorText: 'gone', body: 'Why?', github: 'draft', side: 'old' });
    expect((await listGithubDrafts(t)).map((c) => [c.side, c.github])).toEqual([['old', 'draft']]);
  });

  it('a comment with no side at all (built elsewhere) is on the new side', () => {
    expect(sideOf({})).toBe('new');
    expect(sideOf({ side: 'new' })).toBe('new');
    expect(sideOf({ side: 'old' })).toBe('old');
  });
});

// A made-up file: the change drops a guard and rewrites its condition.
const BASE = ['function allow(item) {', '  if (!item.ready) {', '    return false;', '  }', '  if (item.size > 3) {', '    return true;', '  }', '}', ''].join('\n');
const NOW = ['function allow(item) {', '  if (item.size > 4) {', '    return true;', '  }', '}', ''].join('\n');

function removed(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 1, taskId: 1, path: 'src/allow.js', lineStart: 2, lineEnd: 4,
    anchorText: '  if (!item.ready) {\n    return false;\n  }',
    body: 'Why drop the ready check?', createdAt: 0, updatedAt: 0, sentAt: null, resolvedAt: null,
    github: null, replyTo: null, side: 'old', ...over,
  };
}

describe('placeRemoved', () => {
  it('finds the removed lines in the base, and the line of the file that took their place', () => {
    expect(placeRemoved(removed(), BASE, NOW)).toEqual({ state: 'removed', lineStart: 2, lineEnd: 4, row: 4, before: 2, last: 5 });
  });

  it('finds them again by their text when the base moved', () => {
    const moved = `// header\n// more\n${BASE}`;
    expect(placeRemoved(removed(), moved, NOW)).toMatchObject({ state: 'removed', lineStart: 4, lineEnd: 6 });
  });

  it('is back when every line is in the file again, unchanged', () => {
    expect(placeRemoved(removed(), BASE, BASE)).toEqual({ state: 'back' });
  });

  it('a removed line whose text is elsewhere in the file is not back', () => {
    // `  }` is still in the file twice over; the one removed is not.
    const brace = removed({ lineStart: 4, lineEnd: 4, anchorText: '  }' });
    expect(NOW.split('\n')).toContain('  }');
    expect(placeRemoved(brace, BASE, NOW).state).toBe('removed');
  });

  it('half back is still removed, under its last removed row', () => {
    const half = ['function allow(item) {', '  if (!item.ready) {', '  if (item.size > 4) {', '    return true;', '  }', '}', ''].join('\n');
    expect(placeRemoved(removed(), BASE, half)).toMatchObject({ state: 'removed', lineStart: 2, lineEnd: 4 });
  });

  it('at the end of the file: no line after it, the last line said instead', () => {
    const tail = removed({ lineStart: 8, lineEnd: 8, anchorText: '}' });
    expect(placeRemoved(tail, BASE, 'function allow(item) {\n')).toMatchObject({ state: 'removed', before: null, last: 1 });
  });

  it('is outdated when the base no longer has its text', () => {
    expect(placeRemoved(removed({ anchorText: 'never there' }), BASE, NOW)).toEqual({ state: 'outdated' });
  });
});

describe('resolving a comment on removed lines', () => {
  it('never because its lines are missing from the file: that is what it is about', () => {
    expect(shouldAutoResolve(removed({ sentAt: 5 }), NOW, BASE)).toBe(false);
  });

  it('once sent, when its lines are back', () => {
    expect(shouldAutoResolve(removed({ sentAt: 5 }), BASE, BASE)).toBe(true);
  });

  it('not while unsent, nor without the base, nor once resolved', () => {
    expect(shouldAutoResolve(removed(), BASE, BASE)).toBe(false);
    expect(shouldAutoResolve(removed({ sentAt: 5 }), BASE)).toBe(false);
    expect(shouldAutoResolve(removed({ sentAt: 5 }), BASE, null)).toBe(false);
    expect(shouldAutoResolve(removed({ sentAt: 5, resolvedAt: 6 }), BASE, BASE)).toBe(false);
  });

  it('a comment on the file now resolves as before, base or not', () => {
    const gone = removed({ side: 'new', sentAt: 5, anchorText: 'not in the file' });
    expect(shouldAutoResolve(gone, NOW)).toBe(true);
    expect(shouldAutoResolve(gone, NOW, BASE)).toBe(true);
    const { side: _side, ...unsided } = gone;
    expect(shouldAutoResolve(unsided, NOW)).toBe(true);
    expect(shouldAutoResolve({ ...unsided, anchorText: '  }' }, NOW)).toBe(false);
  });

  it('says why: its lines are back, or you', () => {
    expect(resolvedReason(removed({ sentAt: 5, resolvedAt: 6 }), BASE, BASE)).toBe('back');
    expect(resolvedReason(removed({ sentAt: 5, resolvedAt: 6 }), NOW, BASE)).toBe('you');
    expect(resolvedReason(removed({ sentAt: 5, resolvedAt: 6 }), BASE)).toBe('you');
    expect(resolvedReason(removed({ resolvedAt: 6, side: 'new', sentAt: 5, anchorText: 'not in the file' }), NOW)).toBe('changed');
  });
});

describe('what Claude is told', () => {
  it('names removed lines by the base, and says they are not in the file', () => {
    expect(commentLocation(removed())).toBe('src/allow.js: removed lines 2–4');
    expect(commentLocation(removed({ lineEnd: 2 }))).toBe('src/allow.js: removed line 2');
    expect(formatForClaude([removed({ lineStart: 3, lineEnd: 3, anchorText: '    return false;' })], 'Intro:')).toBe(
      'Intro:\n\n1. src/allow.js: removed line 3 (in the base, not in the file now)\n```\n    return false;\n```\nWhy drop the ready check?',
    );
  });

  it('a comment on the file now reads exactly as before', () => {
    const now = removed({ side: 'new', lineStart: 2, lineEnd: 3 });
    expect(commentLocation(now)).toBe('src/allow.js:2-3');
    const { side: _side, ...unsided } = now;
    expect(formatForClaude([now], 'Intro:')).toBe(formatForClaude([unsided], 'Intro:'));
    expect(formatForClaude([now], 'Intro:')).toMatch(/^Intro:\n\n1\. src\/allow\.js:2-3\n```/);
  });
});
