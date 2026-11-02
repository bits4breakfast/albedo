// The demo profile, checked against the app's own code: the database it seeds
// is read by the app's DB layer, its transcripts by the adapter and status
// derivation, its waiting card goes through the real hook script, and its
// pull request through the app's gh parsing. A demo that drifts from the app
// fails here rather than in a screenshot.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => harness.db } }));

import { parseTranscript } from '../../src/capture/adapter';
import {
  derivePending,
  hookSettingsArg,
  HOOK_SCRIPT,
  parseHookLines,
  permissionDecision,
  parseStatusSnapshot,
} from '../../src/capture/hookEvents';
import { deriveStatus } from '../../src/capture/status';
import { listProjects } from '../../src/db/projects';
import { listTasks, resetDb } from '../../src/db/index';
import { createTestDb, toPositional } from '../../src/db/testkit';
import { fetchPrChecks } from '../../src/gh/gh';
import { fetchPrStatus, setGhRunner } from '../../src/gh/gh';
import type { Message } from '../../src/types';

import { databasePath, demoEnv, setup } from './demo.mjs';
import { migrate, migrationsFromLibRs } from './seed.mjs';

const ROOT = resolve(__dirname, '../..');
const LIB_RS = join(ROOT, 'src-tauri/src/lib.rs');
const FAKE_CLAUDE = join(__dirname, 'fake-claude.mjs');
const FAKE_GH = join(__dirname, 'fake-gh.mjs');

interface DemoTask {
  key: string;
  title: string;
  branch: string;
  worktree: string;
  sessionId: string;
  history: Record<string, unknown>[];
  live: Record<string, unknown>[] | null;
}

let home: string;
let now: number;
let scenario: { projects: { name: string; repo: string }[]; tasks: DemoTask[] };
const task = (key: string) => scenario.tasks.find((t) => t.key === key)!;

