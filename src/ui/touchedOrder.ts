/**
 * The touched-files list's current order, per task, so the editor can step to
 * the next or previous changed file without owning the list. The list
 * publishes; the editor reads and subscribes. Worktree-relative paths only:
 * files outside the worktree are not part of the change set being reviewed.
 */

const orders = new Map<number, readonly string[]>();
const listeners = new Set<() => void>();

export function setTouchedOrder(taskId: number, paths: readonly string[]): void {
  const prev = orders.get(taskId);
  if (prev && prev.length === paths.length && prev.every((p, i) => p === paths[i])) return;
  orders.set(taskId, paths);
  for (const cb of [...listeners]) cb();
}

export function touchedOrder(taskId: number): readonly string[] {
  return orders.get(taskId) ?? [];
}

export function onTouchedOrderChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** The neighbour of `path` in `order`, wrapping at both ends; null if absent. */
export function neighbour(order: readonly string[], path: string, dir: 1 | -1): string | null {
  const i = order.indexOf(path);
  if (i < 0 || order.length < 2) return null;
  return order[(i + dir + order.length) % order.length] ?? null;
}
