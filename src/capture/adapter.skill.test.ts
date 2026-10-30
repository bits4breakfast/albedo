/**
 * A skill's text, written as an `isMeta` user line after Claude's Skill call
 * and linked to it by `sourceToolUseID` (#150). Fixture in the shape Claude
 * Code 2.1.31x writes, with neutral text.
 */
import { describe, expect, it } from 'vitest';

import skills from './fixtures/skill-load.jsonl?raw';
import { harnessInputOf, parseTranscript, queueFactsIn, skillSourceToolUseIdOf, turnEdgeOf } from './adapter';

const rows = parseTranscript(skills);

describe('skillSourceToolUseIdOf', () => {
  it('names the Skill call for each skill text, and nothing else', () => {
    expect(rows.map((r) => [r.role, skillSourceToolUseIdOf(r.rawJson)])).toEqual([
      ['user', null], // typed
      ['tool_use', null],
      ['tool_result', null],
      ['user', 'toolu_SK1'], // built-in: no base directory
      ['tool_use', null],
      ['tool_result', null],
      ['user', 'toolu_SK2'], // plugin or user skill
      ['user', null], // "already loaded": a harness note, string content
      ['assistant', null],
      ['user', null], // the subagent's prompt
      ['tool_use', null],
      ['tool_result', null],
      ['user', 'toolu_SK3'],
      ['assistant', null],
    ]);
  });

  it('leaves the skill text to itself: not a harness note, no turn edge, no queued prompt', () => {
    for (const r of rows.filter((x) => skillSourceToolUseIdOf(x.rawJson) !== null)) {
      expect(harnessInputOf(r.rawJson)).toBeNull();
      expect(turnEdgeOf(r.rawJson)).toBeNull();
    }
    // The "already loaded" note keeps #138's rendering.
    expect(harnessInputOf((rows[7] as { rawJson: string }).rawJson)).toBe('note');
    const prompts = queueFactsIn(skills).flatMap((f) => (f.op === 'prompt' ? [f.text] : []));
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.some((t) => /Chart Maker|Note Taker/.test(t))).toBe(false);
  });

  it('keeps the row a user row with its text and raw line', () => {
    const r = rows[3];
    expect(r?.role).toBe('user');
    expect(r?.body).toContain('# Chart Maker');
    expect(r?.rawJson).toBe(skills.split('\n')[3]);
  });

  it('needs the whole shape: isMeta, a non-empty id, text blocks, no origin', () => {
    const line = (o: Record<string, unknown>) =>
      JSON.stringify({
        type: 'user',
        isMeta: true,
        sourceToolUseID: 'toolu_X',
        message: { role: 'user', content: [{ type: 'text', text: '# A skill' }] },
        ...o,
      });
    expect(skillSourceToolUseIdOf(line({}))).toBe('toolu_X');
    expect(skillSourceToolUseIdOf(line({ isMeta: undefined }))).toBeNull();
    expect(skillSourceToolUseIdOf(line({ sourceToolUseID: '' }))).toBeNull();
    expect(skillSourceToolUseIdOf(line({ sourceToolUseID: undefined }))).toBeNull();
    expect(skillSourceToolUseIdOf(line({ origin: { kind: 'peer' } }))).toBeNull();
    expect(skillSourceToolUseIdOf(line({ type: 'assistant' }))).toBeNull();
    expect(skillSourceToolUseIdOf(line({ message: { role: 'user', content: 'a note' } }))).toBeNull();
    expect(skillSourceToolUseIdOf(line({ message: { role: 'user', content: [] } }))).toBeNull();
    expect(
      skillSourceToolUseIdOf(line({ message: { role: 'user', content: [{ type: 'image', source: {} }] } })),
    ).toBeNull();
    expect(skillSourceToolUseIdOf('not json "sourceToolUseID"')).toBeNull();
  });
});
