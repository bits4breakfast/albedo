/**
 * A suggested edit carried in a review comment's body (#411).
 *
 * Stored as GitHub writes one -- a fenced `suggestion` block -- at the very
 * start of the body, followed by the comment's own text. No column of its
 * own: the body already goes everywhere a comment goes (a GitHub draft is
 * posted as it is stored), and a body is never cut.
 *
 * The block holds the lines that replace the commented ones, each ended by
 * a newline, so an empty block is a deletion -- GitHub reads it the same.
 * Its fence is longer than any run of backticks in the code, so code
 * holding ``` cannot close it.
 *
 * Only this file knows the shape. Pure.
 */

const OPEN = /^(`{3,})suggestion[ \t]*\n/;

export interface SplitBody {
  /** The suggested lines; [] replaces the commented lines with nothing. Null: no suggestion. */
  suggestion: string[] | null;
  /** The comment's own words, trimmed; may be empty when it is only a suggestion. */
  text: string;
}

/** A fence longer than any run of backticks in `lines`, at least ```. */
export function fenceFor(lines: readonly string[]): string {
  let longest = 2;
  for (const l of lines) for (const m of l.match(/`+/g) ?? []) longest = Math.max(longest, m.length);
  return '`'.repeat(longest + 1);
}

/** A body's suggestion, if it opens with one, and its own text. */
export function splitSuggestion(body: string): SplitBody {
  const open = OPEN.exec(body);
  if (!open) return { suggestion: null, text: body.trim() };
  const fence = open[1]!;
  const rest = body.slice(open[0].length);
  // The closing fence: a line of exactly the opening's backticks.
  const close = new RegExp(`(^|\\n)${fence}[ \\t]*(\\n|$)`).exec(rest);
  if (!close) return { suggestion: null, text: body.trim() };
  const inner = rest.slice(0, close.index);
  const suggestion = close[1] === '' ? [] : inner.split('\n');
  return { suggestion, text: rest.slice(close.index + close[0].length).trim() };
}

/** The body to store: the suggestion's block, if any, then the text. */
export function joinSuggestion(suggestion: readonly string[] | null, text: string): string {
  const words = text.trim();
  if (suggestion === null) return words;
  const fence = fenceFor(suggestion);
  const block = `${fence}suggestion\n${suggestion.map((l) => `${l}\n`).join('')}${fence}`;
  return words === '' ? block : `${block}\n${words}`;
}

/** What a textarea of code holds, as lines: empty is no lines at all (a deletion). */
export function linesOf(code: string): string[] {
  return code === '' ? [] : code.split('\n');
}

/** Whether a suggestion is the lines it would replace: no change at all. */
export function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((l, i) => l === b[i]);
}

/**
 * The suggestion to store from a box's code, against the lines it replaces:
 * null when it changes nothing, so an untouched box is no suggestion.
 */
export function suggestionFrom(code: string, lines: readonly string[]): string[] | null {
  // Compared as text first: one blank line and no lines are both '' in a box.
  if (code === lines.join('\n')) return null;
  const after = linesOf(code);
  return sameLines(after, lines) ? null : after;
}

/** The box's header: what the code replaces, or "no change" while it is the lines themselves. */
export function changeLabel(lines: readonly string[], code: string): string {
  if (code === lines.join('\n')) return 'no change';
  const after = linesOf(code);
  return sameLines(after, lines) ? 'no change' : replacesLabel(lines.length, after.length);
}

/** "replaces 3 lines with 1", "replaces 1 line with nothing". */
export function replacesLabel(before: number, after: number): string {
  const lines = (n: number) => (n === 1 ? '1 line' : `${n} lines`);
  return `replaces ${lines(before)} with ${after === 0 ? 'nothing' : after === 1 ? '1' : after}`;
}

/**
 * One line for a list that has room for one (the Files pane, the bar above a
 * file): the text's first line, or what the comment is when it is only a
 * suggestion.
 */
export function commentHeadline(body: string): string {
  const { suggestion, text } = splitSuggestion(body);
  if (text !== '') return text.split('\n')[0]!;
  return suggestion === null ? '' : 'Suggested change';
}

/**
 * A comment's words for a tooltip, which has room for all of them: the text,
 * led by "Suggested change" when it carries one. Never the fence.
 */
export function commentWords(body: string): string {
  const { suggestion, text } = splitSuggestion(body);
  if (suggestion === null) return text;
  return text === '' ? 'Suggested change' : `Suggested change\n\n${text}`;
}

/**
 * The indentation Tab inserts in a suggestion's box: the lines' own. A tab
 * when they are indented with tabs; otherwise as many spaces as their
 * indentation steps by (the greatest common divisor of the leading widths),
 * 4 when they say nothing.
 */
export function indentOf(lines: readonly string[]): string {
  if (lines.some((l) => l.startsWith('\t'))) return '\t';
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  let step = 0;
  for (const l of lines) {
    const n = /^ */.exec(l)![0].length;
    if (n > 0 && n < l.length) step = gcd(n, step);
  }
  return ' '.repeat(step >= 2 && step <= 8 ? step : 4);
}

/**
 * Tab in a suggestion's box: the indentation at the caret, replacing any
 * selection, instead of moving focus out of the box. Typed through the
 * browser's own editing (`insertText`) so ⌘Z undoes it with the rest; set
 * directly only where that is refused. The caller reads the value back.
 */
export function insertIndent(area: HTMLTextAreaElement, indent: string): void {
  area.focus();
  let typed = false;
  try {
    typed = typeof document.execCommand === 'function' && document.execCommand('insertText', false, indent);
  } catch {
    typed = false;
  }
  if (!typed) area.setRangeText(indent, area.selectionStart, area.selectionEnd, 'end');
}
