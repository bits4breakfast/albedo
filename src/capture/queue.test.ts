import { describe, expect, it } from 'vitest';
import { absorbedPromptText, parseLine, queueFactsIn, queueOperationsIn } from './adapter';
import { applyQueueOperations, applyTurnFacts, IDLE_GRACE_MS, queuedFor, queueSettlesAt, seedQueue, type SessionQueue, type TurnMarks } from './queue';
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
    const state = new Map<string, SessionQueue>();
    for (const batch of ops) applyQueueOperations(state, batch);
    return (state.get(S)?.entries ?? []).map((e) => e.text);
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
    const state = new Map<string, SessionQueue>();
    applyQueueOperations(state, [enq('<task-notification>\n<task-id>x</task-id>'), enq('mine'), deq]);
    expect(state.get(S)?.entries).toEqual([{ text: 'mine', ts: 0, injected: false }]);
    applyQueueOperations(state, [enq('<agent-message from="x">hi</agent-message>')]);
    expect(state.get(S)!.entries.map((e) => e.injected)).toEqual([false, true]);
  });
});

describe('queueFactsIn', () => {
  const at = (s: string) => `2026-10-23T08:${s}.000Z`;
  const user = (content: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'user', sessionId: S, timestamp: at('00:01'), message: { role: 'user', content }, ...extra });
  const assistant = (stop_reason: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'assistant', sessionId: S, timestamp: at('00:02'), message: { role: 'assistant', content: [], stop_reason }, ...extra });

  it('reads queue lines, prompts and turn ends in file order', () => {
    const text = [
      line({ operation: 'enqueue', content: 'first' }),
      user('hello'),
      user([{ type: 'text', text: '[Image #1] look' }, { type: 'image' }]),
      assistant('end_turn'),
      assistant('stop_sequence'),
    ].join('\n');
    expect(queueFactsIn(text)).toEqual([
      { op: 'enqueue', sessionId: S, text: 'first', ts: Date.parse('2026-01-01T10:00:00.000Z') },
      { op: 'prompt', sessionId: S, text: 'hello', ts: Date.parse(at('00:01')) },
      { op: 'prompt', sessionId: S, text: '[Image #1] look', ts: Date.parse(at('00:01')) },
      { op: 'turn-end', sessionId: S, ts: Date.parse(at('00:02')) },
      { op: 'turn-end', sessionId: S, ts: Date.parse(at('00:02')) },
    ]);
  });

  it('skips tool results, meta lines, summaries and subagents; a paused turn is only a step', () => {
    const text = [
      user([{ type: 'tool_result', tool_use_id: 't1', content: 'output' }]),
      user('caveat', { isMeta: true }),
      user('summary of what was said', { isCompactSummary: true }),
      user('subagent prompt', { isSidechain: true }),
      assistant('end_turn', { isSidechain: true }),
      assistant('tool_use', { isSidechain: true }),
      user(''),
    ].join('\n');
    expect(queueFactsIn(text)).toEqual([]);
    // A turn paused on a tool is still running: a step, not a prompt or an end.
    expect(queueFactsIn(assistant('tool_use'))).toEqual([{ op: 'turn-step', sessionId: S, ts: Date.parse(at('00:02')) }]);
  });
});

