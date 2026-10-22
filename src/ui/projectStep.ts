/**
 * Which project tab ⇧⌘[ / ⇧⌘] lands on.
 *
 * Pure, so the wrap and the edge cases are tested without the app: the
 * binding in App passes the tab keys in bar order and selects what comes
 * back, exactly as ⌥digit does.
 */

/**
 * The key `delta` tabs away from `activeKey`, stopping at the first and last
 * tab like ⌘[ / ⌘] stop at the first and last task (`step` in TaskList.tsx).
 * Null when there is nowhere to go: fewer than two tabs, or already at that
 * end. An active key that is not in the list (nothing selected yet) enters
 * from the matching end, as the task step does: ⇧⌘] the first tab, ⇧⌘[ the
 * last.
 */
export function stepProjectTab(keys: readonly string[], activeKey: string | null, delta: number): string | null {
  if (keys.length < 2) return null;
  const current = activeKey === null ? -1 : keys.indexOf(activeKey);
  const next = current === -1 ? (delta > 0 ? 0 : keys.length - 1) : current + delta;
  const clamped = Math.min(keys.length - 1, Math.max(0, next));
  return clamped === current ? null : (keys[clamped] ?? null);
}
