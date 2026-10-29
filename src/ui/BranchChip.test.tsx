/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import type { PrStatus } from '../gh/prStatus';
import type { Task } from '../types';

const prs = vi.hoisted(() => ({ current: null as PrStatus | null }));
vi.mock('../gh/prStore', () => ({ usePrStatus: () => prs.current }));

import BranchChip from './BranchChip';

afterEach(cleanup);

const task = { id: 1, kind: 'work', branch: 'fix-login', baseBranch: 'main' } as Task;

describe('BranchChip', () => {
  it('shows the branch and the base it was cut from', () => {
    prs.current = null;
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
});
