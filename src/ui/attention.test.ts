import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __setAttentionBackend,
  attentionFor,
  attentionMarks,
  clearAttention,
  noteStatusChange,
  onAttention,
} from './attention';

describe('attentionFor', () => {
  it('asks for attention when a task becomes blocked', () => {
    expect(attentionFor('running', 'blocked')).toBe('blocked');
    expect(attentionFor('idle', 'blocked')).toBe('blocked');
  });

  it('asks once when a running task finishes its turn', () => {
    expect(attentionFor('running', 'idle')).toBe('finished');
  });

  it('stays quiet when the same status is reported again', () => {
    // Capture ticks on every transcript append; a task blocked for ten minutes
    // must not bounce the dock on each one.
    expect(attentionFor('blocked', 'blocked')).toBeNull();
    expect(attentionFor('running', 'running')).toBeNull();
  });

  it('stays quiet for a prompt the user just answered themselves', () => {
    // blocked -> idle is you answering the permission prompt. Bouncing the
    // dock at someone for something they did a second ago is noise.
    expect(attentionFor('blocked', 'idle')).toBeNull();
  });

  it('stays quiet for starting, archiving and the rest', () => {
    expect(attentionFor('idle', 'running')).toBeNull();
    expect(attentionFor('running', 'archived')).toBeNull();
    expect(attentionFor('idle', 'done')).toBeNull();
  });
});

describe('marks and the OS bounce', () => {
  let bounces: boolean[];
  const setup = (focused: boolean) => {
    bounces = [];
    __setAttentionBackend((critical) => bounces.push(critical), focused);
  };

  beforeEach(() => setup(false));

  it('bounces critically for blocked and once for finished', () => {
    noteStatusChange(1, 'running', 'blocked');
    noteStatusChange(2, 'running', 'idle');
    expect(bounces).toEqual([true, false]);
  });

  it('does not bounce the dock when the window already has focus', () => {
    setup(true);
    noteStatusChange(1, 'running', 'blocked');
    expect(bounces).toEqual([]);
    // ...but the row is still marked: that is the whole in-window cue.
    expect(attentionMarks().get(1)).toBe('blocked');
  });

  it('marks the task in both focus states, so you can see which one', () => {
    noteStatusChange(7, 'running', 'blocked');
    expect(attentionMarks().get(7)).toBe('blocked');
  });

  it('clears when the task is selected', () => {
    noteStatusChange(7, 'running', 'blocked');
    clearAttention(7);
    expect(attentionMarks().has(7)).toBe(false);
  });

  it('notifies subscribers, and stops after the disposer runs', () => {
    const seen: number[] = [];
    const off = onAttention((m) => seen.push(m.size));
    expect(seen).toEqual([0]); // current state on subscribe
    noteStatusChange(1, 'running', 'blocked');
    expect(seen).toEqual([0, 1]);
    off();
    noteStatusChange(2, 'running', 'blocked');
    expect(seen).toEqual([0, 1]);
  });

  it('survives a throwing subscriber', () => {
    const good = vi.fn();
    onAttention(() => {
      throw new Error('boom');
    });
    onAttention(good);
    expect(() => noteStatusChange(1, 'running', 'blocked')).not.toThrow();
    expect(good).toHaveBeenCalled();
  });
});
