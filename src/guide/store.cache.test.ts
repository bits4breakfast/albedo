// @vitest-environment jsdom
/**
 * The guide store decodes what is stored once per stored string (#365): the
 * task list asks for every guide on each activity change, the pane on each
 * render. A write -- from here, another window, anything -- is a new string
 * and is read afresh.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KEYS } from '../ui/persisted';
import { guidesCodec, loadGuide, loadReviewed, resetGuideStoreForTests, reviewingTaskIds, saveGuide, setReviewed } from './store';
import type { Guide } from './validate';

let data: Map<string, string>;
let gets: string[];
beforeEach(() => {
  data = new Map();
  gets = [];
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => {
        gets.push(k);
        return data.get(k) ?? null;
      },
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
  resetGuideStoreForTests();
});

const guide = (writtenAt: number): Guide => ({
  diffHash: 'h',
  writtenAt,
  base: 'main',
  fallback: null,
  files: { 'a.ts': ['b0'] },
  groups: [{ title: 'G', summary: 's', blocks: ['b0'] }],
});

describe('guide store: decoded once per stored string (#365)', () => {
  it('parses the stored guides once while they do not change', () => {
    saveGuide(1, guide(10));
    const parse = vi.spyOn(JSON, 'parse');
    try {
      for (let i = 0; i < 5; i++) {
        expect(loadGuide(1)?.writtenAt).toBe(10);
        reviewingTaskIds();
      }
      // The guides once, the marks once (reviewingTaskIds reads both).
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
    }
  });

  it('reads storage every time, so a write from elsewhere is seen at once', () => {
    saveGuide(1, guide(10));
    expect(loadGuide(1)?.writtenAt).toBe(10);
    // Another window writes the key: no event reaches this one.
    data.set(KEYS.reviewGuides, guidesCodec.encode({ '1': guide(20), '2': guide(30) })!);
    expect(loadGuide(1)?.writtenAt).toBe(20);
    expect(loadGuide(2)?.writtenAt).toBe(30);
    data.delete(KEYS.reviewGuides);
    expect(loadGuide(1)).toBeNull();
    expect(gets.filter((k) => k === KEYS.reviewGuides).length).toBeGreaterThanOrEqual(4);
  });

  it('sees its own writes: a saved guide and a Reviewed mark', () => {
    saveGuide(1, guide(10));
    expect(loadGuide(1)?.writtenAt).toBe(10);
    expect(reviewingTaskIds().has(1)).toBe(false);
    setReviewed(1, ['a.ts#b0'], true);
    expect([...loadReviewed(1)]).toEqual(['a.ts#b0']);
    expect(reviewingTaskIds().has(1)).toBe(true);
    saveGuide(1, guide(11));
    expect(loadGuide(1)?.writtenAt).toBe(11);
    setReviewed(1, ['a.ts#b0'], false);
    expect([...loadReviewed(1)]).toEqual([]);
  });

  it('reads a malformed value as none, as before, and a fixed one once written', () => {
    data.set(KEYS.reviewGuides, '{not json');
    expect(loadGuide(1)).toBeNull();
    expect(loadGuide(1)).toBeNull();
    data.set(KEYS.reviewGuides, guidesCodec.encode({ '1': guide(40) })!);
    expect(loadGuide(1)?.writtenAt).toBe(40);
  });

  it('hands each caller its own Reviewed set', () => {
    setReviewed(1, ['x#1'], true);
    const a = loadReviewed(1) as Set<string>;
    a.add('mutated');
    expect([...loadReviewed(1)]).toEqual(['x#1']);
  });
});
