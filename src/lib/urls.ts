/**
 * URLs in transcript text.
 *
 * Only http and https are ever linkable: transcript text is model output, so a
 * `javascript:`, `file:` or custom-scheme URL must never become a click target.
 * Everything here is pure; opening is in `openUrl.ts`.
 */

const URL_RE = /https?:\/\/[^\s<>"'`]+/g;

/** Punctuation that ends a sentence rather than a URL. */
const TRAILING = /[.,;:!?'"\]}>]+$/;

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n += 1;
  return n;
}

/** Trim sentence punctuation off a matched URL; keep a `)` only if it is balanced. */
function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const before = url;
    url = url.replace(TRAILING, '');
    if (url.endsWith(')') && count(url, ')') > count(url, '(')) url = url.slice(0, -1);
    if (url === before) return url;
  }
}

/** The URL if it is a well-formed http(s) URL, else null. */
export function safeHttpUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** The host of an http(s) URL, for showing where a link really goes. */
export function hostOf(raw: string): string | null {
  const url = safeHttpUrl(raw);
  return url === null ? null : new URL(url).host;
}

/** Split text into plain runs and URLs, in order. No URL: the text, whole. */
export function splitUrls(text: string): Array<string | { url: string }> {
  const out: Array<string | { url: string }> = [];
  let last = 0;
  const re = new RegExp(URL_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const url = trimUrl(m[0]);
    if (safeHttpUrl(url) === null) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ url });
    last = m.index + url.length;
    re.lastIndex = last;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length === 0 ? [text] : out;
}
