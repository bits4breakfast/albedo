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
  /**
   * Review comments in the text, each found by a marker (its location). A
   * message held offline keeps the ids of those whose marker it carries, and
   * they are marked sent when it is delivered: by then this insert, and the
   * `onSent` above, may be gone.
   */
  comments?: ReadonlyArray<{ id: number; marker: string }>;
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

/** "Attach files" asked of a task's composer (⌘U). */
type AttachListener = (taskId: number) => boolean | void;
const attachListeners = new Set<AttachListener>();

/** Ask the task's composer to open its file picker. False when none is mounted. */
export function requestAttach(taskId: number): boolean {
  let taken = false;
  for (const cb of [...attachListeners]) {
    try {
      if (cb(taskId) === true) taken = true;
    } catch {
      /* as above */
    }
  }
  return taken;
}

export function onAttachRequest(cb: AttachListener): () => void {
  attachListeners.add(cb);
  return () => {
    attachListeners.delete(cb);
  };
}
