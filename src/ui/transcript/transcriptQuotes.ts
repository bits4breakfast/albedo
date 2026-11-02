/**
 * Comments on passages of the transcript (#187), as they wait and as they go.
 *
 * Select text in one message, comment on it, collect several, send them
 * together. While they wait they are part of the task's draft (drafts.ts);
 * when the message box sends, each becomes a Markdown quote of the passage
 * and the comment under it, in transcript order, then the box's own text:
 *
 *     <transcript-quote id="1" message="4512">
 *     > Production already runs 8.2.35, from our own build.
 *     </transcript-quote id="1">
 *
 *     How do you know? Which image tag did you check?
 *
 * The quote is plain Markdown, which needs nothing from Claude Code; the
 * marker around it (albedoMarkers.ts) names the row it came from, so the
 * transcript draws it as a quote that takes you back to the passage. A
 * passage from a code block or a tool's output is fenced inside the quote.
 * Nothing in the passage or the comment is rewritten: an `@path` or an image
 * path in either reaches Claude Code exactly as written.
 *
 * Pure, apart from the types: the store is drafts.ts, the UI PassageComments
 * and WaitingComments.
 */

import { encodeMarker, freeMarkerId, splitMarkers, type Marker } from './albedoMarkers';

/** A comment on a passage, waiting to be sent. */
export interface TranscriptComment {
  /** Local id, unique within the task's draft. */
  id: string;
  /** The transcript row the passage is in (`Message.id`). */
  messageId: number;
  /** The passage, as it was selected. */
  quote: string;
  /** Selected inside a code block or a tool's output: sent fenced. */
  code: boolean;
  /** The code block's language, when it named one. */
  lang?: string;
  /** What the person wrote about it. */
  comment: string;
  /** The row's time (`Message.ts`): the first key of transcript order. */
  at: number;
  /** Non-blank characters before the passage in its row: the last key, and which occurrence it is. */
  offset: number;
  addedAt: number;
}

export const QUOTE_TAG = 'transcript-quote' as const;

/** Transcript order: the row's time, then the row, then where in the row. */
export function inTranscriptOrder(comments: readonly TranscriptComment[]): TranscriptComment[] {
  return [...comments].sort((a, b) => a.at - b.at || a.messageId - b.messageId || a.offset - b.offset || a.addedAt - b.addedAt);
}

