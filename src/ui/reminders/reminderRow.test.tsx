/**
 * @vitest-environment jsdom
 *
 * A sent reminder in the transcript (#156): drawn as a reminder, with who set
 * it and when, never as a plain "You" message. And the attention it raises
 * when it comes back.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

import type { Message } from '../../types';
import { MessageRow } from '../transcript/MessageRow';
import { wrapReminder } from '../transcript/envelopes';
import { withBrief } from '../../reminders/brief';
import { __setAttentionBackend, attentionMarks, announcementFor, noteReminder, noteStatusChange } from '../attention';

afterEach(cleanup);

const user = (body: string): Message => ({
  id: 1, taskId: 1, sessionId: 's', seq: 100, role: 'user', toolName: null, targetPath: null, body,
  rawJson: JSON.stringify({ type: 'user', message: { role: 'user', content: body } }), agentId: null, ts: 0,
});

const SET = new Date(2026, 9, 29, 10, 0).getTime();

describe('a sent reminder in the transcript', () => {
  it('is a reminder with its own label, not "You"', () => {
    const { container, getByRole } = render(<MessageRow message={user(wrapReminder({ text: 'Check the deploy.', setAt: SET, by: 'user' }))} />);
    expect(container.querySelector('.tx-row-user')).toBeNull();
    expect(container.querySelector('.tx-gutter')?.textContent).toBe('');
    expect(getByRole('note', { name: 'Reminder' }).textContent).toContain('Check the deploy.');
    expect(container.querySelector('.tx-reminder-meta')?.textContent).toBe('· set Oct 29 by you');
    expect(container.textContent).not.toContain('albedo-action');
  });

  it('inside the paste wrapper too, with the brief folded', () => {
    const text = withBrief('Check the deploy.', { kind: 'last-answer', text: 'It is on main now.', transcriptPath: '/t.jsonl' });
    const body = `<pasted_content id="9f">\n${wrapReminder({ text, setAt: SET, by: 'session' })}\n</pasted_content id="9f">`;
    const { container, getByRole } = render(<MessageRow message={user(body)} />);
    expect(container.querySelector('.tx-reminder-meta')?.textContent).toBe('· set Oct 29 by Claude');
    expect(container.textContent).not.toContain('It is on main now.');
    fireEvent.click(getByRole('button', { name: /Brief Sent with It/ }));
    expect(container.textContent).toContain('It is on main now.');
  });
});

describe('noteReminder', () => {
  let bounces: boolean[];
  let posted: { title: string; body: string; taskId: number }[];
  beforeEach(() => {
    bounces = [];
    posted = [];
  });

  it('focused: the row mark only', () => {
    __setAttentionBackend((c) => bounces.push(c), true, (n) => posted.push(n));
    noteReminder(3, 'fix login', 'Check the deploy');
    expect(attentionMarks().get(3)).toBe('reminder');
    expect(bounces).toEqual([]);
    expect(posted).toEqual([]);
  });

  it('unfocused: one bounce and a banner quoting it', () => {
    __setAttentionBackend((c) => bounces.push(c), false, (n) => posted.push(n));
    noteReminder(3, 'fix login', 'Check\nthe deploy');
    expect(bounces).toEqual([false]);
    expect(posted).toEqual([{ title: 'fix login', body: 'Reminder: Check the deploy', taskId: 3 }]);
    expect(announcementFor(new Map(), attentionMarks(), () => 'fix login')).toBe('fix login: a reminder is back.');
  });

  it('never replaces a prompt waiting on you', () => {
    __setAttentionBackend(() => {}, true);
    noteStatusChange(3, 'running', 'blocked');
    noteReminder(3, 'fix login', 'x');
    expect(attentionMarks().get(3)).toBe('blocked');
  });
});
