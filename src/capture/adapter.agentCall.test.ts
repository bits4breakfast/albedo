/**
 * A subagent's name, from the parent's `Agent` call and the result that names
 * the agent it started (#377). Shapes as Claude Code 2.1.28x-2.1.322 writes
 * them (see adapter.ts).
 */

import { describe, expect, it } from 'vitest';
import { agentCallOf, agentCallSqlPredicate, parseLine, parseTranscript, spawnedAgentOf } from './adapter';
import { asyncAgent, callLine, resultLine } from './backgroundFixtures';

const rows = (lines: Record<string, unknown>[]) => parseTranscript(lines.map((l) => JSON.stringify(l)).join('\n'));

describe('agentCallOf', () => {
  it('reads the description and agent type off an Agent call', () => {
    const [call] = rows(asyncAgent('g1', 'ag1', 1_000, 'Build #365 polling'));
    expect(agentCallOf(call!)).toEqual({ toolUseId: 'g1', description: 'Build #365 polling', subagentType: 'general-purpose' });
  });

  it('reads a Task call, the name before Agent', () => {
    const [call] = rows([callLine('t1', 'Task', { description: 'Explore the repo', prompt: 'p', subagent_type: 'Explore' }, 1_000)]);
    expect(agentCallOf(call!)).toEqual({ toolUseId: 't1', description: 'Explore the repo', subagentType: 'Explore' });
  });

  it('is null on any other tool, and on the result row', () => {
    const [bash] = rows([callLine('b1', 'Bash', { command: 'ls', description: 'List files' }, 1_000)]);
    expect(agentCallOf(bash!)).toBeNull();
    const [, result] = rows(asyncAgent('g1', 'ag1', 1_000));
    expect(agentCallOf(result!)).toBeNull();
  });

  it('gives null for an empty or missing description or type', () => {
    const [call] = rows([callLine('g2', 'Agent', { description: '  ', prompt: 'p' }, 1_000)]);
    expect(agentCallOf(call!)).toEqual({ toolUseId: 'g2', description: null, subagentType: null });
  });

  it('is the block the row came from, when one line starts two agents', () => {
    const line = {
      ...callLine('x', 'Agent', {}, 1_000),
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'g1', name: 'Agent', input: { description: 'First', subagent_type: 'Explore' } },
          { type: 'tool_use', id: 'g2', name: 'Agent', input: { description: 'Second', subagent_type: 'Plan' } },
        ],
      },
    };
    expect(rows([line]).map((m) => agentCallOf(m)?.description)).toEqual(['First', 'Second']);
  });
});

describe('spawnedAgentOf', () => {
  it('reads the agent an async launch started, by the call it answers', () => {
    const [, result] = rows(asyncAgent('g1', 'ag1', 1_000));
    expect(spawnedAgentOf(result!)).toEqual({ toolUseId: 'g1', agentId: 'ag1' });
  });

  it('reads it without the pairing too: a result stored after a restart has no tool name', () => {
    const [, resultRaw] = asyncAgent('g1', 'ag1', 1_000);
    const [result] = parseLine(JSON.stringify(resultRaw), 1);
    expect(result?.toolName).toBeNull();
    expect(spawnedAgentOf(result!)).toEqual({ toolUseId: 'g1', agentId: 'ag1' });
  });

  it('reads a synchronous result that names its agent', () => {
    const [result] = rows([resultLine('g3', { status: 'completed', agentId: 'ag3', totalTokens: 10 }, 1_000)]);
    expect(spawnedAgentOf(result!)).toEqual({ toolUseId: 'g3', agentId: 'ag3' });
  });

  it('is null for a result that names no agent, and for any other row', () => {
    const [plain] = rows([resultLine('b1', { stdout: 'x' }, 1_000)]);
    expect(spawnedAgentOf(plain!)).toBeNull();
    const [refused] = rows([resultLine('g4', { agentId: '' }, 1_000, { isError: true })]);
    expect(spawnedAgentOf(refused!)).toBeNull();
    const [call] = rows(asyncAgent('g1', 'ag1', 1_000));
    expect(spawnedAgentOf(call!)).toBeNull();
  });
});

describe('agentCallSqlPredicate', () => {
  it('selects Agent and Task calls by role and tool name', () => {
    expect(agentCallSqlPredicate()).toBe(`(role = 'tool_use' AND tool_name IN ('Agent', 'Task'))`);
  });
});
