/**
 * Whether Claude Code can reach the API, judged from Albedo's own side.
 *
 * Claude Code knows (it prints "Can't reach the API server … Retrying"), but
 * only in the terminal, which is never read. So Albedo asks twice itself:
 *  - `navigator.onLine`, and its `online` / `offline` events: free, and right
 *    when the machine has no network at all;
 *  - a probe of the API host: a no-cors HEAD, which resolves on any HTTP
 *    answer and rejects only when the name does not resolve or the
 *    connection fails -- the "connected to Wi-Fi, no internet" case that
 *    `navigator.onLine` reports as online.
 *
 * Why no-cors: the webview's origin is not the API's, so a CORS read would be
 * refused even when the host is up. An opaque answer is all the probe needs,
 * it carries no credentials and no body, and it needs no Tauri capability
 * (the app has no CSP to widen).
 *
 * The probe costs a TLS handshake, so it runs every `PROBE_EVERY_MS` only
 * while something is waiting on the network (`watchConnectivity`), and while
 * the last probe failed, so "back online" is noticed without anything waiting.
 *
 * A probe that has never succeeded in this run proves nothing: it may be the
 * webview refusing the request rather than the network being down, and
 * believing it would hold every message forever. Until one succeeds, only
 * `navigator.onLine` decides.
 *
 * That has a cost, accepted on purpose: an app launched while offline has
 * never seen a probe succeed, and `navigator.onLine` is often true when only
 * DNS is down. Until the API answers once, messages then go to Claude Code's
 * own queue, as they did before the outbox existed.
 */

import { useSyncExternalStore } from 'react';

/** The host Claude Code talks to. */
export const PROBE_URL = 'https://api.anthropic.com/';
export const PROBE_EVERY_MS = 10_000;
/** Past this a probe counts as failed: a dead DNS can hang far longer. */
export const PROBE_TIMEOUT_MS = 5_000;

/** Resolves true when the API host answered at all. Never rejects. */
export type Probe = () => Promise<boolean>;

export const probeApi: Probe = async () => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
  try {
    await fetch(PROBE_URL, { method: 'HEAD', mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: abort.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

export interface Signals {
  /** `navigator.onLine`. */
  navigatorOnline: boolean;
  /** The last probe's answer; null before the first. */
  probeOk: boolean | null;
  /** Some probe has succeeded in this run, so a failure means something. */
  probeTrusted: boolean;
}

/** Offline: no network at all, or a probe that has worked before now fails. */
export function isOfflineGiven(s: Signals): boolean {
  return !s.navigatorOnline || (s.probeTrusted && s.probeOk === false);
}

/** Probe while something waits, and while the last probe failed. */
export function shouldProbe(watchers: number, s: Signals): boolean {
  return s.navigatorOnline && (watchers > 0 || (s.probeTrusted && s.probeOk === false));
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

let signals: Signals | null = null;
let offline = false;
let watchers = 0;
let probe: Probe = probeApi;
let timer: ReturnType<typeof setTimeout> | null = null;
let probing = false;
/** When the last probe started, so a burst of watchers costs one probe. */
let probedAt = -Infinity;
const listeners = new Set<() => void>();

function current(): Signals {
  if (signals === null) {
    signals = {
      navigatorOnline: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
      probeOk: null,
      probeTrusted: false,
    };
    offline = isOfflineGiven(signals);
    if (typeof window !== 'undefined') {
      window.addEventListener('online', onNavigator);
      window.addEventListener('offline', onNavigator);
    }
  }
  return signals;
}

function onNavigator(): void {
  update({ navigatorOnline: navigator.onLine !== false });
  // Back on a network: whether the API answers is the next question, now.
  if (navigator.onLine !== false) runProbe();
}

function update(patch: Partial<Signals>): void {
  signals = { ...current(), ...patch };
  const next = isOfflineGiven(signals);
  schedule();
  if (next === offline) return;
  offline = next;
  for (const cb of [...listeners]) cb();
}

function schedule(): void {
  const s = current();
  if (!shouldProbe(watchers, s)) {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    return;
  }
  if (timer === null && !probing) timer = setTimeout(runProbe, PROBE_EVERY_MS);
}

function runProbe(): void {
  if (probing) return;
  if (timer !== null) clearTimeout(timer);
  timer = null;
  probing = true;
  probedAt = Date.now();
  void probe().then(
    (ok) => {
      probing = false;
      update(ok ? { probeOk: true, probeTrusted: true } : { probeOk: false });
    },
    () => {
      probing = false;
      update({ probeOk: false });
    },
  );
}

/** Whether Albedo believes the API is unreachable right now. */
export function isOffline(): boolean {
  current();
  return offline;
}

/** Called whenever `isOffline` changes. */
export function onConnectivityChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Something is waiting on the network: probe now, and every
 * `PROBE_EVERY_MS` until every watcher has stopped.
 */
export function watchConnectivity(): () => void {
  watchers++;
  if (shouldProbe(watchers, current()) && Date.now() - probedAt >= PROBE_EVERY_MS) runProbe();
  else schedule();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    watchers--;
    schedule();
  };
}

function subscribe(cb: () => void): () => void {
  return onConnectivityChange(cb);
}

/** `isOffline`, re-rendering when it changes. */
export function useOffline(): boolean {
  return useSyncExternalStore(subscribe, isOffline, isOffline);
}

/** Test seam: use `p` as the probe and forget all state. */
export function __resetConnectivity(p: Probe = probeApi): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (typeof window !== 'undefined') {
    window.removeEventListener('online', onNavigator);
    window.removeEventListener('offline', onNavigator);
  }
  signals = null;
  offline = false;
  watchers = 0;
  probing = false;
  probedAt = -Infinity;
  probe = p;
  listeners.clear();
}
