// @vitest-environment jsdom
/**
 * ⇧⌘C has two meanings (#456): Comment on the Selected Text in the
 * transcript, Copy Full Path in the Editor. The real FileEditor and the real
 * PassageComments, each in a tab panel that App hides in turn, prove that
 * one press never does both: the Editor's copy while it is on screen, the
 * comment while the transcript is, and neither for a selection left behind
 * a hidden tab (the Files or Review Guide tab on screen).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import type { Task } from '../../types';

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(async () => 'const a = 1;\n'),
  writeTextFile: vi.fn(async () => {}),
  exists: vi.fn(async () => true),
}));
vi.mock('../../lib/paths', () => ({
  resolveInWorktree: vi.fn(async (root: string, path: string) => ({ absolute: `${root}/${path}`, relative: path })),
}));
vi.mock('../../lib/highlight', () => ({
  highlightToTokens: vi.fn(async () => []),
  peekTokens: vi.fn(() => null),
  styleToCss: vi.fn(() => ''),
}));
vi.mock('../Terminal', () => ({ notePty: vi.fn() }));
vi.mock('../../lsp/phpantom', () => ({
  isPhpPath: () => false,
  warmPhpantom: vi.fn(),
  phpantomFailure: () => null,
  phpantomAvailability: () => null,
  subscribePhpantom: () => () => {},
  dismissPhpantomFailure: vi.fn(),
}));
vi.mock('../../db/comments', () => ({
  listComments: vi.fn(async () => []),
  onCommentsChanged: vi.fn(() => () => {}),
  addComment: vi.fn(),
  deleteComment: vi.fn(),
  editComment: vi.fn(),
  moveComment: vi.fn(),
  resolveComment: vi.fn(),
  relocate: vi.fn(),
}));
const copyText = vi.fn(async (_text: string) => true);
vi.mock('../../lib/clipboard', () => ({ copyText }));

// jsdom has no layout; CodeMirror and the comment field measure ranges.
Object.assign(Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new DOMRect() });

const { default: FileEditor } = await import('../editor/FileEditor');
const { PassageComments } = await import('./PassageComments');
const { __resetDrafts } = await import('./drafts');

const task: Task = {
  id: 4, title: 't', projectId: 1, repoPath: '/repo', baseBranch: 'main', branch: 'b',
  worktreePath: '/wt', sessionId: null, ownsWorktree: true, createdBranch: true, kind: 'work',
  status: 'idle', createdAt: 0, lastActivityAt: null, seenAt: null, summary: null,
  reviewUrl: null,
  apiError: null,
  apiErrorText: null,
  spunFromTaskId: null,
};

const PASSAGE = 'Production already runs 8.2.35, from our own build.';

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
  __resetDrafts();
});
afterEach(() => {
  cleanup();
  copyText.mockClear();
  document.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
  __resetDrafts();
});

/** A transcript row and the passage comments, drawn in the scroller as TranscriptPane does. */
function Transcript() {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div className="tx-scroll" ref={scrollRef}>
      <div className="tx-row" data-message-id="1">
        <div className="tx-gutter">Claude</div>
        <div className="tx-content">
          <p>{PASSAGE}</p>
        </div>
      </div>
      <PassageComments taskId={task.id} scrollRef={scrollRef} messages={[]} />
    </div>
  );
}

type Tab = 'transcript' | 'editor' | 'guide';

/**
 * App's reading tabs: one panel each, every one but `tab` hidden. `both`
 * shows the transcript and the editor at once, which App never does, to
 * prove the editor's claim on the key does not lean on that alone.
 */
