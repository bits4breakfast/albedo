/**
 * Theme: the single source of truth.
 *
 * Owner: shell workstream (M2). Everything that needs to know what theme the
 * app is in depends on this module — the toggle, the xterm palette, the
 * editor. There is deliberately ONE of these.
 *
 * Two independent "what theme are we in" resolvers do not stay in agreement.
 * They agree today, when the rule is just `data-theme` plus a media query,
 * and they drift the moment it is anything subtler — a per-window override, a
 * forced theme while capturing a screenshot, a suppressed transition — and
 * they drift silently, because each one looks correct on its own.
 *
 * ## Where the truth lives
 *
 * CSS, not JavaScript. `resolvedTheme()` reads the `--is-dark` token off the
 * computed root style rather than re-deriving the answer from the attribute
 * and the media query. The cascade already resolves those two against each
 * other — including the `:not([data-theme='light'])` guard that lets an
 * explicit light choice win on a dark machine — so asking CSS means there is
 * no second implementation of that logic to get wrong. Any future rule
 * expressed as a selector is picked up for free.
 *
 * The derivation below it is a fallback for the two cases where computed
 * styles cannot answer: before the stylesheet has parsed, and under jsdom.
 */

export type ThemeChoice = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'albedo.shell.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function isChoice(v: unknown): v is ThemeChoice {
  return v === 'system' || v === 'light' || v === 'dark';
}

// ---------------------------------------------------------------------------
// Persisted choice
// ---------------------------------------------------------------------------

function readStored(): ThemeChoice {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isChoice(raw) ? raw : 'system';
  } catch {
    // Private mode, blocked storage: a theme preference is not worth throwing.
    return 'system';
  }
}

let currentChoice: ThemeChoice = 'system';
let choiceLoaded = false;

export function themeChoice(): ThemeChoice {
  if (!choiceLoaded) {
    currentChoice = readStored();
    choiceLoaded = true;
  }
  return currentChoice;
}

/**
 * Write `data-theme` onto <html>. `system` REMOVES the attribute rather than
 * setting it to "system": the media block is guarded on
 * `:not([data-theme='light'])`, so a stray value would still behave, but
 * leaving it off keeps the DOM honest about what was actually chosen.
 */
function writeAttribute(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

export function setThemeChoice(choice: ThemeChoice): void {
  if (!isChoice(choice)) return;
  currentChoice = choice;
  choiceLoaded = true;
  writeAttribute(choice);
  try {
    window.localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    /* preference is lost on restart, nothing else breaks */
  }
  notify();
}

/**
 * Apply the stored choice. Call once, synchronously, BEFORE the first render —
 * doing it in an effect paints one frame of the wrong theme on every launch,
 * which on a dark-preferring machine is a white flash.
 */
export function applyStoredTheme(): void {
  writeAttribute(themeChoice());
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function prefersDark(): boolean {
  try {
    return window.matchMedia(DARK_QUERY).matches;
  } catch {
    return true; // this app was dark-only first; dark is the safer guess
  }
}

/** Fallback for before the stylesheet has parsed, and for jsdom. */
function deriveResolved(): ResolvedTheme {
  let attr: string | null = null;
  try {
    attr = document.documentElement.getAttribute('data-theme');
  } catch {
    /* no DOM */
  }
  if (attr === 'dark') return 'dark';
  if (attr === 'light') return 'light';
  return prefersDark() ? 'dark' : 'light';
}

export function resolvedTheme(): ResolvedTheme {
  try {
    const flag = getComputedStyle(document.documentElement).getPropertyValue('--is-dark').trim();
    if (flag === '1') return 'dark';
    if (flag === '0') return 'light';
  } catch {
    /* fall through */
  }
  return deriveResolved();
}

// ---------------------------------------------------------------------------
// Notification
// ---------------------------------------------------------------------------

/** Fires on ANY theme-relevant change; consumers dedupe as they need. */
const rawListeners = new Set<() => void>();
let watchInstalled = false;

function notify(): void {
  // One frame, so an attribute change has landed in computed styles before
  // anybody reads a token off them.
  const run = () => {
    for (const cb of [...rawListeners]) {
      try {
        cb();
      } catch {
        /* one subscriber failing must not stop the rest */
      }
    }
  };
  if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(run);
  else run();
}

function installWatch(): void {
  if (watchInstalled) return;
  watchInstalled = true;
  try {
    new MutationObserver(notify).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
  } catch {
    /* no MutationObserver: explicit changes still notify via setThemeChoice */
  }
  try {
    window.matchMedia(DARK_QUERY).addEventListener('change', notify);
  } catch {
    /* older webview: system changes apply on next mount */
  }
}

function subscribeRaw(cb: () => void): () => void {
  installWatch();
  rawListeners.add(cb);
  return () => {
    rawListeners.delete(cb);
  };
}

/**
 * Subscribe to the RESOLVED theme. Deduped: switching choice from `system` to
 * `light` on an already-light machine resolves to the same thing and fires
 * nothing, so subscribers doing real work — repainting a terminal — are not
 * asked to repaint for a no-op.
 */
export function onThemeChange(cb: (theme: ResolvedTheme) => void): () => void {
  let last = resolvedTheme();
  return subscribeRaw(() => {
    const next = resolvedTheme();
    if (next === last) return;
    last = next;
    cb(next);
  });
}

// ---------------------------------------------------------------------------
// React
// ---------------------------------------------------------------------------

import { useCallback, useSyncExternalStore } from 'react';

export interface UseThemeResult {
  /** What the user picked. */
  choice: ThemeChoice;
  /** What that actually resolves to right now. */
  resolved: ResolvedTheme;
  setChoice: (choice: ThemeChoice) => void;
}

export function useTheme(): UseThemeResult {
  // Subscribes to the RAW notifier, not onThemeChange: a choice change that
  // resolves to the same theme still has to move the toggle.
  const choice = useSyncExternalStore(subscribeRaw, themeChoice, themeChoice);
  const resolved = useSyncExternalStore(subscribeRaw, resolvedTheme, resolvedTheme);
  const setChoice = useCallback((next: ThemeChoice) => setThemeChoice(next), []);
  return { choice, resolved, setChoice };
}
