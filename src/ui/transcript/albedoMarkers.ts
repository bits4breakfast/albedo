/**
 * Albedo's own markers in a message it sends to Claude Code.
 *
 * The message box sends plain text through the pty, and the transcript gets
 * back plain text. Where Albedo knows more about a part of the message than
 * the text says -- this part was pasted (#155); later, this is a reference to
 * another task or a file (#154) -- it wraps that part in a tag it owns:
 *
 *     <pasted-text id="1" lines="42">
 *     …the pasted text, byte for byte…
 *     </pasted-text id="1">
 *
 * A plain tag reads naturally to the model (it says what the part is), and
 * the transcript can find it again. This file is the one place that writes
 * and reads that shape; `envelopes.ts` turns what it finds into blocks, as it
 * does for Claude Code's envelopes.
 *
 * ## No escaping: the closing tag carries the id
 *
 * The content goes to Claude unchanged -- a pasted log or a pasted transcript
 * is not rewritten to make room for the tag. Instead the closing tag repeats
 * the opening tag's id, the way Claude Code closes `<pasted_content id="…">`,
 * and the writer picks an id whose tags appear nowhere else in the message
 * (`freeMarkerId`). So the first matching closing tag after an opening tag is
 * always that marker's own, whatever the content holds -- including other
 * markers, or this very format. Attribute values are XML-escaped.
 *
 * A marker without an id closes with a bare `</tag>`; that form is for short
 * content Albedo writes itself, never for something pasted.
 *
 * Conservative like the envelopes: only the tags in `MARKER_TAGS`, only when
 * closed, and an opening tag that is never closed is left as text.
 */

/** Every tag Albedo writes into a message. */
export const MARKER_TAGS = ['pasted-text'] as const;
export type MarkerTag = (typeof MARKER_TAGS)[number];

export interface Marker {
  tag: MarkerTag;
  /** Attribute values, unescaped. `id` among them when the marker has one. */
  attrs: Readonly<Record<string, string>>;
  /** What was wrapped, exactly as it was written. */
  content: string;
  /** Where the marker sits in the text it was found in: `[start, end)`. */
  start: number;
  end: number;
}

export type MarkerPart = { kind: 'text'; text: string } | { kind: 'marker'; marker: Marker };

const OPEN_RE = new RegExp(`<(${MARKER_TAGS.join('|')})((?:\\s[^<>]*)?)>`, 'g');
const ATTR_RE = /([A-Za-z][\w-]*)="([^"]*)"/g;

function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unescapeAttr(v: string): string {
  return v.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR_RE)) out[m[1] as string] = unescapeAttr(m[2] as string);
  return out;
}

function closeTag(tag: MarkerTag, id: string | undefined): string {
  return id === undefined ? `</${tag}>` : `</${tag} id="${escapeAttr(id)}">`;
}

/**
 * The marker as it goes into the message. The content sits on lines of its
 * own, so the tags never run into the text; `findMarker` takes those two line
 * breaks off again, so the content round-trips exactly.
 */
export function encodeMarker(tag: MarkerTag, attrs: Readonly<Record<string, string>>, content: string): string {
  const list = Object.entries(attrs).map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('');
  return `<${tag}${list}>\n${content}\n${closeTag(tag, attrs.id)}`;
}

/**
 * An id for a `tag` marker whose tags appear nowhere in `message` (everything
 * the message will hold: what was typed and every part to be wrapped), so the
 * marker's closing tag cannot be met early and no typed or pasted text can
 * pass for its opening one. `preferred` first, then the numbers after it.
 */
export function freeMarkerId(tag: MarkerTag, message: string, preferred = 1): string {
  for (let k = Math.max(1, Math.floor(preferred)); ; k++) {
    const id = String(k);
    if (!message.includes(`<${tag} id="${id}"`) && !message.includes(closeTag(tag, id))) return id;
  }
}

/** The first complete marker at or after `from`, or null. */
export function findMarker(text: string, from = 0): Marker | null {
  if (!text.includes('<', from)) return null;
  OPEN_RE.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = OPEN_RE.exec(text)) !== null) {
    const tag = m[1] as MarkerTag;
    const attrs = parseAttrs(m[2] ?? '');
    const openEnd = m.index + m[0].length;
    const close = closeTag(tag, attrs.id);
    const at = text.indexOf(close, openEnd);
    if (at < 0) continue; // never closed: text, and look on past this tag
    let content = text.slice(openEnd, at);
    if (content.startsWith('\n')) content = content.slice(1);
    if (content.endsWith('\n')) content = content.slice(0, -1);
    return { tag, attrs, content, start: m.index, end: at + close.length };
  }
  return null;
}

/** The text cut into what is plain and what is a marker, in order. */
export function splitMarkers(text: string): MarkerPart[] {
  const out: MarkerPart[] = [];
  let at = 0;
  for (let mk = findMarker(text, 0); mk !== null; mk = findMarker(text, at)) {
    if (mk.start > at) out.push({ kind: 'text', text: text.slice(at, mk.start) });
    out.push({ kind: 'marker', marker: mk });
    at = mk.end;
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) });
  return out;
}

/** `[start, end)` of every marker in the text: what must travel as one piece. */
export function markerSpans(text: string): Array<[number, number]> {
  return splitMarkers(text).flatMap((p) => (p.kind === 'marker' ? [[p.marker.start, p.marker.end] as [number, number]] : []));
}
