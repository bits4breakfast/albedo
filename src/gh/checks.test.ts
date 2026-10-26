import { describe, expect, it } from 'vitest';
import {
  annotationPlace,
  checkSource,
  cleanLogLine,
  failedStep,
  failureLines,
  fixPrompt,
  formatDuration,
  parseAnnotations,
  parsePrChecks,
  parseRunJob,
  PROMPT_MAX_CHARS,
  PROMPT_TAIL_LINES,
  stepLog,
  tailLines,
  timeLabel,
} from './checks';
// Captured with gh 2.97: this repo's failed CI run 39937064964 (jobs, the
// job's log from the per-job endpoint cut to its last seven steps, and its
// annotations), a public repo's run still in progress, and a mix of public
// PRs' checks with the repositories renamed.
import prChecks from './fixtures/pr-checks.json?raw';
import runFailed from './fixtures/run-jobs-failed.json?raw';
import runInProgress from './fixtures/run-jobs-in-progress.json?raw';
import jobLog from './fixtures/job-failed.log?raw';
import annotations from './fixtures/annotations.json?raw';

const FAILED_JOB = '120359352635';

describe('checkSource', () => {
  it('reads an Actions job, another app’s check run, and anything else', () => {
    expect(checkSource('https://github.com/o/r/actions/runs/39937064964/job/120359352635')).toEqual({
      kind: 'actions',
      host: 'github.com',
      repo: 'o/r',
      runId: '39937064964',
      jobId: '120359352635',
    });
    expect(checkSource('https://github.com/o/r/runs/121564525723')).toEqual({
      kind: 'check-run',
      host: 'github.com',
      repo: 'o/r',
      id: '121564525723',
    });
    // A whole run in another repository names no job: nothing to fetch.
    expect(checkSource('https://github.com/o/ci-hub/actions/runs/40319735246')).toEqual({ kind: 'external', host: 'github.com' });
    expect(checkSource('https://vercel.com')).toEqual({ kind: 'external', host: 'vercel.com' });
    expect(checkSource(null)).toEqual({ kind: 'external', host: null });
    expect(checkSource('javascript:alert(1)')).toEqual({ kind: 'external', host: null });
  });
});

describe('parsePrChecks', () => {
  it('parses real gh pr checks output, failing first, with the zero time as null', () => {
    const checks = parsePrChecks(prChecks)!;
    expect(checks.map((c) => [c.state, c.name, c.source.kind])).toEqual([
      ['fail', 'CI / linux', 'actions'],
      ['pending', 'Code OSS / Electron / Windows', 'actions'],
      ['pending', 'VS Code PR Check', 'external'],
      ['pass', 'Code OSS / Compile & Hygiene', 'actions'],
      ['pass', 'license/cla', 'external'],
      ['pass', 'Vercel Internal Security Review', 'external'],
      ['skipped', 'Code OSS / CLI / Linux', 'actions'],
      ['skipped', 'CodeQL', 'check-run'],
    ]);
    const running = checks.find((c) => c.name === 'Code OSS / Electron / Windows')!;
    expect(running.startedAt).toBe('2026-10-26T12:06:49Z');
    expect(running.completedAt).toBeNull();
  });

  it('reads an unknown bucket as pending, and anything but a list as no answer', () => {
    expect(parsePrChecks('[{"bucket":"new","name":"x"}]')![0]!.state).toBe('pending');
    expect(parsePrChecks('[{"bucket":"cancel","name":"x"}]')![0]!.state).toBe('cancelled');
    expect(parsePrChecks('no checks reported')).toBeNull();
    expect(parsePrChecks('{}')).toBeNull();
  });
});

