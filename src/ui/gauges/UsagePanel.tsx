/**
 * src/ui/gauges/UsagePanel.tsx
 *
 * `/context` and `/usage`, displayed constantly instead of asked for.
 *
 * Intended home: the bottom of the left sidebar, under the task list. It is
 * placement-agnostic though — it lays out in a single column, degrades to the
 * 200px sidebar minimum, and takes its whole data set from `capture`, so the
 * shell can drop it anywhere a narrow column exists.
 *
 * ## Refresh strategy
 *
 * Three clocks, deliberately different:
 *
 *  1. `onCaptureUpdate` — the real trigger. Rows landing is the only event
 *     that can change a token figure. The selected session's context reloads
 *     500ms after an update to that session only; the window totals, a scan
 *     across every session, at most once per WINDOW_MIN_INTERVAL_MS.
 *  2. A 30s fallback interval, in case the watcher is not running or a
 *     subscription is dropped. A permanently visible panel that silently
 *     freezes is worse than one that is a few seconds stale.
 *  3. A 1s local clock that touches nothing but the countdowns. It never
 *     queries the database.
 *
 * ## Motion budget
 *
 * The shell's rule is that `running` breathes, `blocked` pings, and nothing
 * else moves, so a blocked session is the one thing that pulls the eye across
 * three panes. A panel that updates constantly is exactly what could wreck
 * that, so: the countdown changes as text and never animates, the context bar
 * transitions only when a value actually changes, `ContextGauge` is memoised
 * so the 1s tick cannot repaint it, and `prefers-reduced-motion` removes the
 * one transition that remains.
 *
 * ## Failure
 *
 * Every call is wrapped, every payload is shape-checked, and anything that
 * does not survive both renders as a quiet "unavailable". A zero here would
 * read as a real measurement — "you have used nothing" — which is the one
 * wrong answer this panel must never give.
 */

import { Component, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { contextBands, contextUsage, onCaptureUpdate, windowUsage } from '../../capture';
import type { ContextBands, ContextUsage, WindowUsage } from '../../capture';
import type { Task } from '../../types';
import ContextGauge from './ContextGauge';
import type { GaugeState } from './ContextGauge';
import WindowGauge from './WindowGauge';
import './gauges.css';

/** Coalesce a burst of capture updates into one query. */
const DEBOUNCE_MS = 500;
/**
 * Floor between window-usage rescans. Those sum every session's rows over 5h
 * and a week, and ran on every burst of any session; a figure read at the
 * scale of minutes does not need refreshing more than this.
 */
const WINDOW_MIN_INTERVAL_MS = 15_000;
/** Belt-and-braces refresh, in case no update event ever arrives. */
const FALLBACK_MS = 30_000;
/** Countdown tick. Local only — never a database round-trip. */
const TICK_MS = 1_000;

export interface UsagePanelProps {
  task: Task | null;
}

interface ContextState {
  usage: ContextUsage | null;
  bands: ContextBands | null;
  state: GaugeState;
}

interface WindowState {
  five: WindowUsage | null;
  week: WindowUsage | null;
  fiveState: GaugeState;
  weekState: GaugeState;
  fetchedAt: number;
}

// ---------------------------------------------------------------------------
// Shape checks
//
// capture is a sibling workstream still in flight. Trusting its payloads
// structurally means a half-written return value renders as 0, and 0 tokens is
// a statement, not an absence. Anything that does not type-check at runtime
// becomes null, which renders as "unavailable".
// ---------------------------------------------------------------------------

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function asContextUsage(v: unknown): ContextUsage | null {
  if (!v || typeof v !== 'object') return null;
  const u = v as Partial<ContextUsage>;
  if (!finite(u.used) || !finite(u.limit) || !finite(u.fraction)) return null;
  if (u.limitBasis !== 'known' && u.limitBasis !== 'inferred') return null;
  return u as ContextUsage;
}

function asContextBands(v: unknown): ContextBands | null {
  if (!v || typeof v !== 'object') return null;
  const b = v as Partial<ContextBands>;
  if (!finite(b.totalUsed) || !finite(b.conversationEst) || !finite(b.overheadEst)) return null;
  if (b.freeEst !== null && !finite(b.freeEst)) return null;
  return b as ContextBands;
}

function asWindowUsage(v: unknown): WindowUsage | null {
  if (!v || typeof v !== 'object') return null;
  const w = v as Partial<WindowUsage>;
  if (!finite(w.inputTokens) || !finite(w.outputTokens)) return null;
  return w as WindowUsage;
}

/** `claude-opus-5[1m]` -> `opus-5[1m]`. Full id stays in the tooltip. */
function shortModel(model: string | null): string | null {
  if (!model) return null;
  return model.replace(/^claude-/, '');
}

// ---------------------------------------------------------------------------
// Render-time failure is still failure
// ---------------------------------------------------------------------------

class GaugeBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(err: unknown) {
    console.warn('[gauges] panel render failed', err);
  }

  override render(): ReactNode {
    if (this.state.failed) return <p className="gz-unavailable">usage unavailable</p>;
    return this.props.children;
  }
}

// ---------------------------------------------------------------------------

