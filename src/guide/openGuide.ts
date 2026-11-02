/**
 * "Open this task's Review Guide", from wherever the button is (the Files
 * pane's head, the task's ⋯ menu). The shell listens and shows the Guide tab;
 * the buttons need not know where it lives.
 */

type Listener = (taskId: number) => void;
const listeners = new Set<Listener>();

/** Ask the shell to show `taskId`'s guide. False when nothing is listening. */
export function requestGuide(taskId: number): boolean {
  for (const l of listeners) l(taskId);
  return listeners.size > 0;
}

export function onGuideRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
