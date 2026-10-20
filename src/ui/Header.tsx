import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { usageSummary } from '../capture';
import OverflowMenu from './OverflowMenu';
import type { ThemeChoice } from './theme';

/**
 * Title bar strip. Carries the macOS overlay drag region, the count of
 * sessions waiting on the user, and one usage figure.
 *
 * Deliberately only one. The gauges panel at the foot of the sidebar is
 * permanently on screen and owns the breakdown — 5h and weekly totals,
 * countdowns, context for the selected task. Repeating any of that up here
 * would be the same numbers twice on one screen. What survives is the rate:
 * several parallel sessions share one quota and burn it several times faster
 * than a single terminal does, and tokens-per-hour is the figure that says
 * whether the current fleet is sustainable — the one thing the panel's
 * point-in-time totals do not tell you.
 *
 * This component must never take the app down. `usageSummary()` may not exist
 * yet, may throw, or may return zeros; all three render as quiet placeholders.
 */

const WINDOW_MS = 5 * 60 * 60 * 1000;
const POLL_MS = 30_000;

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
   * The project tabs, when there are two or more projects. They take the
   * brand's place: the window is already called Albedo, and the tabs are the
   * level above everything below the bar, so this is where they belong.
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

interface Usage {
  inputTokens: number;
  outputTokens: number;
  sinceTs: number;
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

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
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const aliveRef = useRef(true);

  const poll = useCallback(async () => {
    try {
      const u = await usageSummary();
      if (!aliveRef.current) return;
      if (!u || typeof u !== 'object') {
        setUsage(null);
        setError(null);
        return;
      }
      setUsage({
        inputTokens: Number(u.inputTokens) || 0,
        outputTokens: Number(u.outputTokens) || 0,
        sinceTs: Number(u.sinceTs) || 0,
      });
      setError(null);
    } catch (err) {
      if (!aliveRef.current) return;
      setUsage(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void poll();
    const pollId = setInterval(() => void poll(), POLL_MS);
    const tickId = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      aliveRef.current = false;
      clearInterval(pollId);
      clearInterval(tickId);
    };
  }, [poll]);

  const total = usage ? usage.inputTokens + usage.outputTokens : 0;
  const hasWindow = !!usage && usage.sinceTs > 0;
  const elapsed = hasWindow ? Math.max(0, Math.min(WINDOW_MS, now - usage.sinceTs)) : 0;
  const hours = elapsed / 3_600_000;
  // Below a few minutes of window the rate is noise, not a reading.
  const burn = hasWindow && hours > 0.05 ? total / hours : null;

  return (
    <header className="header" data-tauri-drag-region>
      {/* The app's own icon stands for the name: the window is already called
          Albedo, so the room goes to the project tabs after it. Served from
          public/, a copy of src-tauri/icons/64x64.png. */}
      <img
        className="header-icon"
        src="/app-icon-64.png"
        alt="Albedo"
        width={22}
        height={22}
        draggable={false}
        data-tauri-drag-region
      />
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

      <div
        className="usage"
        title={
          'Tokens per hour across all sessions in the rolling 5h window. ' +
          'The sidebar panel has the totals and countdowns.'
        }
      >
        <span className="usage-label">Burn</span>
        {error && <span className="usage-error">Unavailable</span>}
        {!error && !usage && <span className="usage-stale">Reading…</span>}
        {!error && usage && burn !== null && (
          <span className="usage-figure">
            {formatTokens(burn)}
            <em>/h</em>
          </span>
        )}
        {!error && usage && burn === null && <span className="usage-stale">—</span>}
      </div>

      <span className="header-sep" aria-hidden="true" />

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
          ]}
        />
      </div>
    </header>
  );
}
