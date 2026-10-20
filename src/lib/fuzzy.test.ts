import { describe, expect, it } from 'vitest';
import { basenameStart, BASENAME_TIER, fuzzyMatch, lowerSameLength, matchPath, normaliseQuery, TopK } from './fuzzy';

const m = (q: string, text: string) => fuzzyMatch(normaliseQuery(q), text, text.toLowerCase());
const p = (q: string, path: string) => matchPath(normaliseQuery(q), path, path.toLowerCase(), basenameStart(path));

/** Rank candidates by score, best first, as the palette would. */
function rank(q: string, candidates: string[]): string[] {
  return candidates
    .map((c) => ({ c, hit: m(q, c) }))
    .filter((x) => x.hit !== null)
    .sort((a, b) => b.hit!.score - a.hit!.score || a.c.length - b.c.length)
    .map((x) => x.c);
}

describe('fuzzyMatch', () => {
  it('requires a case-insensitive subsequence', () => {
    expect(m('abc', 'aXbXc')).not.toBeNull();
    expect(m('ABC', 'abc')).not.toBeNull();
    expect(m('acb', 'abc')).toBeNull();
    expect(m('abcd', 'abc')).toBeNull();
  });

  it('an empty query matches everything with no indices', () => {
    expect(m('', 'anything')).toEqual({ score: 0, indices: [] });
  });

  it('returns the matched indices for highlighting', () => {
    expect(m('mprt', 'McpParameterRestrictionTest')!.indices).toEqual([0, 3, 12, 23]);
  });

  it('picks the hump, not the leftmost occurrence', () => {
    // Greedy would take the `p` in `Mcp`; the DP takes `Parameter`'s.
    const hit = m('mp', 'McpParameter')!;
    expect(hit.indices).toEqual([0, 3]);
  });

  it('ranks CamelCase humps over scattered letters', () => {
    const out = rank('mprt', [
      'MockProductAnalyticsTracker',
      'ImportReportTotals',
      'McpParameterRestrictionTest',
      'mapreport',
    ]);
    expect(out[0]).toBe('McpParameterRestrictionTest');
  });

  it('ranks consecutive runs over scattered letters', () => {
    expect(rank('user', ['UnsavedSessionError', 'UserService'])[0]).toBe('UserService');
  });

  it('ranks word starts after separators', () => {
    expect(rank('fb', ['afoobar', 'foo_bar'])[0]).toBe('foo_bar');
    expect(rank('fb', ['afoobar', 'foo-bar'])[0]).toBe('foo-bar');
  });

  it('treats the last capital of an acronym as a hump', () => {
    expect(m('hs', 'HTTPServer')!.indices).toEqual([0, 4]);
  });

  it('ignores whitespace in the query', () => {
    expect(m('user ser', 'UserService')).not.toBeNull();
  });

  it('keeps indices aligned when lowercasing would change the length', () => {
    const text = 'İxFoo';
    expect(lowerSameLength(text).length).toBe(text.length);
    expect(fuzzyMatch('foo', text, text.toLowerCase())!.indices).toEqual([2, 3, 4]);
  });
});

describe('matchPath', () => {
  it('prefers a basename match over a directory match', () => {
    const inBase = p('term', 'src/ui/Terminal.tsx')!;
    const inDir = p('term', 'src/terminal/index.ts')!;
    expect(inBase.score).toBeGreaterThan(inDir.score);
    expect(inBase.score).toBeGreaterThanOrEqual(BASENAME_TIER);
  });

  it('falls back to the whole path when the basename cannot match', () => {
    const hit = p('uiterm', 'src/ui/Terminal.tsx')!;
    expect(hit).not.toBeNull();
    expect(hit.score).toBeLessThan(BASENAME_TIER);
    expect(hit.indices.slice(0, 2)).toEqual([4, 5]);
  });

  it('reports indices into the full path for basename hits', () => {
    expect(p('term', 'src/ui/Terminal.tsx')!.indices).toEqual([7, 8, 9, 10]);
  });

  it('a query with a slash is matched against the whole path', () => {
    const hit = p('ui/t', 'src/ui/Terminal.tsx')!;
    expect(hit.indices).toEqual([4, 5, 6, 7]);
  });

  it('handles a path with no directory', () => {
    expect(p('rd', 'README.md')).not.toBeNull();
  });
});

describe('TopK', () => {
  it('keeps the best n in order', () => {
    const top = new TopK<number>(3, (a, b) => b - a);
    for (const n of [5, 1, 9, 3, 7, 2]) top.push(n);
    expect(top.items).toEqual([9, 7, 5]);
    expect(top.seen).toBe(6);
  });
});

describe('performance', () => {
  it('scores 50k candidates well inside a frame budget', () => {
    const words = ['User', 'Service', 'Controller', 'Mcp', 'Parameter', 'Restriction', 'Test', 'Repository', 'Hotel', 'Upgrade'];
    const cands: { text: string; lower: string }[] = [];
    for (let i = 0; i < 50_000; i++) {
      const text = `src/${words[i % 10]}/${words[(i * 7) % 10]}${words[(i * 3) % 10]}${words[(i * 11) % 10]}${i}.php`;
      cands.push({ text, lower: text.toLowerCase() });
    }
    const q = normaliseQuery('usrv');
    // The fastest of five runs: a single wall-clock sample failed whenever the
    // machine was busy (803ms under a parallel build, ~20ms idle). The best
    // run is what the code costs; a regression to quadratic is seconds.
    let best = Infinity;
    let hits = 0;
    for (let run = 0; run < 5; run++) {
      hits = 0;
      const t0 = performance.now();
      for (const c of cands) if (matchPath(q, c.text, c.lower, basenameStart(c.text))) hits++;
      best = Math.min(best, performance.now() - t0);
    }
    expect(hits).toBeGreaterThan(0);
    expect(best).toBeLessThan(500);
  });
});
