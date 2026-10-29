/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

import type { PrStatus } from '../gh/prStatus';
import type { Task } from '../types';

const prs = vi.hoisted(() => ({ current: null as PrStatus | null }));
vi.mock('../gh/prStore', () => ({ usePrStatus: () => prs.current }));
const stacks = vi.hoisted(() => ({ current: null as { base: string; how: 'on' | 'older' } | null }));
vi.mock('../git/stackBase', () => ({ detectStackBase: async () => stacks.current }));

import BranchChip from './BranchChip';

afterEach(cleanup);

const task = { id: 1, kind: 'work', status: 'idle', worktreePath: '/w', branch: 'fix-login', baseBranch: 'main' } as Task;

describe('BranchChip', () => {
  it('shows the branch and the base it was cut from', () => {
    prs.current = null;
    stacks.current = null;
    const { container } = render(<BranchChip task={task} />);
    expect(container.textContent).toBe('fix-login→into main');
    expect(container.querySelector('.main-ident-branch')?.getAttribute('title')).toBe('Branch fix-login, cut from main');
  });

  it("shows the PR's base once there is a PR", () => {
    prs.current = { number: 12, baseRefName: 'add-export' } as PrStatus;
    const { container } = render(<BranchChip task={task} />);
    expect(container.querySelector('.main-ident-base')?.textContent).toBe('→into add-export');
    expect(container.querySelector('.main-ident-branch')?.getAttribute('title')).toBe(
      'Branch fix-login, merging into add-export (PR #12)',
    );
  });

  it('shows a restack git found, and asks for a rebase when the parent was rewritten', async () => {
    prs.current = null;
    stacks.current = { base: 'add-export', how: 'older' };
    const { container } = render(<BranchChip task={task} />);
    await waitFor(() => expect(container.querySelector('.main-ident-stale')?.textContent).toBe('needs rebase'));
    expect(container.querySelector('.main-ident-base')?.textContent).toBe('→into add-exportneeds rebase');
    expect(container.querySelector('.main-ident-branch')?.getAttribute('title')).toContain('needs rebasing onto it (cut from main)');
  });
});
