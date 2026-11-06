/**
 * @vitest-environment jsdom
 *
 * #272: a plan in the "waiting on you" card. The question as markdown, cut to
 * three lines; the plan file it names, as a document; the options in a row;
 * comments collected on the plan and sent once, on a click; Claude Code's own
 * plan mode.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { answerPrompt, derivePending, pendingPrompt, type AnswerResult, type HookEvent, type PendingPrompt } from '../../capture/hookEvents';
import { FileOpenContext } from '../editor/openFile';
import { PromptCard, waitedText } from './PromptCard';
import { __resetPlanComments, addPlanComment, planCommentKey, planCommentsOf } from './planComments';
import { invoke } from '@tauri-apps/api/core';

vi.mock('../../capture/hookEvents', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../capture/hookEvents')>();
  return {
    ...real,
    pendingPrompt: vi.fn(() => null),
    onPromptChange: vi.fn(() => () => {}),
    answerPrompt: vi.fn(async (): Promise<AnswerResult> => 'taken'),
  };
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const answer = vi.mocked(answerPrompt);
const current = vi.mocked(pendingPrompt);
const ipc = vi.mocked(invoke);

const REQ = '7-1700000000000';
const KEY = planCommentKey(3, REQ);
const PATH = '/private/tmp/x/scratchpad/plan-ABC-1234.md';
const PLAN = [
  '# Plan: tags in setup_info',
  '',
  '## Behaviour',
  '',
  '- Staff callers get `tags`.',
  '- Non-staff callers: the key is absent.',
  '',
  '## Changes',
  '',
  '- `SetupInfoTool`: new `dumpTags()`, one line in the staff block.',
].join('\n');

function installStorage(): void {
  const data = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
}

beforeEach(() => {
  installStorage();
  __resetPlanComments();
  ipc.mockImplementation(async (cmd: string) => {
    if (cmd === 'read_plan_file') return { path: PATH, text: PLAN, size: PLAN.length, truncated: false } as never;
    throw new Error(`unexpected ${cmd}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  __resetPlanComments();
});

const NOW = Date.now();

const event = (toolName: string, toolInput: Record<string, unknown>, requestId: string | null = REQ): HookEvent => ({
  event: 'PermissionRequest',
  toolName,
  toolUseId: null,
  toolInput,
  message: null,
  notificationType: null,
  requestId,
  suggestions: null,
  sessionId: null,
  source: null,
  at: NOW,
});

const QUESTION = `Staff callers of \`setup_info\` get a \`tags\` list. Full plan: ${PATH}. Proceed?`;
const OPTIONS = [
  { label: 'Approve (Recommended)', description: 'Implement, then run /review' },
  { label: 'Revise', description: 'Give feedback and re-plan' },
];

function ask(question = QUESTION, options: unknown[] = OPTIONS, requestId: string | null = REQ): PendingPrompt {
  const p = derivePending([event('AskUserQuestion', { questions: [{ question, header: 'Plan', multiSelect: false, options }] }, requestId)]);
  if (p === null) throw new Error('fixture');
  return p;
}

function show(p: PendingPrompt, open = vi.fn()) {
  current.mockReturnValue(p);
  render(
    <FileOpenContext.Provider value={open}>
      <PromptCard taskId={3} onAnswerInTerminal={() => {}} />
    </FileOpenContext.Provider>,
  );
  return open;
}

const typedAnswer = (call = 0) =>
  (answer.mock.calls[call]?.[2]?.hookSpecificOutput.decision as { updatedInput?: { answers: Record<string, string> } })?.updatedInput
    ?.answers;

/** Select `text` inside the plan document, as a drag would. */
function select(text: string): void {
  const md = document.querySelector('.pc-doc-md')!;
  const walker = document.createTreeWalker(md, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const at = (n as Text).data.indexOf(text);
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(n, at);
    range.setEnd(n, at + text.length);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    return;
  }
  throw new Error(`not in the document: ${text}`);
}

