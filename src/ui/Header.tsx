import type { ReactNode } from 'react';
import { BUILD, buildLabel } from '../lib/build';
import OverflowMenu from './OverflowMenu';
import type { ThemeChoice } from './theme';

/**
 * Title bar strip. Carries the macOS overlay drag region, the project tabs,
 * the count of sessions waiting on the user, History and ⋯.
 *
 * No usage figure. A "Burn" rate used to sit here, the same quantity as the
 * Usage panel's Spend/h but divided by a flat 5h instead of the time actually
 * worked, so the two disagreed (936k/h beside 2.52M/h). The panel, with its
 * breakdown and window switch, is where usage lives.
 */

/*
 * No "New task" here on purpose. The sidebar carries it, beside the list it
 * adds to and beside the live/blocked count. Two `btn-primary`s for one action
 * were on screen at once, which means neither reads as the primary one -- and
 * it left the header mixing "open this" with "create that". Every button that
 * remains here opens something.
 */
export interface HeaderProps {
  onReconcile: () => void;
  /** Opens the project manager. Tasks cannot exist without a project. */
  onProjects: () => void;
  /** Opens the past-session browser. */
  onSessions: () => void;
  /** Opens the keyboard shortcuts list. */
  onShortcuts: () => void;
  blockedCount: number;
  /**
   * The appearance choice. A per-viewer preference set once, so it lives in
   * ⋯ rather than taking permanent room in the sidebar.
   */
  theme: ThemeChoice;
  onThemeChange: (next: ThemeChoice) => void;
  /**
   * The project tabs, when there are two or more projects. They lead the
   * bar: the tabs are the level above everything below it.
   */
  tabs?: ReactNode;
  /** Select a task that is waiting on you (the next one, on repeat clicks). */
  onWaitingClick?: () => void;
}

const THEME_ITEMS: { choice: ThemeChoice; label: string; title: string }[] = [
  { choice: 'system', label: 'Theme: Auto', title: 'Follow the system appearance' },
  { choice: 'light', label: 'Theme: Light', title: 'Always light' },
  { choice: 'dark', label: 'Theme: Dark', title: 'Always dark' },
];

export default function Header({
  onReconcile,
  onProjects,
  onSessions,
  onShortcuts,
  theme,
  onThemeChange,
  tabs,
  onWaitingClick,
  blockedCount,
}: HeaderProps) {
  return (
    <header className="header" data-tauri-drag-region>
      {/* No icon and no name: the window is already Albedo. The bar starts
          with the project tabs (absent with a single project). */}
      {tabs}

      <span className="header-spacer" data-tauri-drag-region />

      {blockedCount > 0 && (
        <>
          {/* A button: the count is only useful as a way to get there. With
              several waiting, each click moves to the next. */}
          <button
            type="button"
            className="usage usage-waiting"
            onClick={onWaitingClick}
            title={`${blockedCount} session(s) waiting on you. Click to go to ${blockedCount === 1 ? 'it' : 'the next one'}.`}
          >
            <span className="status-dot" data-status="blocked" aria-hidden="true" />
            <span className="usage-figure">{blockedCount} Waiting</span>
          </button>
          <span className="header-sep" aria-hidden="true" />
        </>
      )}

      {/* One visible action; the rest sit behind ⋯ (pane vertical space: one
          row, one main action). ⌘/ still opens the shortcuts from anywhere,
          and the sidebar's project name still opens Projects. */}
      <div className="header-actions">
        <button
          className="btn btn-ghost"
          onClick={onSessions}
          title="Browse and resume past Claude Code sessions"
        >
          History
        </button>
        <OverflowMenu
          label="More"
          title="Projects, worktrees, theme, keyboard shortcuts"
          items={[
            { id: 'projects', label: 'Projects…', onSelect: onProjects, title: 'Manage projects' },
            { id: 'worktrees', label: 'Worktrees…', onSelect: onReconcile, title: 'Reconcile git worktrees' },
            ...THEME_ITEMS.map((t, i) => ({
              id: `theme-${t.choice}`,
              label: t.label,
              title: t.title,
              checked: theme === t.choice,
              radio: true,
              group: i === 0,
              onSelect: () => onThemeChange(t.choice),
            })),
            {
              id: 'shortcuts',
              label: 'Keyboard Shortcuts',
              aside: '⌘/',
              onSelect: onShortcuts,
              title: 'Keyboard shortcuts (⌘/)',
              group: true,
            },
            {
              // What is running: the commit it was built from ("+": with
              // uncommitted changes). A click copies it.
              id: 'build',
              label: `Build ${buildLabel()}`,
              group: true,
              title: BUILD
                ? `Built from ${BUILD.sha}${BUILD.dirty ? ' with uncommitted changes' : ''}. Click to copy`
                : 'Built outside a git checkout',
              disabled: BUILD === null,
              onSelect: () => {
                if (BUILD) void navigator.clipboard?.writeText(BUILD.sha).catch(() => {});
              },
            },
          ]}
        />
      </div>
    </header>
  );
}
