/**
 * @vitest-environment jsdom
 *
 * The link between a task and what it spun out (#332): what a
 * `request_session` call in the asking task's transcript became, and the new
 * task's "from <source>" chip.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../db', () => ({ getTask: vi.fn(async () => null) }));

import { parseTranscript } from '../capture/adapter';
import type { Message, Task } from '../types';
import type { SessionRequest, SessionOutcome } from './requestQueue';
import { requestKey } from './requestQueue';
import { REQUEST_SESSION_TOOL, SpinOutContext, spinOutStatus, spunFromLink, type SpinOutLookup } from './spinOut';
import { ToolChip } from './transcript/ToolChip';
import SpunFromChip from './SpunFromChip';

const db = await import('../db');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const TITLE = 'Refund not applied';
const BRIEF = 'Booking was refunded on 3 Nov but never posted.\nChecked: two timeouts, no retry.';

type T = Pick<Task, 'id' | 'title' | 'status' | 'spunFromTaskId'>;
const triage: T = { id: 3, title: 'Ticket triage', status: 'idle', spunFromTaskId: null };

const pending = (over: Partial<SessionRequest> = {}): SessionRequest => ({
  id: 'r1',
  taskId: 3,
  at: 1,
  tool: 'request_session',
  title: TITLE,
  prompt: BRIEF,
  reason: 'A different fault.',
  project: null,
  branch: null,
  start: 'brief',
  ...over,
});

const outcome = (over: Partial<SessionOutcome> = {}): SessionOutcome => ({
  id: 'r1',
  taskId: 3,
  key: requestKey(TITLE, BRIEF),
  outcome: 'spun',
  spunTaskId: 9,
  spunTitle: TITLE,
  ...over,
});

/** As Claude wrote it: not trimmed, which the server does. */
const call = { title: `${TITLE} `, prompt: `${BRIEF}\n` };

describe('spinOutStatus', () => {
  it('pending while the request is in the task list', () => {
    expect(spinOutStatus(call, 3, [pending()], [], [triage])).toEqual({ kind: 'pending' });
  });

  it('only for the task that asked, and only for the same title and brief', () => {
    expect(spinOutStatus(call, 4, [pending()], [], [triage])).toBeNull();
    expect(spinOutStatus({ ...call, prompt: 'another brief' }, 3, [pending()], [], [triage])).toBeNull();
  });

  it('denied once Deny was pressed', () => {
    expect(spinOutStatus(call, 3, [], [outcome({ outcome: 'denied', spunTaskId: null, spunTitle: null })], [triage])).toEqual({
      kind: 'denied',
    });
  });

  it('spun out as the task, by its title now, linked while it is live', () => {
    const spun: T = { id: 9, title: 'Refund not posted', status: 'running', spunFromTaskId: 3 };
    expect(spinOutStatus(call, 3, [], [outcome()], [triage, spun])).toEqual({
      kind: 'spun',
      taskId: 9,
      title: 'Refund not posted',
      live: true,
    });
    // Archived, or gone from the list: named as it was, no link.
    expect(spinOutStatus(call, 3, [], [outcome()], [triage])).toEqual({ kind: 'spun', taskId: 9, title: TITLE, live: false });
    expect(spinOutStatus(call, 3, [], [outcome()], [triage, { ...spun, status: 'archived' }])).toMatchObject({ live: false });
  });

  it('the latest decision wins', () => {
    const later = outcome({ id: 'r2', outcome: 'denied', spunTaskId: null, spunTitle: null });
    expect(spinOutStatus(call, 3, [], [outcome(), later], [triage])).toEqual({ kind: 'denied' });
  });

  it('without a record, a task spun out of this one under that title answers', () => {
    const spun: T = { id: 12, title: TITLE, status: 'idle', spunFromTaskId: 3 };
    expect(spinOutStatus(call, 3, [], [], [triage, spun])).toEqual({ kind: 'spun', taskId: 12, title: TITLE, live: true });
    // Spun out of another task: not this request's.
    expect(spinOutStatus(call, 3, [], [], [triage, { ...spun, spunFromTaskId: 4 }])).toBeNull();
  });

  it('nothing for an unknown request, or input that is not text', () => {
    expect(spinOutStatus(call, 3, [], [], [triage])).toBeNull();
    expect(spinOutStatus({ title: 7, prompt: BRIEF }, 3, [pending()], [], [triage])).toBeNull();
  });
});

