/**
 * The change-set view.
 *
 * Everything here is either the pure merge (normalisation, de-duplication,
 * source classification, ordering) or the real `touchedFiles` driven against a
 * stub sql plugin and a stub git runner. The two failure modes worth pinning
 * down are (a) counting a `Read` as an edit, which makes the whole view
 * meaningless, and (b) failing to normalise one side of the merge, which lists
 * the same file twice — once with an edit count, once with a git status.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildTouchedQuery,
  compareTouched,
  mergeTouched,
  toWorktreeRelative,
  touchedFiles,
  touchedFilesDetailed,
  WRITING_TOOLS,
} from './touched';
import { resetDb } from './index';
import { markHandEdited, __resetHandEdited } from '../lib/handEdited';
import { setGitRunner, type StatusEntry } from '../git/worktree';
import type { TouchedFile } from '../types';

const WT = '/Users/me/agents/albedo/fix-upload';

function entry(x: string, y: string, path: string, origPath: string | null = null): StatusEntry {
  return { x, y, path, origPath };
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

describe('buildTouchedQuery', () => {
  it('aggregates in SQL rather than pulling rows into JS', () => {
    const { sql } = buildTouchedQuery(7);
    // A long task is tens of thousands of rows; the whole point is that the
    // database returns a few dozen.
    expect(sql).toMatch(/COUNT\(\*\)/);
    expect(sql).toMatch(/MAX\(ts\)/);
    expect(sql).toMatch(/GROUP BY target_path/);
  });

  it('scopes by task_id, so a resumed task keeps both of its sessions', () => {
    const { sql, binds } = buildTouchedQuery(7);
    expect(sql).toMatch(/WHERE task_id = \$1/);
    expect(sql).not.toMatch(/session_id/);
    expect(binds[0]).toBe(7);
  });

  it('counts only tool_use rows that actually carry a path', () => {
    const { sql } = buildTouchedQuery(1);
    expect(sql).toMatch(/target_path IS NOT NULL/);
    expect(sql).toMatch(/role = 'tool_use'/);
  });

  it('binds an explicit allowlist of writing tools', () => {
    const { sql, binds } = buildTouchedQuery(1);
    // Bound, not interpolated: the list is data, never string-concatenated SQL.
    expect(sql).toMatch(/tool_name IN \(\$2, \$3, \$4, \$5\)/);
    expect(binds).toEqual([1, 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
  });

  it('does not treat reading tools as touches', () => {
    // `target_path` is set for Read/Grep/Glob too. A file read forty times
    // while hunting a bug must not outrank the file that was changed.
    for (const tool of ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch']) {
      expect(WRITING_TOOLS as readonly string[]).not.toContain(tool);
    }
  });
});

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

describe('toWorktreeRelative', () => {
  it('strips the worktree prefix from an absolute transcript path', () => {
    expect(toWorktreeRelative(WT, `${WT}/src/upload.ts`)).toBe('src/upload.ts');
  });

  it('leaves an already-relative git path alone', () => {
    expect(toWorktreeRelative(WT, 'src/upload.ts')).toBe('src/upload.ts');
  });

  it('collapses ./ and duplicate slashes so the two sides can meet', () => {
    expect(toWorktreeRelative(WT, './src/upload.ts')).toBe('src/upload.ts');
    expect(toWorktreeRelative(WT, `${WT}//src//upload.ts`)).toBe('src/upload.ts');
    expect(toWorktreeRelative(`${WT}/`, `${WT}/src/upload.ts`)).toBe('src/upload.ts');
  });

  it('resolves .. inside the path', () => {
    expect(toWorktreeRelative(WT, `${WT}/src/lib/../upload.ts`)).toBe('src/upload.ts');
    expect(toWorktreeRelative(WT, 'src/lib/../upload.ts')).toBe('src/upload.ts');
  });

  it('does not mistake a sibling worktree for a prefix match', () => {
    // `/…/fix-upload-2` starts with `/…/fix-upload`. Without the separator
    // check this returns `2/src/a.ts`, which is a file that does not exist.
    const other = `${WT}-2/src/a.ts`;
    expect(toWorktreeRelative(WT, other)).toBe(other);
  });

  it('keeps a path outside the worktree absolute rather than dropping it', () => {
    // Not part of the change set, but the transcript says it was written to;
    // a row that admits it is elsewhere beats a row that silently vanishes.
    expect(toWorktreeRelative(WT, '/etc/hosts')).toBe('/etc/hosts');
    expect(toWorktreeRelative(WT, `${WT}/../other/x.ts`)).toBe('/Users/me/agents/albedo/other/x.ts');
  });

  it('returns empty for the worktree root itself', () => {
    expect(toWorktreeRelative(WT, WT)).toBe('');
    expect(toWorktreeRelative(WT, `${WT}/`)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

describe('mergeTouched', () => {
  it('joins the two sides on the normalised path, not the raw one', () => {
    // THE bug this module is most likely to have: the transcript holds
    // absolute paths, porcelain is always relative, and an unnormalised join
    // produces two rows for one file.
    const files = mergeTouched({
      worktreePath: WT,
      transcript: [{ path: `${WT}/src/upload.ts`, editCount: 3, lastTouchedAt: 1_000 }],
      git: [entry(' ', 'M', 'src/upload.ts')],
    });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: 'src/upload.ts',
      editCount: 3,
      lastTouchedAt: 1_000,
      source: 'both',
      gitStatus: ' M',
    });
  });

  it('sums edit counts across spellings of the same file', () => {
    const files = mergeTouched({
      worktreePath: WT,
      transcript: [
        { path: `${WT}/src/upload.ts`, editCount: 2, lastTouchedAt: 1_000 },
        { path: 'src/upload.ts', editCount: 1, lastTouchedAt: 3_000 },
        { path: `${WT}/./src/lib/../upload.ts`, editCount: 4, lastTouchedAt: 2_000 },
      ],
      git: [],
    });
    expect(files).toHaveLength(1);
    expect(files[0]?.editCount).toBe(7);
    expect(files[0]?.lastTouchedAt).toBe(3_000);
  });

  it('includes a file git reports that the transcript never mentioned', () => {
    // The agent ran `sed -i` in Bash. Without this row the view lies about
    // exactly the change a human is least likely to expect.
    const files = mergeTouched({
      worktreePath: WT,
      transcript: [{ path: `${WT}/src/upload.ts`, editCount: 1, lastTouchedAt: 5_000 }],
      git: [entry('?', '?', 'scripts/generated.sql'), entry(' ', 'M', 'src/upload.ts')],
    });
    expect(files.map((f) => f.path)).toEqual(['scripts/generated.sql', 'src/upload.ts']);
    expect(files[0]).toMatchObject({
      source: 'git',
      editCount: 0,
      lastTouchedAt: null,
      gitStatus: '??',
    });
  });

  it('keeps a transcript-only file (already committed, or reverted)', () => {
    const files = mergeTouched({
      worktreePath: WT,
      transcript: [{ path: `${WT}/src/done.ts`, editCount: 2, lastTouchedAt: 9 }],
      git: [],
    });
    expect(files[0]).toMatchObject({ source: 'transcript', gitStatus: null, editCount: 2 });
  });

  it('folds a renamed file onto its destination path', () => {
    // Porcelain reports the destination plus the source; the transcript only
    // knows the old name. Two rows for one file otherwise.
    const files = mergeTouched({
      worktreePath: WT,
      transcript: [{ path: `${WT}/src/old.ts`, editCount: 2, lastTouchedAt: 4_000 }],
      git: [entry('R', ' ', 'src/new.ts', 'src/old.ts')],
    });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: 'src/new.ts',
      editCount: 2,
      source: 'both',
      gitStatus: 'R ',
    });
  });

  it('marks hand-edited files using the worktree-relative path', () => {
    const seen: string[] = [];
    const files = mergeTouched({
      worktreePath: WT,
      transcript: [{ path: `${WT}/src/upload.ts`, editCount: 1, lastTouchedAt: 1 }],
      git: [entry(' ', 'M', 'src/by-hand.ts')],
      handEdited: (p) => {
        seen.push(p);
        return p === 'src/by-hand.ts';
      },
    });
    expect(seen.every((p) => !p.startsWith('/'))).toBe(true);
    expect(files.find((f) => f.path === 'src/by-hand.ts')?.handEdited).toBe(true);
    expect(files.find((f) => f.path === 'src/upload.ts')?.handEdited).toBe(false);
  });

  it('ignores the worktree root and empty paths', () => {
    const files = mergeTouched({
      worktreePath: WT,
      transcript: [
        { path: WT, editCount: 1, lastTouchedAt: 1 },
        { path: '   ', editCount: 1, lastTouchedAt: 1 },
      ],
      git: [],
    });
    expect(files).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe('compareTouched', () => {
  const file = (over: Partial<TouchedFile>): TouchedFile => ({
    path: 'x.ts',
    editCount: 1,
    lastTouchedAt: 1_000,
    source: 'transcript',
    gitStatus: null,
    handEdited: false,
    ...over,
  });

  it('lifts git-only rows to the top instead of burying them on a null date', () => {
    const rows = [
      file({ path: 'a.ts', lastTouchedAt: 3_000 }),
      file({ path: 'gen.sql', source: 'git', lastTouchedAt: null, editCount: 0 }),
      file({ path: 'b.ts', lastTouchedAt: 5_000 }),
    ].sort(compareTouched);
    expect(rows.map((r) => r.path)).toEqual(['gen.sql', 'b.ts', 'a.ts']);
  });

  it('orders the rest most recently touched first', () => {
    const rows = [
      file({ path: 'a.ts', lastTouchedAt: 1_000 }),
      file({ path: 'b.ts', lastTouchedAt: 9_000, source: 'both' }),
      file({ path: 'c.ts', lastTouchedAt: 4_000 }),
    ].sort(compareTouched);
    expect(rows.map((r) => r.path)).toEqual(['b.ts', 'c.ts', 'a.ts']);
  });

  it('breaks ties on edit count then path, so the order is stable', () => {
    const rows = [
      file({ path: 'b.ts', editCount: 1 }),
      file({ path: 'a.ts', editCount: 1 }),
      file({ path: 'z.ts', editCount: 9 }),
    ].sort(compareTouched);
    expect(rows.map((r) => r.path)).toEqual(['z.ts', 'a.ts', 'b.ts']);
  });
});

// ---------------------------------------------------------------------------
// touchedFiles — the real query and the real git parsing, stubbed transports
// ---------------------------------------------------------------------------

const sqlState = vi.hoisted(() => ({
  calls: [] as { sql: string; binds: unknown[] }[],
  messageRows: [] as Record<string, unknown>[],
  taskRows: [] as Record<string, unknown>[],
}));

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: {
    load: async () => ({
      select: async (sql: string, binds: unknown[]) => {
        sqlState.calls.push({ sql, binds });
        return sql.includes('FROM tasks') ? sqlState.taskRows : sqlState.messageRows;
      },
      execute: async () => ({ rowsAffected: 0 }),
    }),
  },
}));

function taskRow(): Record<string, unknown> {
  return {
    id: 4,
    title: 'fix upload',
    repo_path: '/Users/me/www/albedo',
    base_branch: 'main',
    branch: 'fix-upload',
    worktree_path: WT,
    session_id: 'sess-b',
    status: 'running',
    created_at: 1,
    last_activity_at: 2,
  };
}

describe('touchedFiles', () => {
  beforeEach(() => {
    resetDb();
    sqlState.calls = [];
    sqlState.taskRows = [taskRow()];
    sqlState.messageRows = [];
  });

  it('merges the real SQL result with real porcelain output', async () => {
    sqlState.messageRows = [
      { path: `${WT}/src/upload.ts`, edit_count: 3, last_touched_at: 1_700 },
      { path: `${WT}/src/old.ts`, edit_count: 1, last_touched_at: 900 },
    ];
    setGitRunner(async (args) => {
      expect(args).toContain('--untracked-files=all'); // untracked files count
      return {
        code: 0,
        stdout: ' M src/upload.ts\0?? scripts/generated.sql\0',
        stderr: '',
      };
    });

    const files = await touchedFiles(4);

    expect(files.map((f) => [f.path, f.source, f.editCount, f.gitStatus])).toEqual([
      ['scripts/generated.sql', 'git', 0, '??'],
      ['src/upload.ts', 'both', 3, ' M'],
      ['src/old.ts', 'transcript', 1, null],
    ]);
    const messageCall = sqlState.calls.find((c) => c.sql.includes('FROM messages'));
    expect(messageCall?.binds).toEqual([4, 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
  });

  it('still returns transcript rows when git cannot be consulted', async () => {
    // The worktree may have been removed out from under us. Half the view is
    // better than an error page — but the caller is told which half is missing.
    sqlState.messageRows = [{ path: `${WT}/src/upload.ts`, edit_count: 1, last_touched_at: 5 }];
    setGitRunner(async () => ({
      code: 128,
      stdout: '',
      stderr: "fatal: not a git repository: '/gone'",
    }));

    const res = await touchedFilesDetailed(4);
    expect(res.files.map((f) => f.path)).toEqual(['src/upload.ts']);
    expect(res.gitError).toMatch(/not a git repository/);
  });

  it('marks files the user saved by hand, keyed on the relative path', async () => {
    // The editor records `resolveInWorktree().relative`; this view must look
    // the file up under the SAME spelling, not the transcript's absolute one.
    __resetHandEdited();
    markHandEdited(4, 'src/upload.ts');
    sqlState.messageRows = [{ path: `${WT}/src/upload.ts`, edit_count: 2, last_touched_at: 10 }];
    setGitRunner(async () => ({ code: 0, stdout: '', stderr: '' }));

    const files = await touchedFiles(4);
    expect(files[0]).toMatchObject({ path: 'src/upload.ts', handEdited: true });
    __resetHandEdited();
  });

  it('throws a named error when the task does not exist', async () => {
    sqlState.taskRows = [];
    await expect(touchedFiles(99)).rejects.toThrow(/no task with id 99/);
  });
});
