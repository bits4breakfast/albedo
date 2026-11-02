/**
 * "Open this task's Review Guide", from wherever the button is (the Files
 * pane's head, the task's ⋯ menu, ⇧⌘G). The shell listens and shows the
 * Guide tab; the buttons need not know where it lives.
 *
 * ⇧⌘G also asks for focus (#217), so the guide's keys work at once even from
 * the message box or a terminal. A click does not: the pane's rule stays
 * "never take focus from someone typing". The request waits for the pane to
 * be on screen with something to focus (the branch may still be being read),
 * and lapses after {@link FOCUS_WINDOW_MS}, so a guide that was left before it
 * appeared never pulls focus later.
 */

import { useSyncExternalStore } from 'react';

type Listener = (taskId: number) => void;
const listeners = new Set<Listener>();

/** How long a focus request waits for the guide to appear. */
export const FOCUS_WINDOW_MS = 10_000;

let wanted: { taskId: number; at: number } | null = null;
let focusVersion = 0;
const focusListeners = new Set<() => void>();

/** Ask the shell to show `taskId`'s guide. False when nothing is listening. */
export function requestGuide(taskId: number, opts: { focus?: boolean } = {}): boolean {
  if (opts.focus) {
    wanted = { taskId, at: Date.now() };
    focusVersion++;
    for (const l of focusListeners) l();
  }
  for (const l of listeners) l(taskId);
  return listeners.size > 0;
}

export function onGuideRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True once, for the task whose guide asked for focus, within the window. */
export function takeGuideFocus(taskId: number, now = Date.now()): boolean {
  if (wanted === null || wanted.taskId !== taskId) return false;
  const fresh = now - wanted.at <= FOCUS_WINDOW_MS;
  wanted = null;
  return fresh;
}

/** Changes on every focus request: an effect that depends on it looks again. */
export function useGuideFocusRequests(): number {
  return useSyncExternalStore(
    (l) => {
      focusListeners.add(l);
      return () => focusListeners.delete(l);
    },
    () => focusVersion,
  );
}

/** Test seam. */
export function resetGuideFocusForTests(): void {
  wanted = null;
}