export default function UsagePanel({ task }: UsagePanelProps) {
  const sessionId = task?.sessionId ?? null;

  const [ctx, setCtx] = useState<ContextState>({ usage: null, bands: null, state: 'loading' });
  const [win, setWin] = useState<WindowState>({
    five: null,
    week: null,
    fiveState: 'loading',
    weekState: 'loading',
    fetchedAt: Date.now(),
  });
  const [now, setNow] = useState(() => Date.now());

  const aliveRef = useRef(true);
  const ctxGenRef = useRef(0);
  const winGenRef = useRef(0);
  const winLoadedAtRef = useRef(0);

  const loadContext = useCallback(async () => {
    const gen = ++ctxGenRef.current;
    if (!sessionId) {
      setCtx({ usage: null, bands: null, state: 'no-session' });
      return;
    }
    const [rUsage, rBands] = await Promise.allSettled([
      contextUsage(sessionId),
      contextBands(sessionId),
    ]);
    if (!aliveRef.current || ctxGenRef.current !== gen) return;
    setCtx({
      usage: rUsage.status === 'fulfilled' ? asContextUsage(rUsage.value) : null,
      bands: rBands.status === 'fulfilled' ? asContextBands(rBands.value) : null,
      state: rUsage.status === 'fulfilled' ? 'ready' : 'unavailable',
    });
  }, [sessionId]);

  const loadWindows = useCallback(async () => {
    const gen = ++winGenRef.current;
    winLoadedAtRef.current = Date.now();
    const [rFive, rWeek] = await Promise.allSettled([windowUsage('5h'), windowUsage('week')]);
    if (!aliveRef.current || winGenRef.current !== gen) return;
    setWin({
      five: rFive.status === 'fulfilled' ? asWindowUsage(rFive.value) : null,
      week: rWeek.status === 'fulfilled' ? asWindowUsage(rWeek.value) : null,
      fiveState: rFive.status === 'fulfilled' ? 'ready' : 'unavailable',
      weekState: rWeek.status === 'fulfilled' ? 'ready' : 'unavailable',
      fetchedAt: Date.now(),
    });
  }, []);

  // Kept in refs so the subscription below is installed exactly once and does
  // not tear down and re-subscribe every time the selected task changes.
  const loadContextRef = useRef(loadContext);
  const sessionRef = useRef(sessionId);
  useEffect(() => {
    loadContextRef.current = loadContext;
    sessionRef.current = sessionId;
  }, [loadContext, sessionId]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    void loadContext();
  }, [loadContext]);

  useEffect(() => {
    void loadWindows();
  }, [loadWindows]);

  useEffect(() => {
    let ctxTimer: ReturnType<typeof setTimeout> | null = null;
    let winTimer: ReturnType<typeof setTimeout> | null = null;

    const onUpdate = (u: { sessionId?: unknown } | null | undefined) => {
      // The selected session's context: one query per burst, and only for
      // updates to THAT session -- another session's append cannot move it.
      if (ctxTimer === null && u?.sessionId === sessionRef.current) {
        ctxTimer = setTimeout(() => {
          ctxTimer = null;
          void loadContextRef.current();
        }, DEBOUNCE_MS);
      }
      // The windows sum every session's rows, so any update moves them, but
      // the scan is the expensive one and the figure is read in minutes.
      if (winTimer === null) {
        const due = winLoadedAtRef.current + WINDOW_MIN_INTERVAL_MS - Date.now();
        winTimer = setTimeout(() => {
          winTimer = null;
          void loadWindows();
        }, Math.max(DEBOUNCE_MS, due));
      }
    };

    let unsubscribe: () => void = () => {};
    try {
      const off = onCaptureUpdate(onUpdate);
      if (typeof off === 'function') unsubscribe = off;
    } catch (err) {
      console.warn('[gauges] capture updates unavailable', err);
    }

    const fallback = setInterval(() => {
      void loadContextRef.current();
      void loadWindows();
    }, FALLBACK_MS);
    return () => {
      unsubscribe();
      clearInterval(fallback);
      if (ctxTimer !== null) clearTimeout(ctxTimer);
      if (winTimer !== null) clearTimeout(winTimer);
    };
  }, [loadWindows]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const model = shortModel(ctx.usage?.model ?? null);

  return (
    <section className="gz-panel" aria-label="Context and subscription usage">
      <GaugeBoundary>
        <div className="gz-section">
          <div className="gz-head">
            <span className="gz-title">context</span>
            {model && (
              <span className="gz-head-note" title={ctx.usage?.model ?? undefined}>
                {model}
              </span>
            )}
          </div>
          <ContextGauge usage={ctx.usage} bands={ctx.bands} state={ctx.state} />
        </div>

        <div className="gz-section">
          <div className="gz-head">
            <span className="gz-title">usage</span>
            <span
              className="gz-head-note"
              title={
                'Token counts across all sessions, from transcript usage records.\n\n' +
                'No percentage of a plan limit is shown: the allowance and its reset ' +
                'anchor are not recorded anywhere on disk, so any percentage here ' +
                'would be against a denominator we made up.'
              }
            >
              all sessions
            </span>
          </div>
          <div className="gz-windows">
            <WindowGauge
              label="5h"
              data={win.five}
              state={win.fiveState}
              now={now}
              fetchedAt={win.fetchedAt}
            />
            <WindowGauge
              label="7d"
              data={win.week}
              state={win.weekState}
              now={now}
              fetchedAt={win.fetchedAt}
            />
          </div>
        </div>
      </GaugeBoundary>
    </section>
  );
}