describe('turn-stop facts (the outbox’s turn)', () => {
  const at = (s: string) => `2026-10-23T08:${s}.000Z`;
  const user = (content: unknown) =>
    JSON.stringify({ type: 'user', sessionId: S, timestamp: at('00:01'), message: { role: 'user', content } });
  const system = (subtype: string) => JSON.stringify({ type: 'system', subtype, sessionId: S, timestamp: at('00:03') });
  const ts1 = Date.parse(at('00:01'));
  const ts3 = Date.parse(at('00:03'));

  it('reads an interrupt, a command run without a turn, and turn_duration as turn stops', () => {
    const text = [
      user([{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
      user('<local-command-stdout>Set model to opus</local-command-stdout>'),
      user('<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>'),
      system('turn_duration'),
      system('local_command'),
      system('stop_hook_summary'),
    ].join('\n');
    expect(queueFactsIn(text)).toEqual([
      { op: 'prompt', sessionId: S, text: '[Request interrupted by user for tool use]', ts: ts1 },
      { op: 'turn-stop', sessionId: S, ts: ts1 },
      { op: 'prompt', sessionId: S, text: '<local-command-stdout>Set model to opus</local-command-stdout>', ts: ts1 },
      { op: 'turn-stop', sessionId: S, ts: ts1 },
      { op: 'prompt', sessionId: S, text: '<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>', ts: ts1 },
      { op: 'turn-stop', sessionId: S, ts: ts1 },
      { op: 'turn-stop', sessionId: S, ts: ts3 },
      { op: 'turn-stop', sessionId: S, ts: ts3 },
    ]);
  });

  it('leaves the queue alone', () => {
    const state = new Map<string, SessionQueue>();
    applyQueueOperations(state, [{ op: 'enqueue', sessionId: S, text: 'waiting', ts: 0 }, { op: 'turn-stop', sessionId: S, ts: 1 }]);
    expect(state.get(S)?.endedAt).toBeNull();
    expect(state.get(S)?.entries.map((e) => e.text)).toEqual(['waiting']);
  });

  it('reads a main-thread API call and a mid-turn assistant line as steps, an API error as neither', () => {
    const request = (querySource: string) =>
      JSON.stringify({ type: 'api-request', sessionId: S, timestamp: at('00:04'), version: '2.1.308', querySource });
    expect(queueFactsIn([request('repl_main_thread'), request('sdk')].join('\n'))).toEqual([
      { op: 'turn-step', sessionId: S, ts: Date.parse(at('00:04')) },
    ]);
    const error = JSON.stringify({
      type: 'assistant',
      sessionId: S,
      timestamp: at('00:05'),
      isApiErrorMessage: true,
      message: { role: 'assistant', content: [], stop_reason: 'stop_sequence_x' },
    });
    expect(queueFactsIn(error)).toEqual([]);
  });

  it('marks turns in file order: an end written after a start closes it, whatever the stamps', () => {
    const marks = new Map<string, TurnMarks>();
    const touched = applyTurnFacts(marks, [
      { op: 'prompt', sessionId: S, text: 'go', ts: 10 },
      { op: 'turn-step', sessionId: S, ts: 12 },
      { op: 'enqueue', sessionId: S, text: 'x', ts: 15 },
    ]);
    expect(marks.get(S)).toEqual({ running: true, startedAt: 12, endedAt: null, pendingAt: null });
    expect([...touched]).toEqual([S]);
    // A dequeue folded into the ending turn, stamped after its end lines.
    applyTurnFacts(marks, [
      { op: 'dequeue', sessionId: S, ts: 31 },
      { op: 'turn-end', sessionId: S, ts: 29 },
      { op: 'turn-stop', sessionId: S, ts: 30 },
    ]);
    expect(marks.get(S)).toEqual({ running: false, startedAt: 12, endedAt: 30, pendingAt: 31 });
  });

  it('takes an injected prompt as pending, not a start', () => {
    const marks = new Map<string, TurnMarks>();
    applyTurnFacts(marks, [
      { op: 'turn-stop', sessionId: S, ts: 30 },
      { op: 'prompt', sessionId: S, text: '<task-notification>\n<task-id>a</task-id>', ts: 31 },
    ]);
    expect(marks.get(S)).toEqual({ running: false, startedAt: null, endedAt: 30, pendingAt: 31 });
  });
});

describe('reconciling the queue', () => {
  const T = Date.parse('2026-10-23T08:00:00.000Z');
  const enq = (text: string, ts = T) => ({ op: 'enqueue' as const, sessionId: S, text, ts });
  const deq = (ts = T) => ({ op: 'dequeue' as const, sessionId: S, ts });
  const prompt = (text: string, ts = T) => ({ op: 'prompt' as const, sessionId: S, text, ts });
  const end = (ts = T) => ({ op: 'turn-end' as const, sessionId: S, ts });
  const texts = (state: Map<string, SessionQueue>) => (state.get(S)?.entries ?? []).map((e) => e.text);

  it('replays the dropped-messages sequence: four enqueues, one dequeue, the last text only', () => {
    // The transcript lines as Claude Code 2.1.302 wrote them (issue #60).
    const q = (ts: string, o: Record<string, unknown>) =>
      JSON.stringify({ type: 'queue-operation', sessionId: S, timestamp: `2026-10-23T${ts}.000Z`, ...o });
    const text = [
      q('08:09:33', { operation: 'enqueue', content: 'can you try again one more time?' }),
      q('08:11:12', { operation: 'enqueue', content: 'one more time!' }),
      q('08:11:24', { operation: 'enqueue', content: 'there is no firewall' }),
      q('08:13:34', { operation: 'enqueue', content: "ok i don't care about remote control at this point" }),
      q('08:14:32', { operation: 'dequeue' }),
      JSON.stringify({
        type: 'user',
        sessionId: S,
        timestamp: '2026-10-23T08:14:32.000Z',
        message: { role: 'user', content: "ok i don't care about remote control at this point" },
      }),
    ].join('\n');
    const state = new Map<string, SessionQueue>();
    applyQueueOperations(state, queueFactsIn(text));
    expect(texts(state)).toEqual([]);
  });

  it('three enqueues, three dequeues: each turn takes its own', () => {
    const state = new Map<string, SessionQueue>();
    applyQueueOperations(state, [enq('a'), enq('b'), enq('c'), end(T + 1000), deq(T + 1100), prompt('a', T + 1100)]);
    expect(texts(state)).toEqual(['b', 'c']);
    applyQueueOperations(state, [end(T + 5000), deq(T + 5100), prompt('b', T + 5100)]);
    expect(texts(state)).toEqual(['c']);
    applyQueueOperations(state, [end(T + 9000), deq(T + 9100), prompt('c', T + 9100)]);
    expect(texts(state)).toEqual([]);
  });

  it('keeps an entry queued after the dequeue the prompt answers', () => {
    const state = new Map<string, SessionQueue>();
    applyQueueOperations(state, [enq('a'), enq('b'), deq(T + 10), enq('later', T + 20), prompt('b', T + 30)]);
    expect(texts(state)).toEqual(['later']);
  });

  it('leaves a same-text entry queued when a dequeue already took the prompt', () => {
    const state = new Map<string, SessionQueue>();
    applyQueueOperations(state, [enq('continue'), enq('continue'), enq('C'), end(T + 1000), deq(T + 1100), prompt('continue', T + 1100)]);
    expect(texts(state)).toEqual(['continue', 'C']);
    applyQueueOperations(state, [end(T + 5000), deq(T + 5100), prompt('continue', T + 5100)]);
    expect(texts(state)).toEqual(['C']);
  });

  it('takes the oldest same-text entry when no dequeue accounts for the prompt', () => {
    const state = new Map<string, SessionQueue>();
    applyQueueOperations(state, [enq('a'), enq('x'), enq('b'), enq('x'), prompt('x')]);
    expect(texts(state)).toEqual(['b', 'x']);
  });

  it('leaves the queue alone when the prompt is no queued text, even one containing it', () => {
    const state = new Map<string, SessionQueue>();
    applyQueueOperations(state, [enq('ok'), enq('b'), prompt('ok, something typed straight in')]);
    expect(texts(state)).toEqual(['ok', 'b']);
  });

  it('does not let an injected entry take the typed ones queued before it', () => {
    const note = '<task-notification>\n<task-id>x</task-id>';
    const state = new Map<string, SessionQueue>();
    applyQueueOperations(state, [enq('mine'), enq(note), prompt(note)]);
    expect(texts(state)).toEqual(['mine', note]);
  });

  it('clears typed entries left at a turn end, only once the grace period has passed', () => {
    const note = '<task-notification>\n<task-id>x</task-id>';
    const state = new Map<string, SessionQueue>();
    applyQueueOperations(state, [enq('stale'), enq(note), end(T + 1000), enq('new', T + 1000 + IDLE_GRACE_MS - 1)]);
    expect(texts(state)).toEqual(['stale', note, 'new']);
    applyQueueOperations(state, [prompt('unrelated', T + 1000 + IDLE_GRACE_MS)]);
    // Typed after the turn ended, and a notification can wait out an idle session.
    expect(texts(state)).toEqual([note, 'new']);
  });

  it('does not clear what the next turn takes within the grace period', () => {
    const state = new Map<string, SessionQueue>();
    applyQueueOperations(state, [enq('a'), enq('b'), end(T + 1000), deq(T + 2000), prompt('a', T + 2000)]);
    applyQueueOperations(state, [enq('c', T + 1000 + 2 * IDLE_GRACE_MS)]);
    expect(texts(state)).toEqual(['b', 'c']);
  });

  it('serves a dequeue long after a turn end without clearing first', () => {
    // A Stop hook carries the turn on past its end_turn, then the queue is served.
    const state = new Map<string, SessionQueue>();
    applyQueueOperations(state, [enq('a'), enq('b'), end(T + 1000), deq(T + 1000 + 2 * IDLE_GRACE_MS)]);
    expect(texts(state)).toEqual(['b']);
  });

  it('ignores a turn end written after the next turn started', () => {
    const state = new Map<string, SessionQueue>();
    applyQueueOperations(state, [enq('a'), enq('b'), deq(T + 2000), end(T + 1000)]);
    applyQueueOperations(state, [enq('c', T + 1000 + 2 * IDLE_GRACE_MS)]);
    expect(texts(state)).toEqual(['b', 'c']);
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
    // A background task's end is kept for the background fold (#122), as a
    // system row with no text: nothing draws it, and it is no message of yours.
    const notice = { type: 'queued_command', prompt: '<task-notification>…', origin: { kind: 'task-notification' } };
    expect(parseLine(JSON.stringify(attachment(notice)), 0)).toMatchObject([{ role: 'system', body: null }]);
    for (const att of [
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

describe('reading the queue of an idle session', () => {
  // The band now shows while the session is alive, idle included (#56), and an
  // idle session writes no fact that would clear what it dropped at a turn end.
  const T = Date.parse('2026-10-23T09:00:00.000Z');
  const SID = 'sess-idle';

  it('drops a typed entry left at a turn end once the grace is over, with no new fact', () => {
    seedQueue([SID], [
      { op: 'enqueue', sessionId: SID, text: 'dropped', ts: T },
      { op: 'enqueue', sessionId: SID, text: '<task-notification>done</task-notification>', ts: T + 1 },
      { op: 'turn-end', sessionId: SID, ts: T + 1000 },
    ]);
    expect(queuedFor(SID, T + 1000 + IDLE_GRACE_MS - 1).map((e) => e.text)).toHaveLength(2);
    expect(queueSettlesAt(SID)).toBe(T + 1000 + IDLE_GRACE_MS);
    // Injected entries can wait out an idle session; only the typed one goes.
    expect(queuedFor(SID, T + 1000 + IDLE_GRACE_MS).map((e) => e.injected)).toEqual([true]);
  });

  it('keeps entries while a turn runs, however long: a retrying session ends no turn', () => {
    seedQueue([SID], [
      { op: 'dequeue', sessionId: SID, ts: T },
      { op: 'enqueue', sessionId: SID, text: 'waiting out the outage', ts: T + 10 },
    ]);
    expect(queuedFor(SID, T + 60 * 60_000).map((e) => e.text)).toEqual(['waiting out the outage']);
    expect(queueSettlesAt(SID)).toBeNull();
  });
});