describe('spunFromLink', () => {
  it('names a live source as a link, an archived one without, and nothing when unknown', () => {
    expect(spunFromLink({ spunFromTaskId: null }, [triage])).toBeNull();
    expect(spunFromLink({ spunFromTaskId: 3 }, [triage])).toEqual({ taskId: 3, title: 'Ticket triage', live: true });
    expect(spunFromLink({ spunFromTaskId: 3 }, [{ ...triage, status: 'archived' }])).toMatchObject({ live: false });
    expect(spunFromLink({ spunFromTaskId: 77 }, [triage])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The tool chip
// ---------------------------------------------------------------------------

const line = JSON.stringify({
  type: 'assistant',
  uuid: 'u-1',
  parentUuid: null,
  sessionId: 'sess-triage',
  timestamp: '2026-11-10T10:00:00.000Z',
  isSidechain: false,
  message: {
    id: 'm-1',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'tool_use', id: 'tu-1', name: REQUEST_SESSION_TOOL, input: { title: TITLE, prompt: BRIEF, reason: 'r' } }],
  },
});
const toolRow: Message = { ...parseTranscript(line).find((r) => r.role === 'tool_use')!, id: 1, taskId: 3 };

function renderChip(lookup: SpinOutLookup | null) {
  return render(
    <SpinOutContext.Provider value={lookup}>
      <ToolChip message={toolRow} result={null} />
    </SpinOutContext.Provider>,
  );
}

describe('the request_session chip in the asking task\'s transcript', () => {
  it('reads as the proposed title, and says it waits in the task list, with no buttons', () => {
    const { container } = renderChip({ statusOf: () => ({ kind: 'pending' }), openTask: vi.fn() });
    const head = container.querySelector('.tx-chip-head')!;
    expect(head.querySelector('.tx-chip-summary')?.textContent).toBe(TITLE);
    expect(head.querySelector('.tx-spinout')?.textContent).toBe('Proposed · in the task list');
    expect([...head.querySelectorAll('button')].map((b) => b.textContent)).toEqual([REQUEST_SESSION_TOOL]);
  });

  it('"Spun out as" links to the task, which opens without toggling the chip', () => {
    const openTask = vi.fn();
    const { container } = renderChip({
      statusOf: (c) => (c.title === TITLE ? { kind: 'spun', taskId: 9, title: TITLE, live: true } : null),
      openTask,
    });
    expect(container.querySelector('.tx-spinout')?.textContent).toBe(`Spun out as ${TITLE}`);
    fireEvent.click(screen.getByRole('button', { name: TITLE }));
    expect(openTask).toHaveBeenCalledWith(9);
    expect(container.querySelector('.tx-chip-open')).toBeNull();
  });

  it('a spun-out task that is gone is named, not linked', () => {
    const { container } = renderChip({ statusOf: () => ({ kind: 'spun', taskId: 9, title: TITLE, live: false }), openTask: vi.fn() });
    expect(container.querySelector('.tx-spinout-gone')?.textContent).toBe(TITLE);
    expect(screen.queryByRole('button', { name: TITLE })).toBeNull();
  });

  it('"Not spun out" once denied; nothing when unknown or outside a task', () => {
    const { container, unmount } = renderChip({ statusOf: () => ({ kind: 'denied' }), openTask: vi.fn() });
    expect(container.querySelector('.tx-spinout')?.textContent).toBe('Not spun out');
    unmount();
    expect(renderChip({ statusOf: () => null, openTask: vi.fn() }).container.querySelector('.tx-spinout')).toBeNull();
    cleanup();
    expect(renderChip(null).container.querySelector('.tx-spinout')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// "from <source>" in the task bar
// ---------------------------------------------------------------------------

describe('SpunFromChip', () => {
  it('a live source is a link to it', () => {
    const onOpen = vi.fn();
    render(<SpunFromChip task={{ id: 9, spunFromTaskId: 3 }} tasks={[triage]} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'from Ticket triage' }));
    expect(onOpen).toHaveBeenCalledWith(3);
    expect(db.getTask).not.toHaveBeenCalled();
  });

  it('an archived source is read from the database and named without a link', async () => {
    vi.mocked(db.getTask).mockResolvedValueOnce({ ...triage, status: 'archived' } as Task);
    const { container } = render(<SpunFromChip task={{ id: 9, spunFromTaskId: 3 }} tasks={[]} onOpen={vi.fn()} />);
    await waitFor(() => expect(container.textContent).toBe('from Ticket triage'));
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelector('[data-gone="true"]')).not.toBeNull();
  });

  it('nothing for a task not spun out, or a source deleted since', async () => {
    const { container } = render(<SpunFromChip task={{ id: 9, spunFromTaskId: null }} tasks={[triage]} onOpen={vi.fn()} />);
    expect(container.textContent).toBe('');
    cleanup();
    const deleted = render(<SpunFromChip task={{ id: 9, spunFromTaskId: 77 }} tasks={[triage]} onOpen={vi.fn()} />);
    await waitFor(() => expect(db.getTask).toHaveBeenCalledWith(77));
    expect(deleted.container.textContent).toBe('');
  });
});
