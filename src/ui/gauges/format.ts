/**
 * src/ui/gauges/format.ts
 *
 * Pure formatting for the usage gauges. No imports on purpose: this is the
 * testable core of a panel that is permanently on screen, so every number it
 * prints has to be predictable, including the degenerate ones (NaN, negative,
 * Infinity) that a half-built data call can hand us.
 *
 * House rule for this panel: an abbreviation is always accompanied by the
 * exact figure in a `title`, because the abbreviation loses information and the
 * user may be deciding whether to start a new session on the strength of it.
 */

const THOUSAND = 1_000;
const MILLION = 1_000_000;

/** What we print when a number is not a number. Never "0" -- see the panel doc. */
export const NO_VALUE = '—';

/**
 * `186919` -> `186.9k`, `1240000` -> `1.24M`.
 *
 * One decimal in the k range all the way to 999.9k: in a 260px sidebar the
 * digit is free, and `187k` vs `186.9k` is the difference between a figure you
 * can watch move and one you cannot.
 */
export function abbreviateTokens(n: number): string {
  if (!Number.isFinite(n)) return NO_VALUE;
  const v = Math.max(0, n);
  if (v < THOUSAND) return String(Math.round(v));
  if (v < MILLION) return `${(v / THOUSAND).toFixed(1)}k`;
  const m = v / MILLION;
  return `${m < 10 ? m.toFixed(2) : m.toFixed(1)}M`;
}

/** `186919` -> `186,919`. Locale-independent on purpose: tests must be stable. */
export function exactTokens(n: number): string {
  if (!Number.isFinite(n)) return NO_VALUE;
  const v = Math.round(Math.max(0, n));
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Remaining time, as a countdown.
 *
 *   >= 1 day   `3d 14:22`   (changes once a minute)
 *   >= 1 hour  `2:47:13`
 *   otherwise  `07:12`
 *
 * Seconds appear only under an hour and under a day, so a long window does not
 * repaint a digit every second for no reason.
 */
export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms)) return NO_VALUE;
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (x: number) => String(x).padStart(2, '0');
  if (d > 0) return `${d}d ${p(h)}:${p(m)}`;
  if (h > 0) return `${h}:${p(m)}:${p(s)}`;
  return `${p(m)}:${p(s)}`;
}

/** Elapsed duration in the compact form the header already uses. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return NO_VALUE;
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

/** Tokens per hour. `—` rather than `0/h` when the rate is not derivable. */
export function formatRate(tokensPerHour: number): string {
  if (!Number.isFinite(tokensPerHour) || tokensPerHour < 0) return NO_VALUE;
  return `${abbreviateTokens(tokensPerHour)}/h`;
}

/**
 * A fraction as a percentage.
 *
 * `approximate` prefixes `~`. That tilde is load-bearing: everywhere in this
 * panel it means "the denominator is inferred, not measured". It is never
 * omitted for tidiness.
 *
 * 99.5..99.99% floors to 99% rather than rounding to 100: "100%" reads as
 * "full, stop typing", and we will not say that from a rounding artefact.
 */
export function formatPercent(fraction: number, approximate = false): string {
  if (!Number.isFinite(fraction)) return NO_VALUE;
  const pct = Math.max(0, Math.min(100, fraction * 100));
  const rounded = pct < 100 ? Math.min(99, Math.round(pct)) : 100;
  const text = `${rounded}%`;
  return approximate ? `~${text}` : text;
}

export interface BandPercents {
  overhead: number;
  conversation: number;
  free: number;
}

/**
 * Three band sizes -> three widths that sum to exactly 100.
 *
 * Negatives and NaN are floored to zero rather than propagated, and an
 * all-zero input renders as entirely free rather than an empty bar, because a
 * bar with no segments looks like a rendering failure.
 */
export function bandPercents(overhead: number, conversation: number, free: number): BandPercents {
  const o = Number.isFinite(overhead) && overhead > 0 ? overhead : 0;
  const c = Number.isFinite(conversation) && conversation > 0 ? conversation : 0;
  const f = Number.isFinite(free) && free > 0 ? free : 0;
  const total = o + c + f;
  if (total <= 0) return { overhead: 0, conversation: 0, free: 100 };
  const op = round2((o / total) * 100);
  const cp = round2((c / total) * 100);
  return { overhead: op, conversation: cp, free: round2(100 - op - cp) };
}

/** How far through `start`..`end` we are, clamped to 0..1. */
export function elapsedFraction(start: number, end: number, now: number): number {
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(now)) return 0;
  if (end <= start) return 0;
  return Math.max(0, Math.min(1, (now - start) / (end - start)));
}

/**
 * Quantise a bar width so a once-a-second re-render does not become an
 * animation. Half a percent of a 240px bar is just over a pixel, which for a
 * 5h window is a step roughly every 90 seconds.
 */
export function quantisePercent(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.round(Math.max(0, Math.min(100, pct)) * 2) / 2;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
