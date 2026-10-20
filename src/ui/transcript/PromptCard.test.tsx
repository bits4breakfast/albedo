/**
 * @vitest-environment jsdom
 *
 * The "waiting on you" card's answering wiring: what reaches `answerPrompt`,
 * and that it reaches it once. The decision JSON itself is tested in
 * capture/hookEvents.test.ts; here only the clicks.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { alwaysAllowRules, answerPrompt, derivePending, pendingPrompt, type AnswerResult, type PendingPrompt } from '../../capture/hookEvents';
import { PromptCard } from './PromptCard';

// Keep the real pure functions; replace only the runtime that touches Tauri.
vi.mock('../../capture/hookEvents', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../capture/hookEvents')>();
  return {
    ...real,
    pendingPrompt: vi.fn(() => null),
    onPromptChange: vi.fn(() => () => {}),
    answerPrompt: vi.fn(async (): Promise<AnswerResult> => 'taken'),
  };
});

const answer = vi.mocked(answerPrompt);
const current = vi.mocked(pendingPrompt);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const NOW = Date.now();

function show(p: PendingPrompt) {
  current.mockReturnValue(p);
  render(<PromptCard taskId={3} onAnswerInTerminal={() => {}} />);
}

const perm = (extra: Partial<Extract<PendingPrompt, { kind: 'permission' }>> = {}): PendingPrompt => ({
  kind: 'permission',
  toolUseId: null,
  toolName: 'Bash',
  summary: 'Bash: curl -s https://example.com',
  requestId: '7-1700000000000',
  alwaysAllow: null,
  at: NOW,
  ...extra,
});

function ask(questions: unknown[], requestId: string | null = '7-1700000000000'): PendingPrompt {
  const p = derivePending([
    {
      event: 'PermissionRequest',
      toolName: 'AskUserQuestion',
      toolUseId: null,
      toolInput: { questions },
      message: null,
      notificationType: null,
      requestId,
      suggestions: null,
      sessionId: null,
      source: null,
      at: NOW,
    },
  ]);
  if (p === null) throw new Error('fixture');
  return p;
}

const decisionOf = (call: number) => answer.mock.calls[call]?.[2]?.hookSpecificOutput.decision;

describe('PromptCard: permission', () => {
  it('Allow sends one allow, then every button is disabled', async () => {
    show(perm());
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer.mock.calls[0]?.[0]).toBe(3);
    expect(decisionOf(0)).toEqual({ behavior: 'allow' });
    expect((screen.getByRole('button', { name: 'Deny' }) as HTMLButtonElement).disabled).toBe(true);
    await screen.findByText('Answered.');
  });

  it('Deny sends a deny that interrupts', () => {
    show(perm());
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(decisionOf(0)).toMatchObject({ behavior: 'deny', interrupt: true });
  });

  it('"don\'t ask again" appears only with a plain rule suggestion, and names the rule', () => {
    show(perm());
    expect(screen.queryByRole('button', { name: /Don’t Ask Again/ })).toBeNull();
    cleanup();
    const rules = alwaysAllowRules([
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'curl -s https://example.com' }], behavior: 'allow', destination: 'localSettings' },
    ]);
    show(perm({ alwaysAllow: rules }));
    screen.getByText('Bash(curl -s https://example.com)');
    fireEvent.click(screen.getByRole('button', { name: /Don’t Ask Again/ }));
    expect(decisionOf(0)).toMatchObject({ behavior: 'allow', updatedPermissions: [{ type: 'addRules' }] });
  });

  it('no hook waiting: no buttons, only the way to the terminal', () => {
    show(perm({ requestId: null }));
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
    screen.getByRole('button', { name: 'Answer in Terminal' });
  });

  it('says so when the answer was refused as stale', async () => {
    answer.mockResolvedValueOnce('refused');
    show(perm());
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await screen.findByText(/Not sent/);
  });

  it('says so when the hook never took the answer (the terminal won)', async () => {
    answer.mockResolvedValueOnce('untaken');
    show(perm());
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await screen.findByText(/did not take the answer/);
    expect((screen.getByRole('button', { name: 'Allow' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('PromptCard: AskUserQuestion', () => {
  const colour = { question: 'Pick a colour', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }, { label: 'Green' }] };
  const fruit = { question: 'Pick fruits', header: 'Fruit', multiSelect: true, options: [{ label: 'Apple' }, { label: 'Pear' }, { label: 'Plum' }] };

  it('one single-select question answers on the click', () => {
    show(ask([colour]));
    fireEvent.click(screen.getByRole('button', { name: /Green/ }));
    fireEvent.click(screen.getByRole('button', { name: /Red/ }));
    expect(answer).toHaveBeenCalledTimes(1);
    expect(decisionOf(0)).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Pick a colour': 'Green' } } });
  });

  it('typed text answers a single question on Enter', () => {
    show(ask([colour]));
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'Teal' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(decisionOf(0)).toMatchObject({ updatedInput: { answers: { 'Pick a colour': 'Teal' } } });
  });

  it('several questions: Submit waits for every answer; multi-select toggles', async () => {
    show(ask([colour, fruit]));
    const submit = () => screen.getByRole('button', { name: 'Submit Answers' }) as HTMLButtonElement;
    expect(submit().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Red/ }));
    expect(answer).not.toHaveBeenCalled(); // not one-click: there is more to answer
    fireEvent.click(screen.getByRole('button', { name: /Plum/ }));
    fireEvent.click(screen.getByRole('button', { name: /Pear/ }));
    fireEvent.click(screen.getByRole('button', { name: /Pear/ })); // toggled back off
    fireEvent.click(screen.getByRole('button', { name: /Apple/ }));
    expect(screen.getByRole('button', { name: /Apple/ }).getAttribute('aria-pressed')).toBe('true');
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());
    fireEvent.click(submit());
    expect(answer).toHaveBeenCalledTimes(1);
    expect(decisionOf(0)).toMatchObject({
      updatedInput: { answers: { 'Pick a colour': 'Red', 'Pick fruits': 'Apple, Plum' } },
    });
    await waitFor(() => expect(submit().disabled).toBe(true));
  });

  it('no hook waiting: the read-only list, no buttons', () => {
    show(ask([colour], null));
    screen.getByText('Red');
    expect(screen.queryByRole('button', { name: /Red/ })).toBeNull();
  });
});
