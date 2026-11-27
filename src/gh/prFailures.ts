/**
 * Tasks whose PR gh has never been able to answer for (#464 review): the PR
 * store holds `null` for them -- "none", as it always read for the badge --
 * but nothing may be decided on that null. My Review, "Create PR without
 * Review…" and the Guide's banner read it as "not known yet" instead: offline
 * at launch, gh logged out, a rate limit or no GitHub remote is not "no PR".
 *
 * Its own module, written by prStore.ts, so the readers need not import the
 * store (which many tests mock in part); with the store mocked, nothing is
 * unknown, as before.
 */

const unknown = new Set<number>();

/** prStore.ts only: whether the task's PR answer is a failure with nothing before it. */
export function notePrUnknown(taskId: number, on: boolean): void {
  if (on) unknown.add(taskId);
  else unknown.delete(taskId);
}

/** gh has never answered for this task's PR: its `null` is not "no PR". */
export function prUnknown(taskId: number): boolean {
  return unknown.has(taskId);
}

/** prStore.ts only, with its cache. */
export function clearPrUnknown(): void {
  unknown.clear();
}
