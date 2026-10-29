import { describe, expect, it } from 'vitest';

import { parseTranscript } from '../../capture/adapter';
import type { Message } from '../../types';
import { formatOutputTokens, formatTurnTotals, stepDetail, stepLabel, workingState } from './working';

/*
 * Transcript lines in Claude Code's shape, parsed by the adapter into the
 * rows the pane holds: one line per content block, each assistant line
 * repeating its message's id and usage.
 */

const T0 = Date.parse('2026-10-20T12:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const base = (s: number, extra: Record<string, unknown> = {}) => ({
  sessionId: 'sess-1',
  uuid: `u-${s}-${Math.random()}`,
  timestamp: at(s),
  cwd: '/work/repo',
  ...extra,
});

const prompt = (s: number, text: string, extra: Record<string, unknown> = {}) => ({
  ...base(s, extra),
  type: 'user',
  message: { role: 'user', content: text },
});
const assistant = (s: number, id: string, out: number, block: unknown, stop: string | null = null, extra = {}) => ({
  ...base(s, extra),
  type: 'assistant',
  message: {
    id,
    role: 'assistant',
    model: 'claude-test',
    content: [block],
    stop_reason: stop,
    usage: { input_tokens: 3, output_tokens: out, cache_read_input_tokens: 1000 },
  },
});
const text = (s: number, id: string, out: number, body: string, stop: string | null = null) =>
  assistant(s, id, out, { type: 'text', text: body }, stop);
const call = (s: number, id: string, out: number, toolId: string, name: string, input: unknown, extra = {}) =>
  assistant(s, id, out, { type: 'tool_use', id: toolId, name, input }, 'tool_use', extra);
const result = (s: number, toolId: string, extra: Record<string, unknown> = {}) => ({
  ...base(s, extra),
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'ok' }] },
});
const turnDuration = (s: number) => ({ ...base(s), type: 'system', subtype: 'turn_duration', durationMs: 1000 });
const side = { isSidechain: true, agentId: 'agent-1' };

function rows(...lines: object[]): Message[] {
  const text = lines.map((l) => JSON.stringify(l)).join('\n');
  return parseTranscript(text).map((r, i) => ({ ...r, id: i + 1, taskId: 1 }));
}

const opts = { sending: false, echoAt: null, complete: false };

/** A finished turn, then the prompt of the one running now. */
const before = [prompt(0, 'first'), text(5, 'msg_a', 900, 'done', 'end_turn'), turnDuration(5)];

