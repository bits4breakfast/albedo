/**
 * Which project tab ⇧⌘[ / ⇧⌘] lands on.
 *
 * Pure, so the wrap and the edge cases are tested without the app: the
 * binding in App passes the tab keys in bar order and selects what comes
 * back, exactly as ⌥digit does.
 */

/**
 * The key `delta` tabs away from `activeKey`, wrapping at both ends. Null when
 * there is nowhere to go: fewer than two tabs. An active key that is not in
 * the list (nothing selected yet) counts as sitting just outside it, so ⇧⌘]
 * lands on the first tab and ⇧⌘[ on the last.
 */
export function stepProjectTab(keys: readonly string[], activeKey: string | null, delta: number): string | null {
  if (keys.length < 2) return null;
  const current = activeKey === null ? -1 : keys.indexOf(activeKey);
  if (current === -1) return (delta > 0 ? keys[0] : keys[keys.length - 1]) ?? null;
  const next = (((current + delta) % keys.length) + keys.length) % keys.length;
  return keys[next] ?? null;
}
