/**
 * @vitest-environment jsdom
 *
 * Offline detection from Albedo's side: navigator.onLine plus a probe that
 * runs only while something waits, with a fake probe in place of the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PROBE_EVERY_MS,
  __resetConnectivity,
  isOffline,
  isOfflineGiven,
  onConnectivityChange,
  probeApi,
  shouldProbe,
  watchConnectivity,
} from './connectivity';

let reachable = true;
const probe = vi.fn(async () => reachable);
let navigatorOnline = true;

beforeEach(() => {
  vi.useFakeTimers();
  reachable = true;
  navigatorOnline = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => navigatorOnline });
  probe.mockClear();
  __resetConnectivity(probe);
});

afterEach(() => {
  __resetConnectivity();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Let the probe's promise settle. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('the rule', () => {
  it('is offline with no network, or when a probe that has worked fails', () => {
    expect(isOfflineGiven({ navigatorOnline: false, probeOk: null, probeTrusted: false })).toBe(true);
    expect(isOfflineGiven({ navigatorOnline: true, probeOk: false, probeTrusted: true })).toBe(true);
    expect(isOfflineGiven({ navigatorOnline: true, probeOk: true, probeTrusted: true })).toBe(false);
  });

  it('does not believe a probe that has never worked: it may be the webview, not the network', () => {
    expect(isOfflineGiven({ navigatorOnline: true, probeOk: false, probeTrusted: false })).toBe(false);
  });

  it('probes only while something waits, or while the API is unreachable', () => {
    const up = { navigatorOnline: true, probeOk: true, probeTrusted: true };
    expect(shouldProbe(0, up)).toBe(false);
    expect(shouldProbe(1, up)).toBe(true);
    expect(shouldProbe(0, { ...up, probeOk: false })).toBe(true);
    // No network at all: the online event says when it is back, for free.
    expect(shouldProbe(1, { ...up, navigatorOnline: false })).toBe(false);
  });
});

describe('the store', () => {
  it('does not probe while nothing waits', async () => {
    expect(isOffline()).toBe(false);
    await vi.advanceTimersByTimeAsync(PROBE_EVERY_MS * 5);
    expect(probe).not.toHaveBeenCalled();
  });

  it('probes at once and every 10s while watched, and stops after', async () => {
    const stop = watchConnectivity();
    await settle();
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PROBE_EVERY_MS);
    expect(probe).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(PROBE_EVERY_MS * 3);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('a burst of watchers costs one probe', async () => {
    const a = watchConnectivity();
    await settle();
    const b = watchConnectivity();
    const c = watchConnectivity();
    await settle();
    expect(probe).toHaveBeenCalledTimes(1);
    a();
    b();
    c();
  });

  it('goes offline when the API stops answering, keeps checking, and comes back', async () => {
    const changes = vi.fn();
    onConnectivityChange(changes);
    const stop = watchConnectivity();
    await settle(); // a success: the probe is trusted from here on
    reachable = false;
    await vi.advanceTimersByTimeAsync(PROBE_EVERY_MS);
    expect(isOffline()).toBe(true);
    // Nothing waits any more, but the way back is still watched.
    stop();
    reachable = true;
    await vi.advanceTimersByTimeAsync(PROBE_EVERY_MS);
    expect(isOffline()).toBe(false);
    expect(changes).toHaveBeenCalledTimes(2);
    // And then it rests.
    const calls = probe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(PROBE_EVERY_MS * 3);
    expect(probe).toHaveBeenCalledTimes(calls);
  });

  it('follows navigator.onLine, and probes on the way back', async () => {
    watchConnectivity();
    await settle();
    navigatorOnline = false;
    window.dispatchEvent(new Event('offline'));
    expect(isOffline()).toBe(true);
    navigatorOnline = true;
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(isOffline()).toBe(false);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe('probeApi', () => {
  it('is a credential-free no-cors HEAD, true on any answer', async () => {
    const fetch = vi.fn(async () => new Response(null));
    vi.stubGlobal('fetch', fetch);
    expect(await probeApi()).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/',
      expect.objectContaining({ method: 'HEAD', mode: 'no-cors', credentials: 'omit' }),
    );
  });

  it('is false when the request fails, and never throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Load failed'))));
    expect(await probeApi()).toBe(false);
  });
});
