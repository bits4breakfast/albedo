/**
 * The window's status strip: subscription usage, across the full width.
 *
 * Usage is global -- every session draws on one quota -- so it is not the
 * sidebar's or a task's to show. It used to be the lower half of a panel at
 * the foot of the sidebar, beside a context gauge for the selected task. The
 * context reading now lives on each task row (the hairline, and the row's
 * tooltip) and Clear in the message box near the limit, which left usage
 * here, on the chrome ground under everything, as Linear keeps its own
 * global strip.
 *
 * Same data and refresh strategy as before: rows landing (`onCaptureUpdate`)
 * trigger a rescan at most every {@link WINDOW_MIN_INTERVAL_MS}, a fallback
 * interval covers a stalled watcher, and a 1s local clock moves only the
 * countdown. The figures are WindowGauge's, in its inline layout, so the
 * rules about what counts as spend stay in one place.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { onCaptureUpdate, windowUsage } from '../capture';
import type { WindowUsage } from '../capture';
import WindowGauge, { type GaugeState } from './gauges/WindowGauge';
import './gauges/gauges.css';

const DEBOUNCE_MS = 500;
/** The windows sum every session's rows; a figure read in minutes. */
const WINDOW_MIN_INTERVAL_MS = 15_000;
const FALLBACK_MS = 30_000;
const TICK_MS = 1_000;

type WindowChoice = '5h' | '7d';
const WINDOW_KEY = 'albedo.usage.window';

function readWindowChoice(): WindowChoice {
  try {
    return localStorage.getItem(WINDOW_KEY) === '7d' ? '7d' : '5h';
  } catch {
    return '5h';
  }
}

function storeWindowChoice(v: WindowChoice): void {
  try {
    localStorage.setItem(WINDOW_KEY, v);
  } catch {
    /* not remembered: 5H next launch */
  }
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** A half-written payload renders as "unavailable", never as a zero. */
function asWindowUsage(v: unknown): WindowUsage | null {
  if (!v || typeof v !== 'object') return null;
  const w = v as Partial<WindowUsage>;
  if (!finite(w.inputTokens) || !finite(w.outputTokens)) return null;
  return w as WindowUsage;
}

interface WindowState {
  five: WindowUsage | null;
  week: WindowUsage | null;
  fiveState: GaugeState;
  weekState: GaugeState;
  fetchedAt: number;
}

export default function StatusBar() {
  const [win, setWin] = useState<WindowState>({
    five: null,
    week: null,
    fiveState: 'loading',
    weekState: 'loading',
    fetchedAt: Date.now(),
  });
  const [now, setNow] = useState(() => Date.now());
  const [choice, setChoice] = useState<WindowChoice>(readWindowChoice);
  const aliveRef = useRef(true);
  const genRef = useRef(0);
  const loadedAtRef = useRef(0);

  const load = useCallback(async () => {
    const gen = ++genRef.current;
    loadedAtRef.current = Date.now();
    const [rFive, rWeek] = await Promise.allSettled([windowUsage('5h'), windowUsage('week')]);
    if (!aliveRef.current || genRef.current !== gen) return;
    setWin({
      five: rFive.status === 'fulfilled' ? asWindowUsage(rFive.value) : null,
      week: rWeek.status === 'fulfilled' ? asWindowUsage(rWeek.value) : null,
      fiveState: rFive.status === 'fulfilled' ? 'ready' : 'unavailable',
      weekState: rWeek.status === 'fulfilled' ? 'ready' : 'unavailable',
      fetchedAt: Date.now(),
    });
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: () => void = () => {};
    try {
      const off = onCaptureUpdate(() => {
        if (timer !== null) return;
        const due = loadedAtRef.current + WINDOW_MIN_INTERVAL_MS - Date.now();
        timer = setTimeout(() => {
          timer = null;
          void load();
        }, Math.max(DEBOUNCE_MS, due));
      });
      if (typeof off === 'function') unsubscribe = off;
    } catch (err) {
      console.warn('[status] capture updates unavailable', err);
    }
    const fallback = setInterval(() => void load(), FALLBACK_MS);
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => {
      aliveRef.current = false;
      unsubscribe();
      clearInterval(fallback);
      clearInterval(tick);
      if (timer !== null) clearTimeout(timer);
    };
  }, [load]);

  const choose = (v: WindowChoice) => {
    setChoice(v);
    storeWindowChoice(v);
  };

  return (
    <footer className="statusbar" aria-label="Subscription usage">
      <span
        className="statusbar-label"
        title={
          'Token counts across all sessions, from transcript usage records.\n\n' +
          'No percentage of a plan limit is shown: the allowance and its reset ' +
          'anchor are not recorded anywhere on disk, so any percentage here ' +
          'would be against a denominator we made up.'
        }
      >
        Usage
      </span>
      <div className="seg-sm statusbar-switch" role="group" aria-label="Usage window">
        {(['5h', '7d'] as const).map((w) => (
          <button
            key={w}
            type="button"
            aria-pressed={choice === w}
            onClick={() => choose(w)}
            title={w === '5h' ? 'Rolling 5-hour window' : 'Rolling 7-day window'}
          >
            {w.toUpperCase()}
          </button>
        ))}
      </div>
      <WindowGauge
        label={choice}
        data={choice === '5h' ? win.five : win.week}
        state={choice === '5h' ? win.fiveState : win.weekState}
        now={now}
        fetchedAt={win.fetchedAt}
        hideLabel
        variant="inline"
      />
    </footer>
  );
}
