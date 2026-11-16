// @vitest-environment jsdom
/**
 * ⌘R and ⇧⌘R in the Review Guide (#390, #391): the file's and the group's
 * Reviewed boxes from the keyboard, toggling and moving on as a click does.
 * Mounted beside the app's real shortcut table (useAppShortcuts), so ⇧⌘R is
 * proven to mark the group in the guide and to stay Remote Control outside it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
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
// A real comment box, opened once (the first file's) when a test asks for it.
let draftsToOpen = 0;
function DraftHost() {
  const [open, setOpen] = useState(() => draftsToOpen-- > 0);
  return open ? (
    <CommentDraftView from={1} to={1} initial="" editing={false} onSave={() => setOpen(false)} onCancel={() => setOpen(false)} />
  ) : null;
}
vi.mock('../ui/editor/diffComments', () => ({
  useDiffComments: () => ({ annotations: null, notice: null, clearNotice: () => {}, bar: <DraftHost /> }),
}));
vi.mock('../ui/zoom', () => ({ applyZoom: async () => {}, stepZoom: (z: number) => z, storedZoom: () => 1 }));

const { default: GuidePane, resetGuideViewsForTests, UNDO_MS } = await import('./GuidePane');
const { resetGuideStoreForTests, saveGuide } = await import('./store');
const { default: useAppShortcuts } = await import('../ui/app/useAppShortcuts');
const { CommentDraftView } = await import('../ui/editor/CommentViews');

const task = {
  id: 7, title: 'Lantern', projectId: 1, repoPath: '/r', baseBranch: 'main', branch: 'lantern', worktreePath: '/wt',
  sessionId: null, ownsWorktree: true, createdBranch: true, kind: 'work', status: 'idle', createdAt: 0,
  lastActivityAt: null, seenAt: null,
} as unknown as Task;

let remoteAsked: number[] = [];
let blocks: { l1: string; l2: string; o1: string; g1: string };
let writtenAt = 0;

/** The app's shortcut table as App wires it, with Remote Control on offer. */
function Shell({ active = true }: { active?: boolean }) {
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
      <GuidePane task={task} active={active} />
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
  draftsToOpen = 0;
  const diff = buildBranchDiff(
    [edited('src/lamp.ts', [3, 30], 'wick'), edited('src/oil.ts', [5], 'flask'), edited('src/vitrine.ts', [5], 'pane')],
    statReason,
  );
  const [l1, l2, o1, g1] = diff.order as [string, string, string, string];
  loaded = { diff, base: 'base1', fromMergeBase: true, uncommitted: new Set() };
  blocks = { l1, l2, o1, g1 };
  writtenAt = Date.now();
  saveGuide(task.id, {
    diffHash: diff.hash,
    writtenAt,
    base: 'main',
    groups: [
      { title: 'Fuel', summary: '', blocks: [l1, o1] },
      { title: 'Housing', summary: '', blocks: [l2, g1] },
    ],
    files: fileBlockIndex(diff),
    fallback: null,
  });
});

