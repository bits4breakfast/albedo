/**
 * The open tasks' terminals, stacked: one shown, the rest kept mounted so
 * their ptys live on (#364).
 *
 * Each terminal is drawn again only when something it uses changed. Every
 * capture burst gives App a new tasks array -- the task that got a row has a
 * new `lastActivityAt` -- and before this every open terminal re-rendered
 * with it, about four times a second per running task.
 *
 * What a slot compares (`terminalSlotPropsEqual`):
 *  - the task, field by field, except `lastActivityAt`: Terminal never reads
 *    it (Terminal.memo.test.tsx proves that), and it is the field a burst
 *    changes. Every other field counts, read or not, so a field Terminal
 *    starts reading later is never missed.
 *  - every other prop by identity. They are values, or callbacks that are
 *    stable for the slot (`onFreshStart` is made here from `forgetResume`).
 */

import { memo, useCallback } from 'react';
import type { Task } from '../types';
import Terminal from './Terminal';

export interface TerminalStackProps {
  /** The terminals to keep mounted: open, and not stopped. */
  tasks: readonly Task[];
  selectedId: number | null;
  initialPromptFor: (task: Task) => string | null;
  spawnArgsFor: (task: Task) => string[] | undefined;
  sessionNameFor: (task: Task) => string | undefined;
  /** The user gave up on a failed resume: drop the task's one-off args. */
  forgetResume: (taskId: number) => void;
}

export default function TerminalStack({
  tasks,
  selectedId,
  initialPromptFor,
  spawnArgsFor,
  sessionNameFor,
  forgetResume,
}: TerminalStackProps) {
  return (
    <div className="term-stack">
      {tasks.map((task) => (
        <TerminalSlot
          /* The folder is part of the identity: a task that moved
             starts again there, resuming the same session. */
          key={`${task.id}@${task.worktreePath}`}
          task={task}
          active={task.id === selectedId}
          initialPrompt={initialPromptFor(task) ?? undefined}
          spawnArgs={spawnArgsFor(task)}
          sessionName={sessionNameFor(task)}
          forgetResume={forgetResume}
        />
      ))}
    </div>
  );
}

export interface TerminalSlotProps {
  task: Task;
  active: boolean;
  initialPrompt: string | undefined;
  spawnArgs: string[] | undefined;
  sessionName: string | undefined;
  forgetResume: (taskId: number) => void;
}

/** The one task field that changes on every burst, and that Terminal never reads. */
const ACTIVITY_ONLY: ReadonlySet<string> = new Set<keyof Task>(['lastActivityAt']);

/** Same task for a terminal: every field equal, `lastActivityAt` aside. */
export function terminalTaskEqual(a: Task, b: Task): boolean {
  if (a === b) return true;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (ACTIVITY_ONLY.has(k)) continue;
    if (!Object.is(a[k as keyof Task], b[k as keyof Task])) return false;
  }
  return true;
}

export function terminalSlotPropsEqual(prev: TerminalSlotProps, next: TerminalSlotProps): boolean {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]) as Set<keyof TerminalSlotProps>;
  for (const k of keys) {
    if (k === 'task') {
      if (!terminalTaskEqual(prev.task, next.task)) return false;
    } else if (!Object.is(prev[k], next[k])) return false;
  }
  return true;
}

const TerminalSlot = memo(function TerminalSlot({
  task,
  active,
  initialPrompt,
  spawnArgs,
  sessionName,
  forgetResume,
}: TerminalSlotProps) {
  const id = task.id;
  const onFreshStart = useCallback(() => forgetResume(id), [forgetResume, id]);
  return (
    <Terminal
      task={task}
      active={active}
      initialPrompt={initialPrompt}
      spawnArgs={spawnArgs}
      onFreshStart={onFreshStart}
      sessionName={sessionName}
    />
  );
}, terminalSlotPropsEqual);
