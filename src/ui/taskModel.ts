/**
 * The model a task's session should run on, when it is not the user's
 * Claude Code default.
 *
 * Kept in local storage rather than the tasks table on purpose: the schema is a
 * shared contract, and this is a per-machine preference about how to launch a
 * process. It matters on every spawn, including a resume after restart -- a
 * resumed session otherwise falls back to the default and silently switches
 * models. Every access is wrapped: storage can throw in a locked-down WebView.
 */

import { KEYS, readPersisted, writePersisted, type Codec } from './persisted';

/** Blank is the default model: it is removed, never stored. */
export const taskModelCodec: Codec<string | null> = {
  decode: (raw) => (raw.trim().length > 0 ? raw : null),
  encode: (model) => (model === null || model.trim() === '' ? null : model.trim()),
};

/** The task's model (a catalog id or an alias like `opus`), or null for the default. */
export function getTaskModel(taskId: number): string | null {
  return readPersisted(KEYS.taskModel(taskId), taskModelCodec, null);
}

/**
 * Set, or with null clear, the task's model. Not remembered when storage
 * throws: the session simply uses the default next time.
 */
export function setTaskModel(taskId: number, model: string | null): void {
  writePersisted(KEYS.taskModel(taskId), taskModelCodec, model);
}