const commentKey = () =>
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM', key: 'µ', metaKey: true, altKey: true, bubbles: true }));
  });

describe('the head', () => {
  it('names the one question’s header, and how long it has waited', () => {
    show(ask());
    const head = document.querySelector('.tx-prompt-head')!;
    expect(head.textContent).toMatch(/Waiting on You· Plan\d+s/);
    // The header is in the head, not again over the question.
    expect(document.querySelector('.tx-prompt-sub')).toBeNull();
  });

  it('reads in seconds, then minutes, then hours', () => {
    expect(waitedText(48_000)).toBe('48s');
    expect(waitedText(3 * 60_000 + 5_000)).toBe('3m');
    expect(waitedText(60 * 60_000)).toBe('1h');
    expect(waitedText(65 * 60_000)).toBe('1h 5m');
  });
});

describe('the question', () => {
  it('is markdown (its weight: planCardContrast.test.ts)', () => {
    show(ask());
    const q = document.querySelector('.pc-q')!;
    expect(q.querySelector('code.tx-md-code')?.textContent).toBe('setup_info');
    expect(q.querySelector('strong')).toBeNull();
  });

  it('is cut to three lines, with Show All and Show Less when longer', () => {
    const sh = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('pc-q-clamp') ? 200 : 60;
    });
    const ch = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(60);
    try {
      show(ask());
      const text = () => document.querySelector('.pc-q-text')!;
      expect(text().classList.contains('pc-q-clamp')).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'Show All' }));
      expect(text().classList.contains('pc-q-clamp')).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: 'Show Less' }));
      expect(text().classList.contains('pc-q-clamp')).toBe(true);
    } finally {
      sh.mockRestore();
      ch.mockRestore();
    }
  });

  it('a short one has no Show All', () => {
    show(ask('Proceed?', OPTIONS));
    expect(screen.queryByRole('button', { name: 'Show All' })).toBeNull();
  });
});

describe('the plan document', () => {
  it('shows the file the question names, read once, with its name, folder and Open', async () => {
    show(ask());
    await screen.findByText('plan-ABC-1234.md');
    expect(screen.getByText('/private/tmp/x/scratchpad/')).toBeTruthy();
    expect(document.querySelector('.pc-doc .tx-md-h1')?.textContent).toBe('Plan: tags in setup_info');
    expect(ipc).toHaveBeenCalledTimes(1);
    expect(ipc).toHaveBeenCalledWith('read_plan_file', { path: PATH });
  });

  it('a missing file: no document, the path stays in the question', async () => {
    ipc.mockRejectedValue({ kind: 'missing', path: PATH, message: 'does not exist' });
    show(ask());
    await waitFor(() => expect(ipc).toHaveBeenCalled());
    await act(async () => {});
    expect(document.querySelector('.pc-doc')).toBeNull();
    expect(document.querySelector('.pc-q')?.textContent).toContain(PATH);
  });

  it('no .md path: nothing is read', () => {
    show(ask('Proceed with docs/plan.md and /tmp/notes.txt?'));
    expect(ipc).not.toHaveBeenCalled();
  });

  it('says so when the file was longer than what was read', async () => {
    ipc.mockResolvedValue({ path: PATH, text: PLAN, size: 900_000, truncated: true } as never);
    show(ask());
    await screen.findByText(/Showing the first 256 KB of 879 KB/);
  });

  it('Open opens the file in the editor, read-only, as a click', async () => {
    const open = show(ask());
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    expect(open).toHaveBeenCalledWith({ path: PATH, line: null }, { activated: true, readOnly: true });
  });
});

