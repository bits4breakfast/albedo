import type { Task } from '../types';
import { getPrStatus } from '../gh/prStore';
import { useCommandBlocker } from './ClearContextButton';
import { useRemoteControlUrl } from './RemoteMark';
import { useRemoteWait } from './remoteWait';
import { usePendingReminders } from './reminders/useReminders';
import { usePtyLiveSince } from './Terminal';
import { useSendsWait } from './transcript/send';
import { useCompacting } from './transcript/commandEcho';
import type { TaskMenuFacts } from './taskMenuItems';

/**
 * What the task's ⋯ items read about `task` (#331), kept current: for the
 * task bar the selected task, for the row menu the row's own -- never the
 * selected one's facts on another task's menu. Null task, inert facts.
 */
export function useTaskMenuFacts(task: Task | null, shown: boolean): TaskMenuFacts {
  const id = task?.id ?? null;
  const compactBlocker = useCommandBlocker(task);
  const live = usePtyLiveSince(id) !== null;
  const remoteUrl = useRemoteControlUrl(task);
  // Make Available Remotely reads it (`remoteControlItem`): re-render on it.
  const remoteWaiting = useRemoteWait(id) !== null;
  const pendingReminders = usePendingReminders(id).length;
  const sendsWait = useSendsWait(id);
  const compacting = useCompacting(id);
  return {
    compactBlocker,
    live,
    remoteUrl,
    remoteWaiting,
    pendingReminders,
    pr: id === null ? null : (getPrStatus(id) ?? null),
    shown,
    sendsWait,
    compacting,
  };
}
