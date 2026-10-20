/**
 * src/ui/gauges/WindowGauge.tsx
 *
 * One rolling subscription window: tokens in, tokens out, burn rate, and a
 * live countdown.
 *
 * ## What the countdown actually says
 *
 * `windowUsage` models a TRUE ROLLING window, because the real quota anchor is
 * not on disk: `windowEnd` is when the OLDEST still-counted turn ages out and
 * its tokens come back — not an instant at which a bucket empties and
 * everything frees at once.
 *
 * "resets in 3h12m" would therefore be an overclaim, and a damaging one: it
 * describes a cliff the user would plan around and that does not exist. The
 * label is "ages out in" and the tooltip spells out what ages out. Same rule
 * as the inferred context limit — where the data does not support the obvious
 * phrasing, change the phrasing, not the claim.
 *
 * An empty window has `resetsInMs === 0`. That renders as "no usage in
 * window", never as `00:00`, which would read as "resetting now".
 *
 * ## cacheReadTokens is never added to anything
 *
 * `cacheReadTokens` is true and answers a DIFFERENT question from the other
 * two figures. A session holding 186k of cached context re-reads it on every
 * turn, so over a window it accumulates to roughly 37x the tokens actually
 * spent. Summing it into a total, a rate or a bar is precisely the arithmetic
 * that had this panel reporting 227,000,000 against a real spend of 5,900,000.
 *
 * So it is rendered on its own demoted line, below the spend figures rather
 * than beside them, with a label that carries the distinction. Not "input" --
 * that word is what made the old number look reasonable. It never enters
 * `total`, and `burnRate` excludes it upstream.
 *
 * ## What is deliberately not here
 *
 * A percentage. Nothing on disk carries the plan's token allowance or its
 * reset anchor — capture's module note records that search — so any "73% of
 * your limit" would be a denominator we invented, on a panel that is
 * permanently on screen.
 *
 * That also rules out a progress bar: in a section headed "usage", any
 * horizontal bar reads as percent-of-quota whatever the caption says. Bars in
 * this panel live only in the context section, where the denominator is at
 * least a real quantity.
 *
 * ## Motion
 *
 * The countdown is driven by a `now` the parent ticks once a second. It is the
 * only thing in the panel that changes on its own, and it changes as text:
 * no transition, no pulse, no glow. Above 24h the format drops seconds, so the
 * 7-day window repaints once a minute rather than sixty times.
 */

import type { WindowUsage } from '../../capture';
import { abbreviateTokens, exactTokens, formatCountdown, formatRate, NO_VALUE } from './format';
import type { GaugeState } from './ContextGauge';

export interface WindowGaugeProps {
  /** Short label, e.g. `5h` or `7d`. */
  label: string;
  data: WindowUsage | null;
  state: GaugeState;
  /** Ticking clock from the parent, epoch ms. */
  now: number;
  /** When `data` was fetched — used only if `windowEnd` is unusable. */
  fetchedAt: number;
  /** Omit the label: a switch above already names the window. */
  hideLabel?: boolean;
}

const ROLLING_NOTE =
  'Rolling window: this is when the oldest turn still being counted ages out ' +
  'and its tokens come back to you. It is not a quota reset — nothing frees ' +
  'up all at once, and the real reset anchor is not recorded on disk.';

interface StatProps {
  value: string;
  label: string;
  title: string;
  /** The lead figure: drawn larger, so five numbers read as one answer and two details. */
  primary?: boolean;
}

function Stat({ value, label, title, primary }: StatProps) {
  return (
    <span className="gz-stat" data-primary={primary || undefined} title={title}>
      <span className="gz-stat-val">{value}</span>
      <span className="gz-stat-key">{label}</span>
    </span>
  );
}

