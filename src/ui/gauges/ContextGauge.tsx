/**
 * src/ui/gauges/ContextGauge.tsx
 *
 * The `/context` analogue: how full is the selected session's context window.
 *
 * ## The honesty problem, and what this component does about it
 *
 * Exactly one number here is a measurement: the token total, straight out of
 * `message.usage`. Everything else is derived from something the transcript
 * does not record.
 *
 *  - The category grid `/context` draws is computed by Claude Code before the
 *    request goes out. The transcript keeps only the aggregate, so the split
 *    is unrecoverable. Two estimated bands (overhead / conversation) beat
 *    seven invented ones.
 *  - The window SIZE is not recorded either, so on most sessions the
 *    denominator -- and therefore the percentage and the free band -- is
 *    inferred from the session's observed peak.
 *
 * So the layout inverts the usual reading order. The exact token count is the
 * large figure; the percentage is small, secondary, and carries a `~` and an
 * `est` marker whenever the limit is inferred. The bar's free region is
 * hatched in that case, matching the convention the task-row meters already
 * use: hatch means "not measured".
 *
 * `capture` refuses to return a free-token figure at all when the limit is
 * inferred (`ContextBands.freeEst === null`). This component honours that: it
 * will draw a bar against the inferred limit, because a picture of fullness is
 * what makes the panel worth glancing at, but it will not PRINT a headroom
 * number it cannot stand behind.
 *
 * Nothing in here animates. Widths transition on a real value change only, and
 * `prefers-reduced-motion` removes even that.
 */

import { memo } from 'react';
import type { ContextBands, ContextUsage } from '../../capture';
import { contextLevel } from '../StatusDot';
import { abbreviateTokens, bandPercents, exactTokens, formatPercent, NO_VALUE } from './format';

/**
 * Past this the reading is the one that matters: the session is close enough
 * to its window that it is about to compact and get slower. Deliberately
 * lower than StatusDot's CONTEXT_HIGH (0.9) -- the task-row hairline is an
 * ambient signal and can wait; this panel is where the user decides whether to
 * start a fresh session, and wants warning before the fact, not at it.
 */
export const NEAR_CEILING = 0.85;

export type GaugeState = 'loading' | 'ready' | 'unavailable' | 'no-session';

export interface ContextGaugeProps {
  usage: ContextUsage | null;
  bands: ContextBands | null;
  state: GaugeState;
}

const LIMIT_CAVEAT =
  'The transcript does not record the model’s context limit, so this window ' +
  'size is inferred from the session’s observed peak. The token count is ' +
  'exact; the percentage and the free band are estimates, not measurements.';

const SPLIT_CAVEAT =
  'Claude Code computes the /context category grid before sending, and the ' +
  'transcript keeps only the aggregate, so this split is approximated from ' +
  'stored message text rather than measured.\n\n' +
  'It has a known direction of error: very large tool results are truncated ' +
  'before they are stored, so on tool-heavy sessions overhead reads high and ' +
  'conversation reads low. Only the total is exact.';

function usageTitle(usage: ContextUsage): string {
  const model = usage.model || 'unknown model';
  const head = `${exactTokens(usage.used)} tokens in context — ${model}`;
  if (usage.limitBasis === 'known' && usage.limit > 0) {
    return `${head}\n${formatPercent(usage.fraction)} of a ${abbreviateTokens(usage.limit)} window (limit known).`;
  }
  return `${head}\nAgainst an inferred ${abbreviateTokens(usage.limit)} window.\n\n${LIMIT_CAVEAT}`;
}

interface KeyRowProps {
  band: 'overhead' | 'conversation' | 'free' | 'used';
  label: string;
  /** null renders as `—`: a band we decline to put a number on. */
  value: number | null;
  estimated: boolean;
  title: string;
}

function KeyRow({ band, label, value, estimated, title }: KeyRowProps) {
  return (
    <>
      <span className="gz-key" title={title}>
        <span className="gz-swatch" data-band={band} aria-hidden="true" />
        <span className="gz-key-label">{label}</span>
        {estimated && <span className="gz-approx">approx</span>}
      </span>
      <span className="gz-val" title={value === null ? title : `${exactTokens(value)} tokens`}>
        {value === null ? NO_VALUE : abbreviateTokens(value)}
      </span>
    </>
  );
}

