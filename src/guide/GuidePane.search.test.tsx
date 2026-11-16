// @vitest-environment jsdom
/**
 * Search in a Review Guide (#413), mounted: ⌘F searches the file being read,
 * ⇧⌘F every file in the guide -- and never reaches the window's Find in
 * Files while the guide has focus -- one bar with a switch that keeps the
 * text, ↩ / ⇧↩ through the matches, a folded match opened, a result opening
 * its file in its group, and Esc closing it all without leaving full screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Task } from '../types';
import { buildBranchDiff, fileBlockIndex, type BranchDiff } from './blocks';
import { statReason } from './budget';
import { edited } from './fixtures';
import type { LoadedBranchDiff } from './branchDiff';

let loaded: LoadedBranchDiff;
vi.mock('./branchDiff', () => ({ loadBranchDiff: async () => loaded }));
vi.mock('./commentMarks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./commentMarks')>()),
  useOpenComments: () => [],
}));
vi.mock('../ui/transcript/codeComments', () => ({ useWaitingCodeComments: () => [] }));
vi.mock('../ui/transcript/drafts', () => ({ useComments: () => [] }));
vi.mock('../ui/transcript/composerBridge', () => ({ sendWaitingComments: () => true }));
vi.mock('./repoFiles', () => ({ repoFiles: async () => new Set<string>() }));
vi.mock('../ui/editor/diffComments', () => ({
  useDiffComments: () => ({ annotations: null, notice: null, clearNotice: () => {}, bar: null }),
}));

const { default: GuidePane, resetGuideViewsForTests } = await import('./GuidePane');
const { resetGuideStoreForTests, saveGuide } = await import('./store');
const { SEARCH_DEBOUNCE_MS } = await import('./GuideSearch');

const task = {
  id: 7, title: 't', projectId: 1, repoPath: '/r', baseBranch: 'main', branch: 'feat', worktreePath: '/wt',
  sessionId: null, ownsWorktree: true, createdBranch: true, kind: 'work', status: 'idle', createdAt: 0,
  lastActivityAt: null, seenAt: null,
} as unknown as Task;

let diff: BranchDiff;
const windowKeys: KeyboardEvent[] = [];
const onWindowKey = (e: KeyboardEvent) => void windowKeys.push(e);

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
  resetGuideStoreForTests();
  resetGuideViewsForTests();
  // a.ts changes at 3 and 30, in two groups; b.ts at 5.
  diff = buildBranchDiff([edited('src/a.ts', [3, 30], 'alpha'), edited('src/b.ts', [5], 'beta')], statReason);
  const [a1, a2, b1] = diff.order as [string, string, string];
  loaded = { diff, base: 'base1', fromMergeBase: true, uncommitted: new Set() };
  saveGuide(task.id, {
    diffHash: diff.hash,
    writtenAt: Date.now(),
    base: 'main',
    groups: [
      { title: 'Foundations', summary: 'The pieces.', blocks: [a1, b1] },
      { title: 'Wiring', summary: 'Connects them.', blocks: [a2] },
    ],
    files: fileBlockIndex(diff),
    fallback: null,
  });
  windowKeys.length = 0;
  window.addEventListener('keydown', onWindowKey);
});

afterEach(() => {
  window.removeEventListener('keydown', onWindowKey);
  cleanup();
});

const root = () => screen.getByLabelText('Review Guide');
const right = () => within(screen.getByRole('region', { name: 'Diff' }));
const field = () => screen.getByLabelText(/^Search (This File|All Guide Files)$/) as HTMLInputElement;
const count = () => within(screen.getByRole('search')).getByRole('status').textContent;
const find = (target: Element, shiftKey = false) =>
  fireEvent.keyDown(target, { code: 'KeyF', key: shiftKey ? 'F' : 'f', metaKey: true, shiftKey });
const currentLine = () => document.querySelector('.tx-d-hit-cur')?.closest('.tx-d-code')?.textContent ?? null;
const highlighted = () => document.querySelectorAll('.tx-d-hit').length;

async function opened() {
  render(<GuidePane task={task} active />);
  await screen.findByRole('heading', { name: 'Foundations' });
  await waitFor(() => expect(screen.getByRole('region', { name: 'Diff' }).querySelector('.tx-d-code')).not.toBeNull());
}

/** Types into the field, and waits out the pause before the text is searched. */
async function type(text: string) {
  fireEvent.change(field(), { target: { value: text } });
  await act(() => new Promise((r) => setTimeout(r, SEARCH_DEBOUNCE_MS + 30)));
}

