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

/** A plus: New Task, where there is no room for the words. */
export function PlusIcon({ size }: { size?: number }) {
  return (
    <Glyph size={size}>
      <path d="M8 3v10M3 8h10" />
    </Glyph>
  );
}

/**
 * A flag: "review carefully" in the Review Guide (#295). Always beside the
 * reason in words, never the only sign.
 */
export function FlagIcon({ size, className }: { size?: number; className?: string }) {
  return (
    <Glyph size={size} className={className}>
      <path d="M4 14.5V2" />
      <path d="M4 2.5h8l-2 3 2 3H4" />
    </Glyph>
  );
}

/** A circular arrow: ask again now. */
export function RefreshIcon({ size }: { size?: number }) {
  return (
    <Glyph size={size}>
      <path d="M13 8a5 5 0 1 1-1.46-3.54" />
      <path d="M13 2.5v3h-3" />
    </Glyph>
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

/**
 * The pane layouts (#317): the terminal alone, terminal and reading pane
 * split, the reading pane alone. They draw panes, not programs: a solid block
 * is the terminal, lines are the transcript. So PTY is not the terminal glyph
 * the Shell button beside it uses (the owner's pick, option A).
 */
export function PtyLayoutIcon({ size = 16 }: { size?: number }) {
  return (
    <Glyph size={size}>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <rect x="4" y="5" width="8" height="6" rx="0.75" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

export function SplitLayoutIcon({ size = 16 }: { size?: number }) {
  return (
    <Glyph size={size}>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <path d="M8 3v10" />
      <rect x="3.75" y="5" width="2.75" height="6" rx="0.5" fill="currentColor" stroke="none" />
      <path d="M10 6h2M10 8.5h2M10 11h1.25" />
    </Glyph>
  );
}

export function TranscriptLayoutIcon({ size = 16 }: { size?: number }) {
  return (
    <Glyph size={size}>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <path d="M4.5 6h7M4.5 8.5h7M4.5 11h4" />
    </Glyph>
  );
}

/** GitHub's mark (#317): the PR link of a review task, where "on GitHub" was. Filled, as GitHub draws it. */
export function GitHubIcon({ size = 14 }: { size?: number }) {
  return (
    <svg className="glyph" width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
