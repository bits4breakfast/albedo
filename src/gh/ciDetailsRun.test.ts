/**
 * Fetching a queued CI failure's details (#280, step 2): the command, run
 * through the `ci-details-sh` scope with the saved project setting and
 * nothing else; GitHub Actions, through gh.ts's own fetches; and the 30 s
 * limit and the fallbacks, which always end in a state, never a throw.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import runFailed from './fixtures/run-jobs-failed.json?raw';
import jobLog from './fixtures/job-failed.txt?raw';
import { setGhRunner, type GhRunner } from './gh';
import { failedStep, failureLines, parseRunJob } from './checks';
import {
  CI_SH_PREAMBLE,
  CI_SH_SCOPE,
  ciShellScript,
  fetchActionsDetails,
  fetchCiDetails,
  runDetailsCommand,
  setCiShellRunner,
  type CiShellRunner,
  type ShellOutcome,
} from './ciDetailsRun';
import type { Project } from '../types';

const SHA = 'abc1234def5678900000000000000000000000aa';
/** A check name a hostile PR could carry: shell syntax, meant to stay data. */
const NASTY = 'build $(touch /tmp/owned) `id`; rm -rf ~';
const failure = {
  prNumber: 14,
  sha: SHA,
  checks: [
    { name: NASTY, conclusion: 'failed', url: 'https://ci.example/job/812' },
    { name: 'lint', conclusion: 'failed', url: 'https://ci.example/job/813' },
  ],
};
const project = (over: Partial<Project> = {}): Pick<Project, 'ciDetails' | 'ciDetailsCommand'> => ({
  ciDetails: 'command',
  ciDetailsCommand: './scripts/ci-details.sh --verbose',
  ...over,
});

let restoreShell: CiShellRunner | null = null;
let restoreGh: GhRunner | null = null;
afterEach(() => {
  if (restoreShell) setCiShellRunner(restoreShell);
  if (restoreGh) setGhRunner(restoreGh);
  restoreShell = restoreGh = null;
  vi.useRealTimers();
});

function fakeShell(outcome: Partial<ShellOutcome> | ((script: string) => Promise<ShellOutcome>)) {
  const calls: { script: string; cwd: string; input: string; timeoutMs: number }[] = [];
  restoreShell = setCiShellRunner(async (script, opts) => {
    calls.push({ script, ...opts });
    if (typeof outcome === 'function') return outcome(script);
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...outcome };
  });
  return calls;
}

describe('the command comes from the project setting, and only from there', () => {
  it('runs the saved value after the fixed preamble, in the task’s folder', async () => {
    const calls = fakeShell({ stdout: JSON.stringify({ checks: [{ name: 'lint', step: 'eslint' }] }) });
    await runDetailsCommand(project(), '/wt/recipe-app/fix-fractions', failure);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.script).toBe(`${CI_SH_PREAMBLE}./scripts/ci-details.sh --verbose\n`);
    expect(calls[0]!.cwd).toBe('/wt/recipe-app/fix-fractions');
    expect(calls[0]!.timeoutMs).toBe(30_000);
  });

  it('hands the checks over as data, never in the script', async () => {
    const calls = fakeShell({ stdout: '{"checks": []}' });
    await runDetailsCommand(project(), '/wt', failure);
    const { script, input } = calls[0]!;
    expect(script).not.toContain('touch');
    expect(script).not.toContain('ci.example');
    expect(JSON.parse(input)).toEqual({
      pr: 14,
      head: SHA,
      checks: [
        { name: NASTY, conclusion: 'failed', link: 'https://ci.example/job/812' },
        { name: 'lint', conclusion: 'failed', link: 'https://ci.example/job/813' },
      ],
    });
  });

  it('runs nothing for a project without a command', async () => {
    const calls = fakeShell({});
    expect(ciShellScript({ ciDetailsCommand: null })).toBeNull();
    expect(ciShellScript({ ciDetailsCommand: '   ' })).toBeNull();
    expect(await runDetailsCommand(project({ ciDetailsCommand: null }), '/wt', failure)).toEqual({
      state: 'failed',
      reason: 'the project has no command',
    });
    expect(calls).toHaveLength(0);
  });

  it('runs nothing at all for a project on name and link only', async () => {
    const calls = fakeShell({});
    expect(await fetchCiDetails(project({ ciDetails: 'link' }), '/wt', failure)).toEqual({ state: 'none' });
    expect(calls).toHaveLength(0);
  });

  it('removes the Anthropic credentials before the command runs (hard rule 3)', () => {
    expect(CI_SH_PREAMBLE.split('\n')[0]).toBe('unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL');
  });

  it('is the only code that spawns through the ci-details-sh scope, and the only reader of the command outside the setting', () => {
    const root = new URL('..', import.meta.url).pathname;
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p);
      }
    };
    walk(root);
    const rel = (p: string) => p.slice(root.length);
    const using = (needle: RegExp) => files.filter((f) => needle.test(readFileSync(f, 'utf8'))).map(rel).sort();
    // As a string the code passes, not a name in a comment.
    expect(using(/['"]ci-details-sh['"]/)).toEqual(['gh/ciDetailsRun.ts']);
    // The setting is written by the Projects dialog and stored by the db
    // layer; the runner is the one place it is read to be run.
    expect(using(/ciDetailsCommand/)).toEqual(['db/projects.ts', 'gh/ciDetailsRun.ts', 'types.ts', 'ui/ProjectsDialog.tsx']);
    expect(CI_SH_SCOPE).toBe('ci-details-sh');
  });
});

