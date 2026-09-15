/**
 * Text shaping for the shell.
 *
 * Owner: shell workstream (M2).
 *
 * These exist because task titles are not short. A title created from a long
 * prompt can be a whole paragraph — the rows truncate it fine, but every other
 * consumer of the same string has to decide what to do with 300 characters,
 * and left alone each one decides differently.
 */

/** Ellipsis, as one character, so a cap of 80 really is 80 columns. */
const ELLIPSIS = '…';

/**
 * Wrap text for a native `title` attribute.
 *
 * A `title` cannot wrap and cannot be width-constrained by CSS, so a long
 * string renders as one line spanning most of the window — which is how a
 * tooltip ends up covering the app, and the context menu it was meant to
 * describe. Tooltips DO honour embedded newlines, though, so the fix is to put
 * the line breaks in ourselves.
 *
 * Breaks on whitespace where it can, mid-token where it cannot (long paths do
 * not contain spaces), and caps the total so a runaway string cannot produce a
 * tooltip taller than the screen either.
 */
export function wrapForTooltip(text: string, width = 72, maxChars = 320): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return '';
  const capped = clean.length > maxChars ? clean.slice(0, maxChars - 1).trimEnd() + ELLIPSIS : clean;

  const lines: string[] = [];
  let line = '';
  for (const word of capped.split(' ')) {
    if (line.length === 0) {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += ' ' + word;
    } else {
      lines.push(line);
      line = word;
    }
    // A single token longer than the width (a path, a URL) still has to break.
    while (line.length > width) {
      lines.push(line.slice(0, width));
      line = line.slice(width);
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.join('\n');
}

/** First line of a multi-line string, whitespace-normalised. */
export function firstLine(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  return first.trim();
}

/**
 * A short, single-line name for somewhere that has room for a label and not a
 * paragraph: Claude Code's `--name`, which surfaces in its prompt box, its
 * /resume picker and the terminal title. A 300-character name there is not
 * harmful, it is just not a name.
 */
export function displayName(text: string, max = 72): string {
  const line = firstLine(text) || text.replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  // Prefer a word boundary, but not one so early that it eats the name.
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd() + ELLIPSIS;
}
