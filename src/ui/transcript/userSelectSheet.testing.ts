/**
 * For tests only: the app's own `user-select` rules, as one stylesheet for
 * jsdom (#449). jsdom loads no CSS, and what a selection may end on depends
 * on these rules -- the shell's `body { user-select: none }`, the panes that
 * turn it back on (`.tx-pane`, `.ed-diff-scroll`, `.gd-diff-scroll`), and the
 * components that turn it off again (a row's gutter, a diff's line numbers).
 * Read from the real files, so a new rule there reaches the tests without
 * anyone retyping it.
 */

import { readFileSync } from 'node:fs';

/** The stylesheets that set it for the transcript and the diffs, shell first (cascade order). */
const FILES = ['../../styles.css', './transcript.css', '../editor/diffview.css', '../../guide/guide.css'];

/** Every rule of the app's main stylesheets that sets `user-select`, reduced to that declaration. */
export function userSelectCss(): string {
  const out: string[] = [];
  for (const file of FILES) {
    const css = readFileSync(new URL(file, import.meta.url), 'utf8');
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    // Innermost rules only: a rule inside @media still matches here, on its own.
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const value = /(?:^|[;\s])(?:-webkit-)?user-select\s*:\s*([a-z-]+)/.exec(m[2]!)?.[1];
      if (!value) continue;
      const selectors = m[1]!
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.startsWith('@') && !s.includes('::') && valid(s));
      if (selectors.length > 0) out.push(`${selectors.join(', ')} { user-select: ${value}; -webkit-user-select: ${value}; }`);
    }
  }
  return out.join('\n');
}

/** A selector jsdom can match: one it cannot would throw from getComputedStyle. */
function valid(selector: string): boolean {
  try {
    document.createDocumentFragment().querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

/** Installs the rules in the document's head; returns what removes them. */
export function installUserSelectCss(): () => void {
  const sheet = document.createElement('style');
  sheet.textContent = userSelectCss();
  document.head.appendChild(sheet);
  return () => sheet.remove();
}
