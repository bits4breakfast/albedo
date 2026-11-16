// @vitest-environment jsdom
/**
 * All Guide Files (#413) covers the file's diff without taking it off the
 * page: a side-by-side diff stays side by side, so its rows -- and a comment
 * being written in one -- are not remounted by ⇧⌘F and back.
 *
 * jsdom has no layout, so the diff's width comes from a stand-in
 * ResizeObserver that measures as a browser does: 0 wide under display:
 * none (the `hidden` attribute), the pane's width otherwise.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
vi.mock('../ui/transcript/composerBridge', () => ({ sendWaitingComments: () => true }));
vi.mock('./repoFiles', () => ({ repoFiles: async () => new Set<string>() }));
// A comment being written under line 3: an uncontrolled box, so its text
// lives in the row's DOM and goes if the row is remounted -- as a draft's does.
vi.mock('../ui/editor/diffComments', () => ({
  useDiffComments: () => ({
    annotations: {
      after: (line: number) => (line === 3 ? <textarea aria-label="Comment being written" /> : null),
      picking: null,
      pick: () => {},
    },
    notice: null,
    clearNotice: () => {},
    bar: null,
  }),
}));

const { default: GuidePane, resetGuideViewsForTests } = await import('./GuidePane');
const { resetGuideStoreForTests, saveGuide } = await import('./store');

const task = {
  id: 9, title: 't', projectId: 1, repoPath: '/r', baseBranch: 'main', branch: 'feat', worktreePath: '/wt',
  sessionId: null, ownsWorktree: true, createdBranch: true, kind: 'work', status: 'idle', createdAt: 0,
  lastActivityAt: null, seenAt: null,
} as unknown as Task;

/** As a browser measures: nothing under display: none, the pane's width otherwise. */
const widthOf = (el: Element) => (el.closest('[hidden]') ? 0 : 1200);
const observed: Array<{ cb: ResizeObserverCallback; el: Element; ro: object }> = [];
class MeasuringObserver {
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe(el: Element) {
    observed.push({ cb: this.cb, el, ro: this });
  }
  unobserve() {}
  disconnect() {
    for (let i = observed.length - 1; i >= 0; i--) if (observed[i]!.ro === this) observed.splice(i, 1);
  }
}
const measure = () =>
  act(() => {
    for (const o of [...observed]) {
      o.cb([{ contentRect: { width: widthOf(o.el) } } as unknown as ResizeObserverEntry], o.ro as ResizeObserver);
    }
  });

const savedObserver = globalThis.ResizeObserver;

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
  globalThis.ResizeObserver = MeasuringObserver as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return widthOf(this);
    },
  });
  const diff = buildBranchDiff([edited('src/a.ts', [3, 30], 'alpha')], statReason);
  loaded = { diff, base: 'base1', fromMergeBase: true, uncommitted: new Set() };
  saveGuide(task.id, {
    diffHash: diff.hash,
    writtenAt: Date.now(),
    base: 'main',
    groups: [{ title: 'Everything', summary: '', blocks: [...diff.order] }],
    files: fileBlockIndex(diff),
    fallback: null,
  });
});

afterEach(() => {
  cleanup();
  observed.length = 0;
  globalThis.ResizeObserver = savedObserver;
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
});

const root = () => screen.getByLabelText('Review Guide');
const find = (target: Element, shiftKey = false) =>
  fireEvent.keyDown(target, { code: 'KeyF', key: shiftKey ? 'F' : 'f', metaKey: true, shiftKey });

describe('All Guide Files over a side-by-side diff (#413)', () => {
  it('keeps it side by side, and the comment being written in it', async () => {
    render(<GuidePane task={task} active />);
    await screen.findByRole('heading', { name: 'Everything' });
    await measure();
    await waitFor(() => expect(document.querySelector('.tx-d-split')).not.toBeNull());
    const box = screen.getByLabelText('Comment being written') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Why not reuse the helper?' } });

    find(root(), true);
    await measure();
    find(screen.getByLabelText('Search All Guide Files'));
    await measure();

    expect(document.querySelector('.tx-d-split')).not.toBeNull();
    expect((screen.getByLabelText('Comment being written') as HTMLTextAreaElement).value).toBe('Why not reuse the helper?');
  });
});
