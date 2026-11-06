/**
 * Escape never leaves full screen (#267).
 *
 * WKWebView hands a key event back to AppKit when the page did not handle it
 * -- did not call `preventDefault()`. AppKit turns Escape into
 * `cancelOperation:` up the responder chain, and a full-screen window answers
 * that by leaving full screen. So wherever nothing in the page took Escape
 * (the transcript, the guide, the task list), it threw the window out of full
 * screen; where something did (the terminal, the editor, a dialog), it didn't.
 * The owner never wants Escape to do that: ⌃⌘F and the green button still do.
 *
 * Every Escape keydown is marked handled -- but only once the app's own
 * listeners have had it. Some read `defaultPrevented` as "already handled"
 * (focusAreas.ts, SubagentInspector.tsx): setting it first would make them
 * ignore the key. So the capture listener, which runs before everything, only
 * adds a one-shot listener to the window's bubble phase; added during the
 * dispatch, it is the last listener the window runs for this event.
 *
 * Left alone: Escape while an input method is composing (it cancels the
 * composition), and an Escape something stopped from bubbling to the window
 * (whatever stopped it handled it, and nearly always prevented it too).
 */
export function keepEscapeFromLeavingFullscreen(target: Window = window): () => void {
  const onCapture = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return;
    const atEnd = (late: Event) => {
      if (late === e) e.preventDefault();
    };
    target.addEventListener('keydown', atEnd, { once: true });
  };
  target.addEventListener('keydown', onCapture, true);
  return () => target.removeEventListener('keydown', onCapture, true);
}
