/**
 * deriveStatus is the function every other workstream trusts to colour a task
 * badge, so each rule from docs/TRANSCRIPT-FORMAT.md gets its own test, plus
 * the failure modes that would be most damaging in the cockpit: a session
 * wedged at `blocked` forever, and a dead session reported as `running`.
 */

import { describe, expect, it } from 'vitest';

import { deriveStatus, RUNNING_WINDOW_MS, UNANSWERED_RUNNING_WINDOW_MS } from './status';
import { parseTranscript } from './adapter';
import type { Message, MessageRole } from '../types';

const NOW = Date.parse('2026-09-15T12:00:00.000Z');
const SESSION = 'sess-1';

let nextLine = 0;

/** Build a Message whose raw_json is shaped the way the adapter produced it. */
function row(
  role: MessageRole,
  opts: { ageMs?: number; toolId?: string; text?: string; stopReason?: string | null } = {},
): Message {
  const line = nextLine++;
  const ts = NOW - (opts.ageMs ?? 0);
  const iso = new Date(ts).toISOString();

  let raw: Record<string, unknown>;
  if (role === 'tool_use') {
    raw = {
      type: 'assistant',
      sessionId: SESSION,
      timestamp: iso,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: opts.toolId ?? `t${line}`, name: 'Bash', input: {} }],
      },
    };
  } else if (role === 'tool_result') {
    raw = {
      type: 'user',
      sessionId: SESSION,
      timestamp: iso,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: opts.toolId ?? `t${line}`, content: 'ok' },
        ],
      },
    };
  } else {
    const message: Record<string, unknown> = {
      role: role === 'assistant' ? 'assistant' : 'user',
      content: opts.text ?? '',
    };
    // `stopReason: null` means "the field is absent", which is what an older
    // Claude Code build or an API-error line looks like.
    if (role === 'assistant' && opts.stopReason !== null) {
      message['stop_reason'] = opts.stopReason ?? 'end_turn';
    }
    raw = {
      type: role === 'assistant' ? 'assistant' : role === 'system' ? 'system' : 'user',
      sessionId: SESSION,
      timestamp: iso,
      message,
    };
  }

  return {
    id: line,
    taskId: 1,
    sessionId: SESSION,
    seq: line * 100,
    role,
    toolName: role === 'tool_use' || role === 'tool_result' ? 'Bash' : null,
    targetPath: null,
    body: opts.text ?? null,
    rawJson: JSON.stringify(raw),
    agentId: null,
    ts,
  };
}

function reset(): void {
  nextLine = 0;
}

describe('deriveStatus — rule 4: nothing to go on', () => {
  it('is idle with no rows', () => {
    expect(deriveStatus([], NOW)).toBe('idle');
  });
});

describe('deriveStatus — unansweredToolUseBlocks: false', () => {
  it('reads a tool call with no result as running (it may just be slow)', () => {
    reset();
    const rows = [
      row('user', { ageMs: 10_000, text: 'go' }),
      row('assistant', { ageMs: 9_000, text: 'running the suite' }),
      row('tool_use', { ageMs: 8_000, toolId: 'a' }),
    ];
    expect(deriveStatus(rows, NOW)).toBe('blocked');
    expect(deriveStatus(rows, NOW, { unansweredToolUseBlocks: false })).toBe('running');
  });

  it('keeps a long-running call running past the usual 90s window', () => {
    reset();
    const rows = [
      row('user', { ageMs: 400_000, text: 'go' }),
      row('tool_use', { ageMs: 300_000, toolId: 'a' }),
    ];
    expect(300_000).toBeGreaterThan(RUNNING_WINDOW_MS);
    expect(deriveStatus(rows, NOW, { unansweredToolUseBlocks: false })).toBe('running');
  });

  it('gives up on a call older than the long window (the session is presumably gone)', () => {
    reset();
    const rows = [
      row('user', { ageMs: UNANSWERED_RUNNING_WINDOW_MS + 60_000, text: 'go' }),
      row('tool_use', { ageMs: UNANSWERED_RUNNING_WINDOW_MS + 30_000, toolId: 'a' }),
    ];
    expect(deriveStatus(rows, NOW, { unansweredToolUseBlocks: false })).toBe('idle');
  });
});

