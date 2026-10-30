import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ParsedMessage } from '../types';
import { __setTextReader, briefFor, lastAnswerOf, withBrief, type TextReader } from './brief';
import { actionLabelOf, isAllEnvelopes, parseUserBody, wrapReminder } from '../ui/transcript/envelopes';

const row = (role: ParsedMessage['role'], body: string | null, agentId: string | null = null): ParsedMessage => ({
  sessionId: 's', seq: 0, role, toolName: null, targetPath: null, body, rawJson: '{}', agentId, ts: 0,
});

describe('lastAnswerOf', () => {
  it('is the run of assistant text the conversation ends on, joined', () => {
    const rows = [
      row('user', 'fix it'),
      row('assistant', 'Looking.'),
      row('tool_use', null),
      row('tool_result', 'ok'),
      row('assistant', 'Done: the retry now backs off.'),
      row('assistant', 'Deploy is next.'),
      row('system', 'note'),
      row('assistant', 'subagent chatter', 'agent-1'),
    ];
    expect(lastAnswerOf(rows)).toBe('Done: the retry now backs off.\n\nDeploy is next.');
  });

  it('skips a trailing prompt or tool row to find the last answer; null with none', () => {
    expect(lastAnswerOf([row('assistant', 'A'), row('user', 'thanks')])).toBe('A');
    expect(lastAnswerOf([row('user', 'hi')])).toBeNull();
  });
});

describe('briefFor and withBrief', () => {
  let restore: TextReader | null = null;
  afterEach(() => {
    if (restore) __setTextReader(restore);
    restore = null;
  });

  it('prefers the session summary, and reads the last answer from the transcript otherwise', async () => {
    expect(await briefFor({ brief: 'All merged.', transcriptPath: '/t.jsonl' })).toEqual({ kind: 'summary', text: 'All merged.', transcriptPath: '/t.jsonl' });
    const line = JSON.stringify({
      type: 'assistant', uuid: 'u1', sessionId: 's', timestamp: '2026-10-30T09:00:00Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'The fix is on main.' }] },
    });
    restore = __setTextReader(async () => `${line}\n`);
    expect(await briefFor({ brief: null, transcriptPath: '/t.jsonl' })).toEqual({ kind: 'last-answer', text: 'The fix is on main.', transcriptPath: '/t.jsonl' });
  });

  it('a transcript that cannot be read is no brief, said in the console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    restore = __setTextReader(async () => {
      throw new Error('gone');
    });
    expect(await briefFor({ brief: null, transcriptPath: '/gone.jsonl' })).toBeNull();
    expect(await briefFor({ brief: null, transcriptPath: null })).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('withBrief puts the brief and transcript path after the text', () => {
    expect(withBrief(' check ', null)).toBe('check');
    expect(withBrief('check', { kind: 'last-answer', text: 'It works.', transcriptPath: '/t.jsonl' })).toBe(
      'check\n\n---\nBrief from the session that set this reminder (its last answer, verbatim). Its transcript: /t.jsonl\n\nIt works.',
    );
  });
});

describe('the reminder envelope', () => {
  const at = new Date(2026, 9, 29, 10, 0).getTime();

  it('round-trips: a reminder block, never text under "You"', () => {
    const body = wrapReminder({ text: 'Check the deploy.', setAt: at, by: 'user' });
    const blocks = parseUserBody(body);
    expect(blocks).toEqual([{ kind: 'reminder', setAt: at, by: 'user', text: 'Check the deploy.', brief: null }]);
    expect(isAllEnvelopes(blocks)).toBe(true);
    expect(actionLabelOf(body)).toBe('Reminder');
  });

  it('is found inside Claude Code’s paste wrapper, with its brief split off', () => {
    const text = withBrief('Check the deploy.', { kind: 'summary', text: 'Merged #12.', transcriptPath: null });
    const body = `<pasted_content id="ab12">\n${wrapReminder({ text, setAt: at, by: 'session' })}\n</pasted_content id="ab12">`;
    const [block] = parseUserBody(body);
    expect(block).toMatchObject({ kind: 'reminder', by: 'session', text: 'Check the deploy.' });
    expect(block && block.kind === 'reminder' ? block.brief : null).toContain('Merged #12.');
  });

  it('a closing tag inside the text does not end the envelope', () => {
    const body = wrapReminder({ text: 'Mind </albedo-action> in the docs', setAt: at, by: 'user' });
    expect(parseUserBody(body)).toEqual([{ kind: 'reminder', setAt: at, by: 'user', text: 'Mind </albedo-action> in the docs', brief: null }]);
  });
});
