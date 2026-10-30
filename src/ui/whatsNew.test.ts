import { describe, expect, it } from 'vitest';
import type { BuildCommit, BuildInfo } from '../lib/build';
import {
  LATEST_COUNT,
  lastList,
  prUrl,
  sameCommit,
  seenBuildCodec,
  seenRecord,
  shortDate,
  somethingNeedsAttention,
  whatsNewSince,
  whatsNewSubtitle,
} from './whatsNew';

const REPO = 'https://github.com/bits4breakfast/albedo';

/** `n` commits, newest first: `Change n-1` ... `Change 0`, shas `a0000{i}`. */
function history(n: number): BuildCommit[] {
  return Array.from({ length: n }, (_, k) => {
    const i = n - 1 - k;
    return { sha: `a${String(i).padStart(6, '0')}`, subject: `Change ${i}`, pr: 100 + i };
  });
}

function build(over: Partial<BuildInfo> = {}): BuildInfo {
  const h = over.history ?? history(30);
  return { sha: h[0]?.sha ?? 'fff0000', dirty: false, at: '2026-10-30T10:00:00Z', repo: REPO, history: h, ...over };
}

const seen = (sha: string, at = '2026-10-29T08:00:00Z') => ({ sha, at });

describe('whatsNewSince', () => {
  it('first run: nothing to show, and nothing to compare', () => {
    expect(whatsNewSince(build(), null)).toEqual({ kind: 'none', reason: 'first-run' });
  });

  it('no embedded build: nothing', () => {
    expect(whatsNewSince(null, seen('a000001'))).toEqual({ kind: 'none', reason: 'no-build' });
  });

  it('same build: nothing, even when the abbreviation grew', () => {
    const b = build();
    expect(whatsNewSince(b, seen(b.sha))).toEqual({ kind: 'none', reason: 'same' });
    expect(whatsNewSince(b, seen(`${b.sha}9`))).toEqual({ kind: 'none', reason: 'same' });
    expect(whatsNewSince({ ...b, sha: `${b.sha}9` }, seen(b.sha))).toEqual({ kind: 'none', reason: 'same' });
  });

  it('found: the commits after the last build, newest first', () => {
    const b = build();
    const d = whatsNewSince(b, seen('a000025'));
    expect(d.kind).toBe('list');
    if (d.kind !== 'list') return;
    expect(d.list.changes.map((c) => c.subject)).toEqual(['Change 29', 'Change 28', 'Change 27', 'Change 26']);
    expect(d.list.since).toEqual(seen('a000025'));
    expect(d.list.dirty).toBe(false);
    expect(d.list.repo).toBe(REPO);
  });

  it('found when git has since lengthened the abbreviation', () => {
    const longer = history(30).map((c) => ({ ...c, sha: `${c.sha}f` }));
    const d = whatsNewSince(build({ history: longer }), seen('a000028'));
    expect(d.kind).toBe('list');
    if (d.kind === 'list') expect(d.list.changes).toHaveLength(1);
  });

  it('not found: the latest few, saying earlier ones are not listed', () => {
    const d = whatsNewSince(build(), seen('deadbee'));
    expect(d.kind).toBe('list');
    if (d.kind !== 'list') return;
    expect(d.list.changes).toHaveLength(LATEST_COUNT);
    expect(d.list.changes[0]!.subject).toBe('Change 29');
    expect(d.list.since).toBeNull();
  });

  it('dirty: the list says the build is not only its commits', () => {
    const d = whatsNewSince(build({ dirty: true }), seen('a000028'));
    expect(d.kind === 'list' && d.list.dirty).toBe(true);
  });

  it('an executable built before the last one run shows nothing', () => {
    expect(whatsNewSince(build(), seen('deadbee', '2026-10-31T00:00:00Z'))).toEqual({ kind: 'none', reason: 'older' });
  });

  it('a new commit with no history embedded shows nothing', () => {
    expect(whatsNewSince(build({ sha: 'b000001', history: [] }), seen('deadbee'))).toEqual({
      kind: 'none',
      reason: 'no-history',
    });
    // A build from before #147 carries no `history` at all.
    const { history: _h, ...old } = build({ sha: 'b000001' });
    expect(whatsNewSince(old, seen('deadbee'))).toEqual({ kind: 'none', reason: 'no-history' });
  });
});

