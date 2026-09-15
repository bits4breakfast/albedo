import { useCallback, useEffect, useRef, useState } from 'react';
import { usageSummary } from '../capture';

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

export interface HeaderProps {
  onNewTask: () => void;
  onReconcile: () => void;
  /** Opens the project manager. Tasks cannot exist without a project. */
  onProjects: () => void;
  /** Opens the past-session browser. */
  onSessions: () => void;
  blockedCount: number;
}

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
  onNewTask,
  onReconcile,
  onProjects,
  onSessions,
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
      <span className="header-brand" data-tauri-drag-region>
        Albedo
      </span>

      <span className="header-spacer" data-tauri-drag-region />

      {blockedCount > 0 && (
        <span className="usage" title={`${blockedCount} session(s) waiting on you`}>
          <span className="status-dot" data-status="blocked" aria-hidden="true" />
          <span className="usage-figure">{blockedCount} waiting</span>
        </span>
      )}

      <div
        className="usage"
        title={
          'Tokens per hour across all sessions in the rolling 5h window. ' +
          'The sidebar panel has the totals and countdowns.'
        }
      >
        <span className="usage-label">burn</span>
        {error && <span className="usage-error">unavailable</span>}
        {!error && !usage && <span className="usage-stale">reading…</span>}
        {!error && usage && burn !== null && (
          <span className="usage-figure">
            {formatTokens(burn)}
            <em>/h</em>
          </span>
        )}
        {!error && usage && burn === null && <span className="usage-stale">—</span>}
      </div>

      <div className="header-actions">
        <button
          className="btn btn-ghost"
          onClick={onSessions}
          title="Browse and resume past Claude Code sessions"
        >
          History
        </button>
        <button className="btn btn-ghost" onClick={onProjects} title="Manage projects">
          Projects
        </button>
        <button className="btn btn-ghost" onClick={onReconcile} title="Reconcile git worktrees">
          Worktrees
        </button>
        <button className="btn btn-primary" onClick={onNewTask} title="New task (⌘N)">
          New task
        </button>
      </div>
    </header>
  );
}
