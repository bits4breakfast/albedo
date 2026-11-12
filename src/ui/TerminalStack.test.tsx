/**
 * @vitest-environment jsdom
 *
 * The memoised terminal stack (#364): a terminal is drawn again when anything
 * it is given changes, and not for a capture burst's `lastActivityAt` or a
 * parent render that hands down equal props. Terminal itself is replaced by
 * a recorder here; Terminal.memo.test.tsx runs the real one.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { Task } from '../types';
import type { TerminalProps } from './Terminal';

const h = vi.hoisted(() => ({
  renders: [] as TerminalProps[],
  mounts: [] as number[],
}));

vi.mock('./Terminal', async () => {
  const { useEffect } = await import('react');
  return {
    default: (p: TerminalProps) => {
      h.renders.push(p);
      useEffect(() => {
        h.mounts.push(p.task.id);
      }, []);
      return <div data-testid={`pty-${p.task.id}`} />;
    },
  };
});

const { default: TerminalStack, terminalTaskEqual } = await import('./TerminalStack');

function task(id: number, over: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    projectId: 1,
    repoPath: '/code/x',
    baseBranch: 'main',
    branch: `feature-${id}`,
    worktreePath: `/code/x-${id}`,
    sessionId: `s-${id}`,
    ownsWorktree: true,
    createdBranch: true,
    kind: 'work',
    status: 'idle',
    createdAt: 1,
    lastActivityAt: 2,
    seenAt: 3,
    summary: null,
    reviewUrl: null,
    apiError: null,
    apiErrorText: null,
    spunFromTaskId: null,
    ...over,
  };
}

/** A different value for every field of a Task, `lastActivityAt` included. */
const CHANGED: { [K in keyof Task]-?: Task[K] } = {
  id: 99,
  title: 'Other',
  projectId: 2,
  repoPath: '/code/y',
  baseBranch: 'develop',
  branch: 'other',
  worktreePath: '/code/elsewhere',
  sessionId: 's-other',
  ownsWorktree: false,
  createdBranch: false,
  kind: 'chat',
  status: 'running',
  createdAt: 100,
  lastActivityAt: 200,
  seenAt: 300,
  summary: 'About',
  reviewUrl: 'https://github.com/o/r/pull/1',
  apiError: 'overloaded',
  apiErrorText: 'API Error: Overloaded',
  spunFromTaskId: 7,
};

const stable = {
  initialPromptFor: () => null,
  spawnArgsFor: () => undefined,
  sessionNameFor: () => undefined,
  forgetResume: () => {},
};

afterEach(() => {
  cleanup();
  h.renders = [];
  h.mounts = [];
});

