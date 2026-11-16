/**
 * @vitest-environment jsdom
 *
 * The Agents band (#377): each row is the agent's name with its type, then
 * what it is doing now; the whole prompt on hover; elapsed time and tokens on
 * the right. Unchanged: the header line, status words, order, which agents
 * are listed, and a click opening the agent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { SubagentRun } from '../db/subagents';
import type { Message } from '../types';

const list = vi.hoisted(() => ({ runs: [] as SubagentRun[], calls: [] as unknown[][] }));

vi.mock('../db/subagents', async () => ({
  ...(await vi.importActual<typeof import('../db/subagents')>('../db/subagents')),
  listSubagents: async (...args: unknown[]) => {
    list.calls.push(args);
    return list.runs;
  },
}));
vi.mock('../capture', () => ({ onCaptureUpdate: () => () => {} }));
vi.mock('./SubagentInspector', () => ({
  default: ({ run }: { run: SubagentRun }) => <div data-testid="inspector">{run.agentId}</div>,
}));

const { default: Subagents } = await import('./Subagents');

const NOW = Date.now();

const call = (toolName: string, input: Record<string, unknown>, targetPath: string | null = null): Message => ({
  id: 0,
  taskId: null,
  sessionId: 's1',
  seq: 100,
  role: 'tool_use',
  toolName,
  targetPath,
  body: null,
  rawJson: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: toolName, input }] } }),
  agentId: 'a',
  ts: NOW,
});

const run = (o: Partial<SubagentRun> & Pick<SubagentRun, 'agentId'>): SubagentRun => ({
  label: null,
  prompt: null,
  name: null,
  kind: null,
  lastCall: null,
  tokens: null,
  status: 'running',
  waiting: false,
  firstTs: NOW - 640_000,
  lastTs: NOW,
  runStartTs: NOW - 640_000,
  messages: 10,
  expiresAt: null,
  ...o,
});

afterEach(() => {
  cleanup();
  list.runs = [];
  list.calls = [];
});

const rows = () => screen.getAllByRole('button').filter((b) => b.classList.contains('sa-row'));

describe('Agents band rows (#377)', () => {
  it('shows the name with its type, then what it is doing now, the prompt on hover, and the tokens', async () => {
    list.runs = [
      run({
        agentId: 'a1',
        name: 'Build #365 polling',
        kind: 'general-purpose',
        label: 'Fix GitHub issue #365 in example/repo.',
        prompt: 'Fix GitHub issue #365 in example/repo.\nYour worktree: /tmp/w',
        lastCall: call('Bash', { command: 'npx vitest run', description: 'Running vitest JSON reporter for totals' }),
        tokens: 345_212,
      }),
    ];
    render(<Subagents sessionId="s1" />);
    const [row] = await waitFor(() => {
      const found = rows();
      expect(found).toHaveLength(1);
      return found;
    });
    expect(row!.querySelector('.sa-name')?.textContent).toBe('Build #365 polling');
    expect(row!.querySelector('.sa-kind')?.textContent).toBe('general-purpose');
    expect(row!.querySelector('.sa-now')?.textContent).toBe('Running vitest JSON reporter for totals');
    expect(row!.querySelector('.sa-elapsed')?.textContent).toMatch(/^10m 4\ds · 345\.2k tokens$/);
    expect(row!.getAttribute('title')).toBe('Fix GitHub issue #365 in example/repo.\nYour worktree: /tmp/w');
    expect(row!.getAttribute('aria-label')).toMatch(
      /^Build #365 polling, general-purpose, Running vitest JSON reporter for totals\. Running for 10 minutes \d+ seconds, 345\.2k tokens\. Open its transcript\.$/,
    );
    // The strip asks for the detail; the task list does not (useTasks).
    expect(list.calls[0]).toEqual(['s1', { detail: true }]);
  });

  it('falls back to the prompt line, says Starting… before a first call, and shows no tokens it does not have', async () => {
    list.runs = [run({ agentId: 'a2', label: 'Review the diff for regressions', prompt: 'Review the diff for regressions' })];
    render(<Subagents sessionId="s1" />);
    const [row] = await waitFor(() => {
      const found = rows();
      expect(found).toHaveLength(1);
      return found;
    });
    expect(row!.querySelector('.sa-name')?.textContent).toBe('Review the diff for regressions');
    expect(row!.querySelector('.sa-kind')).toBeNull();
    const now = row!.querySelector('.sa-now');
    expect(now?.textContent).toBe('Starting…');
    expect(now?.getAttribute('data-starting')).toBe('true');
    expect(row!.querySelector('.sa-elapsed')?.textContent).not.toMatch(/tokens/);
  });

  it('keeps the header, status words, order and listing, and a click still opens the agent', async () => {
    list.runs = [
      run({ agentId: 'a1', name: 'First', lastCall: call('Read', { file_path: '/w/useLayout.ts' }, '/w/useLayout.ts') }),
      run({ agentId: 'a2', name: 'Second', status: 'blocked' }),
      run({ agentId: 'a3', name: 'Third', status: 'idle', waiting: true, lastCall: call('Bash', { command: 'gh pr checks' }) }),
      run({ agentId: 'a4', name: 'Done', status: 'idle' }),
    ];
    render(<Subagents sessionId="s1" />);
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(screen.getByText('2 Agents Running · 1 Needs You · 1 In Background')).toBeTruthy();
    expect(rows().map((r) => r.querySelector('.sa-name')?.textContent)).toEqual(['First', 'Second', 'Third']);
    expect(rows().map((r) => r.querySelector('.sa-status-word')?.textContent)).toEqual(['Running', 'Needs You', 'In Background']);
    expect(rows().map((r) => r.querySelector('.sa-now')?.textContent)).toEqual(['Read useLayout.ts', 'Starting…', 'Bash gh pr checks']);
    fireEvent.click(rows()[1]!);
    expect(screen.getByTestId('inspector').textContent).toBe('a2');
  });

  it('draws nothing while no agent is at work', async () => {
    list.runs = [run({ agentId: 'a4', name: 'Done', status: 'idle' })];
    const { container } = render(<Subagents sessionId="s1" />);
    await waitFor(() => expect(list.calls).toHaveLength(1));
    expect(container.querySelector('.sa-bar')).toBeNull();
  });
});