export default function WindowGauge({ label, data, state, now, fetchedAt, hideLabel = false }: WindowGaugeProps) {
  // Hidden when a switch above already names the window.
  const head = hideLabel ? null : (
    <span className="gz-window-label" title={`Rolling ${label} window, across all sessions`}>
      {label.toUpperCase()}
    </span>
  );

  if (state !== 'ready' || !data) {
    return (
      <div className="gz-window">
        <div className="gz-window-head">
          {head}
          <span className="gz-unavailable">{state === 'loading' ? 'Reading…' : 'Unavailable'}</span>
        </div>
      </div>
    );
  }

  const input = Number.isFinite(data.inputTokens) ? Math.max(0, data.inputTokens) : NaN;
  const output = Number.isFinite(data.outputTokens) ? Math.max(0, data.outputTokens) : NaN;
  // Spend only. cacheRead is deliberately absent from this sum -- see the
  // note at the top of the file; it is the sum that caused the 38x overstate.
  const total = (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0);
  const cacheRead = Number.isFinite(data.cacheReadTokens) ? Math.max(0, data.cacheReadTokens) : NaN;

  // Prefer the absolute instant: it stays correct however stale the fetch is.
  // `resetsInMs` is a fallback only, and then aged against the fetch.
  const agesOutAt =
    Number.isFinite(data.windowEnd) && data.windowEnd > 0
      ? data.windowEnd
      : Number.isFinite(data.resetsInMs) && data.resetsInMs > 0
        ? fetchedAt + data.resetsInMs
        : null;

  const remaining = agesOutAt === null ? null : agesOutAt - now;
  const empty = total <= 0;
  const haveCountdown = !empty && remaining !== null && remaining > 0;

  return (
    <div className="gz-window">
      <div className="gz-window-head">
        {head}
        {empty ? (
          <span className="gz-unavailable" title={`Nothing counted in the last ${label}.`}>
            No usage in window
          </span>
        ) : (
          <span
            className="gz-ages"
            title={
              haveCountdown && agesOutAt !== null
                ? `Oldest counted usage ages out at ${new Date(agesOutAt).toLocaleTimeString()}.\n\n${ROLLING_NOTE}`
                : `Nothing is due to age out yet.\n\n${ROLLING_NOTE}`
            }
          >
            <span className="gz-ages-key">Ages Out In</span>
            <span className="gz-countdown">
              {haveCountdown && remaining !== null ? formatCountdown(remaining) : NO_VALUE}
            </span>
          </span>
        )}
      </div>
      {/* Spend rate first and large: it is the question this panel answers
          ("how fast am I going"). Input and output are its breakdown. */}
      <div className="gz-stats">
        <Stat
          primary
          value={formatRate(data.burnRate)}
          /* Not "rate". A bare "rate" invites exactly one question -- rate of
             what? -- and that is the distinction this panel spent a round
             getting right. The value keeps its own /h so it still reads
             correctly quoted on its own. */
          label="Spend/h"
          title={`${exactTokens(data.burnRate)} tokens spent per hour across all sessions (input + output).\nTotal spent in window: ${exactTokens(total)} tokens. Cached re-read is not counted.`}
        />
        <Stat
          value={abbreviateTokens(input)}
          label="Input"
          title={`${exactTokens(input)} input tokens spent: fresh prompt + cache writes.\nExcludes cached context re-read, which is shown separately.`}
        />
        <Stat value={abbreviateTokens(output)} label="Output" title={`${exactTokens(output)} output tokens`} />
      </div>
      {Number.isFinite(cacheRead) && cacheRead > 0 && (
        <p
          className="gz-cache"
          title={
            `${exactTokens(cacheRead)} tokens of already-cached context re-read from the cache.\n\n` +
            'This is NOT spend and is deliberately kept out of the totals and the ' +
            'rate above. A session holding a large context re-reads it on every ' +
            'turn, so this accumulates to many times the tokens actually spent — ' +
            'adding the two together is what made this panel overstate usage 38x.\n\n' +
            'It is worth showing because it measures how much cached context the ' +
            'fleet is carrying, which is a real cost of running several sessions.'
          }
        >
          <span className="gz-cache-val">{abbreviateTokens(cacheRead)}</span>{' '}
          <span className="gz-cache-key">Cached Re-read &middot; Not Spend</span>
        </p>
      )}
    </div>
  );
}
