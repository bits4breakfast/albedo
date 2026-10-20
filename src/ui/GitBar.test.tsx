/**
 * @vitest-environment jsdom
 *
 * "Keep as Column" lives in the Files ⋯ menu: a layout preference, not an
 * action, so it is not a button of its own in the pane head.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Task } from '../types';

vi.mock('../gh/prStore', () => ({ getPrStatus: () => null, usePrStatus: () => null }));

const { default: GitBar } = await import('./GitBar');

afterEach(cleanup);

const task = {
  id: 1, title: 't', repoPath: '/r', baseBranch: 'main', branch: 'b', worktreePath: '/w',
  sessionId: null, status: 'idle', createdAt: 1, lastActivityAt: null, projectId: null,
  ownsWorktree: true, createdBranch: true,
} as unknown as Task;

function renderBar(column: { pinned: boolean; fits: boolean; onToggle: () => void }) {
  render(
    <GitBar
      task={task} commits={0} dirty={0} remote={null} onAsk={() => {}} onSquash={() => {}}
      mode="branch" onMode={() => {}} onRefresh={() => {}} refreshing={false} column={column}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
}

describe('GitBar ⋯ menu', () => {
  it('offers Keep as Column, ticked when pinned, and toggles it', () => {
    const onToggle = vi.fn();
    renderBar({ pinned: true, fits: true, onToggle });
    const item = screen.getByText('Keep as Column').closest('[role^="menuitem"]') as HTMLElement;
    expect(item.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(item);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('says when a pinned column has no room at this width', () => {
    renderBar({ pinned: true, fits: false, onToggle: () => {} });
    expect(screen.getByText(/no room at this width/)).toBeTruthy();
  });
});
