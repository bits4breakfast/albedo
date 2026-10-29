/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { Message } from '../../types';
import { isInjectedQueueText } from '../../capture/adapter';
import { TaskOpenContext } from '../openTask';
import { MessageRow } from './MessageRow';

const senders = vi.hoisted(() => new Map<string, number>());
vi.mock('../../capture/peers', () => ({ senderTaskOf: async (id: string) => senders.get(id) ?? null }));

afterEach(cleanup);

const user = (body: string, origin: unknown = null): Message => ({
  id: 1,
  taskId: 1,
  sessionId: 's',
  seq: 100,
  role: 'user',
  toolName: null,
  targetPath: null,
  body,
  rawJson: JSON.stringify({ type: 'user', isMeta: true, origin, message: { role: 'user', content: body } }),
  agentId: null,
  ts: 0,
});

const peer = (inner: string, name = 'Fix login') =>
  'Another Claude session sent a message:\n' +
  `<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="${name}" from-mode="prompting">\n${inner}\n</cross-session-message>\n\n` +
  'This came from another Claude session — not typed by your user, but very likely working on their behalf.';

describe('a message from another session', () => {
  it("reads under the sender's name, not as yours, without the framing", () => {
    const { container } = render(<MessageRow message={user(peer('Please rebase onto main.'))} />);
    expect(container.querySelector('.tx-row-user')).toBeNull();
    expect(container.querySelector('.tx-gutter')?.textContent).toBe('');
    expect(container.querySelector('.tx-peer-head')?.textContent).toBe('From Fix login');
    expect(container.textContent).toContain('Please rebase onto main.');
    expect(container.textContent).not.toContain('cross-session-message');
    expect(container.textContent).not.toContain('not typed by your user');
  });

  it('shows a peer message in the older envelope, which was drawn as nothing', () => {
    const body =
      'Another Claude session sent a message:\n<agent-message from="a1">\nShall I take the tests?\n</agent-message>\n\n' +
      'This came from another Claude session.';
    const { container } = render(<MessageRow message={user(body)} />);
    expect(container.querySelector('.tx-peer-head')?.textContent).toBe('From another session');
    expect(container.textContent).toContain('Shall I take the tests?');
  });

  it("keeps a subagent's hand-back out of the row, as before", () => {
    const body =
      'Another Claude session sent a message:\n<agent-message from="a1">\n' +
      '[Subagent hand-back] The text below is the final report. The report follows:\n  ## Done\n</agent-message>';
    const { container } = render(<MessageRow message={user(body)} />);
    expect(container.querySelector('.tx-peer')).toBeNull();
    expect(container.textContent).not.toContain('## Done');
  });
});

describe('the queue', () => {
  it('counts a queued cross-session message as put there by Claude Code, not typed', () => {
    expect(isInjectedQueueText('<cross-session-message from="uds:/x" from-name="a">\nhi\n</cross-session-message>')).toBe(true);
    expect(isInjectedQueueText('please read <cross-session-message> docs')).toBe(false);
  });
});

describe("the sender's name", () => {
  const origin = { kind: 'peer', name: 'Fix login', msg_id: 'm1' };

  it('opens the task that sent it', async () => {
    senders.set('m1', 27);
    const open = vi.fn();
    render(
      <TaskOpenContext.Provider value={{ has: (id) => id === 27, open }}>
        <MessageRow message={user(peer('Please rebase.'), origin)} />
      </TaskOpenContext.Provider>,
    );
    const link = await waitFor(() => screen.getByRole('button', { name: 'Fix login' }));
    expect(link.getAttribute('title')).toBe('Go to Fix login');
    fireEvent.click(link);
    expect(open).toHaveBeenCalledWith(27);
  });

  it('stays plain text when the sender is not a task Albedo has open', async () => {
    senders.set('m1', 27);
    const { container } = render(
      <TaskOpenContext.Provider value={{ has: () => false, open: vi.fn() }}>
        <MessageRow message={user(peer('Please rebase.'), origin)} />
      </TaskOpenContext.Provider>,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelector('.tx-peer-name')?.textContent).toBe('Fix login');
  });
});