async function setup(tab: Tab | 'both') {
  const panel = (shown: boolean) => {
    const p = document.body.appendChild(document.createElement('div'));
    p.className = 'tabpanel';
    p.hidden = !shown;
    return p;
  };
  const transcriptPanel = panel(tab === 'transcript' || tab === 'both');
  const guidePanel = panel(tab === 'guide');
  guidePanel.innerHTML = '<div data-review-guide=""><p>Guide text</p></div>';
  const editorPanel = panel(tab === 'editor' || tab === 'both');
  const slot = document.body.appendChild(document.createElement('div'));
  render(<Transcript />, { container: transcriptPanel.appendChild(document.createElement('div')) });
  render(<FileEditor task={task} request={{ path: 'src/a.ts' }} onClose={() => {}} controlsSlot={slot} />, {
    container: editorPanel.appendChild(document.createElement('div')),
  });
  await waitFor(() => {
    if (!document.querySelector('.cm-content')) throw new Error('editor not mounted yet');
  });
  return { guidePanel };
}

/** Select `text` inside `el`, as a drag would. */
function selectIn(el: Element, text: string): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    const at = t.data.indexOf(text);
    if (at < 0) continue;
    const r = document.createRange();
    r.setStart(t, at);
    r.setEnd(t, at + text.length);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    return;
  }
  throw new Error(`no ${text}`);
}
const selectPassage = () => selectIn(document.querySelector('[data-message-id="1"]')!, 'already runs');

function press(init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: 'C', code: 'KeyC', metaKey: true, shiftKey: true, bubbles: true, cancelable: true, ...init });
  act(() => void window.dispatchEvent(e));
  return e;
}
/** The comment field, on screen or not: `queryByRole` would skip one opened inside a hidden panel. */
const field = () => document.querySelector('.tx-cmt-field');

describe('⇧⌘C: the transcript comments, the Editor copies the path (#456)', () => {
  it('Transcript tab, text selected in it: opens the comment field and copies nothing', async () => {
    await setup('transcript');
    selectPassage();
    expect(press().defaultPrevented).toBe(true);
    expect(field()).toBeTruthy();
    expect(copyText).not.toHaveBeenCalled();
  });

  it('Editor tab, with a selection still in the hidden transcript: copies the full path, opens no field', async () => {
    await setup('editor');
    selectPassage();
    press();
    await waitFor(() => expect(copyText).toHaveBeenLastCalledWith('/wt/src/a.ts'));
    expect(field()).toBeNull();
  });

  it('Editor tab, the same on another layout and with nothing selected', async () => {
    await setup('editor');
    press({ key: 'J' });
    await waitFor(() => expect(copyText).toHaveBeenCalledTimes(1));
    expect(field()).toBeNull();
  });

  it('Editor tab: ⌥⇧⌘C stays Copy Path, from the worktree', async () => {
    await setup('editor');
    selectPassage();
    press({ key: 'Ç', altKey: true });
    await waitFor(() => expect(copyText).toHaveBeenLastCalledWith('src/a.ts'));
    expect(field()).toBeNull();
  });

  it('Transcript tab, with the selection in the hidden editor: nothing, and the key goes on', async () => {
    await setup('transcript');
    selectIn(document.querySelector('.cm-content')!, 'const');
    expect(press().defaultPrevented).toBe(false);
    expect(field()).toBeNull();
    expect(copyText).not.toHaveBeenCalled();
  });

  it('Review Guide tab, with a selection left in the hidden transcript: nothing, and the key goes on', async () => {
    await setup('guide');
    selectPassage();
    expect(press().defaultPrevented).toBe(false);
    expect(field()).toBeNull();
    expect(copyText).not.toHaveBeenCalled();
  });

  it('Review Guide tab, text selected in the guide: nothing either (its diffs comment with ⌥⌘M)', async () => {
    const { guidePanel } = await setup('guide');
    selectIn(guidePanel, 'Guide');
    expect(press().defaultPrevented).toBe(false);
    expect(field()).toBeNull();
    expect(copyText).not.toHaveBeenCalled();
  });

  it('if both were ever on screen, the Editor keeps the key: one press never does two things', async () => {
    await setup('both');
    selectPassage();
    press();
    await waitFor(() => expect(copyText).toHaveBeenCalledTimes(1));
    expect(field()).toBeNull();
  });
});