describe('deriveStatus — rule 1: blocked', () => {
  it('blocks when the last row is an unanswered tool call', () => {
    reset();
    const rows = [
      row('user', { ageMs: 10_000, text: 'go' }),
      row('assistant', { ageMs: 9_000, text: 'running it' }),
      row('tool_use', { ageMs: 8_000, toolId: 'a' }),
    ];
    expect(deriveStatus(rows, NOW)).toBe('blocked');
  });

  it('blocks a stale permission prompt too — age is irrelevant when blocked', () => {
    reset();
    const rows = [
      row('user', { ageMs: 4 * 60 * 60 * 1000, text: 'go' }),
      row('tool_use', { ageMs: 4 * 60 * 60 * 1000, toolId: 'a' }),
    ];
    expect(deriveStatus(rows, NOW)).toBe('blocked');
  });

  it('blocks when only SOME of several parallel calls have come back', () => {
    reset();
    const rows = [
      row('user', { ageMs: 10_000, text: 'go' }),
      row('tool_use', { ageMs: 9_000, toolId: 'a' }),
      row('tool_use', { ageMs: 9_000, toolId: 'b' }),
      row('tool_result', { ageMs: 8_000, toolId: 'a' }),
    ];
    expect(deriveStatus(rows, NOW)).toBe('blocked');
  });

  it('does NOT block once every call has been answered', () => {
    reset();
    const rows = [
      row('user', { ageMs: 10_000, text: 'go' }),
      row('tool_use', { ageMs: 9_000, toolId: 'a' }),
      row('tool_use', { ageMs: 9_000, toolId: 'b' }),
      row('tool_result', { ageMs: 8_000, toolId: 'a' }),
      row('tool_result', { ageMs: 8_000, toolId: 'b' }),
    ];
    expect(deriveStatus(rows, NOW)).toBe('running');
  });

  it('does not wedge forever on a tool call orphaned by an interrupt', () => {
    reset();
    const rows = [
      row('user', { ageMs: 60 * 60 * 1000, text: 'go' }),
      row('tool_use', { ageMs: 60 * 60 * 1000, toolId: 'orphan' }), // Esc pressed
      row('user', { ageMs: 59 * 60 * 1000, text: '[Request interrupted by user]' }),
      row('assistant', { ageMs: 58 * 60 * 1000, text: 'stopped' }),
    ];
    expect(deriveStatus(rows, NOW)).toBe('idle');
  });

  it('ignores an answered call from an earlier turn when judging the tail', () => {
    reset();
    const rows = [
      row('user', { ageMs: 30_000, text: 'go' }),
      row('tool_use', { ageMs: 25_000, toolId: 'a' }),
      row('tool_result', { ageMs: 24_000, toolId: 'a' }),
      row('assistant', { ageMs: 23_000, text: 'still going', stopReason: 'tool_use' }),
    ];
    expect(deriveStatus(rows, NOW)).toBe('running');
  });

  it('does not block on a tool_use whose raw_json cannot be read', () => {
    reset();
    const broken = row('tool_use', { ageMs: 5 * 60 * 1000, toolId: 'x' });
    const rows = [
      row('user', { ageMs: 6 * 60 * 1000, text: 'go' }),
      { ...broken, rawJson: '{ truncated', seq: 999 },
      row('assistant', { ageMs: 4 * 60 * 1000, text: 'finished', stopReason: 'end_turn' }),
    ];
    // last row is not a tool call and the orphan is unidentifiable: refuse to
    // guess `blocked` on missing data
    expect(deriveStatus(rows, NOW)).toBe('idle');
  });
});

