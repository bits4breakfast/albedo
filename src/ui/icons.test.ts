import { describe, expect, it } from 'vitest';
import { branchRepeatsTitle, homeRelative } from './icons';

describe('branchRepeatsTitle', () => {
  it('is true when the branch only spells the title again', () => {
    expect(branchRepeatsTitle('polishing', 'polishing')).toBe(true);
    expect(branchRepeatsTitle('Fix login', 'fix-login')).toBe(true);
  });
  it('is false when the branch says something the title does not', () => {
    expect(branchRepeatsTitle('Review the backend plan', 'UP-2364')).toBe(false);
    expect(branchRepeatsTitle('UP-2364 Review the plan', 'UP-2364')).toBe(true);
    expect(branchRepeatsTitle('polishing', '')).toBe(false);
  });
});

describe('homeRelative', () => {
  it('shortens a home folder', () => {
    expect(homeRelative('/Users/matteo/www/albedo')).toBe('~/www/albedo');
    expect(homeRelative('/home/m/src')).toBe('~/src');
    expect(homeRelative('/opt/x')).toBe('/opt/x');
  });
});
