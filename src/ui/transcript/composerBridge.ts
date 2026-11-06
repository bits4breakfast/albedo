/**
 * Put text into a task's composer from elsewhere in the app, and learn when
 * a message carrying it was sent. (Review comments no longer come this way:
 * they wait in the composer's own queue, #222.)
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

/**
 * "Send the waiting comments" asked of a task's composer (#254): from the
 * Review Guide's Send Comments. The composer sends them as Send with an empty
 * box would, through the same gates, and leaves its draft alone.
 */
type SendCommentsListener = (taskId: number) => boolean | void;
const sendCommentsListeners = new Set<SendCommentsListener>();

/** False when no composer for that task took it: none mounted, or nothing waiting. */
export function requestSendComments(taskId: number): boolean {
  let taken = false;
  for (const cb of [...sendCommentsListeners]) {
    try {
      if (cb(taskId) === true) taken = true;
    } catch {
      /* as above */
    }
  }
  return taken;
}

export function onSendCommentsRequest(cb: SendCommentsListener): () => void {
  sendCommentsListeners.add(cb);
  return () => {
    sendCommentsListeners.delete(cb);
  };
}

/** "Show this task's transcript", heard by the shell (App), which owns the tabs. */
type ShowTranscriptListener = (taskId: number) => void;
const showTranscriptListeners = new Set<ShowTranscriptListener>();

export function onShowTranscriptRequest(cb: ShowTranscriptListener): () => void {
  showTranscriptListeners.add(cb);
  return () => {
    showTranscriptListeners.delete(cb);
  };
}

/**
 * Send the task's waiting comments, then show its transcript (#254, #258):
 * the Review Guide's and the Files pane's Send, and ⇧⌘S. False -- and the
 * tab stays -- when nothing was waiting or no composer took it.
 */
export function sendWaitingComments(taskId: number): boolean {
  if (!requestSendComments(taskId)) return false;
  for (const cb of [...showTranscriptListeners]) {
    try {
      cb(taskId);
    } catch {
      /* as above */
    }
  }
  return true;
}
