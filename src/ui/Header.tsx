import { useCallback, useEffect, useRef, useState } from 'react';
import { usageSummary } from '../capture';

/**
 * Title bar strip. Carries the macOS overlay drag region and the one number
 * that actually constrains this app: subscription headroom.
 *
 * Several parallel sessions share one quota and burn it several times faster
 * than a single terminal does, so the rolling 5h window is front and centre —
 * tokens spent, how far into the window we are, and the burn rate that says
 * whether the current fleet is sustainable.
 *
 * This component must never take the app down. `usageSummary()` may not exist
 * yet, may throw, or may return zeros; all three render as quiet placeholders.
 */

const WINDOW_MS = 5 * 60 * 60 * 1000;
const POLL_MS = 30_000;

export interface HeaderProps {
  onNewTask: () => void;
  onReconcile: () => void;
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

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h${String(m).padStart(2, '0')}m`;
}

export default function Header({ onNewTask, onReconcile, blockedCount }: HeaderProps) {
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
  const remaining = WINDOW_MS - elapsed;
  const elapsedPct = hasWindow ? (elapsed / WINDOW_MS) * 100 : 0;
  const hours = elapsed / 3_600_000;
  const burn = hasWindow && hours > 0.05 ? total / hours : null;

  // The bar tracks how far through the 5h window we are; it turns warm late in
  // the window because that is when a heavy fleet starts to hurt.
  const level = elapsedPct > 85 ? 'high' : elapsedPct > 60 ? 'warn' : 'normal';

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

      <div className="usage" title="Rolling 5h subscription window, from transcript usage records">
        <span className="usage-label">5h window</span>
        {error && <span className="usage-error">usage unavailable</span>}
        {!error && !usage && <span className="usage-stale">reading…</span>}
        {!error && usage && (
          <>
            <span className="usage-figure">
              {formatTokens(total)} <em>tok</em>
            </span>
            {hasWindow ? (
              <>
                <span className="usage-bar" aria-hidden="true">
                  <span
                    className="usage-bar-fill"
                    data-level={level}
                    style={{ width: `${elapsedPct.toFixed(1)}%` }}
                  />
                </span>
                <span className="usage-figure" title={`${formatDuration(elapsed)} elapsed`}>
                  {formatDuration(remaining)} <em>left</em>
                </span>
                {burn !== null && (
                  <span className="usage-figure" title="Burn rate across all sessions">
                    {formatTokens(burn)}
                    <em>/h</em>
                  </span>
                )}
              </>
            ) : (
              <span className="usage-stale">no window yet</span>
            )}
          </>
        )}
      </div>

      <div className="header-actions">
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
