/**
 * React views of the reminders table, refreshed on every change
 * (`onRemindersChanged`). A failed read keeps what was last shown.
 */

import { useEffect, useState } from 'react';
import { cardTaskIds, listCards, listPendingReminders, onRemindersChanged } from '../../reminders';
import type { Reminder } from '../../types';

function useReminderQuery<T>(key: string | null, read: () => Promise<T>, empty: T): T {
  const [state, setState] = useState<{ key: string | null; value: T }>({ key, value: empty });
  useEffect(() => {
    if (key === null) return;
    let alive = true;
    const load = () => {
      read().then(
        (value) => {
          if (alive) setState({ key, value });
        },
        (err: unknown) => console.warn('[reminders] read failed:', err),
      );
    };
    load();
    const off = onRemindersChanged(load);
    return () => {
      alive = false;
      off();
    };
    // `key` names everything `read` reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? state.value : empty;
}

const NO_REMINDERS: Reminder[] = [];
const NO_IDS: ReadonlySet<number> = new Set();

/** The cards a task shows. */
export function useReminderCards(taskId: number | null): Reminder[] {
  return useReminderQuery(taskId === null ? null : `cards:${taskId}`, () => listCards(taskId!), NO_REMINDERS);
}

/** A task's reminders still to come. */
export function usePendingReminders(taskId: number | null): Reminder[] {
  return useReminderQuery(taskId === null ? null : `pending:${taskId}`, () => listPendingReminders(taskId!), NO_REMINDERS);
}

/** Every task showing a card: the rows that say "Reminder". */
export function useReminderTaskIds(): ReadonlySet<number> {
  return useReminderQuery('marks', async () => new Set(await cardTaskIds()) as ReadonlySet<number>, NO_IDS);
}
