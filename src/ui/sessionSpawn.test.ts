import { describe, expect, it } from 'vitest';
import {
  CHAT_SYSTEM_PROMPT,
  isResumePlan,
  kindFlags,
  mcpConfigArg,
  MCP_TOOLS,
  planSpawn,
  withMcpConfig,
  type SpawnInput,
} from './sessionSpawn';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NEW = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const newId = () => NEW;

describe('planSpawn', () => {
  it('starts a task that never had a session under an id Albedo chose', () => {
    expect(planSpawn({ kind: 'work', sessionId: null, transcriptExists: null, newId })).toEqual({
      args: ['--session-id', NEW],
      sessionId: NEW,
      mode: 'new',
      modelFrom: null,
    });
  });

  it('resumes the task session when its transcript exists', () => {
    const plan = planSpawn({ kind: 'work', sessionId: A, transcriptExists: true, newId });
    expect(plan).toEqual({ args: ['--resume', A], sessionId: A, mode: 'resume', modelFrom: A });
    expect(isResumePlan(plan)).toBe(true);
  });

  it('resumes when it cannot tell, rather than claiming an id that may be taken', () => {
    expect(planSpawn({ kind: 'work', sessionId: A, transcriptExists: null, newId }).mode).toBe('resume');
  });

  it('reuses an id Claude Code never wrote a transcript for, instead of a resume it would reject', () => {
    const plan = planSpawn({ kind: 'work', sessionId: A, transcriptExists: false, newId });
    expect(plan).toEqual({ args: ['--session-id', A], sessionId: A, mode: 'reuse', modelFrom: null });
    expect(isResumePlan(plan)).toBe(false);
  });

  it('starts fresh under a new id when asked, whatever the task had or History passed', () => {
    const plan = planSpawn({ kind: 'work', sessionId: A, pending: ['--resume', B], fresh: true, transcriptExists: true, newId });
    expect(plan).toMatchObject({ args: ['--session-id', NEW], sessionId: NEW, mode: 'new' });
  });

  it('continues a past session from History under its own id', () => {
    expect(planSpawn({ kind: 'work', sessionId: B, pending: ['--resume', B], transcriptExists: null, newId })).toEqual({
      args: ['--resume', B],
      sessionId: B,
      mode: 'continue',
      modelFrom: B,
    });
  });

  it('forks under the id History chose, keeping the source model', () => {
    const plan = planSpawn({
      kind: 'work',
      sessionId: NEW,
      pending: ['--resume', A, '--fork-session', '--session-id', NEW],
      transcriptExists: null,
      newId: () => 'unused',
    });
    expect(plan).toEqual({
      args: ['--resume', A, '--fork-session', '--session-id', NEW],
      sessionId: NEW,
      mode: 'fork',
      modelFrom: A,
    });
  });

  it('chooses the fork id itself when none was passed', () => {
    const plan = planSpawn({ kind: 'work', sessionId: null, pending: ['--resume', A, '--fork-session'], transcriptExists: null, newId });
    expect(plan.args).toEqual(['--resume', A, '--fork-session', '--session-id', NEW]);
    expect(plan.sessionId).toBe(NEW);
  });

  it('restarting a fork resumes the fork, not the original (History args are first-spawn only)', () => {
    // Terminal drops `pending` after the first spawn; this is the second.
    expect(planSpawn({ kind: 'work', sessionId: NEW, transcriptExists: true, newId })).toMatchObject({
      args: ['--resume', NEW],
      mode: 'resume',
    });
  });
});

