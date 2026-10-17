/**
 * @vitest-environment jsdom
 *
 * The dialog and its keyboard. Argv, grouping and the cap are covered in
 * src/git/findInFiles.test.ts; git is replaced through the runner seam.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import FindInFiles from './FindInFiles';
import { setGitRunner, type GitRunner } from '../git/worktree';

let restore: GitRunner | null = null;
afterEach(() => {
  cleanup();
  if (restore) setGitRunner(restore);
  restore = null;
});

const OUT = 'src/a.ts\x003\x00const needle = 1\nsrc/a.ts\x009\x00  needle()\nsrc/b.php\x0012\x00$needle;\n';

function setup(runner: GitRunner) {
  restore = setGitRunner(runner);
  const onOpen = vi.fn();
  const onClose = vi.fn();
  render(<FindInFiles open worktreePath="/w" onClose={onClose} onOpen={onOpen} />);
  return { onOpen, onClose, input: screen.getByRole('combobox') as HTMLInputElement };
}

describe('FindInFiles', () => {
  it('is a modal dialog', () => {
    setup(async () => ({ code: 1, stdout: '', stderr: '' }));
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
  });

  it('groups by file, highlights, and opens the chosen line', async () => {
    const { input, onOpen, onClose } = setup(async () => ({ code: 0, stdout: OUT, stderr: '' }));
    fireEvent.change(input, { target: { value: 'needle' } });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['src/a.ts', 'src/b.php']);
    expect(document.querySelectorAll('mark.qo-hit')).toHaveLength(3);
    expect(screen.getByRole('status').textContent).toBe('3 matches in 2 files');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onClose).toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledWith({ path: 'src/a.ts', line: 9 });
  });

  it('does not search a one-character query', async () => {
    const runner = vi.fn(async () => ({ code: 0, stdout: OUT, stderr: '' }));
    const { input } = setup(runner);
    fireEvent.change(input, { target: { value: 'n' } });
    await new Promise((r) => setTimeout(r, 300));
    expect(runner).not.toHaveBeenCalled();
  });

  it('drops the answer of a search the user typed past', async () => {
    let releaseSlow: () => void = () => {};
    const { input } = setup(async (args) => {
      const q = args[args.indexOf('-e') + 1];
      if (q === 'old') {
        await new Promise<void>((r) => (releaseSlow = r));
        return { code: 0, stdout: 'stale.ts\x001\x00old\n', stderr: '' };
      }
      return { code: 0, stdout: 'fresh.ts\x001\x00new one\n', stderr: '' };
    });
    fireEvent.change(input, { target: { value: 'old' } });
    await new Promise((r) => setTimeout(r, 250)); // the slow search is now in flight
    fireEvent.change(input, { target: { value: 'new' } });
    await waitFor(() => expect(screen.getAllByRole('group')[0]!.getAttribute('aria-label')).toBe('fresh.ts'));
    releaseSlow();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['fresh.ts']);
  });

  it('toggles Match Case and Regex with ⌥C / ⌥X, and passes them to git', async () => {
    const calls: string[][] = [];
    const { input } = setup(async (args) => {
      calls.push(args);
      return { code: 1, stdout: '', stderr: '' };
    });
    fireEvent.change(input, { target: { value: 'ne+dle' } });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual(expect.arrayContaining(['-F', '-i']));
    fireEvent.keyDown(input, { key: 'ç', code: 'KeyC', altKey: true });
    fireEvent.keyDown(input, { key: '≈', code: 'KeyX', altKey: true });
    expect(screen.getByTitle('Match case (⌥C)').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTitle('Regex (⌥X)').getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(calls.length).toBeGreaterThan(1));
    const last = calls[calls.length - 1]!;
    expect(last).not.toContain('-F');
    expect(last).not.toContain('-i');
    expect(screen.getByRole('status').textContent).toMatch(/Nothing matches/);
  });

  it('says so when capped', async () => {
    const many = Array.from({ length: 600 }, (_, i) => `f.ts\x00${i + 1}\x00needle\n`).join('');
    const { input } = setup(async () => ({ code: 0, stdout: many, stderr: '' }));
    fireEvent.change(input, { target: { value: 'needle' } });
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/^First 500 matches/));
    expect(screen.getAllByRole('option')).toHaveLength(500);
  });

  it('shows git’s message for an invalid pattern', async () => {
    const { input } = setup(async () => ({ code: 128, stdout: '', stderr: "fatal: command line, '(': missing )\n" }));
    fireEvent.change(input, { target: { value: 'a(' } });
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/^Invalid pattern: command line/));
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('closes on Escape without letting it reach the editor', () => {
    const { input, onClose } = setup(async () => ({ code: 1, stdout: '', stderr: '' }));
    const outer = vi.fn();
    window.addEventListener('keydown', outer);
    fireEvent.keyDown(input, { key: 'Escape' });
    window.removeEventListener('keydown', outer);
    expect(onClose).toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
  });
});