/** A fence longer than any run of backticks in the code, so the code cannot close it. */
function fenceFor(code: string): string {
  const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** The passage as a Markdown quote: `> ` on every line, code fenced inside it. */
export function quoteMarkdown(c: Pick<TranscriptComment, 'quote' | 'code' | 'lang'>): string {
  const text = c.quote.replace(/\r\n?/g, '\n');
  const fence = fenceFor(text);
  const body = c.code ? `${fence}${c.lang ?? ''}\n${text}\n${fence}` : text;
  return body
    .split('\n')
    .map((l) => (l.length > 0 ? `> ${l}` : '>'))
    .join('\n');
}

/**
 * What the message box sends: every comment as its quote and its text, in
 * transcript order, then `box` (already with its pastes and references in
 * their markers) when it holds anything. Each quote's id is free in the
 * whole message (`freeMarkerId`), so a passage that itself holds a quote
 * marker -- a transcript quoting one -- cannot close it early.
 */
export function composeWithComments(comments: readonly TranscriptComment[], box: string): string {
  if (comments.length === 0) return box;
  const sorted = inTranscriptOrder(comments);
  const whole = [box, ...sorted.flatMap((c) => [c.quote, c.comment])].join('\n');
  let taken = '';
  const parts: string[] = [];
  sorted.forEach((c, i) => {
    const id = freeMarkerId(QUOTE_TAG, `${whole}\n${taken}`, i + 1);
    taken += `\n<${QUOTE_TAG} id="${id}"`;
    const quote = encodeMarker(QUOTE_TAG, { id, message: String(c.messageId) }, quoteMarkdown(c));
    const comment = c.comment.trim();
    parts.push(comment.length > 0 ? `${quote}\n\n${comment}` : quote);
  });
  if (box.trim().length > 0) parts.push(box);
  return parts.join('\n\n');
}

/** A quote marker read back: the passage without its `> ` and its fence. */
export interface QuoteOf {
  /** The source row, or null when the marker does not name one. */
  messageId: number | null;
  text: string;
  code: boolean;
  lang: string | null;
}

export function isQuoteMarker(m: Marker): boolean {
  return m.tag === QUOTE_TAG;
}

/** The inverse of `quoteMarkdown`, for what a marker holds. */
export function quoteOf(m: Marker): QuoteOf {
  const n = Number(m.attrs.message);
  const messageId = m.attrs.message !== undefined && Number.isInteger(n) && n > 0 ? n : null;
  const lines = m.content.split('\n').map((l) => l.replace(/^> ?/, ''));
  const open = /^(`{3,})(\S*)\s*$/.exec(lines[0] ?? '');
  if (open && lines.length >= 2 && lines[lines.length - 1] === open[1]) {
    return { messageId, text: lines.slice(1, -1).join('\n'), code: true, lang: open[2] || null };
  }
  return { messageId, text: lines.join('\n'), code: false, lang: null };
}

/** The first line with something on it, and how many lines follow it. */
export function foldQuote(text: string): { first: string; more: number } {
  const lines = text.replace(/\n+$/, '').split('\n');
  const at = Math.max(0, lines.findIndex((l) => l.trim().length > 0));
  return { first: (lines[at] ?? '').trim(), more: lines.length - at - 1 };
}

function moreLines(more: number): string {
  return more > 0 ? ` +${more} line${more === 1 ? '' : 's'}` : '';
}

/** A quote as one short line, for the "Sending" echo and the Queued band: `> first line +12 lines`. */
export function quoteMention(m: Marker): string {
  const { first, more } = foldQuote(quoteOf(m).text);
  return `> ${first}${moreLines(more)}`;
}

// ---------------------------------------------------------------------------
// The held-message editor: a quote stands as a token while it is edited
// ---------------------------------------------------------------------------

const EXCERPT_CHARS = 40;

/** `[Quote #1: Production already runs 8.2.35… +2 lines]`. */
export function quoteToken(id: number, raw: string): string {
  const m = splitMarkers(raw, [QUOTE_TAG]).find((p) => p.kind === 'marker');
  const { first, more } = foldQuote(m && m.kind === 'marker' ? quoteOf(m.marker).text : raw);
  const clean = first.replace(/[[\]]/g, '');
  const excerpt = clean.length > EXCERPT_CHARS ? `${clean.slice(0, EXCERPT_CHARS).trimEnd()}…` : clean;
  return `[Quote #${id}: ${excerpt}${moreLines(more)}]`;
}

/**
 * A held body as the editor shows it: each quote marker as a token, the
 * marker itself kept aside by the token's number. The inverse of `markQuotes`.
 */
export function unmarkQuotes(body: string): { text: string; quotes: Map<number, string> } {
  const quotes = new Map<number, string>();
  if (!body.includes(`<${QUOTE_TAG}`)) return { text: body, quotes };
  let text = '';
  for (const p of splitMarkers(body, [QUOTE_TAG])) {
    if (p.kind === 'text') {
      text += p.text;
      continue;
    }
    const raw = body.slice(p.marker.start, p.marker.end);
    const id = quotes.size + 1;
    quotes.set(id, raw);
    text += quoteToken(id, raw);
  }
  return { text, quotes };
}

/** Every token still exactly as `quoteToken` wrote it goes back to its marker; an edited one is text. */
export function markQuotes(text: string, quotes: ReadonlyMap<number, string>): string {
  if (quotes.size === 0) return text;
  return text.replace(/\[Quote #(\d+): [^\]\n]*\]/g, (token, n: string) => {
    const raw = quotes.get(Number(n));
    return raw !== undefined && quoteToken(Number(n), raw) === token ? raw : token;
  });
}
