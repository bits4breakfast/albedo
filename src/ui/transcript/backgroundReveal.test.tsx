/**
 * @vitest-environment jsdom
 *
 * Where a Background line takes you (#122): the row of the call that started
 * the work, found by `data-message-id`, paging back until it is held. And the
 * end delivered into a running turn, kept as a row, draws nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { parseLine } from '../../capture/adapter';
import { backgroundShell, noticeAttachmentLine, notification } from '../../capture/backgroundFixtures';
import type { Message } from '../../types';
import { MessageRow } from './MessageRow';
import { revealStep } from './TranscriptPane';

afterEach(cleanup);

const T = Date.parse('2026-10-28T10:00:00.000Z');

function row(line: Record<string, unknown>, id: number): Message {
  const [m] = parseLine(JSON.stringify(line), id);
  return { ...m!, id, taskId: 1 };
}

describe('revealing a row', () => {
  it('scrolls once the row is drawn, pages back while it is not held, and otherwise gives up', () => {
    expect(revealStep(true, true, true)).toBe('scroll');
    expect(revealStep(false, false, true)).toBe('grow');
    // Older than the whole transcript: nothing to load.
    expect(revealStep(false, false, false)).toBe('give-up');
    // Held but not drawn on its own, as inside a subagent's group.
    expect(revealStep(false, true, true)).toBe('give-up');
  });

  it('marks a tool call row with its id, which is what the band scrolls to', () => {
    const [call, result] = backgroundShell('t1', 'b1', T);
    const { container } = render(<MessageRow message={row(call!, 7)} result={row(result!, 8)} />);
    expect(container.querySelector('[data-message-id="7"]')?.classList.contains('tx-row-tool')).toBe(true);
  });

  it('draws nothing for a notification delivered into a running turn', () => {
    const notice = row(noticeAttachmentLine(notification({ taskIds: ['b1'], toolUseId: 't1', status: 'completed' }), T), 9);
    expect(notice.role).toBe('system');
    const { container } = render(<MessageRow message={notice} />);
    expect(container.innerHTML).toBe('');
  });
});