async function mount() {
  const view = render(<Shell />);
  await screen.findByRole('heading', { name: 'Fuel' });
  return view;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const root = () => screen.getByLabelText('Review Guide');
const left = () => within(screen.getByRole('region', { name: 'Group' }));
const right = () => within(screen.getByRole('region', { name: 'Diff' }));
const fileBox = () => right().getByRole('checkbox', { name: 'Reviewed' }) as HTMLInputElement;
const groupBox = () => left().getByRole('checkbox', { name: 'Reviewed' }) as HTMLInputElement;
const current = () => left().getAllByRole('button').find((b) => b.getAttribute('aria-current') === 'true')?.textContent ?? '';
const heading = () => screen.getByRole('region', { name: 'Group' }).querySelector('h2')?.textContent;
/** Keys go where focus is, as in the app: never straight at the pane. */
const focused = () => document.activeElement ?? document.body;
const cmdR = (target: Element = focused(), more: { shiftKey?: boolean; repeat?: boolean } = {}) =>
  fireEvent.keyDown(target, { code: 'KeyR', key: more.shiftKey ? 'R' : 'r', metaKey: true, ...more });
const shiftCmdR = (target: Element = focused(), more: { repeat?: boolean } = {}) => cmdR(target, { shiftKey: true, ...more });
const press = (code: string, altKey = false) => fireEvent.keyDown(focused(), { code, key: code, altKey });

describe('⌘R: the file’s Reviewed box (#390)', () => {
  beforeEach(() => mount());

  it('marks the file and opens the next; pressed again straight away, it undoes that and goes back', () => {
    expect(document.activeElement).toBe(root());
    expect(current()).toContain('lamp.ts');
    expect(cmdR()).toBe(false); // prevented
    expect(current()).toContain('oil.ts');
    expect(fileBox().checked).toBe(false);
    cmdR();
    expect(current()).toContain('lamp.ts');
    expect(fileBox().checked).toBe(false);
    // Undone, it is forgotten: the key marks once more.
    cmdR();
    expect(current()).toContain('oil.ts');
  });

  it('any other key in between forgets the mark: back on a reviewed file, ⌘R unmarks it and stays', () => {
    cmdR(); // lamp, on to oil
    press('ArrowUp');
    expect(current()).toContain('lamp.ts');
    expect(fileBox().checked).toBe(true);
    cmdR();
    expect(fileBox().checked).toBe(false);
    expect(current()).toContain('lamp.ts');
    // An unmark is not remembered: again, it marks and moves on.
    cmdR();
    expect(current()).toContain('oil.ts');
  });

  it('a key in between, even one that moves nowhere, forgets it: ⌘R then marks the file on screen', () => {
    cmdR(); // lamp, on to oil
    press('ArrowDown'); // oil is the last: stays
    cmdR(); // oil, the last: Fuel is done
    expect(heading()).toBe('Housing');
  });

  it('the undo says so, as every other move does', () => {
    cmdR();
    cmdR();
    const said = screen.getAllByRole('status').map((x) => x.textContent).join('|');
    expect(said).toContain('Unmarked lamp.ts');
  });

  it(`only within ${UNDO_MS / 1000} s: later, the key marks the file on screen`, () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    cmdR(); // lamp, on to oil
    vi.setSystemTime(Date.now() + UNDO_MS + 1);
    cmdR(); // oil, the last: Fuel is done
    expect(heading()).toBe('Housing');
  });

  it('a wheel or trackpad scroll in the guide forgets it; one elsewhere does not', () => {
    cmdR(); // lamp, on to oil
    fireEvent.wheel(screen.getByRole('button', { name: 'Elsewhere' }), { deltaY: 40 });
    cmdR(); // undone: back on lamp
    expect(heading()).toBe('Fuel');
    expect(current()).toContain('lamp.ts');
    expect(fileBox().checked).toBe(false);
    cmdR(); // lamp, on to oil
    fireEvent.wheel(screen.getByRole('region', { name: 'Diff' }), { deltaY: 40 });
    cmdR(); // oil, the last: Fuel is done
    expect(heading()).toBe('Housing');
  });

  it('the window losing focus forgets it', () => {
    cmdR(); // lamp, on to oil
    fireEvent.blur(window);
    cmdR();
    expect(heading()).toBe('Housing');
  });

  it('groups changed since the mark: forgotten, never undone onto them', () => {
    cmdR(); // lamp, on to oil
    act(() =>
      saveGuide(task.id, {
        diffHash: loaded.diff.hash,
        writtenAt,
        base: 'main',
        groups: [
          { title: 'Fuel', summary: '', blocks: [blocks.l1, blocks.o1, blocks.g1] },
          { title: 'Housing', summary: '', blocks: [blocks.l2] },
        ],
        files: fileBlockIndex(loaded.diff),
        fallback: null,
      }),
    );
    expect(current()).toContain('oil.ts');
    cmdR(); // oil, on to vitrine
    expect(current()).toContain('vitrine.ts');
    press('ArrowUp');
    press('ArrowUp');
    expect(current()).toContain('lamp.ts');
    expect(fileBox().checked).toBe(true);
  });

  it('a click in between forgets it too; the last file still to read goes to the next group', () => {
    cmdR(); // lamp, on to oil
    fireEvent.pointerDown(root());
    cmdR(); // oil, the last: Fuel is done
    expect(heading()).toBe('Housing');
  });

  it('from a focused checkbox: focus stays in the guide as the file changes, so ⌘R ⌘R works', () => {
    fileBox().focus();
    cmdR();
    expect(current()).toContain('oil.ts');
    expect(document.activeElement).toBe(root());
    cmdR();
    expect(current()).toContain('lamp.ts');
    expect(fileBox().checked).toBe(false);
  });

  it('never from a comment box or other text field, nor from an open menu', () => {
    const box = document.createElement('textarea');
    root().appendChild(box);
    expect(cmdR(box)).toBe(true); // not prevented: the key is the text field's
    const field = document.createElement('input');
    root().appendChild(field);
    cmdR(field);
    fireEvent.click(screen.getByRole('button', { name: 'More guide actions' }));
    const item = within(screen.getByRole('menu')).getAllByRole('menuitem')[0]!;
    item.focus();
    expect(cmdR(item)).toBe(true);
    shiftCmdR(item);
    expect(current()).toContain('lamp.ts');
    expect(fileBox().checked).toBe(false);
    expect(groupBox().checked).toBe(false);
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

describe('after a comment box closes, focus is back in the guide', () => {
  beforeEach(async () => {
    draftsToOpen = 1;
    await mount();
  });

  it('saved: ⌘R marks the file, and ⇧⌘R is the group’s, not Remote Control', async () => {
    const box = await screen.findByPlaceholderText(/./);
    box.focus();
    fireEvent.change(box, { target: { value: 'Check the wick length' } });
    cmdR(); // in the box: the box's
    expect(fileBox().checked).toBe(false);
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter', metaKey: true });
    await waitFor(() => expect(document.activeElement).toBe(root()));
    cmdR();
    expect(current()).toContain('oil.ts');
    press('ArrowDown'); // forget the mark
    shiftCmdR();
    expect(heading()).toBe('Housing');
    expect(remoteAsked).toEqual([]);
  });

  it('cancelled: the same', async () => {
    const box = await screen.findByPlaceholderText(/./);
    box.focus();
    fireEvent.keyDown(box, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(root()));
    shiftCmdR();
    expect(heading()).toBe('Housing');
    expect(remoteAsked).toEqual([]);
  });

  it('focus moved away on purpose is not taken back', async () => {
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(document.activeElement).toBe(elsewhere);
  });
});

describe('⇧⌘R: the group’s Reviewed box (#391), not Remote Control in the guide', () => {
  it('marks the group and goes to the next; pressed again straight away, it undoes that and goes back', async () => {
    await mount();
    shiftCmdR();
    expect(heading()).toBe('Housing');
    expect(remoteAsked).toEqual([]);
    shiftCmdR();
    expect(heading()).toBe('Fuel');
    expect(groupBox().checked).toBe(false);
    expect(remoteAsked).toEqual([]);
  });

  it('⌘R then ⇧⌘R: the group is marked, and its undo leaves the file ⌘R marked', async () => {
    await mount();
    cmdR(); // lamp, on to oil
    shiftCmdR(); // the rest of Fuel, on to Housing
    expect(heading()).toBe('Housing');
    shiftCmdR(); // undo the group: only oil
    expect(heading()).toBe('Fuel');
    expect(current()).toContain('oil.ts');
    expect(fileBox().checked).toBe(false);
    press('ArrowUp');
    expect(fileBox().checked).toBe(true); // lamp
    expect(remoteAsked).toEqual([]);
  });

  it('back on a reviewed group after another key, ⇧⌘R unmarks it and stays', async () => {
    await mount();
    shiftCmdR();
    press('ArrowUp', true);
    expect(heading()).toBe('Fuel');
    expect(groupBox().checked).toBe(true);
    shiftCmdR();
    expect(groupBox().checked).toBe(false);
    expect(heading()).toBe('Fuel');
  });

  it('in a comment box or on the Map it does nothing, and is still not Remote Control', async () => {
    await mount();
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

  it('a held key does not toggle again', async () => {
    await mount();
    shiftCmdR(root(), { repeat: true });
    expect(heading()).toBe('Fuel');
    expect(groupBox().checked).toBe(false);
  });

  it('outside the guide it is still Remote Control, and ⌘R there does nothing', async () => {
    await mount();
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();
    shiftCmdR();
    expect(remoteAsked).toEqual([task.id]);
    expect(cmdR()).toBe(true);
    expect(heading()).toBe('Fuel');
    expect(groupBox().checked).toBe(false);
  });

  it('a guide in a hidden tab claims neither key', async () => {
    // Another tab is showing: the guide stays mounted behind it.
    (await mount()).rerender(<Shell active={false} />);
    expect(root().hasAttribute('data-review-guide')).toBe(false);
    root().focus();
    shiftCmdR();
    expect(remoteAsked).toEqual([task.id]);
    expect(cmdR()).toBe(true);
    expect(heading()).toBe('Fuel');
    expect(groupBox().checked).toBe(false);
    expect(fileBox().checked).toBe(false);
  });

  it('its box says the key', async () => {
    await mount();
    expect(groupBox().closest('label')!.getAttribute('title')).toBe('Mark the group reviewed (⇧⌘R)');
    expect(groupBox().getAttribute('aria-keyshortcuts')).toBe('Meta+Shift+R');
  });
});
