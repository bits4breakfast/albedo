/**
 * @vitest-environment jsdom
 *
 * The message box's `@` list (#154), driven through the real Composer: what
 * opens it, what it lists, the keys it takes (and the ones it must leave to
 * the area cycle, #131), and what a pick sends.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';

import { hasLivePty, submitPty } from '../Terminal';
import { useFocusAreaCycle } from '../focusAreas';
import { MentionSourceContext } from '../mentionSource';
import type { Project } from '../../types';
import { Composer } from './TranscriptPane';
import { __resetDrafts, getDraft } from './drafts';
import { encodeMention, fileMention, taskMention } from './mentions';
import { task } from './mentions.fixture';

vi.mock('../Terminal', () => ({
  submitPty: vi.fn(async () => true),
  startPty: vi.fn(() => false),
  hasLivePty: vi.fn(() => true),
  ptyLiveSince: vi.fn(() => null),
  canResume: vi.fn(() => false),
  onPtyPresenceChange: vi.fn(() => () => {}),
}));
vi.mock('../../db/comments', () => ({ markCommentsSent: vi.fn(async () => {}) }));
vi.mock('../../git/codeIndex', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../git/codeIndex')>();
  const index = {
    root: '/code/app-wt/1',
    files: ['src/foo.ts', 'src/ui/App.tsx', 'README.md'],
    symbols: [],
    builtAt: 0,
    took: 0,
  };
  return { ...real, loadCodeIndex: vi.fn(async () => index), peekCodeIndex: vi.fn(() => null) };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  __resetDrafts();
});

const projects = [
  { id: 1, name: 'App' },
  { id: 2, name: 'Site' },
] as unknown as Project[];
const tasks = [
  task(1, 'This task'),
  task(2, 'Fix login retry', { status: 'running' }),
  task(3, 'Docs pass', { projectId: 2 }),
  task(4, 'Archived one', { status: 'archived' }),
];

function Source({ children }: { children: ReactNode }) {
  return <MentionSourceContext.Provider value={{ tasks, projects }}>{children}</MentionSourceContext.Provider>;
}

function renderBox(taskId = 1, extra: ReactNode = null) {
  const utils = render(
    <Source>
      <Composer taskId={taskId} onSent={vi.fn()} />
      {extra}
    </Source>,
  );
  return utils;
}

const box = () => screen.getByRole('textbox') as HTMLTextAreaElement;
const type = (value: string) => {
  box().focus();
  fireEvent.change(box(), { target: { value } });
};
const key = (k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(box(), { key: k, ...init });
const list = () => screen.queryByRole('listbox', { name: 'Mention a task or a file' });
const options = () => within(list()!).getAllByRole('option').map((o) => o.textContent);

describe('opening the list', () => {
  it('opens on @ at the start, listing the other open tasks, this project first', () => {
    renderBox();
    type('@');
    expect(list()).not.toBeNull();
    expect(screen.getByText('Tasks')).toBeTruthy();
    // Not this task, not the archived one; the status word as the task list says it.
    expect(options()).toEqual(['Fix login retryAppRunning', 'Docs passSiteIdle']);
    expect(box().getAttribute('aria-activedescendant')).toBe(within(list()!).getAllByRole('option')[0]?.id);
  });

  it('opens after whitespace, not inside a word', () => {
    renderBox();
    type('mail me@exa');
    expect(list()).toBeNull();
    type('ask @');
    expect(list()).not.toBeNull();
  });

  it('typing filters, fuzzily; files and folders come under their own heading', async () => {
    renderBox();
    type('ask @fixlog');
    expect(options()).toEqual(['Fix login retryAppRunning']);
    type('ask @foo');
    await waitFor(() => expect(options()).toContain('foo.tssrc'));
    expect(screen.getByText('Files')).toBeTruthy();
    type('ask @ui');
    await waitFor(() => expect(options().some((o) => o?.startsWith('ui/'))).toBe(true));
  });

  it('closes when nothing matches, so Return sends as usual', async () => {
    renderBox();
    type('ask @zzzz');
    await waitFor(() => expect(list()).toBeNull());
    key('Enter');
    await waitFor(() => expect(submitPty).toHaveBeenCalledWith(1, 'ask @zzzz'));
  });
});

describe('the keys', () => {
  it('↓ and Return insert the highlighted task as a token, without sending', () => {
    renderBox();
    type('ask @');
    key('ArrowDown');
    key('Enter');
    expect(box().value).toBe('ask @[Docs pass] ');
    expect(list()).toBeNull();
    expect(submitPty).not.toHaveBeenCalled();
  });

  it('picking in the middle of the text keeps what follows, and does not reopen on the token', () => {
    renderBox();
    type('ask @fi now');
    box().setSelectionRange(7, 7);
    fireEvent.select(box());
    expect(options()).toEqual(['Fix login retryAppRunning']);
    key('Enter');
    expect(box().value).toBe('ask @[Fix login retry] now');
    fireEvent.select(box());
    expect(list()).toBeNull();
  });

  it('↑ wraps to the last row', () => {
    renderBox();
    type('@');
    key('ArrowUp');
    expect(within(list()!).getAllByRole('option')[1]?.getAttribute('aria-selected')).toBe('true');
  });

  it('Tab inserts too, and is not taken by the area cycle; with the list closed Tab moves on as before', async () => {
    renderHook(() => useFocusAreaCycle());
    renderBox(
      1,
      <div data-focus-area="terminal">
        <button type="button">terminal</button>
      </div>,
    );
    type('read @foo');
    await waitFor(() => expect(options()).toContain('foo.tssrc'));
    const notPrevented = fireEvent.keyDown(box(), { key: 'Tab' });
    expect(notPrevented).toBe(false);
    expect(box().value).toBe('read @src/foo.ts ');
    expect(document.activeElement).toBe(box());

    // Closed now: Tab is the cycle's again.
    fireEvent.keyDown(box(), { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'terminal' }));
  });

  it('Esc closes this @ for good, stops there, and the text is sent as typed', async () => {
    renderBox();
    const outside = vi.fn();
    window.addEventListener('keydown', outside);
    type('ask @fix');
    key('Escape');
    window.removeEventListener('keydown', outside);
    expect(outside).not.toHaveBeenCalled();
    expect(list()).toBeNull();
    type('ask @fixl'); // the same @: stays closed
    expect(list()).toBeNull();
    key('Enter');
    await waitFor(() => expect(submitPty).toHaveBeenCalledWith(1, 'ask @fixl'));
  });

  it('a click on a row picks it and keeps the caret in the box', () => {
    renderBox();
    type('@');
    const row = within(list()!).getAllByRole('option')[0]!;
    expect(fireEvent.mouseDown(row)).toBe(false); // focus is not taken
    fireEvent.click(row);
    expect(box().value).toBe('@[Fix login retry] ');
  });
});

describe('what is sent', () => {
  it('a picked task goes as its <task-ref>, a picked file as its <file-ref>; typed text as typed', async () => {
    vi.mocked(hasLivePty).mockReturnValue(true);
    renderBox();
    type('ask @fix');
    key('Enter');
    type(`${box().value}about @foo`);
    await waitFor(() => expect(options()).toContain('foo.tssrc'));
    key('Enter');
    type(`${box().value}and @src/ui/App.tsx`);
    act(() => void key('Escape'));
    key('Enter');
    const expected =
      `ask ${encodeMention(taskMention(tasks[1]!))} about ${encodeMention(fileMention('src/foo.ts'))} and @src/ui/App.tsx`;
    await waitFor(() => expect(submitPty).toHaveBeenCalledWith(1, expected));
  });

  it('an edited token is plain text again', async () => {
    renderBox();
    type('ask @');
    key('Enter');
    type('ask @[Fix login retr] now');
    key('Enter');
    await waitFor(() => expect(submitPty).toHaveBeenCalledWith(1, 'ask @[Fix login retr] now'));
  });

  it('a draft keeps its references across a task switch', async () => {
    const { rerender } = renderBox();
    type('ask @');
    key('Enter');
    expect(getDraft(1)?.mentions?.map(([t]) => t)).toEqual(['@[Fix login retry]']);
    rerender(
      <Source>
        <Composer taskId={3} onSent={vi.fn()} />
      </Source>,
    );
    expect(box().value).toBe('');
    rerender(
      <Source>
        <Composer taskId={1} onSent={vi.fn()} />
      </Source>,
    );
    expect(box().value).toBe('ask @[Fix login retry] ');
    key('Enter');
    await waitFor(() => expect(submitPty).toHaveBeenCalledWith(1, `ask ${encodeMention(taskMention(tasks[1]!))} `));
  });
});
