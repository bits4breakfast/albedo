/**
 * The window's status strip: how much of the plan is used, across the full
 * width.
 *
 * Usage is global -- every session draws on one plan -- so it is not the
 * sidebar's or a task's to show. The context reading lives on each task row
 * (the hairline, and the row's tooltip) and Compact/Clear in the message box,
 * which leaves the plan here, on the chrome ground under everything.
 *
 * The percentages and reset times are Claude Code's own, the figures `/usage`
 * shows, as its status line last reported them for any Albedo session
 * (hookEvents.ts, STATUS_SNAPSHOT). A window whose reset time has passed since
 * that report reads as unknown rather than as its old figure. Token counts from
 * the transcripts are kept for the tooltip: they are what this machine spent,
 * not how much of the plan that is.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { onCaptureUpdate, windowUsage } from '../capture';
import type { WindowUsage } from '../capture';
import { onStatusSnapshot, planUsage, type PlanWindow } from '../capture/hookEvents';
import { exactTokens } from './gauges/format';
import './statusbar.css';

/** The token counts are tooltip detail: re-read at most this often. */
const TOKENS_MIN_INTERVAL_MS = 15_000;
const FALLBACK_MS = 30_000;
/** Moves only the "has this window reset since" check. */
const TICK_MS = 30_000;

const WARN_AT = 75;
const HIGH_AT = 90;

type Plan = ReturnType<typeof planUsage>;

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** A half-written payload is left out of the tooltip, never shown as a zero. */
function asWindowUsage(v: unknown): WindowUsage | null {
  if (!v || typeof v !== 'object') return null;
  const w = v as Partial<WindowUsage>;
  if (!finite(w.inputTokens) || !finite(w.outputTokens)) return null;
  return w as WindowUsage;
}

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** "14:59" today, "Oct 25" otherwise: the strip's short form. */
function shortReset(at: number, now: number): string {
  const d = new Date(at);
  if (d.toDateString() === new Date(now).toDateString()) return time(at);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function longReset(at: number): string {
  return new Date(at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function tokenLines(label: string, w: WindowUsage | null): string {
  if (!w) return '';
  return (
    `\n\n${label} on this machine, from the transcripts:\n` +
    `${exactTokens(w.inputTokens + w.outputTokens)} tokens spent ` +
    `(${exactTokens(w.inputTokens)} in, ${exactTokens(w.outputTokens)} out), ` +
    `${exactTokens(w.cacheReadTokens)} re-read from cache.`
  );
}

interface MeterProps {
  label: string;
  /** What the window is, for the tooltip. */
  name: string;
  win: PlanWindow | null;
  reportedAt: number | null;
  tokens: WindowUsage | null;
  tokensLabel: string;
  now: number;
}

function PlanMeter({ label, name, win, reportedAt, tokens, tokensLabel, now }: MeterProps) {
  // Past its reset the old figure describes a window that is over.
  const stale = win !== null && win.resetsAt !== null && win.resetsAt <= now;
  const pct = win && !stale ? Math.round(win.usedPct) : null;
  const level = pct === null ? 'ok' : pct >= HIGH_AT ? 'high' : pct >= WARN_AT ? 'warn' : 'ok';
  const title =
    (pct === null
      ? stale
        ? `${name}: reset at ${longReset(win!.resetsAt!)}. The new figure arrives with the next reply in any session.`
        : `${name}: no figure yet. Claude Code reports it to Albedo's sessions with their replies.`
      : `${name}: ${pct}% used` +
        (win!.resetsAt !== null ? `, resets ${longReset(win!.resetsAt)}` : '') +
        (reportedAt !== null ? `.\nAs Claude Code reported it at ${time(reportedAt)}.` : '.')) +
    tokenLines(tokensLabel, tokens);

  return (
    <span className="ctx plan-meter" data-level={level} title={title}>
      <span className="plan-label">{label}</span>
      <span className="ctx-bar" aria-hidden="true">
        <span className="ctx-fill" style={{ width: `${pct ?? 0}%` }} />
      </span>
      <span className="ctx-text">{pct === null ? '—' : `${pct}%`}</span>
      {pct !== null && win!.resetsAt !== null ? (
        <span className="plan-reset">resets {shortReset(win!.resetsAt, now)}</span>
      ) : null}
    </span>
  );
}

export default function StatusBar() {
  const [plan, setPlan] = useState<Plan>(() => planUsage());
  const [tokens, setTokens] = useState<{ five: WindowUsage | null; week: WindowUsage | null }>({ five: null, week: null });
  const [now, setNow] = useState(() => Date.now());
  const aliveRef = useRef(true);
  const loadedAtRef = useRef(0);

  const loadTokens = useCallback(async () => {
    loadedAtRef.current = Date.now();
    const [rFive, rWeek] = await Promise.allSettled([windowUsage('5h'), windowUsage('week')]);
    if (!aliveRef.current) return;
    setTokens({
      five: rFive.status === 'fulfilled' ? asWindowUsage(rFive.value) : null,
      week: rWeek.status === 'fulfilled' ? asWindowUsage(rWeek.value) : null,
    });
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void loadTokens();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let offCapture: () => void = () => {};
    try {
      const off = onCaptureUpdate(() => {
        if (timer !== null) return;
        const due = loadedAtRef.current + TOKENS_MIN_INTERVAL_MS - Date.now();
        timer = setTimeout(() => {
          timer = null;
          void loadTokens();
        }, Math.max(0, due));
      });
      if (typeof off === 'function') offCapture = off;
    } catch (err) {
      console.warn('[status] capture updates unavailable', err);
    }
    const offSnapshot = onStatusSnapshot(() => setPlan(planUsage()));
    // A snapshot read before this mounted has no event to announce it.
    setPlan(planUsage());
    const fallback = setInterval(() => void loadTokens(), FALLBACK_MS);
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => {
      aliveRef.current = false;
      offCapture();
      offSnapshot();
      clearInterval(fallback);
      clearInterval(tick);
      if (timer !== null) clearTimeout(timer);
    };
  }, [loadTokens]);

  return (
    <footer className="statusbar" aria-label="Plan usage">
      <PlanMeter
        label="Session"
        name="Current session (5-hour limit)"
        win={plan?.fiveHour ?? null}
        reportedAt={plan?.at ?? null}
        tokens={tokens.five}
        tokensLabel="Last 5 hours"
        now={now}
      />
      <PlanMeter
        label="Week"
        name="Current week (7-day limit)"
        win={plan?.sevenDay ?? null}
        reportedAt={plan?.at ?? null}
        tokens={tokens.week}
        tokensLabel="Last 7 days"
        now={now}
      />
    </footer>
  );
}
