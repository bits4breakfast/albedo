/**
 * src/ui/gauges/gauges.test.tsx
 *
 * Two kinds of test:
 *
 *  1. The pure formatters, which every figure on a permanently-visible panel
 *     goes through — including the degenerate inputs (NaN, negative, Infinity)
 *     a half-built data call can hand us.
 *  2. Rendered markup for the branches where the panel makes an HONESTY claim:
 *     an inferred limit must never print a bare percentage, a known limit must
 *     print one, and an empty usage window must never render as `00:00`.
 *
 * Rendering is done with react-dom/server, so these run in the existing
 * `environment: 'node'` vitest setup with no jsdom.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ContextBands, ContextUsage, WindowUsage } from '../../capture';
import ContextGauge from './ContextGauge';
import WindowGauge from './WindowGauge';
import {
  abbreviateTokens,
  bandPercents,
  elapsedFraction,
  exactTokens,
  formatCountdown,
  formatDuration,
  formatPercent,
  formatRate,
  quantisePercent,
  NO_VALUE,
} from './format';

describe('abbreviateTokens', () => {
  it('keeps one decimal through the k range', () => {
    expect(abbreviateTokens(186_919)).toBe('186.9k');
    expect(abbreviateTokens(1_500)).toBe('1.5k');
    expect(abbreviateTokens(999_949)).toBe('999.9k');
  });

  it('prints small counts exactly', () => {
    expect(abbreviateTokens(0)).toBe('0');
    expect(abbreviateTokens(999)).toBe('999');
    expect(abbreviateTokens(999.4)).toBe('999');
  });

  it('switches to M with more precision while small', () => {
    expect(abbreviateTokens(1_240_000)).toBe('1.24M');
    expect(abbreviateTokens(12_400_000)).toBe('12.4M');
  });

  it('never invents a zero from a bad input', () => {
    expect(abbreviateTokens(NaN)).toBe(NO_VALUE);
    expect(abbreviateTokens(Infinity)).toBe(NO_VALUE);
    expect(abbreviateTokens(-5)).toBe('0');
  });
});

describe('exactTokens', () => {
  it('groups thousands locale-independently', () => {
    expect(exactTokens(186_919)).toBe('186,919');
    expect(exactTokens(1_000)).toBe('1,000');
    expect(exactTokens(999)).toBe('999');
    expect(exactTokens(1_234_567)).toBe('1,234,567');
  });

  it('degrades rather than lying', () => {
    expect(exactTokens(NaN)).toBe(NO_VALUE);
  });
});

describe('formatCountdown', () => {
  it('drops seconds past a day', () => {
    expect(formatCountdown((3 * 86_400 + 14 * 3600 + 22 * 60 + 9) * 1000)).toBe('3d 14:22');
  });

  it('shows h:mm:ss inside a day', () => {
    expect(formatCountdown((2 * 3600 + 47 * 60 + 13) * 1000)).toBe('2:47:13');
  });

  it('shows mm:ss under an hour', () => {
    expect(formatCountdown(7 * 60_000 + 12_000)).toBe('07:12');
    expect(formatCountdown(0)).toBe('00:00');
  });

  it('clamps negatives instead of printing a minus sign', () => {
    expect(formatCountdown(-5_000)).toBe('00:00');
    expect(formatCountdown(NaN)).toBe(NO_VALUE);
  });
});

describe('formatDuration', () => {
  it('scales the unit to the magnitude', () => {
    expect(formatDuration(45 * 60_000)).toBe('45m');
    expect(formatDuration((2 * 3600 + 5 * 60) * 1000)).toBe('2h 05m');
    expect(formatDuration(2.5 * 86_400_000)).toBe('2d 12h');
    expect(formatDuration(NaN)).toBe(NO_VALUE);
  });
});

describe('formatRate', () => {
  it('abbreviates and units the rate', () => {
    expect(formatRate(31_400)).toBe('31.4k/h');
    expect(formatRate(0)).toBe('0/h');
  });

  it('refuses a rate it cannot derive', () => {
    expect(formatRate(NaN)).toBe(NO_VALUE);
    expect(formatRate(-1)).toBe(NO_VALUE);
  });
});

describe('formatPercent', () => {
  it('rounds and clamps', () => {
    expect(formatPercent(0.4321)).toBe('43%');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(1.4)).toBe('100%');
  });

  it('never rounds up into a bare 100%', () => {
    // 99.6% is not full. Saying "100%" would tell the user to stop typing.
    expect(formatPercent(0.996)).toBe('99%');
  });

  it('marks an approximation with a tilde', () => {
    expect(formatPercent(0.4321, true)).toBe('~43%');
    expect(formatPercent(NaN, true)).toBe(NO_VALUE);
  });
});

describe('bandPercents', () => {
  it('normalises to exactly 100', () => {
    const b = bandPercents(10, 30, 60);
    expect(b).toEqual({ overhead: 10, conversation: 30, free: 60 });
    expect(b.overhead + b.conversation + b.free).toBe(100);
  });

  it('rescales when the inputs are raw token counts', () => {
    const b = bandPercents(50_000, 50_000, 100_000);
    expect(b.overhead + b.conversation + b.free).toBe(100);
    expect(b.free).toBe(50);
  });

  it('floors junk rather than propagating it', () => {
    expect(bandPercents(NaN, -3, 0)).toEqual({ overhead: 0, conversation: 0, free: 100 });
    const b = bandPercents(-1, 25, 75);
    expect(b.overhead).toBe(0);
    expect(b.conversation + b.free).toBe(100);
  });
});

describe('elapsedFraction / quantisePercent', () => {
  it('clamps to 0..1', () => {
    expect(elapsedFraction(0, 100, 50)).toBe(0.5);
    expect(elapsedFraction(0, 100, -10)).toBe(0);
    expect(elapsedFraction(0, 100, 500)).toBe(1);
    expect(elapsedFraction(100, 100, 100)).toBe(0);
    expect(elapsedFraction(NaN, 1, 1)).toBe(0);
  });

  it('quantises to half a percent so a 1s tick is not an animation', () => {
    expect(quantisePercent(33.31)).toBe(33.5);
    expect(quantisePercent(33.2)).toBe(33);
    expect(quantisePercent(-4)).toBe(0);
    expect(quantisePercent(180)).toBe(100);
    expect(quantisePercent(NaN)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rendered honesty claims
// ---------------------------------------------------------------------------

function usage(over: Partial<ContextUsage> = {}): ContextUsage {
  return {
    used: 186_919,
    limit: 200_000,
    fraction: 186_919 / 200_000,
    limitBasis: 'inferred',
    model: 'claude-opus-5',
    at: 1_700_000_000_000,
    ...over,
  };
}

function bands(over: Partial<ContextBands> = {}): ContextBands {
  return {
    totalUsed: 186_919,
    conversationEst: 120_000,
    overheadEst: 66_919,
    freeEst: null,
    basis: { total: 'measured', conversation: 'estimated', overhead: 'estimated' },
    ...over,
  };
}

describe('ContextGauge — inferred limit', () => {
  const html = renderToStaticMarkup(
    <ContextGauge usage={usage()} bands={bands()} state="ready" />,
  );

  it('always shows the exact total, which is the only measurement', () => {
    expect(html).toContain('186.9k');
    expect(html).toContain('186,919 tokens');
  });

  it('never prints a bare percentage', () => {
    expect(html).toContain('~93%');
    expect(html).not.toMatch(/>93%</);
    expect(html).toContain('approx');
  });

  it('marks the bar as inferred so the fill is not read as measured', () => {
    expect(html).toContain('data-basis="inferred"');
    expect(html).toContain('data-band="free" data-est="true"');
  });

  it('declines to print a headroom figure it cannot stand behind', () => {
    // capture returns freeEst === null for an inferred limit; we do not
    // recompute limit - used behind its back.
    expect(html).not.toContain('13.1k');
    expect(html).toContain(NO_VALUE);
  });

  it('explains the inference in a tooltip', () => {
    expect(html).toContain('inferred from the session');
  });

  it('warns near the ceiling without claiming precision', () => {
    expect(html).toContain('near the inferred ceiling');
  });
});

describe('ContextGauge — known limit', () => {
  const known = usage({ limitBasis: 'known', limit: 1_000_000, used: 420_000, fraction: 0.42 });
  const html = renderToStaticMarkup(
    <ContextGauge
      usage={known}
      bands={bands({ totalUsed: 420_000, conversationEst: 300_000, overheadEst: 120_000, freeEst: 580_000 })}
      state="ready"
    />,
  );

  it('prints a hard percentage with no tilde and no approx marker on it', () => {
    expect(html).toContain('42%');
    expect(html).not.toContain('~42%');
    expect(html).toContain('data-approx="false"');
  });

  it('prints real headroom and leaves the free band unhatched', () => {
    expect(html).toContain('580.0k');
    expect(html).toContain('data-band="free" data-est="false"');
    expect(html).toContain('data-basis="known"');
  });

  it('still marks the two estimated bands', () => {
    expect(html).toContain('approx');
    expect(html).toContain('overhead');
    expect(html).toContain('conversation');
  });

  it('does not cry wolf below the ceiling', () => {
    expect(html).not.toContain('compaction likely');
  });
});

describe('ContextGauge — degraded states', () => {
  it('renders a quiet note rather than a zero', () => {
    for (const state of ['loading', 'unavailable', 'no-session'] as const) {
      const html = renderToStaticMarkup(<ContextGauge usage={null} bands={null} state={state} />);
      expect(html).toContain('gz-unavailable');
      expect(html).not.toContain('0%');
    }
  });

  it('falls back to a single measured band when the split is missing', () => {
    const html = renderToStaticMarkup(
      <ContextGauge usage={usage()} bands={null} state="ready" />,
    );
    expect(html).toContain('data-band="used"');
    expect(html).toContain('186.9k');
  });

  it('says nothing at all when the session has no reading yet', () => {
    const html = renderToStaticMarkup(<ContextGauge usage={null} bands={null} state="ready" />);
    expect(html).toContain('no context reading yet');
  });
});

// ---------------------------------------------------------------------------

function windowData(over: Partial<WindowUsage> = {}): WindowUsage {
  const now = 1_700_000_000_000;
  return {
    windowStart: now - 5 * 3_600_000,
    windowEnd: now + (2 * 3600 + 47 * 60 + 13) * 1000,
    inputTokens: 1_420_000,
    outputTokens: 44_800,
    resetsInMs: (2 * 3600 + 47 * 60 + 13) * 1000,
    burnRate: 31_400,
    ...over,
  };
}

describe('WindowGauge', () => {
  const now = 1_700_000_000_000;

  it('counts down to the oldest turn ageing out, not to a quota reset', () => {
    const html = renderToStaticMarkup(
      <WindowGauge label="5h" data={windowData()} state="ready" now={now} fetchedAt={now} />,
    );
    expect(html).toContain('2:47:13');
    expect(html).toContain('ages out in');
    expect(html).not.toMatch(/resets? in/i);
  });

  it('shows in, out and rate with units', () => {
    const html = renderToStaticMarkup(
      <WindowGauge label="5h" data={windowData()} state="ready" now={now} fetchedAt={now} />,
    );
    expect(html).toContain('1.42M');
    expect(html).toContain('44.8k');
    expect(html).toContain('31.4k/h');
    expect(html).toContain('1,420,000');
  });

  it('never shows a percentage of a plan limit', () => {
    const html = renderToStaticMarkup(
      <WindowGauge label="5h" data={windowData()} state="ready" now={now} fetchedAt={now} />,
    );
    expect(html).not.toMatch(/\d%/);
  });

  it('renders an empty window as "no usage", never as 00:00', () => {
    const html = renderToStaticMarkup(
      <WindowGauge
        label="7d"
        data={windowData({ inputTokens: 0, outputTokens: 0, resetsInMs: 0, windowEnd: now })}
        state="ready"
        now={now}
        fetchedAt={now}
      />,
    );
    expect(html).toContain('no usage in window');
    expect(html).not.toContain('00:00');
  });

  it('ages resetsInMs against the fetch when windowEnd is unusable', () => {
    const html = renderToStaticMarkup(
      <WindowGauge
        label="5h"
        data={windowData({ windowEnd: 0, resetsInMs: 3_600_000 })}
        state="ready"
        now={now + 60_000}
        fetchedAt={now}
      />,
    );
    expect(html).toContain('59:00');
  });

  it('renders unavailable rather than zeros when the call failed', () => {
    const html = renderToStaticMarkup(
      <WindowGauge label="5h" data={null} state="unavailable" now={now} fetchedAt={now} />,
    );
    expect(html).toContain('unavailable');
    expect(html).not.toContain('0/h');
  });
});
