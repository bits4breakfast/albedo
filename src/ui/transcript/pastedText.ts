/**
 * Collapsed text pastes in the message box, as Claude Code does it: a large
 * paste is kept aside and the box shows `[Pasted text #1 +42 lines]` in its
 * place, so a log or a stack trace does not bury what you are typing around
 * it. The real text goes back in when the message is sent.
 *
 * Pure: the composer owns the store and the textarea.
 */

/** Pastes at or below this stay inline: a short snippet reads fine as itself. */
export const COLLAPSE_MIN_LINES = 3;
export const COLLAPSE_MIN_CHARS = 600;

const PLACEHOLDER_RE = /\[Pasted text #(\d+) \+\d+ lines?\]/g;

export function lineCount(text: string): number {
  return text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n').length;
}

/** Whether a text paste is big enough to collapse. */
export function shouldCollapse(text: string): boolean {
  return lineCount(text) >= COLLAPSE_MIN_LINES || text.length > COLLAPSE_MIN_CHARS;
}

export function placeholderFor(id: number, text: string): string {
  const n = lineCount(text);
  return `[Pasted text #${id} +${n} line${n === 1 ? '' : 's'}]`;
}

/**
 * The draft with every intact placeholder replaced by its text. A placeholder
 * the user edited is no longer intact and stays as typed; one they deleted is
 * simply gone, and so is its text -- deleting the token is how you drop it.
 */
export function expandPastes(draft: string, store: ReadonlyMap<number, string>): string {
  if (store.size === 0) return draft;
  return draft.replace(PLACEHOLDER_RE, (whole, id: string) => store.get(Number(id)) ?? whole);
}

/** A queued message as one short line: a pasted block reads as a mention of it. */
export function queuedLabel(text: string): string {
  return text.replace(/<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content\b[^>]*>/g, '[pasted text]').trim();
}
