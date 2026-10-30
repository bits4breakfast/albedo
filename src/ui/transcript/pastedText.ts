/**
 * Collapsed text pastes in the message box, as Claude Code does it: a large
 * paste is kept aside and the box shows `[Pasted text #1 +42 lines]` in its
 * place, so a log or a stack trace does not bury what you are typing around
 * it. Unlike Claude Code's, the paste can be looked at, removed, or put back
 * as ordinary text before sending (PastedTexts.tsx). The real text goes back
 * in when the message is sent -- `expandPastes`, called from the composer's
 * `send` and nowhere else.
 *
 * A token stands for its paste only while it is intact: exactly the text
 * `placeholderFor` wrote, id and line count alike. Edit a character of it and
 * it is plain text, and its paste is no longer part of the message -- never
 * sent, never kept with the draft. Moving it whole (cut and paste) keeps it.
 *
 * Pure: the composer owns the store and the textarea.
 */

import { actionLabelOf } from './envelopes';

/*
   Claude Code's own threshold, read from its bundle (2.1.314, the prompt
   input's paste handler): a paste collapses when it is longer than 800
   characters, or has more line breaks than `min(rows - 10, 2)` -- 2 on any
   terminal 12 rows or taller -- counting `\r\n`, `\r` and `\n` alike. So
   three line breaks collapse and two do not. Albedo uses the same numbers,
   so a paste collapses in the box exactly when it would in the terminal.
*/
/** A paste longer than this collapses. */
export const COLLAPSE_MAX_CHARS = 800;
/** A paste with more line breaks than this collapses. */
export const COLLAPSE_MAX_BREAKS = 2;

/**
 * Any intact-looking token; `intactTokens` then checks it against its paste.
 * The `+N lines` form is Claude Code's, and drafts saved before this file
 * changed hold it, so it stays.
 */
const PLACEHOLDER_RE = /\[Pasted text #(\d+) \+\d+ lines?\]/g;

/** Lines as the token reports them: a trailing line break does not start one. */
export function lineCount(text: string): number {
  return text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n').length;
}

/** Line breaks as Claude Code counts them for its threshold. */
export function lineBreaks(text: string): number {
  return (text.match(/\r\n|\r|\n/g) ?? []).length;
}

/** Whether a text paste is big enough to collapse (see the numbers above). */
export function shouldCollapse(text: string): boolean {
  return text.length > COLLAPSE_MAX_CHARS || lineBreaks(text) > COLLAPSE_MAX_BREAKS;
}

export function placeholderFor(id: number, text: string): string {
  const n = lineCount(text);
  return `[Pasted text #${id} +${n} line${n === 1 ? '' : 's'}]`;
}

/** Where an intact token sits in the draft: `[start, end)`. */
export interface PasteToken {
  id: number;
  start: number;
  end: number;
}

/**
 * Every intact token in the draft, in order: the id is in the store, and the
 * token is exactly what `placeholderFor` writes for that paste. A token whose
 * number or line count was edited is not one.
 */
export function intactTokens(draft: string, store: ReadonlyMap<number, string>): PasteToken[] {
  if (store.size === 0) return [];
  const out: PasteToken[] = [];
  for (const m of draft.matchAll(PLACEHOLDER_RE)) {
    const id = Number(m[1]);
    const text = store.get(id);
    if (text === undefined || m[0] !== placeholderFor(id, text)) continue;
    out.push({ id, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * The draft with every intact token replaced by its paste. A token the user
 * edited is no longer intact and stays as typed; one they deleted is simply
 * gone, and so is its text -- deleting the token is how you drop it.
 */
export function expandPastes(draft: string, store: ReadonlyMap<number, string>): string {
  const tokens = intactTokens(draft, store);
  if (tokens.length === 0) return draft;
  let out = '';
  let at = 0;
  for (const t of tokens) {
    out += draft.slice(at, t.start) + (store.get(t.id) ?? '');
    at = t.end;
  }
  return out + draft.slice(at);
}

/**
 * The pastes the draft still uses, in order of first appearance, each once.
 * What the chips show, and what a draft keeps: a paste whose token is gone
 * is never stored with it.
 */
export function pastesIn(draft: string, store: ReadonlyMap<number, string>): Map<number, string> {
  const used = new Map<number, string>();
  for (const t of intactTokens(draft, store)) {
    const text = store.get(t.id);
    if (text !== undefined && !used.has(t.id)) used.set(t.id, text);
  }
  return used;
}

/** Where paste `id`'s intact tokens are, in order. Usually one. */
export function tokenRanges(draft: string, store: ReadonlyMap<number, string>, id: number): PasteToken[] {
  return intactTokens(draft, store).filter((t) => t.id === id);
}

/** The draft with each range replaced by `insert`. Ranges in order, not overlapping. */
export function replaceRanges(draft: string, ranges: readonly PasteToken[], insert: string): string {
  let out = draft;
  for (const r of [...ranges].reverse()) out = out.slice(0, r.start) + insert + out.slice(r.end);
  return out;
}

/** A queued message as one short line: a pasted block reads as a mention of it. */
export function queuedLabel(text: string): string {
  const action = actionLabelOf(text);
  if (action !== null) return action;
  return text.replace(/<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content\b[^>]*>/g, '[pasted text]').trim();
}
