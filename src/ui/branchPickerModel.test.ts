import { describe, expect, it } from 'vitest';
import { filterBranches, orderBranches } from './branchPickerModel';

const list = {
  current: 'fix-login',
  // Most recent commit first.
  recentLocals: ['spike', 'fix-login', 'develop', 'main'],
};
const all = ['develop', 'fix-login', 'main', 'spike', 'origin/develop', 'origin/main', 'origin/release'];

describe('orderBranches', () => {
  it('puts the default, the current branch and main first, then locals by date, then remotes', () => {
    expect(orderBranches(all, list, 'develop')).toEqual([
      'develop',
      'fix-login',
      'main',
      'spike',
      'origin/develop',
      'origin/main',
      'origin/release',
    ]);
  });

  it('lists each branch once when the default is also the current branch and main', () => {
    expect(orderBranches(all, { ...list, current: 'main' }, 'main')).toEqual([
      'main',
      'spike',
      'fix-login',
      'develop',
      'origin/develop',
      'origin/main',
      'origin/release',
    ]);
  });

  it('falls back to master, and skips names that are not candidates', () => {
    const order = orderBranches(
      ['master', 'topic', 'origin/topic'],
      { current: '262adc4', recentLocals: ['topic', 'master', 'gone'] },
      'trunk',
    );
    // A detached HEAD's commit id and a default that no longer exists are not branches.
    expect(order).toEqual(['master', 'topic', 'origin/topic']);
  });

  it('keeps only the given candidates, as Branch to Check Out passes them', () => {
    expect(orderBranches(['spike', 'origin/release'], list, 'develop')).toEqual(['spike', 'origin/release']);
  });
});

describe('filterBranches', () => {
  const ordered = orderBranches(all, list, 'develop');

  it('returns the order unchanged with no query', () => {
    const r = filterBranches(ordered, '  ');
    expect(r.rows.map((x) => x.name)).toEqual(ordered);
    expect(r.total).toBe(ordered.length);
  });

  it('ranks by match score and marks the matched characters', () => {
    const r = filterBranches(ordered, 'rel');
    // `origin/develop` holds r…e…l too, scattered; the run at a word start wins.
    expect(r.rows.map((x) => x.name)).toEqual(['origin/release', 'origin/develop']);
    expect(r.rows[0]?.hits).toEqual([7, 8, 9]);
  });

  it('keeps the default order between equal scores, so a local branch beats its remote copy', () => {
    const names = filterBranches(ordered, 'main').rows.map((x) => x.name);
    expect(names.indexOf('main')).toBeLessThan(names.indexOf('origin/main'));
  });

  it('caps the rows and still counts every match', () => {
    const many = Array.from({ length: 120 }, (_, i) => `origin/feature-${i}`);
    const r = filterBranches(many, 'feat', 50);
    expect(r.rows).toHaveLength(50);
    expect(r.total).toBe(120);
  });
});