describe('the ci-details-sh scope', () => {
  const caps = JSON.parse(readFileSync(new URL('../../src-tauri/capabilities/default.json', import.meta.url), 'utf8')) as {
    permissions: (string | { identifier: string; allow?: { name: string; cmd?: string; args?: unknown }[] })[];
  };
  const entries = caps.permissions.flatMap((p) => (typeof p === 'object' && p.allow ? p.allow.map((a) => ({ id: p.identifier, ...a })) : []));
  const entry = entries.find((e) => e.name === CI_SH_SCOPE);

  it('is a spawn of /bin/sh -c and nothing broader', () => {
    expect(entries.filter((e) => e.name === CI_SH_SCOPE)).toHaveLength(1);
    expect(entry?.id).toBe('shell:allow-spawn');
    expect(entry?.cmd).toBe('/bin/sh');
    expect(Array.isArray(entry?.args) && entry.args.length).toBe(2);
    expect((entry?.args as unknown[])[0]).toBe('-c');
  });

  // The plugin anchors the validator (^…$) and compiles it with Rust's regex
  // crate; `(?s:…)` is the one piece JS spells differently.
  const validator = new RegExp(`^${((entry?.args as { validator: string }[])[1]!.validator).replace('(?s:.+)', '[\\s\\S]+')}$`);

  it('accepts a script only when it starts with the preamble', () => {
    expect(validator.test(ciShellScript(project())!)).toBe(true);
    expect(validator.test(ciShellScript(project({ ciDetailsCommand: 'printf a\nprintf b' }))!)).toBe(true);
    expect(validator.test('rm -rf ~')).toBe(false);
    expect(validator.test(CI_SH_PREAMBLE)).toBe(false); // and a command after it
    expect(validator.test(`echo hi\n${CI_SH_PREAMBLE}x`)).toBe(false);
  });
});

