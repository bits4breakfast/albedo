/**
 * The few glyphs that say what a value IS, so a word does not need a label.
 *
 * A branch and a task are often named the same ("polishing" / polishing), and
 * a bare word twice in one row reads as a repetition. With an icon it reads as
 * two facts: this is the task, that is its branch. Inline SVG in currentColor,
 * so the text token beside it sets the contrast and nothing new is introduced.
 */

import type { ReactNode } from 'react';

export function Glyph({
  children,
  size = 13,
  className,
  kind,
}: {
  children: ReactNode;
  size?: number;
  className?: string;
  /** What the glyph stands for, as `data-kind`: fileicons.css colours by it. */
  kind?: string;
}) {
  return (
    <svg
      className={className === undefined ? 'glyph' : `glyph ${className}`}
      data-kind={kind}
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

/**
 * A speech bubble: a chat task, which has no branch. Drawn on the branch
 * glyph's grid and stroke so it reads as the same kind of fact in its place.
 */
export function ChatIcon({ size }: { size?: number }) {
  return (
    <Glyph size={size}>
      <path d="M2.75 3.25h10.5c.55 0 1 .45 1 1v5.5c0 .55-.45 1-1 1H7.5l-3 2.5v-2.5H2.75c-.55 0-1-.45-1-1v-5.5c0-.55.45-1 1-1z" />
    </Glyph>
  );
}

/** A closed folder's outline: FolderIcon, and the Project tree's closed folder. */
export const FOLDER_CLOSED =
  'M1.75 4.25c0-.83.67-1.5 1.5-1.5h3l1.5 1.75h5c.83 0 1.5.67 1.5 1.5v6.25c0 .83-.67 1.5-1.5 1.5h-9.5c-.83 0-1.5-.67-1.5-1.5z';

/** A folder: the worktree on disk. */
export function FolderIcon({ size }: { size?: number }) {
  return (
    <Glyph size={size}>
      <path d={FOLDER_CLOSED} />
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
 * `fix-login`. An issue-key branch (`ACME-142`) under a prose title says
 * something the title does not, so it stays.
 */
export function branchRepeatsTitle(title: string, branch: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (branch.length === 0) return false;
  const b = norm(branch);
  // The whole title, or its first word: "ACME-142 Review the plan" on branch
  // `ACME-142` already shows the key as the row's lead.
  return norm(title) === b || norm(title.trim().split(/\s+/)[0] ?? '') === b;
}