function ContextGaugeInner({ usage, bands, state }: ContextGaugeProps) {
  if (state === 'no-session') {
    return <p className="gz-unavailable">no session yet</p>;
  }
  if (state === 'loading') {
    return <p className="gz-unavailable">reading…</p>;
  }
  if (state === 'unavailable') {
    return <p className="gz-unavailable">context unavailable</p>;
  }
  if (!usage || !Number.isFinite(usage.used)) {
    // A session that has only a typed prompt so far genuinely has no reading.
    // Drawing 0% here would claim an empty window for a session mid-turn.
    return <p className="gz-unavailable">no context reading yet</p>;
  }

  const inferred = usage.limitBasis !== 'known';
  const level = contextLevel(usage.fraction);

  // Bar geometry. The free slice is drawn against the limit even when that
  // limit is inferred -- the hatch and the `~` say so -- because a bar with no
  // right-hand extent conveys nothing at all.
  const drawFree = Math.max(0, (Number.isFinite(usage.limit) ? usage.limit : 0) - usage.used);
  const split = bands !== null && Number.isFinite(bands.overheadEst) && Number.isFinite(bands.conversationEst);
  const widths = split
    ? bandPercents(bands!.overheadEst, bands!.conversationEst, drawFree)
    : bandPercents(0, usage.used, drawFree);

  // What we are willing to PRINT for headroom. capture returns null whenever
  // the limit is inferred; we do not second-guess it.
  const freeValue: number | null = bands ? bands.freeEst : inferred ? null : drawFree;

  const title = usageTitle(usage);
  const nearCeiling = usage.fraction >= NEAR_CEILING;
  const tone = level === 'high' ? 'danger' : 'warn';

  return (
    <>
      <div className="gz-total">
        <span className="gz-total-figure" title={`${exactTokens(usage.used)} tokens`}>
          {abbreviateTokens(usage.used)}
        </span>
        <span className="gz-total-unit">tok</span>
        <span
          className="gz-total-pct"
          data-approx={inferred ? 'true' : 'false'}
          data-level={level}
          title={title}
        >
          {formatPercent(usage.fraction, inferred)}
          {inferred && <span className="gz-approx">approx</span>}
        </span>
      </div>

      <div className="gz-bar" data-level={level} data-basis={usage.limitBasis} title={title} role="img"
        aria-label={`Context ${exactTokens(usage.used)} tokens, ${formatPercent(usage.fraction, inferred)} of ${inferred ? 'an inferred' : 'a'} ${abbreviateTokens(usage.limit)} window`}>
        {split ? (
          <>
            <span className="gz-seg" data-band="overhead" data-est="true" style={{ width: `${widths.overhead}%` }} />
            <span className="gz-seg" data-band="conversation" data-est="true" style={{ width: `${widths.conversation}%` }} />
          </>
        ) : (
          <span className="gz-seg" data-band="used" style={{ width: `${widths.conversation}%` }} />
        )}
        <span
          className="gz-seg"
          data-band="free"
          data-est={inferred ? 'true' : 'false'}
          style={{ width: `${widths.free}%` }}
        />
      </div>

      <div className="gz-legend">
        {split ? (
          <>
            <KeyRow
              band="overhead"
              label="overhead"
              value={bands!.overheadEst}
              estimated
              title={`System prompt, tools, MCP servers and memory files.\n\n${SPLIT_CAVEAT}`}
            />
            <KeyRow
              band="conversation"
              label="conversation"
              value={bands!.conversationEst}
              estimated
              title={`Messages exchanged in this session.\n\n${SPLIT_CAVEAT}`}
            />
          </>
        ) : (
          <KeyRow
            band="used"
            label="used"
            value={usage.used}
            estimated={false}
            title="Exact, from the most recent turn’s usage record."
          />
        )}
        <KeyRow
          band="free"
          label="free"
          value={freeValue}
          estimated={inferred}
          title={
            freeValue === null
              ? `Not shown: headroom is limit minus used, and the limit here is inferred.\n\n${LIMIT_CAVEAT}`
              : `Headroom against a known ${abbreviateTokens(usage.limit)} window.`
          }
        />
      </div>

      {nearCeiling && (
        <p className="gz-note" data-tone={tone}>
          {inferred
            ? `near the inferred ceiling — compaction likely soon (limit not measured)`
            : `near the ceiling — compaction likely soon`}
        </p>
      )}
    </>
  );
}

/**
 * Memoised: the panel re-renders once a second to tick the countdowns, and
 * none of that concerns the context reading.
 */
const ContextGauge = memo(ContextGaugeInner);
export default ContextGauge;