describe('Search in a Review Guide (#413)', () => {
  it('⌘F searches this file: every match highlighted, ↩ / ⇧↩ step, a folded match opened', async () => {
    await opened();
    find(root());
    expect(document.activeElement).toBe(field());
    expect(field().getAttribute('aria-label')).toBe('Search This File');
    expect(screen.getByRole('button', { name: 'This File' }).getAttribute('aria-pressed')).toBe('true');
    // Foundations shows a.ts's first block only; line 30 is folded below it.
    await type('alpha');
    expect(count()).toBe('1 of 2');
    expect(highlighted()).toBe(2);
    expect(currentLine()).toBe('line 3 alpha');
    expect(right().getByRole('button', { name: /Unchanged Lines · opened: 1 match inside/ })).toBeTruthy();
    fireEvent.keyDown(field(), { key: 'Enter', code: 'Enter' });
    expect(count()).toBe('2 of 2');
    expect(currentLine()).toBe('line 30 alpha');
    fireEvent.keyDown(field(), { key: 'Enter', code: 'Enter' });
    expect(count()).toBe('1 of 2');
    fireEvent.keyDown(field(), { key: 'Enter', code: 'Enter', shiftKey: true });
    expect(currentLine()).toBe('line 30 alpha');
    await type('nothing like it');
    expect(count()).toBe('No matches');
    expect(highlighted()).toBe(0);
    // Not Find in Files: the window never heard either key.
    expect(windowKeys.filter((e) => e.code === 'KeyF')).toEqual([]);
  });

  it('Esc closes the bar and its highlights, handled so full screen stays, and gives focus back to the guide', async () => {
    await opened();
    find(root());
    await type('alpha');
    expect(highlighted()).toBe(2);
    const esc = fireEvent.keyDown(field(), { key: 'Escape', code: 'Escape' });
    expect(esc).toBe(false); // preventDefault: WKWebView does not hand it to AppKit
    expect(screen.queryByRole('search')).toBeNull();
    expect(highlighted()).toBe(0);
    expect(right().queryByText(/opened: 1 match inside/)).toBeNull();
    expect(document.activeElement).toBe(root());
    // ⌘F again: the text is still there, selected.
    find(root());
    expect(field().value).toBe('alpha');
    // Esc from elsewhere in the guide closes it too.
    root().focus();
    expect(fireEvent.keyDown(root(), { key: 'Escape', code: 'Escape' })).toBe(false);
    expect(screen.queryByRole('search')).toBeNull();
  });

  it('⇧⌘F in the guide searches all its files, by group, and the window’s Find in Files never hears it', async () => {
    await opened();
    find(root(), true);
    expect(windowKeys.filter((e) => e.code === 'KeyF')).toEqual([]);
    expect(field().getAttribute('aria-label')).toBe('Search All Guide Files');
    await type('alpha');
    expect(count()).toBe('2 in 1 file');
    const list = screen.getByRole('listbox', { name: /Matches in the guide/ });
    const groups = within(list).getAllByRole('group').filter((g) => g.parentElement === list);
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['01 Foundations', '02 Wiring']);
    expect(within(groups[0]!).getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual(['Line 3: line 3 alpha']);
    expect(within(groups[1]!).getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual(['Line 30: line 30 alpha']);
    // Outside the guide, ⇧⌘F is still Find in Files.
    find(document.body, true);
    expect(windowKeys.filter((e) => e.code === 'KeyF')).toHaveLength(1);
  });

  it('↓ ↩ on a result opens its file in its group, on This File, at that match', async () => {
    await opened();
    find(root(), true);
    await type('alpha');
    fireEvent.keyDown(field(), { key: 'ArrowDown', code: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /line 30 alpha/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(field(), { key: 'Enter', code: 'Enter' });
    expect(screen.getByRole('heading', { name: 'Wiring' })).toBeTruthy();
    expect(field().getAttribute('aria-label')).toBe('Search This File');
    expect(field().value).toBe('alpha');
    expect(document.activeElement).toBe(field());
    await waitFor(() => expect(currentLine()).toBe('line 30 alpha'));
    expect(count()).toBe('2 of 2');
  });

  it('a click on a result opens it too; the switch keeps the text', async () => {
    await opened();
    find(root());
    await type('beta');
    expect(count()).toBe('No matches'); // a.ts is open, and has none
    fireEvent.click(screen.getByRole('button', { name: 'All Guide Files' }));
    expect(field().value).toBe('beta');
    expect(count()).toBe('1 in 1 file');
    fireEvent.click(screen.getByRole('option', { name: /line 5 beta/ }));
    expect(screen.getByRole('button', { name: /b\.ts/ }).getAttribute('aria-current')).toBe('true');
    await waitFor(() => expect(currentLine()).toBe('line 5 beta'));
    expect(count()).toBe('1 of 1');
    // ⇧⌘F from the field itself switches back to all files.
    find(field(), true);
    expect(field().getAttribute('aria-label')).toBe('Search All Guide Files');
    expect(windowKeys.filter((e) => e.code === 'KeyF')).toEqual([]);
  });

  it('lists three lines a file, then “+ N more”, which ↩ opens', async () => {
    await opened();
    find(root(), true);
    await type('line 1');
    // a.ts: lines 1 and 10-19 match, all folded or in Foundations' hunk.
    const more = screen.getAllByRole('option').find((o) => /^\+ \d+ more$/.test(o.textContent ?? ''))!;
    expect(more.textContent).toBe('+ 8 more');
    const before = screen.getAllByRole('option').length;
    const i = screen.getAllByRole('option').indexOf(more);
    for (let k = 0; k < i; k++) fireEvent.keyDown(field(), { key: 'ArrowDown', code: 'ArrowDown' });
    fireEvent.keyDown(field(), { key: 'Enter', code: 'Enter' });
    expect(screen.getAllByRole('option').length).toBe(before - 1 + 8);
  });

  it('keeps the file’s diff under All Guide Files: what was open in it is still open after', async () => {
    await opened();
    fireEvent.click(right().getByRole('button', { name: 'Whole File (2 blocks)' }));
    find(root(), true);
    expect(screen.queryByRole('button', { name: /Only This Group/ })).toBeNull();
    find(field());
    expect(right().getByRole('button', { name: /Only This Group/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('searches once typing pauses, not on every key, in both scopes', async () => {
    await opened();
    find(root());
    await type('alpha');
    expect(count()).toBe('1 of 2');
    fireEvent.change(field(), { target: { value: 'beta' } });
    expect(count()).toBe('1 of 2');
    await waitFor(() => expect(count()).toBe('No matches'));
    find(field(), true);
    expect(count()).toBe('1 in 1 file');
    fireEvent.change(field(), { target: { value: 'alpha' } });
    expect(count()).toBe('1 in 1 file');
    await waitFor(() => expect(count()).toBe('2 in 1 file'));
  });

  it('Esc goes no further than the search: the window (the editor’s Esc, full screen) never hears it', async () => {
    await opened();
    find(root());
    await type('alpha');
    fireEvent.keyDown(field(), { key: 'Escape', code: 'Escape' });
    expect(screen.queryByRole('search')).toBeNull();
    find(root());
    root().focus();
    fireEvent.keyDown(root(), { key: 'Escape', code: 'Escape' });
    expect(screen.queryByRole('search')).toBeNull();
    expect(windowKeys.filter((e) => e.key === 'Escape')).toEqual([]);
  });

  it('the switch keeps the caret after the text; ⌘F selects it', async () => {
    await opened();
    find(root());
    await type('alpha');
    fireEvent.click(screen.getByRole('button', { name: 'All Guide Files' }));
    expect(document.activeElement).toBe(field());
    expect([field().selectionStart, field().selectionEnd]).toEqual([5, 5]);
    find(field());
    expect([field().selectionStart, field().selectionEnd]).toEqual([0, 5]);
  });

  it('opens Read from the map', async () => {
    await opened();
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    find(root());
    expect(screen.getByRole('button', { name: 'Read' }).getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(field());
  });
});
