import { describe, expect, it } from 'vitest';
import { taskTabsCodec, withTaskTab } from './useTaskTabs';
import type { RightTab } from './useLayout';

const tabs = (pairs: [number, RightTab][]) => new Map(pairs);

describe('withTaskTab (#314)', () => {
  it('moves the task to the newest end and trims the oldest', () => {
    const next = withTaskTab(tabs([[1, 'files'], [2, 'guide'], [3, 'transcript']]), 1, 'guide', 3);
    expect([...next]).toEqual([[2, 'guide'], [3, 'transcript'], [1, 'guide']]);
    const full = withTaskTab(next, 4, 'files', 3);
    expect([...full.keys()]).toEqual([3, 1, 4]);
  });

  it('returns the same map when nothing changes', () => {
    const before = tabs([[1, 'files']]);
    expect(withTaskTab(before, 1, 'files')).toBe(before);
  });
});

describe('taskTabsCodec', () => {
  it('keeps Transcript, Files and Guide, never Editor', () => {
    const raw = taskTabsCodec.encode(tabs([[1, 'files'], [2, 'editor'], [3, 'guide']]));
    expect(raw).toBe('[[1,"files"],[3,"guide"]]');
    expect([...taskTabsCodec.decode(raw!)!]).toEqual([[1, 'files'], [3, 'guide']]);
  });

  it('skips what it cannot read rather than dropping everything', () => {
    expect([...taskTabsCodec.decode('[[1,"files"],[2,"editor"],["x","guide"],[4],[5,"guide"]]')!]).toEqual([
      [1, 'files'],
      [5, 'guide'],
    ]);
    expect(taskTabsCodec.decode('nope')).toBeNull();
    expect(taskTabsCodec.decode('{}')).toBeNull();
  });
});
