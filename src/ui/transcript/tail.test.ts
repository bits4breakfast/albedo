import { describe, expect, it } from 'vitest';
import type { Message } from '../../types';
import { mergeTail, tailCursor } from './tail';

function msg(id: number, seq: number, ts: number, agentId: string | null = null): Message {
  return {
    id,
    taskId: 1,
    sessionId: 's1',
    seq,
    role: 'assistant',
    toolName: null,
    targetPath: null,
    body: `row ${id}`,
    rawJson: '{}',
    agentId,
    ts,
  } as Message;
}

const BY_TS = ['ts', 'seq', 'id'];

describe('tailCursor', () => {
  it('is the highest id held, whatever the seqs say', () => {
    // A subagent at seq 108 900, the parent at 96 800: the parent row was
    // inserted last, and that is what the next read must start after.
    expect(tailCursor([msg(10, 108_900, 1, 'a5'), msg(11, 96_800, 2)])).toBe(11);
  });

  it('is null with nothing held', () => {
    expect(tailCursor([])).toBeNull();
  });
});

describe('mergeTail', () => {
  it('appends fresh rows that read after the last one held', () => {
    const prev = [msg(1, 100, 1), msg(2, 200, 2)];
    expect(mergeTail(prev, [msg(3, 300, 3)], BY_TS)?.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it('is null when every row is already held', () => {
    const prev = [msg(1, 100, 1), msg(2, 200, 2)];
    expect(mergeTail(prev, [msg(2, 200, 2)], BY_TS)).toBeNull();
  });

  it('puts a row ingested late where a reload would show it', () => {
    // A parent row written at ts 5 was ingested after a subagent row at ts 6.
    const prev = [msg(1, 100, 1), msg(2, 50_000, 6, 'a5')];
    const next = mergeTail(prev, [msg(3, 200, 5)], BY_TS);
    expect(next?.map((m) => m.id)).toEqual([1, 3, 2]);
  });

  it('orders the fresh rows among themselves, not by id', () => {
    const prev = [msg(1, 100, 1)];
    const next = mergeTail(prev, [msg(2, 300, 4, 'a5'), msg(3, 200, 3)], BY_TS);
    expect(next?.map((m) => m.id)).toEqual([1, 3, 2]);
  });
});