describe('the options', () => {
  it('sit in one row with Other, and only "(Recommended)" is drawn as the suggestion', () => {
    show(ask());
    const row = screen.getByRole('group', { name: /Answers to/ });
    const approve = within(row).getByRole('button', { name: /Approve \(Recommended\)/ });
    const revise = within(row).getByRole('button', { name: /Revise/ });
    expect(approve.classList.contains('pc-option-suggested')).toBe(true);
    expect(revise.classList.contains('pc-option-suggested')).toBe(false);
    expect(within(row).getByRole('textbox')).toBeTruthy();
    expect(row.closest('.pc-foot')).not.toBeNull();
  });

  it('no "(Recommended)": none is', () => {
    show(ask(QUESTION, [{ label: 'Approve' }, { label: 'Revise' }]));
    expect(document.querySelector('.pc-option-suggested')).toBeNull();
  });
});

describe('comments on the plan', () => {
  it('select, ⌥⌘M, type, Add Comment: kept on the card, marked in the tray, nothing sent', async () => {
    show(ask());
    await screen.findByText('plan-ABC-1234.md');
    select('the key is absent.');
    commentKey();
    const box = screen.getByRole('textbox', { name: 'Comment on the selected passage' });
    fireEvent.change(box, { target: { value: 'Send an empty list instead.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Comment' }));
    expect(planCommentsOf(KEY)).toMatchObject([{ quote: 'the key is absent.', comment: 'Send an empty list instead.' }]);
    expect(screen.getByText('Comments · 1, not sent yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Send 1 Comment/ })).toBeTruthy();
    expect(answer).not.toHaveBeenCalled();
  });

  it('a selection in the document offers Comment, which opens the box', async () => {
    show(ask());
    await screen.findByText('plan-ABC-1234.md');
    select('the key is absent.');
    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    const button = await screen.findByRole('button', { name: /^Comment/ });
    expect(button.getAttribute('title')).toBe('Comment on this passage (⌥⌘M)');
    fireEvent.click(button);
    expect(screen.getByRole('textbox', { name: 'Comment on the selected passage' })).toBeTruthy();
    expect(document.querySelector('.pc-cbox-quote')?.textContent).toBe('the key is absent.');
  });

  it('a selection outside the document offers nothing', async () => {
    show(ask());
    await screen.findByText('plan-ABC-1234.md');
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('.pc-q')!);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('button', { name: /^Comment/ })).toBeNull();
    commentKey();
    expect(screen.queryByRole('textbox', { name: 'Comment on the selected passage' })).toBeNull();
  });

  it('⌥⌘M with nothing selected in the document does nothing', async () => {
    show(ask());
    await screen.findByText('plan-ABC-1234.md');
    commentKey();
    expect(screen.queryByRole('textbox', { name: 'Comment on the selected passage' })).toBeNull();
  });

  it('Esc and Cancel drop the box, keeping nothing', async () => {
    show(ask());
    await screen.findByText('plan-ABC-1234.md');
    select('the key is absent.');
    commentKey();
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment on the selected passage' }), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox', { name: 'Comment on the selected passage' })).toBeNull();
    expect(planCommentsOf(KEY)).toEqual([]);
  });

  it('Edit and ✕ in the tray', async () => {
    addPlanComment(KEY, { quote: 'the key is absent.', offset: 60, comment: 'first' });
    show(ask());
    await screen.findByText('Comments · 1, not sent yet');
    fireEvent.click(screen.getByRole('button', { name: 'Edit comment 1' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit comment 1' }), { target: { value: 'changed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(planCommentsOf(KEY)[0]?.comment).toBe('changed');
    fireEvent.click(screen.getByRole('button', { name: 'Remove comment 1' }));
    expect(planCommentsOf(KEY)).toEqual([]);
    expect(screen.queryByRole('button', { name: /Send \d Comment/ })).toBeNull();
  });

  it('Send N Comments answers once, as Revise with every comment, in the plan’s order', async () => {
    addPlanComment(KEY, { quote: 'new dumpTags()', offset: 90, comment: 'Reuse the serializer.' }, 1);
    addPlanComment(KEY, { quote: 'Non-staff callers: the key is absent.', offset: 40, comment: 'Empty list?\nClients check.' }, 2);
    show(ask());
    const send = await screen.findByRole('button', { name: /Send 2 Comments/ });
    // First in the row.
    expect(send.parentElement?.firstElementChild).toBe(send);
    expect(send.textContent).toContain('Answers “Revise” with your comments');
    fireEvent.click(send);
    fireEvent.click(send);
    expect(answer).toHaveBeenCalledTimes(1);
    expect(typedAnswer()).toEqual({
      [QUESTION]: [
        'Revise. Comments on the plan (plan-ABC-1234.md):',
        '',
        '1. On "Non-staff callers: the key is absent.":',
        '   Empty list?',
        '   Clients check.',
        '',
        '2. On "new dumpTags()":',
        '   Reuse the serializer.',
      ].join('\n'),
    });
  });

  it('Approve sends just its label, and the comments stay until the prompt is gone', async () => {
    addPlanComment(KEY, { quote: 'new dumpTags()', offset: 90, comment: 'c' });
    show(ask());
    await screen.findByRole('button', { name: /Send 1 Comment/ });
    fireEvent.click(screen.getByRole('button', { name: /Approve \(Recommended\)/ }));
    expect(typedAnswer()).toEqual({ [QUESTION]: 'Approve (Recommended)' });
    await screen.findByText('Answered.');
    expect(planCommentsOf(KEY)).toHaveLength(1);
  });

  it('no hook waiting: the document, without comments or Send', async () => {
    addPlanComment(KEY, { quote: 'new dumpTags()', offset: 90, comment: 'c' });
    show(ask(QUESTION, OPTIONS, null));
    await screen.findByText('plan-ABC-1234.md');
    select('the key is absent.');
    commentKey();
    expect(screen.queryByRole('textbox', { name: 'Comment on the selected passage' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Send/ })).toBeNull();
    expect(screen.queryByText(/not sent yet/)).toBeNull();
  });
});

describe('Claude Code’s own plan mode (ExitPlanMode)', () => {
  const plan = (requestId: string | null = REQ) => derivePending([event('ExitPlanMode', { plan: PLAN }, requestId)])!;
  const decision = () => answer.mock.calls[0]?.[2]?.hookSpecificOutput.decision;

  it('shows the plan as the document, with Approve and Keep Planning', () => {
    show(plan());
    expect(document.querySelector('.pc-doc .tx-md-h1')?.textContent).toBe('Plan: tags in setup_info');
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
    expect(decision()).toEqual({ behavior: 'allow' });
  });

  it('Keep Planning alone stops Claude', () => {
    show(plan());
    fireEvent.click(screen.getByRole('button', { name: /Keep Planning/ }));
    expect(decision()).toMatchObject({ behavior: 'deny', interrupt: true });
  });

  it('with comments, Send denies with them as the message and lets Claude go on planning', () => {
    addPlanComment(KEY, { quote: 'new dumpTags()', offset: 90, comment: 'Reuse the serializer.' });
    show(plan());
    const send = screen.getByRole('button', { name: /Send 1 Comment/ });
    expect(send.textContent).toContain('Answers “Keep Planning” with your comments');
    fireEvent.click(send);
    expect(answer).toHaveBeenCalledTimes(1);
    expect(decision()).toEqual({
      behavior: 'deny',
      message: 'Keep Planning. Comments on the plan:\n\n1. On "new dumpTags()":\n   Reuse the serializer.',
      interrupt: false,
    });
  });

  it('can be commented on like a plan file', () => {
    show(plan());
    select('one line in the staff block');
    commentKey();
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment on the selected passage' }), { target: { value: 'Which test?' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Comment on the selected passage' }), { key: 'Enter', metaKey: true });
    expect(planCommentsOf(KEY)).toMatchObject([{ quote: 'one line in the staff block', comment: 'Which test?' }]);
  });

  it('no hook waiting: the plan, no buttons', () => {
    show(plan(null));
    expect(document.querySelector('.pc-doc')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
  });
});