describe('workingState', () => {
  it('says Running and the call, timed from the call, while a tool has no result', () => {
    const w = workingState(
      rows(
        ...before,
        prompt(100, 'commit it'),
        text(104, 'msg_b', 40, 'Committing.'),
        call(108, 'msg_b', 40, 'tu_1', 'Bash', { command: 'git add -A && git commit -q --amend\necho done' }),
      ),
      opts,
    );
    expect(w.step).toEqual({ kind: 'tool', name: 'Bash', target: null, summary: 'git add -A && git commit -q --amend' });
    expect(stepLabel(w.step)).toBe('Running');
    expect(stepDetail(w.step)).toBe('Bash git add -A && git commit -q --amend');
    expect(w.since).toBe(T0 + 108_000);
    expect(w.turn?.startedAt).toBe(T0 + 100_000);
  });

  it('shows an edit as its chip does, by file name', () => {
    const w = workingState(
      rows(prompt(0, 'fix it'), call(3, 'msg_b', 10, 'tu_1', 'Edit', { file_path: '/work/repo/src/Foo.php', old_string: 'a', new_string: 'b' })),
      opts,
    );
    expect(stepDetail(w.step)).toBe('Edit Foo.php');
  });

  it('says Thinking once the result is in, timed from the result', () => {
    const w = workingState(
      rows(...before, prompt(100, 'commit it'), call(108, 'msg_b', 40, 'tu_1', 'Bash', { command: 'git status' }), result(117, 'tu_1')),
      opts,
    );
    expect(w.step).toEqual({ kind: 'thinking' });
    expect(w.since).toBe(T0 + 117_000);
  });

  it('says Thinking right after the prompt, before any reply', () => {
    const w = workingState(rows(...before, prompt(100, 'commit it')), opts);
    expect(stepLabel(w.step)).toBe('Thinking');
    expect(w.since).toBe(T0 + 100_000);
    expect(w.turn).toEqual({ startedAt: T0 + 100_000, outputTokens: 0 });
  });

  it('says Working while a reply is being written', () => {
    const w = workingState(rows(...before, prompt(100, 'go'), text(103, 'msg_b', 12, 'Looking.')), opts);
    expect(w.step).toEqual({ kind: 'working' });
    expect(w.since).toBe(T0 + 103_000);
  });

  it('says Sending while the message is on its way, timed from the send', () => {
    const w = workingState(rows(...before), { sending: true, echoAt: T0 + 200_000, complete: false });
    expect(stepLabel(w.step)).toBe('Sending');
    expect(w.since).toBe(T0 + 200_000);
  });

  it('counts parallel calls, timed from the first', () => {
    const w = workingState(
      rows(
        prompt(0, 'look around'),
        call(2, 'msg_b', 30, 'tu_1', 'Read', { file_path: '/work/repo/a.ts' }),
        call(2, 'msg_b', 30, 'tu_2', 'Grep', { pattern: 'foo' }),
        call(3, 'msg_b', 30, 'tu_3', 'Glob', { pattern: '*.ts' }),
        result(4, 'tu_2'),
      ),
      opts,
    );
    expect(w.step).toEqual({ kind: 'tools', count: 2, agents: false });
    expect(stepLabel(w.step)).toBe('Running 2 tools');
    expect(w.since).toBe(T0 + 2_000);
  });

  it('names a running subagent by its description, and ignores its own rows', () => {
    const w = workingState(
      rows(
        prompt(0, 'investigate'),
        call(2, 'msg_b', 50, 'tu_agent', 'Agent', { description: 'Find the cache bug', prompt: 'Look for it' }),
        // The subagent's traffic, under the same session id.
        prompt(3, 'Look for it', side),
        call(5, 'msg_s1', 4000, 'tu_s1', 'Bash', { command: 'git log' }, side),
        result(9, 'tu_s1', side),
        assistant(12, 'msg_s2', 700, { type: 'text', text: 'Found it' }, null, side),
      ),
      opts,
    );
    expect(w.step).toEqual({ kind: 'agent', description: 'Find the cache bug' });
    expect(stepLabel(w.step)).toBe('Agent');
    expect(w.since).toBe(T0 + 2_000);
    // The subagent's tokens are its own, not the turn's.
    expect(w.turn?.outputTokens).toBe(50);
  });

  it('says how many subagents run when every open call is one', () => {
    const w = workingState(
      rows(
        prompt(0, 'investigate'),
        call(2, 'msg_b', 50, 'tu_1', 'Agent', { description: 'One' }),
        call(2, 'msg_b', 50, 'tu_2', 'Task', { description: 'Two' }),
      ),
      opts,
    );
    expect(stepLabel(w.step)).toBe('Running 2 agents');
  });

  it('counts output tokens once per message id, over the turn only', () => {
    const w = workingState(
      rows(
        ...before,
        prompt(100, 'commit it'),
        // One message, three blocks, three lines repeating its usage.
        text(101, 'msg_b', 120, 'Checking.'),
        call(102, 'msg_b', 120, 'tu_1', 'Bash', { command: 'git status' }),
        call(102, 'msg_b', 120, 'tu_2', 'Bash', { command: 'git diff' }),
        result(110, 'tu_1'),
        result(111, 'tu_2'),
        call(115, 'msg_c', 37_407, 'tu_3', 'Bash', { command: 'git commit' }),
      ),
      opts,
    );
    // msg_a belongs to the turn before.
    expect(w.turn).toEqual({ startedAt: T0 + 100_000, outputTokens: 37_527 });
    expect(formatTurnTotals(w.turn!, T0 + 100_000 + 468_000)).toBe('7m 48s · ↓ 37.5k tokens');
  });

  it('starts a turn Claude Code took from its queue at its first row after the last turn end', () => {
    const w = workingState(
      rows(
        ...before,
        // A queued message taken as the next turn opens with a meta line.
        prompt(60, 'queued text', { isMeta: true }),
        call(62, 'msg_b', 10, 'tu_1', 'Skill', { skill: 'review' }),
        result(63, 'tu_1'),
        // A skill's text, inside the turn: not a new start.
        prompt(63, 'Base directory for this skill', { isMeta: true }),
      ),
      opts,
    );
    expect(w.turn?.startedAt).toBe(T0 + 60_000);
  });

  it('does not start a turn at the summary of a compaction made while idle', () => {
    const w = workingState(
      rows(
        ...before,
        { ...base(30), type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'auto' } },
        prompt(30, 'This session is being continued from a previous conversation', { isCompactSummary: true }),
        // Five minutes later another session's message starts the turn.
        prompt(330, 'Another Claude session sent a message', { isMeta: true }),
        call(332, 'msg_b', 10, 'tu_1', 'Bash', { command: 'git status' }),
      ),
      opts,
    );
    expect(w.turn?.startedAt).toBe(T0 + 330_000);
  });

  it('does not start a turn at text Claude Code gave itself mid-turn', () => {
    const w = workingState(
      rows(prompt(0, 'run it'), call(1, 'msg_b', 5, 'tu_1', 'Bash', { command: 'make' }), prompt(30, '<task-notification>done</task-notification>')),
      opts,
    );
    expect(w.turn?.startedAt).toBe(T0);
  });

  it('starts after an interrupt, which ends the turn before', () => {
    const w = workingState(
      rows(prompt(0, 'run it'), call(1, 'msg_b', 5, 'tu_1', 'Bash', { command: 'make' }), prompt(9, '[Request interrupted by user]'), prompt(20, 'try again')),
      opts,
    );
    expect(w.turn?.startedAt).toBe(T0 + 20_000);
    // The interrupted call is the turn before's, not running now.
    expect(w.step).toEqual({ kind: 'thinking' });
  });

  it('hides the totals when the turn started before the loaded rows', () => {
    const loaded = rows(call(2, 'msg_b', 50, 'tu_1', 'Bash', { command: 'npm test' }));
    const w = workingState(loaded, opts);
    expect(w.turn).toBeNull();
    expect(stepLabel(w.step)).toBe('Running');
    // From the start of the conversation, the first row is the turn's start.
    const all = rows(prompt(0, 'test it', { isMeta: true }), call(2, 'msg_b', 50, 'tu_1', 'Bash', { command: 'npm test' }));
    expect(workingState(all, { ...opts, complete: true }).turn).toEqual({ startedAt: T0, outputTokens: 50 });
    expect(workingState(all, opts).turn).toBeNull();
  });

  it('says only Working, with no totals, between a turn end and the next start', () => {
    const w = workingState(rows(...before), opts);
    expect(w.step).toEqual({ kind: 'working' });
    expect(w.turn).toBeNull();
  });
});

describe('formatOutputTokens', () => {
  it('counts as Claude Code does', () => {
    expect(formatOutputTokens(1)).toBe('↓ 1 token');
    expect(formatOutputTokens(999)).toBe('↓ 999 tokens');
    expect(formatOutputTokens(1000)).toBe('↓ 1k tokens');
    expect(formatOutputTokens(37_640)).toBe('↓ 37.6k tokens');
    expect(formatOutputTokens(999_960)).toBe('↓ 1m tokens');
    expect(formatOutputTokens(1_240_000)).toBe('↓ 1.2m tokens');
  });
});
