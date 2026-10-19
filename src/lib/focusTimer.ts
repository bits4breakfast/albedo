/**
 * Call `done` once the window has had focus for `ms` in total. Time spent in
 * another app does not count, so a confirmation is never missed because you
 * looked away. Returns a cancel function.
 */
export function dismissAfterFocusedTime(
  ms: number,
  done: () => void,
  win: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
  hasFocus: () => boolean = () => document.hasFocus(),
): () => void {
  let left = ms;
  let startedAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    if (timer !== null) return;
    startedAt = Date.now();
    timer = setTimeout(() => {
      timer = null;
      cancel();
      done();
    }, left);
  };
  const pause = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    left = Math.max(0, left - (Date.now() - startedAt));
  };
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    win.removeEventListener('focus', run);
    win.removeEventListener('blur', pause);
  };
  win.addEventListener('focus', run);
  win.addEventListener('blur', pause);
  if (hasFocus()) run();
  return cancel;
}
