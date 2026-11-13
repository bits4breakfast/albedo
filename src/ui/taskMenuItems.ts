/**
 * The task's actions (#331): the one list behind both of its ⋯ menus, the
 * sidebar row's (right-click or its ⋯) and the task bar's. Same items, same
 * order, same rules for when an item is offered; each menu only draws it.
 *
 * Adding an action means adding it here (and, when it needs App's state,
 * to {@link TaskActions}); neither menu lists items of its own.
 *
 * Every action acts on the task it is given, which from a row may not be the
 * selected one. Only Review Guide moves the selection: it shows that task's
 * Guide tab, and a tab is something you look at.
 */

import type { Task } from '../types';
import type { PrStatus } from '../gh/prStatus';
import type { OverflowItem } from './OverflowMenu';
import { COMPACT } from './ClearContextButton';
import { remoteControlItem } from './RemoteMark';
import { remindMenuItem } from './reminders/menuItem';
import { renameMenuItem } from './taskRename';
import { canMarkDone, canMarkNotDone } from './taskGroups';
import { canFollowUp } from './followUp';
import { sendToSession } from './transcript/send';
import { normalizePath } from '../git/reconcile';
import { isUpdating } from '../guide/copyUpdate';

/**
 * What App does for an action that needs its state (a dialog, the
 * selection). Each is optional: an action with no handler is not offered.
 */
export interface TaskActions {
  /** Opens "Remind Me…" for the task. */
  remind?: (task: Task) => void;
  /** Shows the task's Review Guide, selecting the task first. */
  guide?: (task: Task) => void;
  /** A review task (#352): fetch its PR's head and move the copy to it. */
  updateReview?: (task: Task) => void;
  /** Opens the new-task dialog to fork the task's conversation (#332). */
  fork?: (task: Task) => void;
  /** Opens the move dialog: to the main checkout, or to a worktree. */
  move?: (task: Task) => void;
  /** Mark as Done, or with false, Mark as Not Done. */
  setDone?: (task: Task, done: boolean) => void;
  /** Opens the new-task dialog prefilled as a follow-up. */
  followUp?: (task: Task) => void;
  /** Opens the archive dialog. */
  archive?: (task: Task) => void;
  /** Opens the delete dialog. */
  delete?: (task: Task) => void;
}

/** What the items read about the task, kept current by `useTaskMenuFacts`. */
export interface TaskMenuFacts {
  /** Why Compact Now cannot go now (`commandBlocker`), or null. */
  compactBlocker: string | null;
  /** The task has a live pty. */
  live: boolean;
  /** Its Remote Control link while that is on, else null. */
  remoteUrl: string | null;
  /** Remote Control was asked for and has not settled (remoteWait.ts). */
  remoteWaiting?: boolean;
  /** Reminders still to come, counted beside "Remind Me…". */
  pendingReminders: number;
  /** Its PR as last polled, or null. */
  pr: PrStatus | null;
  /**
   * The task is the one on screen. A prompt that cannot go to its session
   * now waits in the message box, and only the task on screen has one.
   */
  shown: boolean;
  /** A send now would wait in the outbox (`useSendsWait`). */
  sendsWait: boolean;
}

/** Why Make Available Remotely cannot go from here, or null when it can. */
export function remoteBlocker(task: Pick<Task, 'status'>, facts: Pick<TaskMenuFacts, 'shown' | 'sendsWait'>): string | null {
  // On a waiting prompt with nothing held, the command is left in the
  // message box (`sendPrompt`), and a task not on screen has none to take it.
  if (task.status === 'blocked' && !facts.sendsWait && !facts.shown) {
    return 'Not available here while this task is waiting on you: open it to send this';
  }
  return null;
}

/**
 * The task's actions, in order, each group after the first starting with a
 * hairline. `rename` starts a rename where the menu is: on the row, or in the
 * task bar.
 */