describe('when the command gives nothing usable, the failure still queues, saying why', () => {
  it('reads what it prints', async () => {
    fakeShell({ stdout: JSON.stringify({ checks: [{ name: 'lint', step: 'eslint', log: 'a.ts:1 no-unused-vars' }] }) });
    expect(await runDetailsCommand(project(), '/wt', failure)).toEqual({
      state: 'ready',
      checks: [{ name: 'lint', step: 'eslint', log: ['a.ts:1 no-unused-vars'], more: 0 }],
    });
  });

  it('a non-zero exit', async () => {
    fakeShell({ code: 3, stderr: 'circleci: no token\n' });
    expect(await runDetailsCommand(project(), '/wt', failure)).toEqual({
      state: 'failed',
      reason: 'the command exited with 3: circleci: no token',
    });
  });

  it('a timeout', async () => {
    fakeShell({ code: null, timedOut: true });
    expect(await runDetailsCommand(project(), '/wt', failure)).toEqual({
      state: 'failed',
      reason: 'the command took longer than 30 s',
    });
  });

  it('output that is not the contract', async () => {
    fakeShell({ stdout: 'All good?' });
    expect(await runDetailsCommand(project(), '/wt', failure)).toEqual({ state: 'failed', reason: 'its output is not JSON' });
  });

  it('a command that cannot start', async () => {
    fakeShell(() => Promise.reject(new Error('program not allowed on the configured shell scope: /bin/sh')));
    expect(await runDetailsCommand(project(), '/wt', failure)).toEqual({
      state: 'failed',
      reason: 'the command could not be started (program not allowed on the configured shell scope: /bin/sh)',
    });
  });

  it('a runner that never closes is given up on after the limit', async () => {
    vi.useFakeTimers();
    fakeShell(() => new Promise<ShellOutcome>(() => {}));
    const p = fetchCiDetails(project(), '/wt', failure);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await p).toEqual({ state: 'failed', reason: 'fetching took longer than 30 s' });
  });
});

describe('GitHub Actions, through what the Checks dialog fetches', () => {
  const JOB = 'https://github.com/o/r/actions/runs/39937064964/job/120359352635';
  const actions = {
    prNumber: 14,
    sha: SHA,
    checks: [
      { name: 'CI / linux', conclusion: 'failed', url: JOB },
      { name: 'deploy-preview', conclusion: 'failed', url: 'https://ci.example/build/9' },
    ],
  };

  function fakeGh(answer: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>) {
    const calls: string[][] = [];
    restoreGh = setGhRunner(async (_program, args) => {
      calls.push(args);
      return answer(args);
    });
    return calls;
  }

  it('gives the failing step and the end of its log, cut to the limits', async () => {
    const calls = fakeGh(async (args) => ({ code: 0, stdout: args[0] === 'run' ? runFailed : jobLog, stderr: '' }));
    const job = parseRunJob(runFailed, '120359352635')!;
    const all = failureLines(jobLog, job);
    const d = await fetchActionsDetails(actions);
    expect(d.state).toBe('ready');
    if (d.state !== 'ready') return;
    expect(d.checks).toHaveLength(1); // the other is not an Actions job
    expect(d.checks[0]!.name).toBe('CI / linux');
    expect(d.checks[0]!.step).toBe(failedStep(job)!.name);
    expect(d.checks[0]!.log.at(-1)).toBe(all.at(-1));
    expect(d.checks[0]!.log.length).toBeLessThanOrEqual(40);
    expect(d.checks[0]!.log.length + d.checks[0]!.more).toBe(all.length);
    // The same two calls the Checks dialog makes.
    expect(calls.map((a) => a.slice(0, 2))).toEqual(
      expect.arrayContaining([
        ['run', 'view'],
        ['api', '--allow-escape-sequences'],
      ]),
    );
  });

  it('says why when there is nothing to fetch, or GitHub gives nothing', async () => {
    expect(await fetchActionsDetails({ ...actions, checks: actions.checks.slice(1) })).toEqual({
      state: 'failed',
      reason: 'none of these checks is a GitHub Actions job',
    });
    fakeGh(async () => ({ code: 1, stdout: '', stderr: 'HTTP 404' }));
    expect(await fetchActionsDetails(actions)).toEqual({ state: 'failed', reason: 'GitHub did not give the jobs’ steps or logs' });
  });

  it('gives up after 30 s', async () => {
    vi.useFakeTimers();
    fakeGh(() => new Promise(() => {}));
    const p = fetchCiDetails(project({ ciDetails: 'actions' }), '/wt', actions);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await p).toEqual({ state: 'failed', reason: 'fetching took longer than 30 s' });
  });
});
