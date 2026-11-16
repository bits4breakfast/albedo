// @vitest-environment jsdom
/**
 * Suggest Change (#411): the toggle in the comment box puts the commented
 * lines in as code to edit, in the Diff mode (and the guide, which draws the
 * same box) and in the File mode; the body stored carries the suggestion as
 * a fenced block; the card shows it as a small diff; Edit reopens both; the
 * lists show the words, never the fence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { ReviewComment } from '../../db/comments';
import { joinSuggestion } from '../../lib/suggestion';

const db = vi.hoisted(() => ({ rows: [] as ReviewComment[] }));
const addComment = vi.hoisted(() => vi.fn(async (_c: unknown) => 1));
const editComment = vi.hoisted(() => vi.fn(async (_t: number, _id: number, _body: string) => {}));
vi.mock('../../db/comments', async () => {
  const actual = await vi.importActual<typeof import('../../db/comments')>('../../db/comments');
  return {
    ...actual,
    listComments: vi.fn(async () => db.rows),
    onCommentsChanged: vi.fn(() => () => {}),
    addComment,
    editComment,
    resolveComment: vi.fn(async () => {}),
    resolveComments: vi.fn(async () => {}),
    deleteComment: vi.fn(async () => {}),
  };
});

const { CommentCardView, CommentDraftView } = await import('./CommentViews');
const { commentsExtension, setDraft, setPlacedComments } = await import('./comments');
const { useDiffComments } = await import('./diffComments');
const { WaitingComments } = await import('../transcript/WaitingComments');
const { toSendOf } = await import('../transcript/toSend');

beforeEach(() => {
  const data = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
});
afterEach(() => {
  cleanup();
  db.rows = [];
  addComment.mockClear();
  editComment.mockClear();
});

const FILE = 'function total(range) {\n  let sum = 0;\n  for (const d of range) sum += d;\n  return sum;\n}\n';
const base: ReviewComment = {
  id: 1, taskId: 1, path: 'src/total.ts', lineStart: 2, lineEnd: 4,
  anchorText: '  let sum = 0;\n  for (const d of range) sum += d;\n  return sum;',
  body: 'Plain.', createdAt: 0, updatedAt: 0, sentAt: null, resolvedAt: null, github: null, replyTo: null,
};
const noop = () => {};

function openDiffBox() {
  const { result } = renderHook(() => useDiffComments(1, 'src/total.ts', FILE, false));
  act(() => result.current.annotations!.pick(2, 4, true));
  render(<>{result.current.annotations!.after(4)}</>);
  return screen.getByPlaceholderText(/Leave a comment/) as HTMLTextAreaElement;
}

describe('the box in Diff mode (and the guide)', () => {
  it('Suggest Change puts the commented lines in as code, focused, and saves them as a suggestion with the text', async () => {
    const area = openDiffBox();
    expect(screen.queryByRole('textbox', { name: 'Suggested code' })).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Suggest Change' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    const code = screen.getByRole('textbox', { name: 'Suggested code' }) as HTMLTextAreaElement;
    expect(code.value).toBe(base.anchorText);
    expect(document.activeElement).toBe(code);
    expect(screen.getByText('no change')).toBeTruthy();
    fireEvent.change(code, { target: { value: '  return range.reduce((a, b) => a + b, 0);' } });
    expect(screen.getByText('replaces 3 lines with 1')).toBeTruthy();
    fireEvent.change(area, { target: { value: ' One pass. ' } });
    fireEvent.keyDown(code, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(addComment).toHaveBeenCalledOnce());
    expect(addComment).toHaveBeenCalledWith({
      taskId: 1,
      path: 'src/total.ts',
      lineStart: 2,
      lineEnd: 4,
      anchorText: base.anchorText,
      body: '```suggestion\n  return range.reduce((a, b) => a + b, 0);\n```\nOne pass.',
    });
  });

  it('turning it off drops the suggestion and keeps the text', async () => {
    const area = openDiffBox();
    fireEvent.change(area, { target: { value: 'Keep me.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Suggest Change' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Suggested code' }), { target: { value: 'gone' } });
    fireEvent.click(screen.getByRole('button', { name: 'Suggest Change' }));
    expect(screen.queryByRole('textbox', { name: 'Suggested code' })).toBeNull();
    expect(area.value).toBe('Keep me.');
    fireEvent.keyDown(area, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(addComment).toHaveBeenCalledOnce());
    expect((addComment.mock.calls[0]![0] as { body: string }).body).toBe('Keep me.');
  });

  it('a suggestion needs no words, and an empty one deletes the lines', async () => {
    openDiffBox();
    fireEvent.click(screen.getByRole('button', { name: 'Suggest Change' }));
    const code = screen.getByRole('textbox', { name: 'Suggested code' });
    fireEvent.change(code, { target: { value: '' } });
    expect(screen.getByText('replaces 3 lines with nothing')).toBeTruthy();
    fireEvent.keyDown(code, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(addComment).toHaveBeenCalledOnce());
    expect((addComment.mock.calls[0]![0] as { body: string }).body).toBe('```suggestion\n```');
  });

  it('code left as the lines themselves is no suggestion: saved as the words alone', async () => {
    const area = openDiffBox();
    fireEvent.click(screen.getByRole('button', { name: 'Suggest Change' }));
    expect(screen.getByText('no change')).toBeTruthy();
    fireEvent.change(area, { target: { value: 'Just a note.' } });
    fireEvent.keyDown(area, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(addComment).toHaveBeenCalledOnce());
    expect((addComment.mock.calls[0]![0] as { body: string }).body).toBe('Just a note.');
  });

  it('a single blank line left untouched is no change, not a deletion', async () => {
    const onSave = vi.fn();
    render(<CommentDraftView from={3} to={3} initial="" editing={false} onSave={onSave} onCancel={noop} lines={['']} />);
    fireEvent.click(screen.getByRole('button', { name: 'Suggest Change' }));
    expect(screen.getByText('no change')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/Leave a comment/), { target: { value: 'Why blank?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(onSave).toHaveBeenCalledWith('Why blank?', null);
  });

  it('a CRLF file: the box gets its lines without the \\r', () => {
    const { result } = renderHook(() => useDiffComments(1, 'src/total.ts', FILE.replace(/\n/g, '\r\n'), false));
    act(() => result.current.annotations!.pick(2, 4, true));
    render(<>{result.current.annotations!.after(4)}</>);
    fireEvent.click(screen.getByRole('button', { name: 'Suggest Change' }));
    const code = screen.getByRole('textbox', { name: 'Suggested code' }) as HTMLTextAreaElement;
    expect(code.value).toBe(base.anchorText);
    expect(screen.getByText('no change')).toBeTruthy();
  });

  it('Tab types through the browser, so ⌘Z undoes it', () => {
    const exec = vi.fn(() => false);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec });
    try {
      render(<CommentDraftView from={2} to={4} initial="" editing={false} onSave={noop} onCancel={noop} lines={base.anchorText.split('\n')} />);
      fireEvent.click(screen.getByRole('button', { name: 'Suggest Change' }));
      const code = screen.getByRole('textbox', { name: 'Suggested code' }) as HTMLTextAreaElement;
      code.setSelectionRange(0, 0);
      fireEvent.keyDown(code, { key: 'Tab' });
      expect(exec).toHaveBeenCalledWith('insertText', false, '  ');
      expect(code.value.startsWith('    let sum')).toBe(true); // refused here: set directly instead
    } finally {
      delete (document as { execCommand?: unknown }).execCommand;
    }
  });

  it('Tab indents in the code as its lines do, and stays in the box; Esc cancels', () => {
    const onCancel = vi.fn();
    render(<CommentDraftView from={2} to={4} initial="" editing={false} onSave={noop} onCancel={onCancel} lines={base.anchorText.split('\n')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Suggest Change' }));
    const code = screen.getByRole('textbox', { name: 'Suggested code' }) as HTMLTextAreaElement;
    code.setSelectionRange(0, 0);
    const tab = fireEvent.keyDown(code, { key: 'Tab' });
    expect(tab).toBe(false); // default prevented: focus does not move
    expect(code.value.startsWith('    let sum')).toBe(true);
    fireEvent.keyDown(code, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('Edit reopens both: the suggestion in the code box, the words in the comment box', () => {
    const onSave = vi.fn();
    const body = joinSuggestion(['  return sum(range);'], 'Use the helper.');
    render(<CommentDraftView from={2} to={4} initial={body} editing onSave={onSave} onCancel={noop} lines={base.anchorText.split('\n')} />);
    expect(screen.getByRole('button', { name: 'Suggest Change' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByRole('textbox', { name: 'Suggested code' }) as HTMLTextAreaElement).value).toBe('  return sum(range);');
    const area = screen.getByPlaceholderText(/Leave a comment/) as HTMLTextAreaElement;
    expect(area.value).toBe('Use the helper.');
    expect(document.activeElement).toBe(area);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith(body, null);
  });

  it('with no lines to replace, there is no Suggest Change', () => {
    render(<CommentDraftView from={2} to={4} initial="" editing={false} onSave={noop} onCancel={noop} />);
    expect(screen.queryByRole('button', { name: 'Suggest Change' })).toBeNull();
  });
});

describe('the card', () => {
  it('shows the suggestion as a diff of the commented lines against it, then the words, never the fence', () => {
    const c = { ...base, body: joinSuggestion(['  return sum(range);'], 'Use the helper.') };
    render(<CommentCardView comment={c} onEdit={noop} onResolve={noop} onDelete={noop} />);
    const diff = screen.getByRole('group', { name: 'Suggested change: replaces 3 lines with 1' });
    const rows = [...diff.querySelectorAll('.ed-cmt-sug-line')].map((r) => [r.getAttribute('data-kind'), r.textContent]);
    expect(rows).toEqual([
      ['del', '  let sum = 0;'],
      ['del', '  for (const d of range) sum += d;'],
      ['del', '  return sum;'],
      ['add', '  return sum(range);'],
    ]);
    expect(screen.getByText('Use the helper.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('```');
  });

  it('a plain comment is drawn as before', () => {
    render(<CommentCardView comment={base} onEdit={noop} onResolve={noop} onDelete={noop} />);
    expect(screen.queryByRole('group', { name: /Suggested change/ })).toBeNull();
    expect(screen.getByText('Plain.')).toBeTruthy();
  });

  it('in the bar, one whose lines are gone says its suggestion is against older lines', async () => {
    db.rows = [{ ...base, body: joinSuggestion(['x'], 'Shorter.') }];
    function Bar() {
      return <>{useDiffComments(1, 'src/total.ts', 'something else\n', false).bar}</>;
    }
    render(<Bar />);
    const item = await screen.findByText(/Lines 2–4: Shorter\. · suggested change to older lines/);
    expect(item.closest('[title]')?.getAttribute('title')).not.toContain('```');
  });

  it('a resolved trace\'s tooltip has the words, never the fence', async () => {
    db.rows = [{ ...base, sentAt: 5, body: joinSuggestion(['x'], 'Shorter.') }];
    function Bar() {
      return <>{useDiffComments(1, 'src/total.ts', 'something else\n', false).bar}</>;
    }
    render(<Bar />);
    const trace = (await screen.findByText(/Resolved:/)).closest('.ed-cmt-trace')!;
    expect(trace.getAttribute('title')).toBe('Suggested change\n\nShorter.');
  });
});

describe('the File mode widget', () => {
  function editor(actions: Parameters<typeof commentsExtension>[0]) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = new EditorView({ parent: host, state: EditorState.create({ doc: FILE, extensions: [commentsExtension(actions)] }) });
    return { host, view };
  }

  it('the box: Suggest Change puts the lines in, Tab indents, ⌘↩ saves the suggestion with the text', () => {
    const save = vi.fn();
    const { host, view } = editor(() => ({ save, edit: noop, resolve: noop, remove: noop }));
    try {
      const from = view.state.doc.line(2).from;
      const to = view.state.doc.line(4).to;
      view.dispatch({ effects: setDraft.of({ from, to, editing: null }) });
      const box = within(host.querySelector('.ed-cmt-draft') as HTMLElement);
      const toggle = box.getByRole('button', { name: 'Suggest Change' });
      expect(toggle.getAttribute('aria-pressed')).toBe('false');
      const code = host.querySelector('.ed-cmt-code') as HTMLTextAreaElement;
      expect(code.closest('.ed-cmt-sug')!.hasAttribute('hidden')).toBe(true);
      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
      expect(code.closest('.ed-cmt-sug')!.hasAttribute('hidden')).toBe(false);
      expect(code.value).toBe(base.anchorText);
      expect(box.getByText('no change')).toBeTruthy();
      code.value = '  return sum(range);';
      code.setSelectionRange(0, 0);
      expect(fireEvent.keyDown(code, { key: 'Tab' })).toBe(false);
      expect(code.value).toBe('    return sum(range);');
      expect(box.getByText('replaces 3 lines with 1')).toBeTruthy();
      (host.querySelector('.ed-cmt-input') as HTMLTextAreaElement).value = 'Use the helper.';
      fireEvent.keyDown(code, { key: 'Enter', metaKey: true });
      expect(save).toHaveBeenCalledOnce();
      expect(save.mock.calls[0]![1]).toBe('```suggestion\n    return sum(range);\n```\nUse the helper.');
      // Off again: the text alone.
      fireEvent.click(toggle);
      fireEvent.keyDown(host.querySelector('.ed-cmt-input')!, { key: 'Enter', metaKey: true });
      expect(save.mock.calls[1]![1]).toBe('Use the helper.');
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it('a box moved to other lines suggests from those lines, and names them', () => {
    const save = vi.fn();
    const { host, view } = editor(() => ({ save, edit: noop, resolve: noop, remove: noop }));
    try {
      const doc = view.state.doc;
      view.dispatch({ effects: setDraft.of({ from: doc.line(1).from, to: doc.line(2).to, editing: null }) });
      const box = host.querySelector('.ed-cmt-draft') as HTMLElement;
      (box.querySelector('.ed-cmt-input') as HTMLTextAreaElement).value = 'Kept.';
      expect(box.querySelector('.ed-cmt-foot .ed-cmt-where')?.textContent).toBe('Lines 1–2');
      // A new drag: the same box, moved.
      view.dispatch({ effects: setDraft.of({ from: doc.line(2).from, to: doc.line(4).to, editing: null }) });
      const moved = host.querySelector('.ed-cmt-draft') as HTMLElement;
      expect((moved.querySelector('.ed-cmt-input') as HTMLTextAreaElement).value).toBe('Kept.');
      expect(moved.querySelector('.ed-cmt-foot .ed-cmt-where')?.textContent).toBe('Lines 2–4');
      fireEvent.click(within(moved).getByRole('button', { name: 'Suggest Change' }));
      const code = moved.querySelector('.ed-cmt-code') as HTMLTextAreaElement;
      expect(code.value).toBe(base.anchorText);
      code.value = '  return sum(range);';
      fireEvent.input(code);
      expect(within(moved).getByText('replaces 3 lines with 1')).toBeTruthy();
      fireEvent.keyDown(code, { key: 'Enter', metaKey: true });
      expect(save.mock.calls[0]![1]).toBe('```suggestion\n  return sum(range);\n```\nKept.');
      const d = save.mock.calls[0]![0] as { from: number; to: number };
      expect([view.state.doc.lineAt(d.from).number, view.state.doc.lineAt(d.to).number]).toEqual([2, 4]);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it('code left as the lines themselves is stored as the words alone', () => {
    const save = vi.fn();
    const { host, view } = editor(() => ({ save, edit: noop, resolve: noop, remove: noop }));
    try {
      view.dispatch({ effects: setDraft.of({ from: view.state.doc.line(2).from, to: view.state.doc.line(4).to, editing: null }) });
      fireEvent.click(within(host).getByRole('button', { name: 'Suggest Change' }));
      expect(within(host).getByText('no change')).toBeTruthy();
      (host.querySelector('.ed-cmt-input') as HTMLTextAreaElement).value = 'Just a note.';
      fireEvent.keyDown(host.querySelector('.ed-cmt-code')!, { key: 'Enter', metaKey: true });
      expect(save.mock.calls[0]![1]).toBe('Just a note.');
    } finally {
      view.destroy();
      host.remove();
    }
  });

  describe('a box for another comment is drawn afresh, never carried over', () => {
    const A = { ...base, id: 10, lineStart: 2, lineEnd: 2, anchorText: '  let sum = 0;', body: joinSuggestion(['  let sum = 1;'], 'From A.') };
    const B = { ...base, id: 11, lineStart: 4, lineEnd: 4, anchorText: '  return sum;', body: 'From B.' };
    function open(at: (v: EditorView) => { from: number; to: number; editing: ReviewComment | null }) {
      const save = vi.fn();
      const ctx = editor(() => ({ save, edit: noop, resolve: noop, remove: noop }));
      ctx.view.dispatch({ effects: setDraft.of(at(ctx.view)) });
      return { ...ctx, save };
    }
    const line = (v: EditorView, n: number, editing: ReviewComment | null) => ({ from: v.state.doc.line(n).from, to: v.state.doc.line(n).to, editing });
    const box = (host: HTMLElement) => ({
      input: host.querySelector('.ed-cmt-draft .ed-cmt-input') as HTMLTextAreaElement,
      code: host.querySelector('.ed-cmt-draft .ed-cmt-code') as HTMLTextAreaElement,
      toggle: within(host.querySelector('.ed-cmt-draft') as HTMLElement).getByRole('button', { name: 'Suggest Change' }),
    });

    it('Edit A, then Edit B: B’s body is shown, and saved as B’s', () => {
      const { host, view, save } = open((v) => line(v, 2, A));
      try {
        expect(box(host).input.value).toBe('From A.');
        view.dispatch({ effects: setDraft.of(line(view, 4, B)) });
        const b = box(host);
        expect(b.input.value).toBe('From B.');
        expect(b.toggle.getAttribute('aria-pressed')).toBe('false');
        fireEvent.keyDown(b.input, { key: 'Enter', metaKey: true });
        expect(save.mock.calls[0]![1]).toBe('From B.');
        expect((save.mock.calls[0]![0] as { editing: ReviewComment }).editing.id).toBe(11);
      } finally {
        view.destroy();
        host.remove();
      }
    });

    it('a new box with typed text, then Edit B: B’s body, not the typed text', () => {
      const { host, view, save } = open((v) => line(v, 2, null));
      try {
        box(host).input.value = 'Typed, not saved.';
        view.dispatch({ effects: setDraft.of(line(view, 4, B)) });
        const b = box(host);
        expect(b.input.value).toBe('From B.');
        fireEvent.keyDown(b.input, { key: 'Enter', metaKey: true });
        expect(save.mock.calls[0]![1]).toBe('From B.');
      } finally {
        view.destroy();
        host.remove();
      }
    });

    it('Edit A, then a new range elsewhere: an empty new box, without A’s words or suggestion', () => {
      const { host, view } = open((v) => line(v, 2, A));
      try {
        expect(box(host).toggle.getAttribute('aria-pressed')).toBe('true');
        view.dispatch({ effects: setDraft.of({ from: view.state.doc.line(4).from, to: view.state.doc.line(5).to, editing: null }) });
        const n = box(host);
        expect(n.input.value).toBe('');
        expect(n.toggle.getAttribute('aria-pressed')).toBe('false');
        expect(host.querySelector('.ed-cmt-draft .ed-cmt-foot .ed-cmt-where')?.textContent).toBe('Lines 4–5');
      } finally {
        view.destroy();
        host.remove();
      }
    });
  });

  it('asks CodeMirror to measure again when the box grows or shrinks', () => {
    const { host, view } = editor(() => ({ save: noop, edit: noop, resolve: noop, remove: noop }));
    try {
      view.dispatch({ effects: setDraft.of({ from: view.state.doc.line(2).from, to: view.state.doc.line(4).to, editing: null }) });
      const measure = vi.spyOn(view, 'requestMeasure');
      fireEvent.click(within(host).getByRole('button', { name: 'Suggest Change' }));
      expect(measure).toHaveBeenCalled();
      measure.mockClear();
      const code = host.querySelector('.ed-cmt-code') as HTMLTextAreaElement;
      code.value = 'one\ntwo\nthree\nfour';
      fireEvent.input(code);
      expect(measure).toHaveBeenCalled();
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it('keys typed in the code box reach neither CodeMirror nor the window', () => {
    const cmKeys = vi.fn(() => false);
    const winKeys = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: FILE,
        extensions: [commentsExtension(() => ({ save: noop, edit: noop, resolve: noop, remove: noop })), EditorView.domEventHandlers({ keydown: cmKeys })],
      }),
    });
    window.addEventListener('keydown', winKeys);
    try {
      view.dispatch({ effects: setDraft.of({ from: view.state.doc.line(2).from, to: view.state.doc.line(4).to, editing: null }) });
      fireEvent.click(within(host).getByRole('button', { name: 'Suggest Change' }));
      const code = host.querySelector('.ed-cmt-code') as HTMLTextAreaElement;
      for (const key of ['a', 'Enter', 'Tab', 'Backspace', 'ArrowUp', 'z']) fireEvent.keyDown(code, { key, metaKey: key === 'z' });
      expect(cmKeys).not.toHaveBeenCalled();
      expect(winKeys).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', winKeys);
      view.destroy();
      host.remove();
    }
  });

  it('Edit reopens both, and the card draws the same diff as the Diff mode', () => {
    const save = vi.fn();
    const { host, view } = editor(() => ({ save, edit: noop, resolve: noop, remove: noop }));
    try {
      const from = view.state.doc.line(2).from;
      const to = view.state.doc.line(4).to;
      const c = { ...base, body: joinSuggestion(['  return sum(range);'], 'Use the helper.') };
      view.dispatch({ effects: setPlacedComments.of([{ comment: c, from, to }]) });
      const card = host.querySelector('.ed-cmt') as HTMLElement;
      const rows = [...card.querySelectorAll('.ed-cmt-sug-line')].map((r) => [r.getAttribute('data-kind'), r.textContent]);
      expect(rows).toEqual([
        ['del', '  let sum = 0;'],
        ['del', '  for (const d of range) sum += d;'],
        ['del', '  return sum;'],
        ['add', '  return sum(range);'],
      ]);
      expect(card.querySelector('.ed-cmt-body')?.textContent).toBe('Use the helper.');
      expect(card.textContent).not.toContain('```');

      view.dispatch({ effects: setDraft.of({ from, to, editing: c }) });
      const box = host.querySelector('.ed-cmt-draft') as HTMLElement;
      expect(within(box).getByRole('button', { name: 'Suggest Change' }).getAttribute('aria-pressed')).toBe('true');
      expect((box.querySelector('.ed-cmt-code') as HTMLTextAreaElement).value).toBe('  return sum(range);');
      expect((box.querySelector('.ed-cmt-input') as HTMLTextAreaElement).value).toBe('Use the helper.');
      fireEvent.click(within(box).getByRole('button', { name: 'Save' }));
      expect(save.mock.calls[0]![1]).toBe(c.body);
    } finally {
      view.destroy();
      host.remove();
    }
  });
});

describe('the To Send list above the message box', () => {
  it('shows what the suggestion replaces and the words, and Edit changes the words only', async () => {
    const c = { ...base, body: joinSuggestion(['  return sum(range);'], 'Use the helper.') };
    render(<WaitingComments taskId={1} frozen={false} list={toSendOf(null, [c], [])} />);
    fireEvent.click(screen.getByRole('button', { name: /To Send · 1/ }));
    const list = screen.getByRole('group', { name: 'To Send, 1' });
    expect(within(list).getByText(/Suggested change · replaces 3 lines with 1/)).toBeTruthy();
    expect(list.textContent).not.toContain('```');
    fireEvent.click(within(list).getByRole('button', { name: 'Edit' }));
    const box = within(list).getByRole('textbox', { name: 'Edit comment' }) as HTMLTextAreaElement;
    expect(box.value).toBe('Use the helper.');
    fireEvent.change(box, { target: { value: 'Use sum().' } });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(editComment).toHaveBeenCalledWith(1, 1, joinSuggestion(['  return sum(range);'], 'Use sum().')));
  });
});