describe('parseRunJob', () => {
  it('reads a failed job’s steps: the failure, and the skipped steps after it', () => {
    const job = parseRunJob(runFailed, FAILED_JOB)!;
    expect(job.state).toBe('fail');
    expect(job.completed).toBe(true);
    expect(job.url).toBe('https://github.com/bits4breakfast/albedo/actions/runs/39937064964/job/120359352635');
    const byName = Object.fromEntries(job.steps.map((s) => [s.name, s.state]));
    expect(byName['Run npm run typecheck']).toBe('pass');
    expect(byName['Run npx vitest run']).toBe('fail');
    expect(byName['cargo fmt']).toBe('skipped');
    expect(failedStep(job)?.name).toBe('Run npx vitest run');
  });

  it('reads a job still running: its running step, the pending ones, no zero times', () => {
    const job = parseRunJob(runInProgress, '121563278356')!;
    expect(job.state).toBe('running');
    expect(job.completed).toBe(false);
    const running = job.steps.find((s) => s.state === 'running')!;
    expect(running.name).toBe('Run Playwright fixture tests');
    expect(running.completedAt).toBeNull();
    const pending = job.steps.filter((s) => s.state === 'pending');
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((s) => s.startedAt === null)).toBe(true);
    expect(failedStep(job)).toBeNull();
  });

  it('is null for a job the run does not have, or output that is not a run', () => {
    expect(parseRunJob(runFailed, '1')).toBeNull();
    expect(parseRunJob('not json', FAILED_JOB)).toBeNull();
  });
});

describe('the failed step’s log', () => {
  const job = parseRunJob(runFailed, FAILED_JOB)!;

  it('keeps exactly the failed step: not the step before it, nor the cleanup after', () => {
    const lines = stepLog(jobLog, failedStep(job));
    // Its header group (command, shell, env) is left out.
    expect(lines.some((l) => l.includes('CARGO_HOME'))).toBe(false);
    // The step before ran tsc.
    expect(lines.some((l) => l.includes('tsc --noEmit'))).toBe(false);
    // Post job cleanup runs in the same second as the failure.
    expect(lines.some((l) => l.includes('Post job cleanup'))).toBe(false);
    expect(lines.some((l) => l.includes('Node.js 20 is deprecated'))).toBe(false);
    expect(lines[lines.length - 1]).toBe('Error: Process completed with exit code 1.');
    // The multi-line assertion messages, unstamped, come through whole.
    expect(lines).toContain('Received: "held"');
  });

  it('is plain text: no timestamps, no escapes, no runner markers', () => {
    const lines = stepLog(jobLog, failedStep(job));
    for (const l of lines) {
      expect(l).not.toMatch(/^\d{4}-\d\d-\d\dT/);
      expect(l).not.toContain('\x1b');
      expect(l).not.toMatch(/^##\[/);
    }
  });

  it('falls back to the whole job when no step failed, still ending at the error', () => {
    const noStep = { ...job, steps: job.steps.map((s) => ({ ...s, state: 'pass' as const })) };
    const lines = failureLines(jobLog, noStep);
    expect(lines[lines.length - 1]).toBe('Error: Process completed with exit code 1.');
    expect(lines.length).toBeGreaterThan(stepLog(jobLog, failedStep(job)).length);
  });

  it('cleans one line', () => {
    expect(cleanLogLine('\x1b[1m\x1b[7m\x1b[36m RUN \x1b[39m\x1b[27m\x1b[22m v2')).toBe(' RUN  v2');
    expect(cleanLogLine('##[endgroup]')).toBeNull();
    expect(cleanLogLine('##[group]Cache Configuration')).toBe('Cache Configuration');
    expect(cleanLogLine('##[warning]old')).toBe('Warning: old');
    expect(cleanLogLine('x'.repeat(1000))).toHaveLength(401);
  });

  it('takes a BOM-led first line’s timestamp off too', () => {
    const log = '﻿2026-10-23T10:10:01.79Z ##[group]Run x\n2026-10-23T10:10:01.80Z ##[endgroup]\n2026-10-23T10:10:02.00Z out';
    expect(stepLog(log, { startedAt: '2026-10-23T10:10:01Z', completedAt: '2026-10-23T10:10:02Z' })).toEqual(['out']);
  });
});

describe('tailLines', () => {
  it('keeps the last lines within both caps, and says when it cut', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    expect(tailLines(lines, 3)).toEqual({ lines: ['line 47', 'line 48', 'line 49'], cut: true });
    expect(tailLines(lines, 100, 16).lines).toEqual(['line 48', 'line 49']);
    expect(tailLines(['a'], 5)).toEqual({ lines: ['a'], cut: false });
  });
});

