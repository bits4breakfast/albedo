// @vitest-environment jsdom
/**
 * ⌘R and ⇧⌘R in the Review Guide (#390, #391): the file's and the group's
 * Reviewed boxes from the keyboard, toggling and moving on as a click does.
 * Mounted beside the app's real shortcut table (useAppShortcuts), so ⇧⌘R is
 * proven to mark the group in the guide and to stay Remote Control outside it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Task } from '../types';
import { buildBranchDiff, fileBlockIndex } from './blocks';
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
vi.mock('../ui/transcript/composerBridge', () => ({ sendWaitingComments: () => true, requestAttach: () => {} }));
vi.mock('./repoFiles', () => ({ repoFiles: async () => new Set<string>() }));
vi.mock('../ui/editor/diffComments', () => ({
  useDiffComments: () => ({ annotations: null, notice: null, clearNotice: () => {}, bar: null }),
}));
vi.mock('../ui/zoom', () => ({ applyZoom: async () => {}, stepZoom: (z: number) => z, storedZoom: () => 1 }));

const { default: GuidePane, resetGuideViewsForTests } = await import('./GuidePane');
const { resetGuideStoreForTests, saveGuide } = await import('./store');
const { default: useAppShortcuts } = await import('../ui/app/useAppShortcuts');

const task = {
  id: 7, title: 'Lantern', projectId: 1, repoPath: '/r', baseBranch: 'main', branch: 'lantern', worktreePath: '/wt',
  sessionId: null, ownsWorktree: true, createdBranch: true, kind: 'work', status: 'idle', createdAt: 0,
  lastActivityAt: null, seenAt: null,
} as unknown as Task;

let remoteAsked: number[] = [];

/** The app's shortcut table as App wires it, with Remote Control on offer. */
function Shell() {
  useAppShortcuts({
    readingTabs: ['guide'] as never,
    activeTab: 'guide' as never,
    setRightTab: () => {},
    toggleQuickOpen: () => {},
    toggleFind: () => {},
    selected: task,
    setMode: () => {},
    remoteItem: { id: 'remote' } as never,
    setRemoteConfirmFor: (id) => void remoteAsked.push(id as number),
    projectView: false,
    filesColumnShown: false,
    setShellOpen: () => {},
    setShortcutsOpen: () => {},
    showTabs: false,
    tabs: [],
    switchTab: () => {},
    activeProjectTab: null as never,
    setTaskListCollapsed: () => {},
    editorShowing: false,
    setRenaming: () => {},
  });
  return (
    <>
      <button type="button">Elsewhere</button>
      <GuidePane task={task} active />
    </>
  );
}

beforeEach(async () => {
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
  remoteAsked = [];
  const diff = buildBranchDiff(
    [edited('src/lamp.ts', [3, 30], 'wick'), edited('src/oil.ts', [5], 'flask'), edited('src/vitrine.ts', [5], 'pane')],
    statReason,
  );
  const [l1, l2, o1, g1] = diff.order as [string, string, string, string];
  loaded = { diff, base: 'base1', fromMergeBase: true, uncommitted: new Set() };
  saveGuide(task.id, {
    diffHash: diff.hash,
    writtenAt: Date.now(),
    base: 'main',
    groups: [
      { title: 'Fuel', summary: '', blocks: [l1, o1] },
      { title: 'Housing', summary: '', blocks: [l2, g1] },
    ],
    files: fileBlockIndex(diff),
    fallback: null,
  });
  render(<Shell />);
  await screen.findByRole('heading', { name: 'Fuel' });
});

afterEach(cleanup);

const root = () => screen.getByLabelText('Review Guide');
const left = () => within(screen.getByRole('region', { name: 'Group' }));
const right = () => within(screen.getByRole('region', { name: 'Diff' }));
const fileBox = () => right().getByRole('checkbox', { name: 'Reviewed' }) as HTMLInputElement;
const groupBox = () => left().getByRole('checkbox', { name: 'Reviewed' }) as HTMLInputElement;
const current = () => left().getAllByRole('button').find((b) => b.getAttribute('aria-current') === 'true')?.textContent ?? '';
const heading = () => screen.getByRole('region', { name: 'Group' }).querySelector('h2')?.textContent;
const cmdR = (target: Element = root(), more: { shiftKey?: boolean; repeat?: boolean } = {}) =>
  fireEvent.keyDown(target, { code: 'KeyR', key: more.shiftKey ? 'R' : 'r', metaKey: true, ...more });
