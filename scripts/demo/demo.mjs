#!/usr/bin/env node
// The demo profile (#193): Albedo with made-up projects, for screenshots.
//
//   npm run demo                 reset the demo and start the app in it
//   npm run demo -- --setup-only reset the demo, don't start the app
//   npm run demo -- --no-reset   start the app on the demo as it was left
//   npm run demo -- --real-claude  your own `claude` instead of the stand-in
//
// The profile is a separate home folder, /Users/Shared/albedo-demo on macOS
// and ~/.albedo-demo elsewhere (ALBEDO_DEMO_HOME overrides it). The app runs with HOME pointing there and
// its own bundle identifier, so its database, ~/.albedo, ~/.claude/projects,
// worktrees and web storage are all the demo's, and nothing of yours is read
// or written. On its PATH, stand-ins for `claude` and `gh` play back the
// made-up sessions and pull request (fake-claude.mjs, fake-gh.mjs).
//
// A reset rebuilds everything from scenario.mjs, timed from now, and keeps the
// app's own preferences (zoom, theme, layout), which live in its web storage.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildScenario } from './scenario.mjs';
import { createDatabase } from './seed.mjs';
import { commitToken } from './workspace.mjs';
import { projectDirName } from './transcript.mjs';

export const IDENTIFIER = 'com.bits4breakfast.albedo.demo';
const MARKER = 'ALBEDO-DEMO-HOME';
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

/** Where the app keeps its database under `home` (tauri-plugin-sql: app_config_dir). */
export function databasePath(home, os = platform()) {
  const dir = os === 'darwin' ? join(home, 'Library', 'Application Support', IDENTIFIER) : join(home, '.config', IDENTIFIER);
  return join(dir, 'albedo.db');
}

/**
 * On macOS the demo lives in /Users/Shared, not under your home folder: the
 * transcript and the Files panel show full paths, and a path under
 * /Users/<you> would put your account name in every screenshot.
 */
export function defaultDemoHome(os = platform(), real = homedir()) {
  return os === 'darwin' ? '/Users/Shared/albedo-demo' : join(real, '.albedo-demo');
}

function demoHome() {
  const real = homedir();
  const home = resolve(process.env.ALBEDO_DEMO_HOME || defaultDemoHome());
  if (home === real || real.startsWith(`${home}/`)) {
    throw new Error(`ALBEDO_DEMO_HOME must not be your home folder or contain it: ${home}`);
  }
  if (existsSync(home) && readdirSync(home).length > 0 && !existsSync(join(home, MARKER))) {
    throw new Error(`${home} exists and is not a demo profile (no ${MARKER} in it). Pick another ALBEDO_DEMO_HOME.`);
  }
  return home;
}

/** git as the demo's user: its own config, none of your hooks, signing or aliases. */
let gitHome = null;
function git(cwd, args, env = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: gitHome, XDG_CONFIG_HOME: join(gitHome, '.config'), GIT_CONFIG_NOSYSTEM: '1', ...env },
  }).trim();
}