describe('parseAnnotations', () => {
  it('keeps the file annotations, failures first, first line of each, and drops the runner’s own', () => {
    const list = parseAnnotations(annotations);
    expect(list.map((a) => annotationPlace(a))).toEqual([
      'src/ui/transcript/send.test.ts:95',
      'src/ui/transcript/send.test.ts:67',
      'src/ui/transcript/send.test.ts:61',
    ]);
    expect(list[1]!.message).toBe("AssertionError: expected 'held' to be 'sent' // Object.is equality");
  });

  it('is empty for anything else', () => {
    expect(parseAnnotations('{"message":"Not Found"}')).toEqual([]);
  });
});

describe('fixPrompt', () => {
  const job = parseRunJob(runFailed, FAILED_JOB)!;
  const log = failureLines(jobLog, job);

  it('carries the check, the step, the run, the annotations and the log’s tail', () => {
    const text = fixPrompt({
      prNumber: 69,
      check: 'CI / linux',
      step: 'Run npx vitest run',
      url: job.url,
      log,
      annotations: parseAnnotations(annotations),
    });
    expect(text).toContain('The CI check "CI / linux" failed on pull request #69, at the step "Run npx vitest run".');
    expect(text).toContain(`Run: ${job.url}`);
    expect(text).toContain("- src/ui/transcript/send.test.ts:67 AssertionError: expected 'held' to be 'sent'");
    expect(text).toContain('Error: Process completed with exit code 1.');
    expect(text).toMatch(/The last \d+ lines of the step's log:/);
    expect(text.length).toBeLessThan(PROMPT_MAX_CHARS + 2_000);
  });

  it('caps the log, and fences it so the log cannot close the fence', () => {
    const many = Array.from({ length: 500 }, (_, i) => (i === 499 ? '```' : `l${i}`));
    const text = fixPrompt({ prNumber: 1, check: 'c', step: null, url: null, log: many, annotations: [] });
    expect(text).toContain(`The last ${PROMPT_TAIL_LINES} lines of the job's log:`);
    expect(text).toContain('````\nl380');
    expect(text).not.toContain('l379\n');
  });

  it('says so when there is no log', () => {
    const text = fixPrompt({ prNumber: 1, check: 'c', step: 's', url: 'https://x', log: null, annotations: [] });
    expect(text).toContain('Its log could not be read; the run link has it.');
  });
});

describe('time', () => {
  it('formats durations', () => {
    expect(formatDuration(41_000)).toBe('41s');
    expect(formatDuration(134_000)).toBe('2m 14s');
    expect(formatDuration(3_780_000)).toBe('1h 3m');
  });

  it('labels finished, running, pending and skipped rows', () => {
    const now = Date.parse('2026-10-26T12:10:00Z');
    expect(timeLabel({ state: 'fail', startedAt: '2026-10-23T10:10:01Z', completedAt: '2026-10-23T10:12:19Z' }, now)).toBe('2m 18s');
    expect(timeLabel({ state: 'running', startedAt: '2026-10-26T12:09:00Z', completedAt: null }, now)).toBe('Running 1m 0s');
    expect(timeLabel({ state: 'pending', startedAt: null, completedAt: null }, now)).toBe('Pending');
    expect(timeLabel({ state: 'skipped', startedAt: null, completedAt: null }, now)).toBe('Skipped');
  });
});