describe('TerminalStack (#364)', () => {
  it('a burst (a new task object, only lastActivityAt changed) redraws no terminal', () => {
    const tasks = [task(1), task(2), task(3)];
    const { rerender } = render(<TerminalStack tasks={tasks} selectedId={1} {...stable} />);
    expect(h.renders).toHaveLength(3);
    h.renders = [];
    rerender(<TerminalStack tasks={tasks.map((t) => (t.id === 2 ? { ...t, lastActivityAt: 50 } : t))} selectedId={1} {...stable} />);
    expect(h.renders).toEqual([]);
  });

  it('a parent render with new callbacks of the same meaning redraws no terminal', () => {
    const tasks = [task(1), task(2)];
    const props = () => ({
      initialPromptFor: () => null,
      spawnArgsFor: () => undefined,
      sessionNameFor: () => undefined,
    });
    const forgetResume = () => {};
    const { rerender } = render(<TerminalStack tasks={tasks} selectedId={1} {...props()} forgetResume={forgetResume} />);
    h.renders = [];
    rerender(<TerminalStack tasks={[...tasks]} selectedId={1} {...props()} forgetResume={forgetResume} />);
    expect(h.renders).toEqual([]);
  });

  // Every field but lastActivityAt reaches the terminal, read today or not.
  // id and worktreePath are in the key: a change there mounts a new terminal.
  for (const key of Object.keys(CHANGED) as (keyof Task)[]) {
    if (key === 'lastActivityAt') continue;
    it(`a change to ${key} reaches that terminal, and only it`, () => {
      const tasks = [task(1), task(2)];
      const { rerender } = render(<TerminalStack tasks={tasks} selectedId={1} {...stable} />);
      h.renders = [];
      h.mounts = [];
      const next = { ...tasks[1]!, [key]: CHANGED[key] } as Task;
      rerender(<TerminalStack tasks={[tasks[0]!, next]} selectedId={1} {...stable} />);
      expect(h.renders).toHaveLength(1);
      expect(h.renders[0]!.task).toBe(next);
      if (key === 'id' || key === 'worktreePath') expect(h.mounts).toEqual([next.id]);
      else expect(h.mounts).toEqual([]);
    });
  }

  it('the selection redraws the two terminals whose `active` changed', () => {
    const tasks = [task(1), task(2), task(3)];
    const { rerender } = render(<TerminalStack tasks={tasks} selectedId={1} {...stable} />);
    h.renders = [];
    rerender(<TerminalStack tasks={tasks} selectedId={3} {...stable} />);
    expect(h.renders.map((p) => [p.task.id, p.active])).toEqual([
      [1, false],
      [3, true],
    ]);
  });

  it('a changed initial prompt, spawn args or session name redraws that terminal', () => {
    const tasks = [task(1), task(2)];
    const args = ['--resume', 's-2', '--fork-session'];
    const { rerender } = render(<TerminalStack tasks={tasks} selectedId={1} {...stable} />);
    for (const [name, over] of [
      ['initialPrompt', { initialPromptFor: (t: Task) => (t.id === 2 ? 'Do it' : null) }],
      ['spawnArgs', { spawnArgsFor: (t: Task) => (t.id === 2 ? args : undefined) }],
      ['sessionName', { sessionNameFor: (t: Task) => (t.id === 2 ? 'Task 2 (fork)' : undefined) }],
    ] as const) {
      h.renders = [];
      rerender(<TerminalStack tasks={tasks} selectedId={1} {...stable} {...over} />);
      expect(h.renders.map((p) => p.task.id), name).toEqual([2]);
      h.renders = [];
      rerender(<TerminalStack tasks={tasks} selectedId={1} {...stable} />);
    }
    expect(h.renders.at(-1)?.sessionName).toBeUndefined();
  });

  it('passes what it was given, and Start a Fresh Session forgets that task’s resume', () => {
    const forgetResume = vi.fn();
    const args = ['--resume', 's-2'];
    render(
      <TerminalStack
        tasks={[task(1), task(2)]}
        selectedId={2}
        initialPromptFor={(t) => (t.id === 1 ? 'Hello' : null)}
        spawnArgsFor={(t) => (t.id === 2 ? args : undefined)}
        sessionNameFor={(t) => `name-${t.id}`}
        forgetResume={forgetResume}
      />,
    );
    const [one, two] = h.renders;
    expect(one).toMatchObject({ active: false, initialPrompt: 'Hello', spawnArgs: undefined, sessionName: 'name-1' });
    expect(two).toMatchObject({ active: true, initialPrompt: undefined, spawnArgs: args, sessionName: 'name-2' });
    two!.onFreshStart?.();
    expect(forgetResume).toHaveBeenCalledWith(2);
  });

  it('a new forgetResume reaches the terminals', () => {
    const first = vi.fn();
    const second = vi.fn();
    const tasks = [task(1)];
    const { rerender } = render(<TerminalStack tasks={tasks} selectedId={1} {...stable} forgetResume={first} />);
    rerender(<TerminalStack tasks={tasks} selectedId={1} {...stable} forgetResume={second} />);
    h.renders.at(-1)!.onFreshStart?.();
    expect(second).toHaveBeenCalledWith(1);
    expect(first).not.toHaveBeenCalled();
  });
});

describe('terminalTaskEqual', () => {
  it('ignores lastActivityAt and nothing else', () => {
    const a = task(1);
    expect(terminalTaskEqual(a, { ...a, lastActivityAt: 999 })).toBe(true);
    for (const key of Object.keys(CHANGED) as (keyof Task)[]) {
      if (key === 'lastActivityAt') continue;
      expect(terminalTaskEqual(a, { ...a, [key]: CHANGED[key] } as Task), key).toBe(false);
    }
  });

  it('counts a field one side lacks', () => {
    const a = task(1);
    const extra = { ...a, later: 1 } as unknown as Task;
    expect(terminalTaskEqual(a, extra)).toBe(false);
    expect(terminalTaskEqual(extra, a)).toBe(false);
  });
});