describe('deriveStatus — rule 2: running', () => {
  it('is running just inside the window', () => {
    reset();
    const rows = [row('assistant', { ageMs: RUNNING_WINDOW_MS - 1, text: 'working', stopReason: null })];
    expect(deriveStatus(rows, NOW)).toBe('running');
  });

  it('is running exactly at the window boundary', () => {
    reset();
    const rows = [row('assistant', { ageMs: RUNNING_WINDOW_MS, text: 'working', stopReason: null })];
    expect(deriveStatus(rows, NOW)).toBe('running');
  });

  it('is idle one millisecond past the window', () => {
    reset();
    const rows = [row('assistant', { ageMs: RUNNING_WINDOW_MS + 1, text: 'working', stopReason: null })];
    expect(deriveStatus(rows, NOW)).toBe('idle');
  });

  it('counts a fresh tool_result as activity', () => {
    reset();
    const rows = [
      row('user', { ageMs: 20_000, text: 'go' }),
      row('tool_use', { ageMs: 15_000, toolId: 'a' }),
      row('tool_result', { ageMs: 5_000, toolId: 'a' }),
    ];
    expect(deriveStatus(rows, NOW)).toBe('running');
  });

  it('does not count a system row as assistant/tool activity', () => {
    reset();
    const rows = [
      row('assistant', { ageMs: 10_000, text: 'done', stopReason: null }),
      row('system', { ageMs: 1_000 }),
    ];
    expect(deriveStatus(rows, NOW)).toBe('idle');
  });

  it('counts a freshly submitted prompt as running', () => {
    reset();
    // Claude Code writes the assistant line only once the response completes,
    // so during a long thinking phase the newest row IS the human's prompt.
    const rows = [row('user', { ageMs: 3_000, text: 'refactor the parser' })];
    expect(deriveStatus(rows, NOW)).toBe('running');
  });

  it('lets an abandoned prompt age out of the window', () => {
    reset();
    const rows = [row('user', { ageMs: RUNNING_WINDOW_MS + 1, text: 'refactor' })];
    expect(deriveStatus(rows, NOW)).toBe('idle');
  });
});

describe('deriveStatus — rule 3: control handed back', () => {
  it('is idle on an old assistant text turn', () => {
    reset();
    const rows = [
      row('user', { ageMs: 10 * 60 * 1000, text: 'go' }),
      row('assistant', { ageMs: 9 * 60 * 1000, text: 'all done' }),
    ];
    expect(deriveStatus(rows, NOW)).toBe('idle');
  });

  it('is idle the INSTANT the turn ends, not 90 seconds later', () => {
    reset();
    // The regression this rule exists for: recency alone cannot tell "still
    // working" from "just finished", so a completed task used to read
    // `running` for the whole window -- the wrong answer to the one question
    // the cockpit is for.
    const rows = [
      row('user', { ageMs: 4_000, text: 'go' }),
      row('assistant', { ageMs: 1_000, text: 'Done.', stopReason: 'end_turn' }),
    ];
    expect(deriveStatus(rows, NOW)).toBe('idle');
  });

  it('treats stop_sequence as handing control back too', () => {
    reset();
    const rows = [row('assistant', { ageMs: 1_000, text: 'Done.', stopReason: 'stop_sequence' })];
    expect(deriveStatus(rows, NOW)).toBe('idle');
  });

  it('keeps running when stop_reason says the turn is NOT over', () => {
    reset();
    const rows = [row('assistant', { ageMs: 1_000, text: 'Reading files', stopReason: 'tool_use' })];
    expect(deriveStatus(rows, NOW)).toBe('running');
  });

  it('falls back to the recency window when stop_reason is absent', () => {
    reset();
    expect(deriveStatus([row('assistant', { ageMs: 1_000, text: 'x', stopReason: null })], NOW)).toBe(
      'running',
    );
    reset();
    expect(
      deriveStatus([row('assistant', { ageMs: RUNNING_WINDOW_MS + 1, text: 'x', stopReason: null })], NOW),
    ).toBe('idle');
  });

  it('falls back to the window on an unknown stop_reason', () => {
    reset();
    const rows = [row('assistant', { ageMs: 1_000, text: 'x', stopReason: 'max_tokens' })];
    expect(deriveStatus(rows, NOW)).toBe('running');
  });

  it('does not read stop_reason off a non-assistant tail row', () => {
    reset();
    const rows = [
      row('user', { ageMs: 20_000, text: 'go' }),
      row('tool_use', { ageMs: 15_000, toolId: 'a' }),
      row('tool_result', { ageMs: 2_000, toolId: 'a' }),
    ];
    expect(deriveStatus(rows, NOW)).toBe('running');
  });

  it('stays blocked even when the line claims the turn ended', () => {
    reset();
    // An unanswered tool call outranks stop_reason: the permission prompt is
    // what the user actually has to deal with.
    const rows = [
      row('user', { ageMs: 10_000, text: 'go' }),
      row('tool_use', { ageMs: 5_000, toolId: 'a' }),
    ];
    const tail = rows[1] as Message;
    tail.rawJson = JSON.stringify({
      type: 'assistant',
      sessionId: SESSION,
      timestamp: new Date(NOW - 5_000).toISOString(),
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }],
      },
    });
    expect(deriveStatus(rows, NOW)).toBe('blocked');
  });

  it('is idle on a long-dead session', () => {
    reset();
    const rows = [
      row('user', { ageMs: 48 * 60 * 60 * 1000, text: 'go' }),
      row('tool_use', { ageMs: 48 * 60 * 60 * 1000, toolId: 'a' }),
      row('tool_result', { ageMs: 48 * 60 * 60 * 1000, toolId: 'a' }),
      row('assistant', { ageMs: 47 * 60 * 60 * 1000, text: 'done' }),
    ];
    expect(deriveStatus(rows, NOW)).toBe('idle');
  });
});