describe('lastList and seenRecord', () => {
  it('reopens the list that was dismissed for this build', () => {
    const b = build();
    const d = whatsNewSince(b, seen('a000027'));
    const record = seenRecord(b, d.kind === 'list' ? d.list : null);
    expect(record).toEqual({ sha: b.sha, at: b.at, from: seen('a000027') });
    expect(lastList(b, record)?.changes).toHaveLength(2);
  });

  it('falls back to the latest few: first run, not found, or a record for another build', () => {
    const b = build();
    expect(lastList(b, seenRecord(b, null))?.changes).toHaveLength(LATEST_COUNT);
    expect(lastList(b, null)?.since).toBeNull();
    expect(lastList(b, { sha: 'b000001', at: b.at, from: seen('a000027') })?.since).toBeNull();
  });

  it('has nothing for a build without history', () => {
    expect(lastList(build({ history: [] }), null)).toBeNull();
    expect(lastList(null, null)).toBeNull();
  });
});

describe('seenBuildCodec', () => {
  it('round-trips, and reads anything else as never seen', () => {
    const v = { sha: 'abc1234', at: '2026-10-29T08:00:00Z', from: { sha: 'abc0000', at: '2026-10-20T08:00:00Z' } };
    expect(seenBuildCodec.decode(seenBuildCodec.encode(v) as string)).toEqual(v);
    expect(seenBuildCodec.decode('{"sha":"abc1234","at":"x"}')).toEqual({ sha: 'abc1234', at: 'x', from: null });
    expect(seenBuildCodec.decode('"abc1234"')).toBeNull();
    expect(seenBuildCodec.decode('{"sha":""}')).toBeNull();
  });
});

describe('words', () => {
  it('says when it was built and what the list covers', () => {
    const b = build();
    const found = whatsNewSince(b, seen('a000017'));
    if (found.kind !== 'list') throw new Error('expected a list');
    expect(whatsNewSubtitle(found.list)).toBe(
      `Built ${shortDate(b.at)} · 12 changes since the build you last ran on ${shortDate('2026-10-29T08:00:00Z')}`,
    );
    const one = whatsNewSince(b, seen('a000028'));
    if (one.kind !== 'list') throw new Error('expected a list');
    expect(whatsNewSubtitle(one.list)).toContain('1 change since');
    const notFound = whatsNewSince(b, seen('deadbee'));
    if (notFound.kind !== 'list') throw new Error('expected a list');
    expect(whatsNewSubtitle(notFound.list)).toBe(`Built ${shortDate(b.at)} · The latest 20 changes; earlier ones aren't listed`);
  });

  it('links a PR only with a GitHub repository and a number', () => {
    expect(prUrl(REPO, 71)).toBe(`${REPO}/pull/71`);
    expect(prUrl(null, 71)).toBeNull();
    expect(prUrl(REPO, null)).toBeNull();
  });

  it('sameCommit needs a real prefix', () => {
    expect(sameCommit('abc1234', 'abc1234f')).toBe(true);
    expect(sameCommit('abc1234', 'abc1235')).toBe(false);
    expect(sameCommit('', 'abc1234')).toBe(false);
  });
});

describe('somethingNeedsAttention', () => {
  const doc = (match: boolean) => ({ querySelector: (s: string) => (match && s.includes('.tx-prompt') ? ({} as Element) : null) });
  it('asks the DOM for a modal dialog or the waiting-on-you card', () => {
    expect(somethingNeedsAttention(doc(true))).toBe(true);
    expect(somethingNeedsAttention(doc(false))).toBe(false);
  });
});
