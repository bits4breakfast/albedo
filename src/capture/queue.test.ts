import { describe, expect, it } from 'vitest';
import { absorbedPromptText, parseLine, queueOperationsIn } from './adapter';
import { applyQueueOperations, type QueuedEntry } from './queue';
import { queuedLabel } from '../ui/transcript/pastedText';

const S = 'sess-1';
const line = (o: Record<string, unknown>) => JSON.stringify({ type: 'queue-operation', sessionId: S, timestamp: '2026-01-01T10:00:00.000Z', ...o });

describe('queueOperationsIn', () => {
  it('reads enqueue, dequeue and remove, and skips everything else', () => {
    const text = [
      line({ operation: 'enqueue', content: 'first' }),
      JSON.stringify({ type: 'user', sessionId: S, message: { content: 'not a queue line' } }),
      line({ operation: 'dequeue' }),
      line({ operation: 'remove', content: 'second', reason: 'absorbed_mid_turn' }),
      line({ operation: 'something-new', content: 'x' }),
      '{not json "queue-operation"',
    ].join('\n');
    expect(queueOperationsIn(text).map((o) => o.op)).toEqual(['enqueue', 'dequeue', 'remove']);
    expect(queueOperationsIn(text)[0]).toEqual({ op: 'enqueue', sessionId: S, text: 'first', ts: Date.parse('2026-01-01T10:00:00.000Z') });
  });
});

describe('applyQueueOperations', () => {
  const run = (...ops: Parameters<typeof applyQueueOperations>[1][]) => {
    const state = new Map<string, QueuedEntry[]>();
    for (const batch of ops) applyQueueOperations(state, batch);
    return (state.get(S) ?? []).map((e) => e.text);
  };
  const enq = (text: string) => ({ op: 'enqueue' as const, sessionId: S, text, ts: 0 });
  const deq = { op: 'dequeue' as const, sessionId: S, ts: 0 };
  const rem = (text: string) => ({ op: 'remove' as const, sessionId: S, text, ts: 0 });

  it('dequeue takes the oldest; remove takes its own entry', () => {
    expect(run([enq('a'), enq('b'), enq('c'), deq, rem('c')])).toEqual(['b']);
  });

  it('keeps order across chunks, and a dequeue on an empty queue is harmless', () => {
    expect(run([deq, enq('a')], [enq('b')], [deq])).toEqual(['b']);
  });

  it('counts injected entries for order but marks them', () => {
    const state = new Map<string, QueuedEntry[]>();
    applyQueueOperations(state, [enq('<task-notification>\n<task-id>x</task-id>'), enq('mine'), deq]);
    expect(state.get(S)).toEqual([{ text: 'mine', ts: 0, injected: false }]);
    applyQueueOperations(state, [enq('<agent-message from="x">hi</agent-message>')]);
    expect(state.get(S)!.map((e) => e.injected)).toEqual([false, true]);
  });
});

describe('absorbed mid-turn messages', () => {
  const attachment = (att: Record<string, unknown>) => ({ type: 'attachment', sessionId: S, timestamp: '2026-01-01T10:00:00.000Z', attachment: att });

  it("become the person's message, text and image parts alike", () => {
    expect(absorbedPromptText(attachment({ type: 'queued_command', prompt: 'also do this', origin: { kind: 'human' } }))).toBe('also do this');
    expect(
      absorbedPromptText(
        attachment({ type: 'queued_command', prompt: [{ type: 'text', text: 'look' }, { type: 'image' }], origin: { kind: 'human' } }),
      ),
    ).toBe('look\n[image]');
    const rows = parseLine(JSON.stringify(attachment({ type: 'queued_command', prompt: 'also do this', origin: { kind: 'human' } })), 3);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: 'user', body: 'also do this', sessionId: S });
  });

  it('are not invented from other origins or other attachments', () => {
    for (const att of [
      { type: 'queued_command', prompt: '<task-notification>…', origin: { kind: 'task-notification' } },
      { type: 'queued_command', prompt: 'peer says', origin: { kind: 'peer' } },
      { type: 'queued_command', prompt: 'no origin' },
      { type: 'prompt_snapshot', prompt: 'x', origin: { kind: 'human' } },
    ]) {
      expect(parseLine(JSON.stringify(attachment(att)), 0)).toEqual([]);
    }
  });
});

describe('queuedLabel', () => {
  it('shows a paste as a mention of it', () => {
    expect(queuedLabel('see this <pasted_content id="1">long\ntext</pasted_content id="1"> please')).toBe('see this [pasted text] please');
  });
});
