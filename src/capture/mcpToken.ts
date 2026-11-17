/**
 * Each session's MCP token (#427): a random value Albedo makes for every
 * spawn and hands Albedo's MCP server beside `ALBEDO_TASK_ID`
 * (`ALBEDO_TASK_TOKEN`). The server writes it into each inbox line, and the
 * GitHub tools act only on lines carrying their task's current token -- so a
 * line another session appended to this task's inbox file, by mistake or
 * not, reads, removes or deletes nothing.
 *
 * In memory, one per task, replaced on every spawn: the session a task had
 * before a restart of its terminal, or of Albedo, is over. Never logged.
 */

const tokens = new Map<number, string>();

/** The token's shape, here and in the server (`parse_task_token`). */
export const TOKEN_PATTERN = /^[A-Za-z0-9-]{16,100}$/;

/** A new token for a task's next session, replacing any it had. */
export function newTaskToken(taskId: number): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  tokens.set(taskId, token);
  return token;
}

/** Whether `token` is the task's current one. A task with none accepts nothing. */
export function isTaskToken(taskId: number, token: string | null): boolean {
  const current = tokens.get(taskId);
  return current !== undefined && token !== null && token === current;
}

/** Test seam. */
export function __setTaskTokenForTests(taskId: number, token: string | null): void {
  if (token === null) tokens.delete(taskId);
  else tokens.set(taskId, token);
}
