/**
 * Projects: mapping, uniqueness, and the backfill.
 *
 * The backfill tests carry the weight here. Deriving a folder basename is the
 * one piece of this feature that looked trivial and is not: the pure-SQLite
 * version returns an EMPTY name for any path with a trailing slash, and an
 * empty name satisfies NOT NULL, so nothing complains until two unrelated
 * projects are found sharing the worktree root `~/agents/`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  projects: [] as Record<string, unknown>[],
  tasks: [] as Record<string, unknown>[],
  nextId: { projects: 1, tasks: 1 },
  calls: 0,
  /** Makes the next repo_path lookup miss, to exercise the UNIQUE race path. */
  hideRepoPathOnce: false,
}));

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: {
    load: async () => ({
      select: async (sql: string, binds: unknown[]) => runSelect(sql, binds ?? []),
      execute: async (sql: string, binds: unknown[]) => runExecute(sql, binds ?? []),
    }),
  },
}));

import {
  archiveProject,
  backfillProjectsFromTasks,
  createProject,
  deriveProjectDefaults,
  findProjectByRepo,
  getProject,
  listProjects,
  normalizeRepoPath,
  onProjectsChanged,
  ProjectExistsError,
  projectNameFor,
  updateProject,
} from './projects';
import { createTask, getTask, listTasks, resetDb, updateTask } from './index';

// ---------------------------------------------------------------------------
// In-memory engine. Understands the statement shapes this module emits, and
// enforces the UNIQUE index on projects.repo_path the way SQLite would.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function table(name: string): Row[] {
  if (name === 'projects') return store.projects;
  if (name === 'tasks') return store.tasks;
  throw new Error(`fake engine: unknown table ${name}`);
}

function matches(row: Row, whereSql: string | undefined, binds: unknown[]): boolean {
  if (!whereSql) return true;
  return whereSql.split(' AND ').every((raw) => {
    const clause = raw.trim();
    let m = /^(\w+) IS NOT NULL$/.exec(clause);
    if (m) return row[m[1] as string] !== null && row[m[1] as string] !== undefined;
    m = /^(\w+) IS NULL$/.exec(clause);
    if (m) return row[m[1] as string] === null || row[m[1] as string] === undefined;
    m = /^TRIM\((\w+)\) != ''$/.exec(clause);
    if (m) return String(row[m[1] as string] ?? '').trim() !== '';
    m = /^(\w+) (=|!=) \$(\d+)$/.exec(clause);
    if (m) {
      const v = row[m[1] as string];
      const b = binds[Number(m[3]) - 1];
      return m[2] === '=' ? v === b : v !== b;
    }
    m = /^(\w+) (=|!=) '(.*)'$/.exec(clause);
    if (m) {
      const v = row[m[1] as string];
      return m[2] === '=' ? v === m[3] : v !== m[3];
    }
    throw new Error(`fake engine: cannot parse clause "${clause}"`);
  });
}

