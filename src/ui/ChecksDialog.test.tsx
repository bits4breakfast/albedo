/**
 * @vitest-environment jsdom
 *
 * The Checks dialog against captured gh output (src/gh/fixtures): what a
 * person sees on opening it for a failing PR, and what Ask Claude to Fix
 * hands the message box.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import prChecks from '../gh/fixtures/pr-checks.json?raw';
import runFailed from '../gh/fixtures/run-jobs-failed.json?raw';
import jobLog from '../gh/fixtures/job-failed.txt?raw';
import annotations from '../gh/fixtures/annotations.json?raw';
import { parseAnnotations, parsePrChecks, parseRunJob } from '../gh/checks';
import type { PrStatus } from '../gh/prStatus';

const calls = { job: 0, log: 0, annotations: 0 };
vi.mock('../gh/gh', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gh/gh')>()),
  fetchPrChecks: vi.fn(async () => parsePrChecks(prChecks)),
  fetchJob: vi.fn(async (ref: { jobId: string }) => {
    calls.job += 1;
    return parseRunJob(runFailed, ref.jobId);
  }),
  fetchJobLog: vi.fn(async () => {
    calls.log += 1;
    return jobLog;
  }),
  fetchAnnotations: vi.fn(async () => {
    calls.annotations += 1;
    return parseAnnotations(annotations);
  }),
}));
vi.mock('../lib/openUrl', () => ({ openExternal: vi.fn(async () => {}) }));
vi.mock('./transcript/composerBridge', () => ({ insertIntoComposer: vi.fn(() => true) }));

const { default: ChecksDialog, clearCheckCachesForTests } = await import('./ChecksDialog');
const { openExternal } = await import('../lib/openUrl');
const { insertIntoComposer } = await import('./transcript/composerBridge');

const JOB_URL = 'https://github.com/bits4breakfast/albedo/actions/runs/39937064964/job/120359352635';

const pr: PrStatus = {
  number: 69,
  url: 'https://github.com/bits4breakfast/albedo/pull/69',
  title: 'Offline: keep queued messages visible',
  state: 'open',
  headRefName: '56-offline-outbox',
  baseRefName: 'main',
  mergedAt: null,
  review: null,
  checks: { kind: 'failing', failing: 1, total: 2 },
  lines: [
    { name: 'CI / linux', bucket: 'fail', url: JOB_URL },
    { name: 'Vercel Internal Security Review', bucket: 'pass', url: 'https://vercel.com' },
  ],
};
const task = { id: 7, worktreePath: '/w', repoPath: '/r' };

beforeEach(() => {
  clearCheckCachesForTests();
  calls.job = calls.log = calls.annotations = 0;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ChecksDialog', () => {
  it('opens on the failing job: its steps, the failed step’s log tail and its annotations', async () => {
    render(<ChecksDialog task={task} pr={pr} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Checks for pull request 69' });
    // Failing first, opened by itself.
    const failing = within(dialog).getByRole('button', { name: /CI \/ linux/ });
    expect(failing.getAttribute('aria-expanded')).toBe('true');

    const steps = await screen.findByRole('list', { name: 'Steps of CI / linux' });
    expect(within(steps).getByText('Run npx vitest run').closest('li')?.getAttribute('data-state')).toBe('fail');
    expect(within(steps).getByText('cargo fmt').closest('li')?.getAttribute('data-state')).toBe('skipped');

    const log = await waitFor(() => {
      const pre = dialog.querySelector('pre.ck-log');
      expect(pre).not.toBeNull();
      return pre!;
    });
    expect(log.textContent).toContain('Error: Process completed with exit code 1.');
    expect(log.textContent).not.toContain('\x1b');
    expect(log.textContent!.split('\n').length).toBeLessThanOrEqual(40);
    expect(await screen.findByText('src/ui/transcript/send.test.ts:95')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('1 failing');
  });

  it('Ask Claude to Fix… puts the check, step, run and log in the message box, and closes', async () => {
    const onClose = vi.fn();
    render(<ChecksDialog task={task} pr={pr} onClose={onClose} />);
    const ask = await screen.findByRole('button', { name: 'Ask Claude to Fix…' });
    await waitFor(() => expect((ask as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(ask);
    expect(insertIntoComposer).toHaveBeenCalledTimes(1);
    const { taskId, text } = vi.mocked(insertIntoComposer).mock.calls[0]![0];
    expect(taskId).toBe(7);
    expect(text).toContain('"CI / linux" failed on pull request #69, at the step "Run npx vitest run"');
    expect(text).toContain(`Run: ${JOB_URL}`);
    expect(text).toContain('- src/ui/transcript/send.test.ts:67 ');
    expect(text).toContain('Error: Process completed with exit code 1.');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says where the message box is when no composer took the text, and stays open', async () => {
    vi.mocked(insertIntoComposer).mockReturnValueOnce(false);
    const onClose = vi.fn();
    render(<ChecksDialog task={task} pr={pr} onClose={onClose} />);
    const ask = await screen.findByRole('button', { name: 'Ask Claude to Fix…' });
    await waitFor(() => expect((ask as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(ask);
    expect(screen.getByRole('alert').textContent).toContain('message box');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('opens an annotation’s file at its line', async () => {
    const onOpenFile = vi.fn();
    const onClose = vi.fn();
    render(<ChecksDialog task={task} pr={pr} onClose={onClose} onOpenFile={onOpenFile} />);
    fireEvent.click(await screen.findByRole('button', { name: 'src/ui/transcript/send.test.ts:67' }));
    expect(onOpenFile).toHaveBeenCalledWith({ path: 'src/ui/transcript/send.test.ts', line: 67 });
    expect(onClose).toHaveBeenCalled();
  });

  it('shows another host’s check with its state and a link out, and nothing to expand', async () => {
    render(<ChecksDialog task={task} pr={pr} onClose={() => {}} />);
    const out = await screen.findByRole('button', { name: 'Logs on vercel.com' });
    expect(screen.queryByRole('button', { name: /Vercel Internal Security Review/ })).toBeNull();
    fireEvent.click(out);
    expect(openExternal).toHaveBeenCalledWith('https://vercel.com');
  });

  it('fetches a finished job’s log once, however often it is opened', async () => {
    const { unmount } = render(<ChecksDialog task={task} pr={pr} onClose={() => {}} />);
    await screen.findByText('src/ui/transcript/send.test.ts:95');
    unmount();
    render(<ChecksDialog task={task} pr={pr} onClose={() => {}} />);
    await screen.findByText('src/ui/transcript/send.test.ts:95');
    expect(calls.log).toBe(1);
    expect(calls.annotations).toBe(1);
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<ChecksDialog task={task} pr={pr} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
