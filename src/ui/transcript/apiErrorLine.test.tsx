/**
 * @vitest-environment jsdom
 *
 * An API error in the transcript (#338): Claude Code's line for a failed
 * request is drawn tinted, as an error and not as Claude's reply, and the one
 * the task's last turn stopped on carries Try Again -- while the session is
 * live. Lines shaped like Claude Code 2.1.322's, with made-up text.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Message } from '../../types';

const sent = vi.hoisted(() => [] as [number, string][]);
const live = vi.hoisted(() => ({ value: true }));
vi.mock('../Terminal', () => ({
  hasLivePty: () => live.value,
  ptyLiveSince: () => (live.value ? 1 : null),
  usePtyLiveSince: () => (live.value ? 1 : null),
  onPtyPresenceChange: () => () => {},
}));
vi.mock('./send', async (orig) => ({
  ...(await orig<typeof import('./send')>()),
  useSendsWait: () => false,
  sendToSession: async (taskId: number, text: string) => {
    sent.push([taskId, text]);
    return 'sent';
  },
}));

const { parseTranscript } = await import('../../capture/adapter');
const { MessageRow } = await import('./MessageRow');
const { ApiErrorRetryContext, apiErrorRetryOf } = await import('./apiErrorRetry');

afterEach(() => {
  cleanup();
  sent.length = 0;
  live.value = true;
});

const SESSION = 'sess-tx';
let clock = 0;
const at = () => new Date(Date.parse('2026-11-10T09:00:00.000Z') + 1_000 * clock++).toISOString();

const prompt = (text: string) => JSON.stringify({ type: 'user', sessionId: SESSION, timestamp: at(), message: { role: 'user', content: text } });
const reply = (text: string) =>
  JSON.stringify({ type: 'assistant', sessionId: SESSION, timestamp: at(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
const apiError = (text: string) =>
  JSON.stringify({
    type: 'assistant',
    sessionId: SESSION,
    timestamp: at(),
    apiError: 'stream_idle_timeout',
    error: 'server_error',
    isApiErrorMessage: true,
    message: { model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text }] },
  });
const turnDuration = () => JSON.stringify({ type: 'system', subtype: 'turn_duration', sessionId: SESSION, timestamp: at() });

const STOPPED = 'API Error: The response stopped arriving. The response above may be incomplete.';

function rows(...lines: string[]): Message[] {
  return parseTranscript(lines.join('\n') + '\n').map((m, i) => ({ ...m, id: i + 1, taskId: 7 }));
}

describe('the API error line (#338)', () => {
  const history = rows(prompt('Sort the inbox'), apiError(STOPPED), turnDuration());
  const error = history[1]!;

  it('is drawn as an error, tinted, with "API Error:" set apart', () => {
    const { container } = render(<MessageRow message={error} />);
    const box = container.querySelector('.tx-api-error') as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.getAttribute('role')).toBe('note');
    expect(box.querySelector('.tx-api-error-head')?.textContent).toBe('API Error:');
    expect(box.textContent).toContain('The response stopped arriving. The response above may be incomplete.');
    // Not drawn as Claude's prose.
    expect(container.querySelector('.tx-md')).toBeNull();
  });

  it('carries Try Again when it is the error the task stopped on, and it sends "try again"', () => {
    const retry = apiErrorRetryOf(history, 7, SESSION, 'idle');
    expect(retry).toEqual({ messageId: error.id, task: { id: 7, status: 'idle' } });
    render(
      <ApiErrorRetryContext.Provider value={retry}>
        <MessageRow message={error} />
      </ApiErrorRetryContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(sent).toEqual([[7, 'try again']]);
  });

  it('has no Try Again without a live session', () => {
    live.value = false;
    render(
      <ApiErrorRetryContext.Provider value={apiErrorRetryOf(history, 7, SESSION, 'idle')}>
        <MessageRow message={error} />
      </ApiErrorRetryContext.Provider>,
    );
    expect(screen.queryByRole('button', { name: 'Try Again' })).toBeNull();
  });

  it('an older error, which more work followed, is drawn the same, without the button', () => {
    const later = rows(prompt('Sort the inbox'), apiError(STOPPED), turnDuration(), prompt('try again'), reply('Sorted.'));
    expect(apiErrorRetryOf(later, 7, SESSION, 'idle')).toBeNull();
    render(
      <ApiErrorRetryContext.Provider value={apiErrorRetryOf(later, 7, SESSION, 'idle')}>
        <MessageRow message={later[1]!} />
      </ApiErrorRetryContext.Provider>,
    );
    expect(document.querySelector('.tx-api-error')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Try Again' })).toBeNull();
  });

  it('offers no retry while the task is not idle, or with no task', () => {
    for (const status of ['running', 'blocked', 'done', 'archived', null] as const) {
      expect(apiErrorRetryOf(history, 7, SESSION, status), String(status)).toBeNull();
    }
    expect(apiErrorRetryOf(history, null, SESSION, 'idle')).toBeNull();
  });

  it('reads the session’s own thread: a subagent’s error, or another session’s, is not it', () => {
    const sub = history.map((m) => ({ ...m, agentId: 'a1' }));
    expect(apiErrorRetryOf(sub, 7, SESSION, 'idle')).toBeNull();
    expect(apiErrorRetryOf(history, 7, 'another-session', 'idle')).toBeNull();
  });
});
