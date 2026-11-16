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

describe('placeRemoved, found among the copies the change removes (review of #417)', () => {
  // Two functions, each with an `if` block; the change drops a()'s block.
  const base = ['function a() {', '  if (x) {', '    go();', '  }', '  return 1;', '}', 'function b() {', '  if (y) {', '    stop();', '  }', '  return 2;', '}'];
  const now = base.filter((_, i) => i < 1 || i > 3);
  const brace = { anchorText: '  }', lineStart: 4, sentAt: 1, resolvedAt: null, side: 'old' as const };
  const text = (ls: string[]) => `${ls.join('\n')}\n`;

  it('a removed `}` is placed on the removed copy', () => {
    expect(placeRemoved(brace, text(base), text(now))).toMatchObject({ state: 'removed', lineStart: 4, row: 4 });
  });

  it('after the base moves, an unchanged `}` at its stored line does not make it "back"', () => {
    // Update Copy: five lines arrive above, so the stored line 4 is now an unchanged `}`.
    const pre = ['function z() {', '  if (q) {', '    q();', '  }', '}'];
    const moved = placeRemoved(brace, text([...pre, ...base]), text([...pre, ...now]));
    expect(moved).toMatchObject({ state: 'removed', lineStart: 9, lineEnd: 9, row: 9 });
    expect(shouldAutoResolve(brace, text([...pre, ...now]), text([...pre, ...base]))).toBe(false);
  });

  it('is back only when no copy of its text is removed', () => {
    expect(placeRemoved(brace, text(base), text(base))).toEqual({ state: 'back' });
  });

  it('a range of removed, added-over, unchanged and removed lines: its row is the last removed one, and the gap is after it', () => {
    const b = ['a', 'X', 'b', 'Y', 'c', ''].join('\n');
    const n = ['a', 'X2', 'b', 'c', ''].join('\n');
    expect(placeRemoved({ anchorText: 'X\nb\nY', lineStart: 2 }, b, n)).toEqual({
      state: 'removed', lineStart: 2, lineEnd: 4, row: 4, before: 4, last: 4,
    });
  });

  it('a CRLF base against a file read without its \\r (the editor\'s) still matches line for line', () => {
    const crlf = 'start\r\nguard\r\nend\r\n';
    expect(placeRemoved({ anchorText: 'guard\r', lineStart: 2 }, crlf, 'start\nend\n')).toMatchObject({ state: 'removed', lineStart: 2 });
    expect(placeRemoved({ anchorText: 'guard', lineStart: 2 }, crlf, 'start\nguard\nend\n')).toEqual({ state: 'back' });
  });
});

describe('one comment on both sides (review of #417)', () => {
  it('is written in one statement: both rows, one moment', async () => {
    const { addCommentsTogether } = await import('./comments');
    const t = await task();
    db.log.length = 0;
    await addCommentsTogether([
      { taskId: t, path: 'src/a.ts', lineStart: 4, lineEnd: 5, anchorText: 'gone\nalso', body: 'Why?', side: 'old' },
      { taskId: t, path: 'src/a.ts', lineStart: 4, lineEnd: 4, anchorText: 'kept', body: 'Why?' },
    ]);
    expect(db.log.filter((l) => /INSERT INTO comments/.test(l.sql))).toHaveLength(1);
    const rows = await listComments(t);
    expect(rows.map((c) => c.side).sort()).toEqual(['new', 'old']);
    expect(rows[0]!.createdAt).toBe(rows[1]!.createdAt);
  });

  it('a write that fails stores neither row', async () => {
    const { addCommentsTogether } = await import('./comments');
    const t = await task();
    await expect(
      addCommentsTogether([
        { taskId: t, path: 'src/a.ts', lineStart: 4, lineEnd: 4, anchorText: 'gone', body: 'Why?', side: 'old' },
        // NOT NULL: the second row fails, and with it the statement.
        { taskId: t, path: 'src/a.ts', lineStart: 4, lineEnd: 4, anchorText: 'kept', body: null as unknown as string },
      ]),
    ).rejects.toThrow();
    expect(await listComments(t)).toEqual([]);
  });

  it('reaches Claude as one item: both places and quotes, its text once', () => {
    const old = removed({ id: 1, lineStart: 2, lineEnd: 2, anchorText: '  if (!item.ready) {', body: 'Why?', createdAt: 42 });
    const now = removed({ id: 2, side: 'new', lineStart: 2, lineEnd: 2, anchorText: '  if (item.size > 4) {', body: 'Why?', createdAt: 42 });
    expect(formatForClaude([now, old], 'Intro:')).toBe(
      'Intro:\n\n1. src/allow.js: removed line 2 (in the base, not in the file now)\n```\n  if (!item.ready) {\n```\nand src/allow.js:2\n```\n  if (item.size > 4) {\n```\nWhy?',
    );
  });

  it('two comments that only share their text stay two items', () => {
    const a = removed({ id: 1, body: 'Why?', createdAt: 42 });
    const b = removed({ id: 2, side: 'new', body: 'Why?', createdAt: 43 });
    const c = removed({ id: 3, body: 'Why?', createdAt: 42, lineStart: 9, lineEnd: 9 });
    expect(formatForClaude([a, b, c], 'I:').match(/^\d+\. /gm)).toEqual(['1. ', '2. ', '3. ']);
  });
});
