/** Test fixtures for the Review Guide: changed files built the way git's are. */

import { composeFileDiff, sideFromText } from '../git/fileDiff';
import type { ChangedFile } from './blocks';

/** `n` numbered lines, `prefix` on each. */
export function lines(n: number, prefix = 'line'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);
}

export function text(ls: readonly string[]): string {
  return `${ls.join('\n')}\n`;
}

/** A file changed from `before` to `after` (null: absent on that side). */
export function changed(path: string, before: string | null, after: string | null): ChangedFile {
  return { path, result: composeFileDiff(sideFromText(before), sideFromText(after), path) };
}

/** A 40-line file with edits at the given 1-based lines: separate hunks when far apart. */
export function edited(path: string, at: readonly number[], tag = 'edited'): ChangedFile {
  const before = lines(40);
  const after = before.map((l, i) => (at.includes(i + 1) ? `${l} ${tag}` : l));
  return changed(path, text(before), text(after));
}