describe('chat tasks', () => {
  const CHAT = ['--append-system-prompt', CHAT_SYSTEM_PROMPT];

  // Every way a task's `claude` starts. The instruction must ride on each:
  // a resumed session never sees a first message again, and /clear drops it.
  const modes: Array<[string, Omit<SpawnInput, 'kind'>]> = [
    ['new', { sessionId: null, transcriptExists: null, newId }],
    ['resume', { sessionId: A, transcriptExists: true, newId }],
    ['reuse', { sessionId: A, transcriptExists: false, newId }],
    ['fresh session', { sessionId: A, fresh: true, transcriptExists: true, newId }],
    ['continue', { sessionId: null, pending: ['--resume', B], transcriptExists: null, newId }],
    ['fork', { sessionId: null, pending: ['--resume', A, '--fork-session'], transcriptExists: null, newId }],
  ];

  it.each(modes)('appends the instruction to the system prompt on %s', (_name, input) => {
    const work = planSpawn({ ...input, kind: 'work' });
    const chat = planSpawn({ ...input, kind: 'chat' });
    // Same session, same mode, same model source: only the flag differs.
    expect(chat).toEqual({ ...work, args: [...work.args, ...CHAT] });
  });

  it.each(modes)('adds nothing to a work task on %s', (_name, input) => {
    expect(planSpawn({ ...input, kind: 'work' }).args).not.toContain('--append-system-prompt');
  });

  it('keeps the flag and its text as two argv entries, never a quoted string', () => {
    expect(kindFlags('chat')).toEqual(['--append-system-prompt', CHAT_SYSTEM_PROMPT]);
    expect(kindFlags('work')).toEqual([]);
  });

  it('says what the owner decided, and does not read as a flag', () => {
    expect(CHAT_SYSTEM_PROMPT.startsWith('This is a conversation about the code, not a change to it.')).toBe(true);
    expect(CHAT_SYSTEM_PROMPT).toContain('Do not create, edit, move or delete files in this folder');
    expect(CHAT_SYSTEM_PROMPT).toContain('via MCP');
    expect(CHAT_SYSTEM_PROMPT.startsWith('-')).toBe(false);
  });

  it('is still a resume plan when it resumes', () => {
    expect(isResumePlan(planSpawn({ kind: 'chat', sessionId: A, transcriptExists: true, newId }))).toBe(true);
  });
});

describe('Albedo MCP server (#157)', () => {
  const server = '/Applications/Albedo.app/Contents/MacOS/albedo-mcp';

  it('names the server, its absolute path and the task id in its environment', () => {
    expect(JSON.parse(mcpConfigArg(42, server))).toEqual({
      mcpServers: { albedo: { type: 'stdio', command: server, args: [], env: { ALBEDO_TASK_ID: '42' } } },
    });
  });

  it('goes in front, followed by a flag, and never strict', () => {
    const args = withMcpConfig(['--settings', '{}', '--session-id', 'abc', 'Fix the bug'], 7, server);
    expect(args.slice(0, 4)).toEqual(['--mcp-config', mcpConfigArg(7, server), '--allowedTools', MCP_TOOLS.join(',')]);
    expect(args.slice(4)).toEqual(['--settings', '{}', '--session-id', 'abc', 'Fix the bug']);
    expect(args).not.toContain('--strict-mcp-config');
  });

  it('ends the options before a bare prompt, so the prompt is not read as a config', () => {
    expect(withMcpConfig(['Fix the bug'], 7, server).slice(4)).toEqual(['--', 'Fix the bug']);
    expect(withMcpConfig([], 7, server).slice(4)).toEqual(['--']);
  });

  it('allows exactly the three tools', () => {
    expect(MCP_TOOLS).toEqual([
      'mcp__albedo__create_reminder',
      'mcp__albedo__request_session',
      'mcp__albedo__notify_blocked',
    ]);
  });

  it('keeps every planned flag for every spawn mode', () => {
    for (const input of [
      { kind: 'work', sessionId: null, transcriptExists: null },
      { kind: 'chat', sessionId: 's1', transcriptExists: true },
      { kind: 'work', sessionId: 's1', transcriptExists: false },
    ] as const) {
      const plan = planSpawn({ ...input, newId: () => 'new' });
      const args = withMcpConfig(plan.args, 3, server);
      expect(args.slice(4)).toEqual(plan.args);
    }
  });
});