function runSelect(rawSql: string, binds: unknown[]): Row[] {
  store.calls += 1;
  const sql = rawSql.replace(/\s+/g, ' ').trim();
  const m = /^SELECT (DISTINCT )?(.+?) FROM (\w+)(?: WHERE (.+?))?(?: ORDER BY (.+?))?$/.exec(sql);
  if (!m) throw new Error(`fake engine: cannot parse select "${sql}"`);
  const [, distinct, colsSql, tableName, whereSql, orderSql] = m;

  const cols = (colsSql as string).split(',').map((c) => c.trim());
  if (store.hideRepoPathOnce && (whereSql ?? '').includes('repo_path = $')) {
    store.hideRepoPathOnce = false;
    return [];
  }
  let rows = table(tableName as string).filter((r) => matches(r, whereSql, binds));

  if (orderSql) {
    // split on commas that are not inside parentheses, so COALESCE(a, b) holds
    const terms = (orderSql as string).split(/,(?![^(]*\))/);
    const keys = terms.map((k) => {
      const nocase = k.includes('COLLATE NOCASE');
      const desc = /\bDESC\b/.test(k);
      const coalesce = /COALESCE\((\w+), *(\w+)\)/.exec(k);
      const columns = coalesce
        ? [coalesce[1] as string, coalesce[2] as string]
        : [(k.trim().split(/\s+/)[0] as string)];
      return { columns, nocase, sign: desc ? -1 : 1 };
    });
    const pick = (r: Row, columns: string[]) => {
      for (const c of columns) {
        const v = r[c];
        if (v !== null && v !== undefined) return v as string | number;
      }
      return null as unknown as string | number;
    };
    rows = [...rows].sort((a, b) => {
      for (const { columns, nocase, sign } of keys) {
        let av = pick(a, columns);
        let bv = pick(b, columns);
        if (nocase && typeof av === 'string' && typeof bv === 'string') {
          av = av.toLowerCase();
          bv = bv.toLowerCase();
        }
        if (av < bv) return -1 * sign;
        if (av > bv) return 1 * sign;
      }
      return 0;
    });
  }

  let out = rows.map((r) => {
    const projected: Row = {};
    for (const c of cols) projected[c] = r[c] ?? null;
    return projected;
  });
  if (distinct) {
    const seen = new Set<string>();
    out = out.filter((r) => {
      const k = JSON.stringify(r);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  return out;
}

function runExecute(rawSql: string, binds: unknown[]): { rowsAffected: number; lastInsertId?: number } {
  store.calls += 1;
  const sql = rawSql.replace(/\s+/g, ' ').trim();

  let m = /^INSERT INTO (\w+) \((.+?)\) VALUES \((.+?)\)$/.exec(sql);
  if (m) {
    const tableName = m[1] as string;
    const cols = (m[2] as string).split(',').map((c) => c.trim());
    const slots = (m[3] as string).split(',').map((v) => v.trim());
    const row: Row = {};
    cols.forEach((c, i) => {
      const slot = slots[i] as string;
      const bind = /^\$(\d+)$/.exec(slot);
      row[c] = bind ? binds[Number(bind[1]) - 1] : slot === 'NULL' ? null : slot.replace(/'/g, '');
    });
    // The UNIQUE index is the real guarantee, so the fake enforces it.
    if (tableName === 'projects' && store.projects.some((p) => p['repo_path'] === row['repo_path'])) {
      throw new Error('UNIQUE constraint failed: projects.repo_path');
    }
    const id = store.nextId[tableName as 'projects' | 'tasks']++;
    row['id'] = id;
    table(tableName).push(row);
    return { rowsAffected: 1, lastInsertId: id };
  }

  m = /^UPDATE (\w+) SET (.+?) WHERE (.+?)$/.exec(sql);
  if (m) {
    const tableName = m[1] as string;
    const assignments = (m[2] as string).split(',').map((a) => {
      const am = /^(\w+) = \$(\d+)$/.exec(a.trim());
      if (!am) throw new Error(`fake engine: cannot parse assignment "${a}"`);
      return { column: am[1] as string, slot: Number(am[2]) - 1 };
    });
    let affected = 0;
    for (const row of table(tableName)) {
      if (!matches(row, m[3] as string, binds)) continue;
      for (const a of assignments) row[a.column] = binds[a.slot];
      affected += 1;
    }
    return { rowsAffected: affected };
  }

  throw new Error(`fake engine: cannot parse execute "${sql}"`);
}

// ---------------------------------------------------------------------------

const NEW = {
  name: 'albedo',
  repoPath: '/Users/x/www/albedo',
  worktreeRoot: '/Users/x/www/worktrees/albedo',
  defaultBaseBranch: null,
};

beforeEach(() => {
  resetDb();
  store.projects = [];
  store.tasks = [];
  store.nextId = { projects: 1, tasks: 1 };
  store.calls = 0;
  store.hideRepoPathOnce = false;
});

describe('path derivation — where the pure-SQLite version broke', () => {
  it('takes the basename of a plain absolute path', () => {
    expect(projectNameFor('/Users/x/www/albedo')).toBe('albedo');
    expect(projectNameFor('/a/b')).toBe('b');
    expect(projectNameFor('/albedo')).toBe('albedo');
  });

  it('takes the basename of a path WITH a trailing slash', () => {
    // The rtrim/replace trick returns '' here, which passes NOT NULL and
    // silently collapses every such project onto the root `~/agents/`.
    expect(projectNameFor('/Users/x/www/albedo/')).toBe('albedo');
    expect(projectNameFor('/Users/x/www/worktrees//')).toBe('worktrees');
    expect(deriveProjectDefaults('/Users/x/www/albedo/')).toEqual({
      name: 'albedo',
      repoPath: '/Users/x/www/albedo',
      worktreeRoot: '~/agents/albedo',
    });
  });

  it('normalises trailing slashes so one repo cannot become two projects', () => {
    expect(normalizeRepoPath('/a/b/')).toBe('/a/b');
    expect(normalizeRepoPath('/a/b//')).toBe('/a/b');
    expect(normalizeRepoPath('  /a/b/  ')).toBe('/a/b');
    expect(normalizeRepoPath('/a/b')).toBe('/a/b');
  });

  it('survives degenerate paths without producing an empty name', () => {
    expect(normalizeRepoPath('/')).toBe('/');
    expect(projectNameFor('/')).toBe('repo');
    expect(projectNameFor('')).toBe('repo');
    expect(projectNameFor('albedo')).toBe('albedo'); // relative, no slash
    expect(projectNameFor('~/www/albedo')).toBe('albedo');
  });

  it('defaults the worktree root to the pre-projects layout', () => {
    // ~/agents/<repo>, so `<root>/<slug>` reproduces ~/agents/<repo>/<slug>
    // and worktrees created before projects existed stay reachable.
    expect(deriveProjectDefaults('/Users/x/www/albedo').worktreeRoot).toBe('~/agents/albedo');
  });
});

describe('create / list / update / archive round trip', () => {
  it('creates and reads back every field', async () => {
    const p = await createProject(NEW);
    expect(p.id).toBeGreaterThan(0);
    expect(p.name).toBe('albedo');
    expect(p.repoPath).toBe('/Users/x/www/albedo');
    expect(p.worktreeRoot).toBe('/Users/x/www/worktrees/albedo');
    expect(p.defaultBaseBranch).toBeNull();
    expect(p.archivedAt).toBeNull();
    expect(await getProject(p.id)).toEqual(p);
  });

  it('normalises the repo path on the way in', async () => {
    const p = await createProject({ ...NEW, repoPath: '/Users/x/www/albedo/' });
    expect(p.repoPath).toBe('/Users/x/www/albedo');
    expect((await findProjectByRepo('/Users/x/www/albedo'))?.id).toBe(p.id);
    expect((await findProjectByRepo('/Users/x/www/albedo/'))?.id).toBe(p.id);
  });

  it('falls back to the basename when no name is given', async () => {
    const p = await createProject({ ...NEW, name: '   ' });
    expect(p.name).toBe('albedo');
  });

  it('updates fields and maps them back', async () => {
    const p = await createProject(NEW);
    await updateProject(p.id, { name: 'Albedo App', worktreeRoot: '/tmp/wt', defaultBaseBranch: 'main' });
    const after = await getProject(p.id);
    expect(after?.name).toBe('Albedo App');
    expect(after?.worktreeRoot).toBe('/tmp/wt');
    expect(after?.defaultBaseBranch).toBe('main');
    expect(after?.repoPath).toBe(p.repoPath); // untouched
  });

  it('ignores an empty patch and unknown fields', async () => {
    const p = await createProject(NEW);
    await updateProject(p.id, {});
    await updateProject(p.id, { bogus: 1 } as unknown as Partial<typeof NEW>);
    expect(await getProject(p.id)).toEqual(p);
  });

  it('archives, and hides archived projects by default', async () => {
    const a = await createProject(NEW);
    const b = await createProject({ ...NEW, name: 'other', repoPath: '/Users/x/www/other' });

    expect((await listProjects()).map((p) => p.id)).toEqual([a.id, b.id]);
    await archiveProject(a.id);

    expect((await listProjects()).map((p) => p.id)).toEqual([b.id]);
    expect((await listProjects({ includeArchived: true })).map((p) => p.id)).toEqual([a.id, b.id]);
    expect((await getProject(a.id))?.archivedAt).toBeGreaterThan(0);
  });

  it('sorts by name case-insensitively', async () => {
    await createProject({ ...NEW, name: 'zebra', repoPath: '/r/z' });
    await createProject({ ...NEW, name: 'Apple', repoPath: '/r/a' });
    expect((await listProjects()).map((p) => p.name)).toEqual(['Apple', 'zebra']);
  });

  it('returns null for a project that does not exist', async () => {
    expect(await getProject(999)).toBeNull();
    expect(await findProjectByRepo('/nope')).toBeNull();
  });
});

describe('repo_path uniqueness', () => {
  it('REJECTS a second project for the same repo, naming the existing one', async () => {
    const first = await createProject(NEW);
    // A silent "return the existing row" would attach the next task to
    // someone else's worktree root, discovered only by watching a worktree
    // appear in the wrong place.
    await expect(createProject({ ...NEW, name: 'dupe' })).rejects.toBeInstanceOf(ProjectExistsError);

    let caught: unknown;
    try {
      await createProject({ ...NEW, name: 'dupe' });
    } catch (e) {
      caught = e;
    }
    const err = caught as ProjectExistsError;
    expect(err.existing.id).toBe(first.id);
    expect(err.message).toContain('albedo');
    expect(err.message).toContain('/Users/x/www/albedo');
    expect(err.message).toContain('/Users/x/www/worktrees/albedo');
    expect(store.projects).toHaveLength(1); // nothing written
  });

  it('rejects a duplicate that differs only by a trailing slash', async () => {
    await createProject(NEW);
    await expect(createProject({ ...NEW, repoPath: '/Users/x/www/albedo/' })).rejects.toBeInstanceOf(
      ProjectExistsError,
    );
  });

  it('translates a raced UNIQUE violation into the same error', async () => {
    // Make the pre-flight lookup miss exactly once, so the INSERT is what
    // discovers the clash -- the path taken when another writer wins the race.
    await createProject({ ...NEW, name: 'racer', repoPath: '/r/raced' });
    store.hideRepoPathOnce = true;

    let caught: unknown;
    try {
      await createProject({ ...NEW, repoPath: '/r/raced' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProjectExistsError);
    expect((caught as ProjectExistsError).existing.name).toBe('racer');
    expect(store.projects).toHaveLength(1);
  });

  it('refuses to move a project onto another project’s repo path', async () => {
    const a = await createProject(NEW);
    const b = await createProject({ ...NEW, name: 'other', repoPath: '/Users/x/www/other' });
    await expect(updateProject(b.id, { repoPath: a.repoPath })).rejects.toBeInstanceOf(
      ProjectExistsError,
    );
    // moving onto its own path is fine
    await expect(updateProject(b.id, { repoPath: '/Users/x/www/other/' })).resolves.toBeUndefined();
  });

  it('requires a repo path', async () => {
    await expect(createProject({ ...NEW, repoPath: '   ' })).rejects.toThrow(/repoPath is required/);
  });
});

describe('onProjectsChanged', () => {
  it('fires after each committed write and unsubscribes cleanly', async () => {
    const cb = vi.fn();
    const off = onProjectsChanged(cb);

    const p = await createProject(NEW);
    expect(cb).toHaveBeenCalledTimes(1);
    await updateProject(p.id, { name: 'x' });
    expect(cb).toHaveBeenCalledTimes(2);
    await archiveProject(p.id);
    expect(cb).toHaveBeenCalledTimes(3);

    off();
    await createProject({ ...NEW, repoPath: '/r/another' });
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it('does not let one broken subscriber stop the others', async () => {
    const boom = vi.fn(() => {
      throw new Error('subscriber exploded');
    });
    const ok = vi.fn();
    const offBoom = onProjectsChanged(boom);
    const offOk = onProjectsChanged(ok);
    await expect(createProject(NEW)).resolves.toBeDefined();
    expect(ok).toHaveBeenCalledTimes(1);
    offBoom();
    offOk();
  });
});

describe('backfillProjectsFromTasks', () => {
  function seedTask(repoPath: string): void {
    store.tasks.push({
      id: store.nextId.tasks++,
      title: `task for ${repoPath}`,
      project_id: null,
      repo_path: repoPath,
      base_branch: 'main',
      branch: 'feat',
      worktree_path: `${repoPath}-wt`,
      session_id: null,
      status: 'idle',
      created_at: 1,
      last_activity_at: null,
    });
  }

  it('creates one project per distinct repo path and links its tasks', async () => {
    seedTask('/Users/x/www/albedo');
    seedTask('/Users/x/www/albedo');
    seedTask('/Users/x/www/upsellguru');

    expect(await backfillProjectsFromTasks()).toBe(2);
    const projects = await listProjects();
    expect(projects.map((p) => p.name).sort()).toEqual(['albedo', 'upsellguru']);

    const albedo = await findProjectByRepo('/Users/x/www/albedo');
    const linked = store.tasks.filter((t) => t['project_id'] === albedo?.id);
    expect(linked).toHaveLength(2);
    expect(store.tasks.every((t) => t['project_id'] !== null)).toBe(true);
  });

  it('collapses paths that differ only by a trailing slash onto ONE project', async () => {
    seedTask('/Users/x/www/albedo');
    seedTask('/Users/x/www/albedo/');

    expect(await backfillProjectsFromTasks()).toBe(1);
    expect(await listProjects()).toHaveLength(1);
    const p = (await listProjects())[0];
    expect(p?.name).toBe('albedo'); // not '' as the SQL version produced
    expect(p?.worktreeRoot).toBe('~/agents/albedo'); // not '~/agents/'
    expect(store.tasks.every((t) => t['project_id'] === p?.id)).toBe(true);
  });

  it('is idempotent — running it again creates nothing', async () => {
    seedTask('/Users/x/www/albedo');
    expect(await backfillProjectsFromTasks()).toBe(1);
    expect(await backfillProjectsFromTasks()).toBe(0);
    expect(await backfillProjectsFromTasks()).toBe(0);
    expect(store.projects).toHaveLength(1);
  });

  it('reuses a project the user already created for that repo', async () => {
    const existing = await createProject(NEW);
    seedTask('/Users/x/www/albedo');
    expect(await backfillProjectsFromTasks()).toBe(0);
    expect(store.tasks[0]?.['project_id']).toBe(existing.id);
    // the user's chosen worktree root is not overwritten by the default
    expect((await getProject(existing.id))?.worktreeRoot).toBe('/Users/x/www/worktrees/albedo');
  });

  it('leaves already-linked tasks alone', async () => {
    seedTask('/Users/x/www/albedo');
    store.tasks[0]!['project_id'] = 42;
    expect(await backfillProjectsFromTasks()).toBe(0);
    expect(store.tasks[0]?.['project_id']).toBe(42);
  });

  it('skips blank repo paths rather than making a junk project', async () => {
    seedTask('   ');
    seedTask('');
    expect(await backfillProjectsFromTasks()).toBe(0);
    expect(store.projects).toHaveLength(0);
  });

  it('does nothing, and issues no writes, when there is nothing to do', async () => {
    store.calls = 0;
    expect(await backfillProjectsFromTasks()).toBe(0);
    expect(store.calls).toBe(1); // the single DISTINCT probe
  });
});

describe('projectId survives the Task mapping in both directions', () => {
  it('persists on create and reads back', async () => {
    const project = await createProject(NEW);
    const task = await createTask({
      title: 'add retry',
      projectId: project.id,
      repoPath: project.repoPath,
      baseBranch: 'main',
      branch: 'feat/retry',
      worktreePath: '/Users/x/www/worktrees/albedo/retry',
    });
    expect(task.projectId).toBe(project.id);
    expect(store.tasks[0]?.['project_id']).toBe(project.id);

    const read = await getTask(task.id);
    expect(read?.projectId).toBe(project.id);
    expect(read).toEqual(task);
  });

  it('round-trips through listTasks', async () => {
    const project = await createProject(NEW);
    await createTask({
      title: 't',
      projectId: project.id,
      repoPath: project.repoPath,
      baseBranch: 'main',
      branch: 'b',
      worktreePath: '/wt/b',
    });
    expect((await listTasks()).map((t) => t.projectId)).toEqual([project.id]);
  });

  it('accepts a null projectId for a task that predates projects', async () => {
    const task = await createTask({
      title: 'legacy',
      projectId: null,
      repoPath: '/Users/x/www/albedo',
      baseBranch: 'main',
      branch: 'b',
      worktreePath: '/wt/b',
    });
    expect(task.projectId).toBeNull();
    expect((await getTask(task.id))?.projectId).toBeNull();
  });

  it('is patchable through updateTask', async () => {
    const project = await createProject(NEW);
    const task = await createTask({
      title: 't',
      projectId: null,
      repoPath: project.repoPath,
      baseBranch: 'main',
      branch: 'b',
      worktreePath: '/wt/b',
    });
    await updateTask(task.id, { projectId: project.id });
    expect((await getTask(task.id))?.projectId).toBe(project.id);
  });
});