function writeFiles(root, files) {
  for (const [path, text] of Object.entries(files)) {
    const abs = join(root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
}

function commitAll(cwd, message, at) {
  const date = new Date(at).toISOString();
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return git(cwd, ['rev-parse', '--short', 'HEAD']);
}

/** Remove everything a previous run made, but never the app's web storage. */
function reset(home) {
  for (const p of ['code', 'remotes', 'agents', '.claude', '.claude.json', '.albedo', '.albedo-demo']) {
    rmSync(join(home, p), { recursive: true, force: true });
  }
  rmSync(dirname(databasePath(home)), { recursive: true, force: true });
}

/**
 * The stand-ins on the demo's PATH, and the shell profiles that put them
 * first. `realClaude` leaves `claude` to whatever your PATH finds.
 */
export function writeProfile(home, { realClaude = false } = {}) {
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  const node = process.execPath;
  rmSync(join(bin, 'claude'), { force: true });
  for (const [name, script] of [
    ...(realClaude ? [] : [['claude', 'fake-claude.mjs']]),
    ['gh', 'fake-gh.mjs'],
  ]) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\nexec ${JSON.stringify(node)} ${JSON.stringify(join(here, script))} "$@"\n`);
    chmodSync(path, 0o755);
  }
  // The login shell Albedo starts `claude` through reads these. They put the
  // stand-ins first, after the system profile has had its say (path_helper).
  const line = `export PATH=${JSON.stringify(`${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`)}\n`;
  for (const f of ['.zprofile', '.bash_profile', '.profile']) writeFileSync(join(home, f), line);
  writeFileSync(join(home, '.zshrc'), '');
  writeFileSync(
    join(home, '.gitconfig'),
    '[user]\n\tname = Sam Rivera\n\temail = sam@example.com\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n',
  );
}

export function setup(home, now = Date.now()) {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, MARKER), 'This folder is the Albedo demo profile, made by scripts/demo/demo.mjs. A reset deletes most of it.\n');
  reset(home);
  writeProfile(home);
  gitHome = home;
  const scenario = buildScenario({ home, now });
  const day = 86_400_000;

  for (const p of scenario.projects) {
    mkdirSync(p.repo, { recursive: true });
    git(p.repo, ['init', '-q', '-b', 'main']);
    p.commits.forEach((c) => {
      writeFiles(p.repo, c.files);
      commitAll(p.repo, c.message, now - c.daysAgo * day);
    });
    mkdirSync(dirname(p.remote), { recursive: true });
    git(home, ['init', '-q', '--bare', p.remote]);
    git(p.repo, ['remote', 'add', 'origin', p.remote]);
    git(p.repo, ['push', '-q', '-u', 'origin', 'main']);
    // The Reviewing tab's pull requests (#287): one commit each on main,
    // pushed where GitHub keeps a PR's head, so opening one checks it out.
    for (const r of scenario.reviews[p.repo] ?? []) {
      git(p.repo, ['checkout', '-q', '-b', `pr-${r.number}`, 'main']);
      writeFiles(p.repo, r.files ?? {});
      commitAll(p.repo, r.title, now - r.lastCommitMinutes * 60_000);
      // The head GitHub would report, so a review task checked out from it
      // reads as up to date.
      r.head = git(p.repo, ['rev-parse', 'HEAD']);
      git(p.repo, ['push', '-q', 'origin', `HEAD:refs/pull/${r.number}/head`]);
      git(p.repo, ['checkout', '-q', 'main']);
      git(p.repo, ['branch', '-q', '-D', `pr-${r.number}`]);
    }
  }

  const hashes = new Map();
  for (const t of scenario.tasks) {
    mkdirSync(dirname(t.worktree), { recursive: true });
    git(t.repo, ['worktree', 'add', '-q', '-b', t.branch, t.worktree, 'main']);
    t.commits.forEach((c, i) => {
      writeFiles(t.worktree, c.files);
      hashes.set(commitToken(t.branch, i), commitAll(t.worktree, c.message, t.createdAt + (i + 1) * 4 * 60_000));
    });
    writeFiles(t.worktree, t.uncommitted);
    if (t.pr) git(t.worktree, ['push', '-q', '-u', 'origin', t.branch]);
  }

  // Commit hashes are known only now; the transcripts quote them.
  const withHashes = (lines) =>
    lines && JSON.parse(JSON.stringify(lines).replace(/@@COMMIT:[^@]+@@/g, (tok) => hashes.get(tok) ?? tok));

  const plays = join(home, '.albedo-demo', 'plays');
  mkdirSync(plays, { recursive: true });
  const prs = {};
  scenario.tasks.forEach((t, i) => {
    const transcriptDir = join(home, '.claude', 'projects', projectDirName(t.worktree));
    const transcript = join(transcriptDir, `${t.sessionId}.jsonl`);
    const history = withHashes(t.history);
    if (history.length > 0) {
      mkdirSync(transcriptDir, { recursive: true });
      writeFileSync(transcript, history.map((l) => JSON.stringify(l)).join('\n') + '\n');
    }
    const play = {
      title: t.title,
      cwd: t.worktree,
      transcript,
      transcriptDir,
      live: withHashes(t.live),
      outcomes: t.outcomes && {
        request: t.outcomes.request,
        allow: withHashes(t.outcomes.allow),
        deny: withHashes(t.outcomes.deny),
      },
      status: { context: 18 + i * 9, session: 38, week: 21 },
    };
    writeFileSync(join(plays, `${t.sessionId}.json`), JSON.stringify(play));
    if (t.pr) {
      prs[t.branch] = {
        number: t.pr.number,
        title: t.pr.title,
        url: `https://github.com/example/${t.project}/pull/${t.pr.number}`,
        base: 'main',
        checks: t.pr.checks,
        reviews: t.pr.reviews,
        threads: t.pr.threads,
      };
    }
  });
  writeFileSync(join(home, '.albedo-demo', 'prs.json'), JSON.stringify(prs, null, 2));
  // The Reviewing tab's PRs (#287), keyed by the folder gh is asked in.
  writeFileSync(join(home, '.albedo-demo', 'reviews.json'), JSON.stringify(scenario.reviews, null, 2));

  // Claude Code's own record that these folders are trusted: without it,
  // Albedo would show the workspace trust prompt as waiting on you.
  const trusted = Object.fromEntries(
    [...scenario.projects.map((p) => p.repo), ...scenario.tasks.map((t) => t.worktree)].map((p) => [
      p,
      { hasTrustDialogAccepted: true },
    ]),
  );
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, projects: trusted }, null, 2));

  const db = databasePath(home);
  mkdirSync(dirname(db), { recursive: true });
  createDatabase(db, { libRs: join(repoRoot, 'src-tauri', 'src', 'lib.rs'), scenario, now });
  return scenario;
}

/** The environment the app runs in: the demo's HOME, with your toolchains. */
export function demoEnv(home, env = process.env) {
  const real = homedir();
  const next = { ...env };
  for (const k of Object.keys(next)) if (k.startsWith('XDG_') || k === 'ZDOTDIR') delete next[k];
  return {
    ...next,
    HOME: home,
    // macOS reads the home folder from here, not HOME, for the web view's
    // storage; without it the demo would share yours.
    CFFIXED_USER_HOME: home,
    CARGO_HOME: env.CARGO_HOME || join(real, '.cargo'),
    RUSTUP_HOME: env.RUSTUP_HOME || join(real, '.rustup'),
    PATH: `${join(home, 'bin')}:${env.PATH ?? ''}`,
  };
}

function launch(home) {
  const tauri = join(repoRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  const child = spawn(process.execPath, [tauri, 'dev', '--config', join(here, 'tauri.demo.json')], {
    cwd: repoRoot,
    env: demoEnv(home),
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = new Set(process.argv.slice(2));
  const home = demoHome();
  if (!flags.has('--no-reset')) {
    setup(home);
    console.log(`Demo profile ready in ${home}`);
  }
  if (!flags.has('--setup-only')) {
    writeProfile(home, { realClaude: flags.has('--real-claude') });
    launch(home);
  }
}