function transcriptOf(t: DemoTask): string {
  const dir = join(home, '.claude/projects', t.worktree.replace(/[^A-Za-z0-9]/g, '-'));
  const path = join(dir, `${t.sessionId}.jsonl`);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function messagesOf(text: string): Message[] {
  return parseTranscript(text).map((m, i) => ({ ...m, id: i + 1, taskId: 1 }) as unknown as Message);
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'albedo-demo-test-'));
  now = Date.now();
  scenario = setup(home, now);
}, 60_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('the database', () => {
  it('applies the migrations lib.rs registers, recorded as sqlx records them', () => {
    const migrations = migrationsFromLibRs(LIB_RS);
    const files = readdirSync(join(ROOT, 'src/db/migrations')).filter((f) => f.endsWith('.sql'));
    expect(migrations).toHaveLength(files.length + 1);

    const db = new BetterSqlite3(databasePath(home));
    const rows = db.prepare('SELECT version, checksum, success FROM _sqlx_migrations ORDER BY version').all() as {
      version: number;
      checksum: Buffer;
      success: number;
    }[];
    db.close();
    expect(rows.map((r) => r.version)).toEqual(migrations.map((m: { version: number }) => m.version));
    const schema = readFileSync(join(ROOT, 'src/db/schema.sql'), 'utf8');
    expect(rows[0]!.checksum.toString('hex')).toBe(createHash('sha384').update(schema).digest('hex'));
    expect(rows.every((r) => r.success === 1)).toBe(true);
  });

  it('ends with the same schema as the shipped migrations', () => {
    const viaLibRs = new BetterSqlite3(':memory:');
    migrate(viaLibRs, migrationsFromLibRs(LIB_RS));
    const reference = createTestDb();
    const shape = (db: BetterSqlite3.Database) =>
      db
        .prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name != '_sqlx_migrations' ORDER BY name")
        .all();
    expect(shape(viaLibRs)).toEqual(shape(reference.raw));
  });

  it('holds projects and tasks the app reads back as it would its own', async () => {
    const file = new BetterSqlite3(databasePath(home));
    harness.db = {
      async select(q: string, b: unknown[] = []) {
        const p = toPositional(q, b);
        return file.prepare(p.sql).all(...(p.binds as never[]));
      },
      async execute(q: string, b: unknown[] = []) {
        const p = toPositional(q, b);
        const info = file.prepare(p.sql).run(...(p.binds as never[]));
        return { rowsAffected: info.changes, lastInsertId: Number(info.lastInsertRowid) };
      },
      async close() {
        return true;
      },
    };
    resetDb();
    const projects = await listProjects();
    const tasks = await listTasks();
    file.close();

    expect(projects.map((p) => p.name).sort()).toEqual(['blog', 'recipe-app']);
    expect(tasks).toHaveLength(6);
    const recipeApp = projects.find((p) => p.name === 'recipe-app')!.id;
    expect(tasks.filter((t) => t.projectId === recipeApp)).toHaveLength(5);
    const byTitle = new Map(tasks.map((t) => [t.title, t]));
    expect(byTitle.get('Show cooking time on recipe cards')!.status).toBe('done');
    expect(byTitle.get('Round amounts to kitchen fractions')!.seenAt).toBeNull();
    for (const t of tasks) {
      expect(t.kind).toBe('work');
      expect(t.ownsWorktree).toBe(true);
      expect(t.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

describe('the repositories', () => {
  const git = (cwd: string, ...args: string[]) =>
    spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, HOME: home } }).stdout.trim();

  it('has the waiting task two commits ahead, with its test change not committed', () => {
    const wt = task('dark-mode').worktree;
    expect(git(wt, 'log', '--format=%s', 'main..HEAD').split('\n')).toEqual([
      'Add a Theme setting: system, light or dark',
      'Move colours into CSS variables',
    ]);
    expect(git(wt, 'status', '--porcelain')).toBe('M src/settings/SettingsPage.test.tsx');
  });

  it('pushed the branch with a pull request, so it has nothing to push', () => {
    const wt = task('fractions').worktree;
    expect(git(wt, 'rev-list', '--count', '@{upstream}..HEAD')).toBe('0');
  });
});

describe('the transcripts', () => {
  it('quote the real commit hashes', () => {
    const wt = task('fractions').worktree;
    const sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: wt, encoding: 'utf8' }).stdout.trim();
    expect(transcriptOf(task('fractions'))).toContain(`[kitchen-fractions ${sha}]`);
  });

  it('parse into rows for every line, with finished turns reading idle', () => {
    for (const key of ['fractions', 'cooking-time', 'rss', 'dark-mode']) {
      const text = transcriptOf(task(key));
      const rows = messagesOf(text);
      expect(rows.length).toBeGreaterThan(3);
      expect(deriveStatus(rows, now)).toBe('idle');
    }
  });

  it('end the blog task on a question', () => {
    const rows = messagesOf(transcriptOf(task('rss')));
    const last = rows.filter((r) => r.role === 'assistant').at(-1)!;
    expect(last.body).toMatch(/\?/);
  });
});

describe('the stand-in claude', () => {
  const script = () => join(home, '.albedo', 'hook.sh');

  function run(t: DemoTask, taskId: number) {
    mkdirSync(join(home, '.albedo'), { recursive: true });
    writeFileSync(script(), HOOK_SCRIPT);
    const child = spawn(
      process.execPath,
      [FAKE_CLAUDE, '--settings', hookSettingsArg(taskId, script()), '--resume', t.sessionId],
      { cwd: t.worktree, env: demoEnv(home), stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    return { child, out: () => out };
  }

  const events = (taskId: number) => {
    const path = join(home, '.albedo/events', `task-${taskId}.jsonl`);
    return existsSync(path) ? parseHookLines(readFileSync(path, 'utf8')) : [];
  };

  async function until<T>(f: () => T | null | undefined | false, ms = 10_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = f();
      if (v) return v;
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it('plays a working session that reads Running, and says what it is', async () => {
    const t = task('import-link');
    const { child, out } = run(t, 2);
    try {
      await until(() => transcriptOf(t).includes('importFromLink'));
      const rows = messagesOf(transcriptOf(t));
      expect(deriveStatus(rows, Date.now(), { unansweredToolUseBlocks: false })).toBe('running');
      await until(() => out().includes('scripted stand-in'));
      const status = await until(() => {
        const p = join(home, '.albedo/events/status-2.json');
        return existsSync(p) && parseStatusSnapshot(readFileSync(p, 'utf8'));
      });
      expect(status).toMatchObject({ sessionId: t.sessionId, fiveHour: { usedPct: 38 }, sevenDay: { usedPct: 21 }, contextSize: 200_000 });
    } finally {
      child.kill('SIGTERM');
    }
  });

  it('asks on the card, and Allow from the card finishes the turn', async () => {
    const t = task('dark-mode');
    const { child } = run(t, 1);
    try {
      const prompt = await until(() => {
        const p = derivePending(events(1));
        return p?.kind === 'permission' && p.requestId ? p : null;
      });
      expect(prompt).toMatchObject({ kind: 'permission', summary: 'Bash: npm test -- src/settings' });
      if (prompt.kind !== 'permission') throw new Error('unreachable');
      expect(prompt.alwaysAllow?.[0]?.label).toBe('Bash(npm test:*)');

      // While it waits, the transcript holds the whole turn and the call.
      const waiting = messagesOf(transcriptOf(t));
      expect(waiting.some((r) => r.body?.includes('Move colours into CSS variables'))).toBe(true);

      // Answer exactly as the card does.
      const decision = permissionDecision(prompt, 'allow');
      writeFileSync(join(home, '.albedo/events', `answer-1-${prompt.requestId}.json`), JSON.stringify(decision));
      await until(() => transcriptOf(t).includes('Dark mode is in'));
      expect(deriveStatus(messagesOf(transcriptOf(t)), Date.now(), { unansweredToolUseBlocks: false })).toBe('idle');
      await until(() => derivePending(events(1)) === null);
    } finally {
      child.kill('SIGTERM');
    }
  }, 20_000);
});

describe('the stand-in gh', () => {
  afterAll(() => {
    setGhRunner(async () => {
      throw new Error('no gh in tests');
    });
  });

  it('answers the PR badge and the checks with an open PR, all green', async () => {
    setGhRunner(async (_program, args, cwd) => {
      const r = spawnSync(process.execPath, [FAKE_GH, ...args], { cwd, env: demoEnv(home), encoding: 'utf8' });
      return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    });
    const t = task('fractions');
    const where = { branch: t.branch, baseBranch: 'main', worktreePath: t.worktree, repoPath: scenario.projects[0]!.repo };
    const pr = await fetchPrStatus(where);
    expect(pr).toMatchObject({ number: 14, state: 'open', headRefName: 'kitchen-fractions' });
    expect(pr!.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(pr!.lines.length).toBe(3);
    expect(pr!.lines.every((l) => l.bucket === 'pass')).toBe(true);
    const checks = await fetchPrChecks(14, where);
    expect(checks?.map((c) => c.state)).toEqual(['pass', 'pass', 'pass']);

    expect(await fetchPrStatus({ ...where, branch: 'add-dark-mode', worktreePath: task('dark-mode').worktree })).toBeNull();
  });
});
