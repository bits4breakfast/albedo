/**
 * Input Claude Code writes itself, for the model (#138): a `/loop` wake-up,
 * the prompt it re-sends, and the notes it adds. Fixtures in the shape Claude
 * Code 2.1.31x writes, with neutral text.
 */
import { describe, expect, it } from 'vitest';

import loop from './fixtures/loop-wakeup.jsonl?raw';
import notes from './fixtures/harness-notes.jsonl?raw';
import { harnessInputOf, notMetaSqlPredicate, parseTranscript, queueFactsIn, turnEdgeOf } from './adapter';
import { deriveStatus } from './status';
import type { Message } from '../types';

const loopRows = parseTranscript(loop);
const noteRows = parseTranscript(notes);
const persisted = loop.split('\n').filter((l) => l.length > 0 && !l.includes('"queue-operation"'));

describe('harnessInputOf, on a /loop wake-up', () => {
  it('names the wake-up line, the health note and the re-sent prompt, and nothing else', () => {
    expect(loopRows.map((r) => [r.role, harnessInputOf(r.rawJson)])).toEqual([
      ['user', null], // typed
      ['assistant', null],
      ['system', null], // turn_duration
      ['system', 'wakeup'],
      ['user', 'scheduled-prompt'],
      ['assistant', null],
      ['system', null],
      ['system', 'wakeup'],
      ['user', 'note'],
      ['user', 'scheduled-prompt'],
      ['assistant', null],
    ]);
  });

  it('keeps every line as it was: same roles, raw line verbatim', () => {
    expect(loopRows.map((r) => r.rawJson)).toEqual(persisted);
  });

  it('starts no typed turn: no turn edge, no queue prompt', () => {
    for (const r of loopRows.filter((x) => harnessInputOf(x.rawJson) !== null)) {
      expect(turnEdgeOf(r.rawJson)).toBeNull();
    }
    const prompts = queueFactsIn(loop).filter((f) => f.op === 'prompt');
    expect(prompts.map((f) => (f.op === 'prompt' ? f.text : ''))).toEqual([
      'Watch the nightly build every few minutes until it finishes.',
    ]);
  });

  it('reads as running while the wake-up turn works, as before', () => {
    const msgs = loopRows.map((r, i) => ({ ...r, id: i + 1, taskId: 1 })) as Message[];
    const last = msgs[msgs.length - 1] as Message;
    expect(deriveStatus(msgs, last.ts + 1000)).toBe('running');
    // The note and the prompt alone, just written: running too.
    expect(deriveStatus(msgs.slice(0, 10), (msgs[9] as Message).ts + 1000)).toBe('running');
  });
});

describe('harnessInputOf, on the other isMeta user lines', () => {
  it('is a note for the hand-back reminder and the empty-output nudge, and null for the rest', () => {
    expect(noteRows.map((r) => [r.agentId !== null, harnessInputOf(r.rawJson)])).toEqual([
      [true, null], // a subagent's prompt
      [true, null], // its reply
      [true, 'note'], // [handback-send-enforce]
      [false, null], // a skill's body: content blocks
      [false, null], // another session's message: origin
      [false, null], // <system-reminder>: an envelope
      [false, 'note'], // [Your previous response had no visible output…]
      [false, null], // typed
    ]);
  });

  it('leaves image notes, peer frames without origin, and typed lines alone', () => {
    const meta = (content: unknown, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ type: 'user', isMeta: true, ...extra, message: { role: 'user', content } });
    expect(harnessInputOf(meta('[Image: original 2000x1000, displayed at 1000x500.]'))).toBeNull();
    expect(harnessInputOf(meta('Another Claude session sent a message:\n<agent-message from="a1">\nhi\n</agent-message>'))).toBeNull();
    expect(harnessInputOf(meta('[note]', { origin: { kind: 'coordinator' } }))).toBeNull();
    expect(harnessInputOf(meta('[note]', { promptSource: 'typed' }))).toBeNull();
    expect(harnessInputOf(JSON.stringify({ type: 'user', message: { role: 'user', content: '[not meta]' } }))).toBeNull();
    expect(harnessInputOf('{"type":"user","isMeta":true')).toBeNull();
  });
});

describe('notMetaSqlPredicate', () => {
  it('tests the raw line for the key', () => {
    expect(notMetaSqlPredicate('y.raw_json')).toBe(`instr(y.raw_json, '"isMeta":true') = 0`);
  });
});