describe('deriveStatus — robustness', () => {
  it('does not depend on the caller sorting the rows', () => {
    reset();
    const rows = [
      row('user', { ageMs: 10_000, text: 'go' }),
      row('assistant', { ageMs: 9_000, text: 'thinking' }),
      row('tool_use', { ageMs: 8_000, toolId: 'a' }),
    ];
    const shuffled = [rows[2], rows[0], rows[1]] as Message[];
    expect(deriveStatus(shuffled, NOW)).toBe('blocked');
  });

  it('does not mutate the array it is given', () => {
    reset();
    const rows = [
      row('tool_use', { ageMs: 8_000, toolId: 'a' }),
      row('user', { ageMs: 10_000, text: 'go' }),
    ];
    const before = rows.map((r) => r.id);
    deriveStatus(rows, NOW);
    expect(rows.map((r) => r.id)).toEqual(before);
  });

  it('never returns a lifecycle-only status', () => {
    reset();
    const cases: Message[][] = [
      [],
      [row('user', { ageMs: 1_000, text: 'go' })],
      [row('system', { ageMs: 1_000 })],
      [row('tool_use', { ageMs: 1_000, toolId: 'a' })],
    ];
    for (const rows of cases) {
      expect(['idle', 'running', 'blocked']).toContain(deriveStatus(rows, NOW));
    }
  });
});

describe('deriveStatus — fed straight from the adapter', () => {
  /** Turn adapter output into Message rows the way the db layer would. */
  function asMessages(text: string): Message[] {
    return parseTranscript(text).map((r, i) => ({ ...r, id: i, taskId: 1 }));
  }

  const blockedTranscript = [
    JSON.stringify({
      type: 'user',
      sessionId: SESSION,
      timestamp: '2026-09-15T11:59:00.000Z',
      message: { role: 'user', content: 'deploy it' },
    }),
    JSON.stringify({
      type: 'assistant',
      sessionId: SESSION,
      timestamp: '2026-09-15T11:59:30.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Deploying.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'deploy.sh' } },
        ],
      },
    }),
    '',
  ].join('\n');

  it('reports blocked for a transcript waiting on a permission prompt', () => {
    expect(deriveStatus(asMessages(blockedTranscript), NOW)).toBe('blocked');
  });

  it('flips to running once the result line lands', () => {
    const answered =
      blockedTranscript +
      JSON.stringify({
        type: 'user',
        sessionId: SESSION,
        timestamp: '2026-09-15T11:59:45.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'deployed' }],
        },
      }) +
      '\n';
    expect(deriveStatus(asMessages(answered), NOW)).toBe('running');
  });

  it('ignores thinking rows when deciding the tail', () => {
    const thinkingOnly = [
      JSON.stringify({
        type: 'assistant',
        sessionId: SESSION,
        timestamp: '2026-09-15T11:59:50.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'hmm', signature: 's' }],
        },
      }),
      '',
    ].join('\n');
    // a thinking block is still an assistant row, so recent => running
    expect(deriveStatus(asMessages(thinkingOnly), NOW)).toBe('running');
  });
});
