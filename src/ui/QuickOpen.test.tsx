/**
 * @vitest-environment jsdom
 *
 * The dialog and its keyboard. Ranking is covered in quickOpenModel.test.ts;
 * git is replaced through the runner seam, so no worktree is touched.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import QuickOpen from './QuickOpen';
import { invalidateCodeIndex } from '../git/codeIndex';
import { setGitRunner, type GitRunner } from '../git/worktree';

let restore: GitRunner;
beforeAll(() => {
  restore = setGitRunner(async (args) => {
    if (args[0] === 'ls-files') return { code: 0, stdout: 'src/UserService.php\0src/ui/Terminal.tsx\0', stderr: '' };
    if (args.includes('*.php')) {
      return {
        code: 0,
        stdout: 'src/UserService.php\x007\x00final class UserService\nsrc/UserService.php\x0020\x00    public function find($id)\n',
        stderr: '',
      };
    }
    return { code: 1, stdout: '', stderr: '' };
  });
});
afterAll(() => {
  setGitRunner(restore);
});
afterEach(() => {
  cleanup();
  invalidateCodeIndex();
});

function setup(mode: 'file' | 'class' | 'symbol' | 'all' = 'symbol', currentFile: string | null = null) {
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const onMode = vi.fn();
  render(
    <QuickOpen mode={mode} worktreePath="/w" currentFile={currentFile} onMode={onMode} onClose={onClose} onOpen={onOpen} />,
  );
  return { onOpen, onClose, onMode, input: screen.getByRole('combobox') as HTMLInputElement };
}

describe('QuickOpen', () => {
  it('is a modal dialog, so the rest of the app knows one is open', () => {
    setup();
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
  });

  it('filters as you type and opens the chosen symbol at its line', async () => {
    const { input, onOpen, onClose } = setup('symbol');
    fireEvent.change(input, { target: { value: 'usvc' } });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onClose).toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledWith({ path: 'src/UserService.php', line: 7 });
  });

  it('arrows move the selection and wrap', async () => {
    const { input, onOpen } = setup('all');
    fireEvent.change(input, { target: { value: 'user' } });
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(2));
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[0]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith({ path: 'src/UserService.php', line: null });
  });

  it('with an empty query, lists the open file outline', async () => {
    setup('symbol', 'src/UserService.php');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    expect(screen.getAllByRole('option')[0]!.textContent).toContain('this file');
  });

  it('Escape closes and does not reach window listeners', () => {
    const { input, onClose } = setup();
    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    fireEvent.keyDown(input, { key: 'Escape' });
    window.removeEventListener('keydown', seen);
    expect(onClose).toHaveBeenCalled();
    expect(seen).not.toHaveBeenCalled();
  });

  it('Tab walks the scopes', () => {
    const { input, onMode } = setup('file');
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(onMode).toHaveBeenCalledWith('class');
  });

  it('renders nothing when closed', () => {
    render(
      <QuickOpen mode={null} worktreePath="/w" currentFile={null} onMode={vi.fn()} onClose={vi.fn()} onOpen={vi.fn()} />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('names the folder when searching a main checkout, and only then', () => {
    render(
      <QuickOpen mode="file" worktreePath="/repo" scopeLabel="app · main checkout" currentFile={null}
        onMode={vi.fn()} onClose={vi.fn()} onOpen={vi.fn()} />,
    );
    expect(screen.getByText('Searching app · main checkout')).toBeTruthy();
    cleanup();
    setup('file');
    expect(screen.queryByText(/^Searching /)).toBeNull();
  });
});