const shiftCmdR = (target: Element = root(), more: { repeat?: boolean } = {}) => cmdR(target, { shiftKey: true, ...more });

describe('⌘R: the file’s Reviewed box (#390)', () => {
  it('marks the file and opens the next one still to read; back on it, ⌘R unmarks it and stays', () => {
    expect(current()).toContain('lamp.ts');
    const handled = !cmdR();
    expect(handled).toBe(true);
    expect(current()).toContain('oil.ts');
    expect(fileBox().checked).toBe(false);
    fireEvent.keyDown(root(), { code: 'ArrowUp', key: 'ArrowUp' });
    expect(current()).toContain('lamp.ts');
    expect(fileBox().checked).toBe(true);
    cmdR();
    expect(fileBox().checked).toBe(false);
    expect(current()).toContain('lamp.ts');
  });

  it('the last file still to read finishes the group and goes to the next, as the box does', () => {
    cmdR();
    cmdR();
    expect(heading()).toBe('Housing');
  });

  it('works with a checkbox focused, but never from a comment box or other text field', () => {
    const box = document.createElement('textarea');
    root().appendChild(box);
    expect(cmdR(box)).toBe(true); // not prevented: the key is the text field's
    const field = document.createElement('input');
    root().appendChild(field);
    cmdR(field);
    expect(current()).toContain('lamp.ts');
    fileBox().focus();
    cmdR(fileBox());
    expect(current()).toContain('oil.ts');
  });

  it('does nothing on the Map, nor on a held key’s repeats', () => {
    cmdR(root(), { repeat: true });
    expect(current()).toContain('lamp.ts');
    expect(fileBox().checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    cmdR();
    fireEvent.click(screen.getByRole('button', { name: 'Read' }));
    expect(current()).toContain('lamp.ts');
    expect(fileBox().checked).toBe(false);
  });

  it('its box says the key', () => {
    expect(fileBox().closest('label')!.getAttribute('title')).toBe('Mark this file reviewed (⌘R)');
    expect(fileBox().getAttribute('aria-keyshortcuts')).toBe('Meta+R');
  });
});

describe('⇧⌘R: the group’s Reviewed box (#391), not Remote Control in the guide', () => {
  it('marks the group and goes to the next; back on it, ⇧⌘R unmarks it and stays', () => {
    shiftCmdR();
    expect(heading()).toBe('Housing');
    expect(remoteAsked).toEqual([]);
    fireEvent.keyDown(root(), { code: 'ArrowUp', key: 'ArrowUp', altKey: true });
    expect(heading()).toBe('Fuel');
    expect(groupBox().checked).toBe(true);
    shiftCmdR();
    expect(groupBox().checked).toBe(false);
    expect(heading()).toBe('Fuel');
    expect(remoteAsked).toEqual([]);
  });

  it('in a comment box or on the Map it does nothing, and is still not Remote Control', () => {
    const box = document.createElement('textarea');
    root().appendChild(box);
    shiftCmdR(box);
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    shiftCmdR();
    fireEvent.click(screen.getByRole('button', { name: 'Read' }));
    expect(heading()).toBe('Fuel');
    expect(groupBox().checked).toBe(false);
    expect(remoteAsked).toEqual([]);
  });

  it('a held key does not toggle again', () => {
    shiftCmdR(root(), { repeat: true });
    expect(heading()).toBe('Fuel');
    expect(groupBox().checked).toBe(false);
  });

  it('outside the guide it is still Remote Control, and ⌘R there does nothing', () => {
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    shiftCmdR(elsewhere);
    expect(remoteAsked).toEqual([task.id]);
    expect(cmdR(elsewhere)).toBe(true);
    expect(heading()).toBe('Fuel');
    expect(groupBox().checked).toBe(false);
  });

  it('its box says the key', () => {
    expect(groupBox().closest('label')!.getAttribute('title')).toBe('Mark the group reviewed (⇧⌘R)');
    expect(groupBox().getAttribute('aria-keyshortcuts')).toBe('Meta+Shift+R');
  });
});
