import { describe, expect, it } from 'vitest';
import { BUILD, buildLabel } from './build';

describe('buildLabel', () => {
  it('names the commit, marks a dirty tree, and says when', () => {
    const label = buildLabel({ sha: '377ae12', dirty: true, at: '2026-10-20T13:28:00Z' });
    expect(label.startsWith('377ae12+ · ')).toBe(true);
    expect(buildLabel({ sha: 'abc1234', dirty: false, at: 'nonsense' })).toBe('abc1234');
  });

  it('says it does not know outside a Vite build (vitest has no define)', () => {
    expect(BUILD).toBeNull();
    expect(buildLabel()).toBe('Build Unknown');
  });
});
