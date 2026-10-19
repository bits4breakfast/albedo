import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setAttentionBackend, attentionMarks, noteMerged, noteStatusChange, notificationFor } from './attention';
import { mergeNoticeFor } from './mergeNotice';

describe('mergeNoticeFor', () => {
  it('notifies for a merge observed live', () => {
    expect(mergeNoticeFor('open', 'merged')).toBe('notify');
    expect(mergeNoticeFor('draft', 'merged')).toBe('notify');
  });

  it('only marks a PR already merged on the first observation', () => {
    expect(mergeNoticeFor(undefined, 'merged')).toBe('mark');
  });

  it('only marks when the previous answer was "no PR"', () => {
    // gh coming back after an outage is not a merge that just happened.
    expect(mergeNoticeFor(null, 'merged')).toBe('mark');
  });

  it('never repeats for a PR that stays merged', () => {
    expect(mergeNoticeFor('merged', 'merged')).toBeNull();
  });

  it('ignores everything that is not a merge', () => {
    expect(mergeNoticeFor(undefined, 'open')).toBeNull();
    expect(mergeNoticeFor('open', 'closed')).toBeNull();
    expect(mergeNoticeFor('open', null)).toBeNull();
    expect(mergeNoticeFor('merged', null)).toBeNull();
  });
});

describe('noteMerged', () => {
  let bounce: ReturnType<typeof vi.fn<(critical: boolean) => void>>;
  let post: ReturnType<typeof vi.fn<(n: { title: string; body: string }) => void>>;

  beforeEach(() => {
    bounce = vi.fn();
    post = vi.fn();
    __setAttentionBackend(bounce, false, post);
  });
  afterEach(() => __setAttentionBackend(null));

  it('marks the row and posts "PR #N merged" for a live merge', () => {
    noteMerged(7, 'ACME-1 fix', 42, true);
    expect(attentionMarks().get(7)).toBe('merged');
    expect(bounce).toHaveBeenCalledWith(false);
    expect(post).toHaveBeenCalledWith({ title: 'ACME-1 fix', body: 'PR #42 merged — archive or follow up.' });
  });

  it('marks without notifying for a merge that predates the run', () => {
    noteMerged(7, 'ACME-1 fix', 42, false);
    expect(attentionMarks().get(7)).toBe('merged');
    expect(bounce).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('goes through the per-(task, kind) rate limit', () => {
    noteMerged(7, 't', 42, true);
    noteMerged(7, 't', 42, true);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('never replaces a "blocked" mark', () => {
    noteStatusChange(7, 'running', 'blocked', 't');
    noteMerged(7, 't', 42, true);
    expect(attentionMarks().get(7)).toBe('blocked');
  });

  it('words the banner without a number when none is known', () => {
    expect(notificationFor('merged', 't', 7).body).toBe('PR merged — archive or follow up.');
  });
});
