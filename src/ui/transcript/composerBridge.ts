/**
 * Put text into a task's composer from elsewhere in the app -- review
 * comments, for now -- and learn when a message carrying it was sent.
 *
 * The composer does the sending, so everything it already handles (a held
 * message during a permission prompt, starting the session, a failed write)
 * applies unchanged, and the person can read and edit the text first.
 */

export interface ComposerInsert {
  taskId: number;
  text: string;
  /** Called with the text Claude Code received, each time a message is sent until it returns true. */
  onSent?: (sent: string) => boolean;
}

/** Returns true when it took the text: only the task's own composer does. */
type Listener = (insert: ComposerInsert) => boolean | void;
const listeners = new Set<Listener>();

/** Hand text to the task's composer. False when no composer for that task took it. */
export function insertIntoComposer(insert: ComposerInsert): boolean {
  let taken = false;
  for (const cb of [...listeners]) {
    try {
      if (cb(insert) === true) taken = true;
    } catch {
      /* a broken subscriber is not the sender's problem */
    }
  }
  return taken;
}

/** For the composer (which returns true for its task) and the shell (which only reacts). */
export function onComposerInsert(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
