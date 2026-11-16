/**
 * @vitest-environment jsdom
 *
 * The task row menu stays inside the window (#285): opened on the last row,
 * it used to run off the bottom and hide Delete Task.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { Task } from '../types';

vi.mock('../gh/prStore', () => ({
  getPrStatus: () => null,
  usePrPolling: () => {},
  usePrStatusVersion: () => 0,
}));
vi.mock('../git/branchSync', () => ({ useBranchSync: () => {} }));

const { default: TaskList } = await import('./TaskList');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const task: Task = {
  id: 7, title: 'Fix login', projectId: 1, repoPath: '/r/app', baseBranch: 'main', branch: 'fix-login',
  worktreePath: '/w/fix-login', sessionId: 's7', ownsWorktree: true, createdBranch: true, kind: 'work',
  status: 'idle', createdAt: 1, lastActivityAt: 1, seenAt: null, summary: null,
  reviewUrl: null,
  apiError: null,
  apiErrorText: null,
  spunFromTaskId: null,
};

/** jsdom lays nothing out: give the menu a real size and the window a known one. */
function sized(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const w = this.classList.contains('row-menu') ? width : 0;
    const h = this.classList.contains('row-menu') ? height : 0;
    return { x: 0, y: 0, left: 0, top: 0, right: w, bottom: h, width: w, height: h, toJSON: () => ({}) } as DOMRect;
  });
}

function openAt(x: number, y: number): HTMLElement {
  const { container } = render(<TaskList tasks={[task]} selectedId={null} onSelect={() => {}} onNew={() => {}} />);
  fireEvent.contextMenu(container.querySelector('[data-task-id="7"]') as HTMLElement, { clientX: x, clientY: y });
  return document.querySelector('.row-menu') as HTMLElement;
}

describe('the task row menu fits in the window (#285)', () => {
  it('opens upward from a row near the bottom', () => {
    sized(340, 420);
    const menu = openAt(480, 700);
    expect(menu.style.top).toBe('280px');
    expect(menu.style.left).toBe('480px');
  });

  it('opens downward where it fits, as before', () => {
    sized(340, 420);
    const menu = openAt(100, 100);
    expect(menu.style.top).toBe('100px');
    expect(menu.style.maxHeight).toBe('');
  });

  it('scrolls when the window is shorter than the menu', () => {
    sized(340, 900);
    const menu = openAt(100, 400);
    expect(menu.style.top).toBe('8px');
    expect(menu.style.maxHeight).toBe('784px');
    expect(menu.style.overflowY).toBe('auto');
  });
});
