/**
 * The few glyphs that say what a value IS, so a word does not need a label.
 *
 * A branch and a task are often named the same ("polishing" / polishing), and
 * a bare word twice in one row reads as a repetition. With an icon it reads as
 * two facts: this is the task, that is its branch. Inline SVG in currentColor,
 * so the text token beside it sets the contrast and nothing new is introduced.
 */

import type { ReactNode } from 'react';

function Glyph({ children, size = 13 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      className="glyph"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** A git branch: two commits and a fork. */
export function BranchIcon({ size }: { size?: number }) {
  return (
    <Glyph size={size}>
      <circle cx="4.5" cy="3.5" r="1.75" />
      <circle cx="4.5" cy="12.5" r="1.75" />
      <circle cx="11.5" cy="5.5" r="1.75" />
      <path d="M4.5 5.25v5.5M11.5 7.25c0 2.5-2.5 3-5.5 4" />
    </Glyph>
  );
}

/** A folder: the worktree on disk. */
export function FolderIcon({ size }: { size?: number }) {
  return (
    <Glyph size={size}>
      <path d="M1.75 4.25c0-.83.67-1.5 1.5-1.5h3l1.5 1.75h5c.83 0 1.5.67 1.5 1.5v6.25c0 .83-.67 1.5-1.5 1.5h-9.5c-.83 0-1.5-.67-1.5-1.5z" />
    </Glyph>
  );
}

/** `/Users/me/www/x` -> `~/www/x`. Display only; the full path goes in the tooltip. */
export function homeRelative(path: string): string {
  return path.replace(/^\/(Users|home)\/[^/]+/, '~');
}

/**
 * Should a row show the branch under the title? Not when it only repeats it:
 * a task called "polishing" on branch `polishing`, or "Fix login" on
 * `fix-login`. An issue-key branch (`UP-2364`) under a prose title says
 * something the title does not, so it stays.
 */
export function branchRepeatsTitle(title: string, branch: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (branch.length === 0) return false;
  const b = norm(branch);
  // The whole title, or its first word: "UP-2364 Review the plan" on branch
  // `UP-2364` already shows the key as the row's lead.
  return norm(title) === b || norm(title.trim().split(/\s+/)[0] ?? '') === b;
}
