/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import type { Message } from '../../types';
import { isInjectedQueueText } from '../../capture/adapter';
import { MessageRow } from './MessageRow';

afterEach(cleanup);

const user = (body: string): Message => ({
  id: 1,
  taskId: 1,
  sessionId: 's',
  seq: 100,
  role: 'user',
  toolName: null,
  targetPath: null,
  body,
  rawJson: JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: body } }),
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