export function taskMenuItems(
  task: Task,
  facts: TaskMenuFacts,
  actions: TaskActions,
  rename?: () => void,
): OverflowItem[] {
  const chat = task.kind === 'chat';
  const { remind, guide, updateReview, fork, move, setDone, followUp, archive, delete: del } = actions;

  const remote = remoteControlItem(task, facts.live, facts.remoteUrl);
  const remoteWhy = remote ? remoteBlocker(task, facts) : null;

  const groups: (OverflowItem | null | false | undefined)[][] = [
    [
      rename && renameMenuItem(rename),
      // Set one, and see or change the ones to come (#156).
      remind && remindMenuItem(facts.pendingReminders, () => remind(task)),
      // A branch's changes, grouped by what they do (#186). A chat has no
      // branch of its own to guide.
      !chat &&
        guide && {
          id: 'guide',
          label: 'Review Guide',
          aside: '⇧⌘G',
          title: 'This branch’s changes against its base, grouped by what they do',
          onSelect: () => guide(task),
        },
      // A review copy, brought up to its PR (#352). Always offered on a
      // review task, behind or not: git says whether there was anything.
      !!task.reviewUrl &&
        updateReview && {
          id: 'update-review',
          label: isUpdating(task.id) ? 'Updating from GitHub…' : 'Update from GitHub',
          disabled: isUpdating(task.id),
          title: 'Fetch the pull request’s head and move your copy to it',
          onSelect: () => updateReview(task),
        },
    ],
    [
      // The same /compact as the button by the message box, which appears
      // only past 70%; here at any fill.
      {
        id: 'compact',
        label: COMPACT.label,
        disabled: facts.compactBlocker !== null,
        title: facts.compactBlocker ?? COMPACT.hint,
        onSelect: () => void sendToSession(task.id, COMPACT.command, COMPACT.from),
      },
      // A copy of this conversation as a new task (#332). Hidden, not
      // disabled, with no session: there is nothing to copy, and Copy
      // Session ID below already says "No session yet".
      fork &&
        task.sessionId !== null && {
          id: 'fork',
          label: 'Fork Conversation…',
          title: 'A copy of this conversation, as a new task (opens the new-task dialog)',
          onSelect: () => fork(task),
        },
      // Hidden, not disabled, while on or with no session: the Remote mark
      // beside the title says the first.
      remote && (remoteWhy ? { ...remote, disabled: true, title: remoteWhy } : remote),
      {
        id: 'copy-session',
        label: 'Copy Session ID',
        disabled: task.sessionId === null,
        title: task.sessionId ?? 'No session yet',
        onSelect: () => {
          if (task.sessionId) void navigator.clipboard?.writeText(task.sessionId).catch(() => {});
        },
      },
    ],
    [
      {
        id: 'copy-path',
        label: 'Copy Worktree Path',
        title: task.worktreePath,
        onSelect: () => void navigator.clipboard?.writeText(task.worktreePath).catch(() => {}),
      },
      // Moving a chat to a worktree would turn it into work on a branch: out
      // of scope (#49), so not offered.
      !chat &&
        move && {
          id: 'move',
          label:
            normalizePath(task.worktreePath) === normalizePath(task.repoPath)
              ? 'Move to a Worktree…'
              : 'Move to Main Checkout…',
          title: 'Same branch, same conversation; uncommitted changes come along',
          onSelect: () => move(task),
        },
    ],
    /*
      Three verbs meet on one surface and the wording is what keeps them
      apart, so each says what it costs rather than just naming itself:

        Close    hide the tab -- view state, on the tab bar, not here
        Archive  out of the active list
        Delete   gone, worktree optional, CONVERSATION KEPT

      That last clause is the reason Delete can sit next to Archive at all,
      and the dialog states it too. The tooltips carry it, so the menu can
      be trusted before the dialog opens.
    */
    [
      setDone &&
        canMarkDone(task, facts.pr) && {
          id: 'mark-done',
          label: 'Mark as Done',
          title: 'Worktree and session kept',
          onSelect: () => setDone(task, true),
        },
      setDone &&
        canMarkNotDone(task, facts.pr) && {
          id: 'mark-not-done',
          label: 'Mark as Not Done',
          onSelect: () => setDone(task, false),
        },
      followUp &&
        canFollowUp(task, facts.pr) && {
          id: 'follow-up',
          label: 'Follow-Up…',
          title: 'New task from the base (opens the new-task dialog)',
          onSelect: () => followUp(task),
        },
      archive && {
        id: 'archive',
        label: 'Archive Task…',
        title: 'Out of the active list (opens the archive dialog)',
        onSelect: () => archive(task),
      },
      del && {
        id: 'delete',
        label: 'Delete Task…',
        tone: 'danger' as const,
        title: 'Worktree optional, conversation kept (opens the delete dialog)',
        onSelect: () => del(task),
      },
    ],
  ];

  const items: OverflowItem[] = [];
  for (const group of groups) {
    const present = group.filter((i): i is OverflowItem => !!i);
    present.forEach((item, i) => items.push(i === 0 && items.length > 0 ? { ...item, group: true } : item));
  }
  return items;
}
