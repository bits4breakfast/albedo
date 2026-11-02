// @vitest-environment jsdom
/**
 * The Review Guide pane, mounted: writing a guide on demand, its groups and
 * Unsorted, switching files, Reviewed surviving a remount, the keys, the
 * stale banner and a failed write. The diff is built the way git's is
 * (fixtures.ts); the writer runs through its injected runner, never `claude`.
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
vi.mock('../ui/editor/diffComments', () => ({
  useDiffComments: () => ({ annotations: null, notice: null, clearNotice: () => {} }),
}));

const { default: GuidePane, nextToReview } = await import('./GuidePane');
const { resetGuideStoreForTests, saveGuide } = await import('./store');
const { setOneshotRunner } = await import('./writer');

const task = {
  id: 5, title: 't', projectId: 1, repoPath: '/r', baseBranch: 'main', branch: 'feat', worktreePath: '/wt',
  sessionId: null, ownsWorktree: true, createdBranch: true, kind: 'work', status: 'idle', createdAt: 0,
  lastActivityAt: null, seenAt: null,
} as unknown as Task;

function makeDiff(cAt = 5): BranchDiff {
  return buildBranchDiff(
    [edited('src/a.ts', [3, 30], 'alpha'), edited('src/b.ts', [5], 'beta'), edited('src/c.ts', [cAt], 'gamma')],
    statReason,
  );
}

let diff: BranchDiff;
let ids: { a1: string; a2: string; b1: string; c1: string };
let prevRunner: ReturnType<typeof setOneshotRunner>;
let reply: () => { code: number | null; stdout: string; stderr: string; timedOut: boolean };

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
  diff = makeDiff();
  const [a1, a2, b1, c1] = diff.order as [string, string, string, string];
  ids = { a1, a2, b1, c1 };
  loaded = { diff, base: 'base1', fromMergeBase: true, uncommitted: new Set(['src/b.ts']) };
  // c.ts is named by no group: it must land in Unsorted, not vanish.
  const structured = {
    groups: [
      { title: 'Foundations', summary: 'Adds the alpha and beta pieces.', blocks: [a1, b1] },
      { title: 'Wiring', summary: 'Connects them.', blocks: [a2] },
    ],
  };
  reply = () => ({ code: 0, stdout: JSON.stringify({ type: 'result', is_error: false, structured_output: structured }), stderr: '', timedOut: false });
  prevRunner = setOneshotRunner(async () => reply());
});

afterEach(() => {
  cleanup();
  setOneshotRunner(prevRunner);
});

const pane = () => render(<GuidePane task={task} active />);
const root = () => screen.getByLabelText('Review Guide');
const left = () => within(screen.getByRole('region', { name: 'Group' }));
const right = () => within(screen.getByRole('region', { name: 'Diff' }));
const diffText = () => screen.getByRole('region', { name: 'Diff' }).textContent ?? '';
const key = (code: string, altKey = false) => fireEvent.keyDown(root(), { code, key: code, altKey });

async function written() {
  pane();
  fireEvent.click(await screen.findByRole('button', { name: 'Write Guide' }));
  await screen.findByRole('heading', { name: 'Foundations' });
}

describe('GuidePane', () => {
  it('writes a guide on demand and shows its groups, with Unsorted for what it did not place', async () => {
    pane();
    expect(await screen.findByText(/3 files · 4 blocks · against main/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Write Guide' }));
    await screen.findByRole('heading', { name: 'Foundations' });
    expect(left().getByText('01 / 03')).toBeTruthy();
    expect(left().getByText('Adds the alpha and beta pieces.')).toBeTruthy();
    const marks = within(screen.getByRole('navigation', { name: 'Groups' })).getAllByRole('button');
    expect(marks.map((m) => m.getAttribute('aria-label'))).toEqual(['01 Foundations', '02 Wiring', '03 Unsorted']);
    fireEvent.click(marks[2]!);
    expect(screen.getByRole('heading', { name: 'Unsorted' })).toBeTruthy();
    expect(left().getByText('c.ts')).toBeTruthy();
  });

  it('shows the picked file’s diff with only this group’s blocks, and the whole file on request', async () => {
    await written();
    // a.ts has 2 blocks; this group has the first.
    expect(left().getByText(/1 of 2 blocks/)).toBeTruthy();
    await waitFor(() => expect(diffText()).toContain('line 3 alpha'));
    expect(diffText()).not.toContain('line 30 alpha');
    fireEvent.click(right().getByRole('button', { name: 'Whole File (2 blocks)' }));
    await waitFor(() => expect(diffText()).toContain('line 30 alpha'));
    // Another file of the group.
    fireEvent.click(left().getByRole('button', { name: /b\.ts/ }));
    await waitFor(() => expect(diffText()).toContain('line 5 beta'));
    // Albedo's own counts beside each file.
    expect(within(left().getByRole('button', { name: /b\.ts/ })).getByText('+1')).toBeTruthy();
  });

  it('moves with ⌥↑/⌥↓ between groups and ↑/↓ between files', async () => {
    await written();
    key('ArrowDown');
    expect(left().getByRole('button', { name: /b\.ts/ }).getAttribute('aria-current')).toBe('true');
    key('ArrowUp');
    expect(left().getByRole('button', { name: /a\.ts/ }).getAttribute('aria-current')).toBe('true');
    key('ArrowDown', true);
    expect(screen.getByRole('heading', { name: 'Wiring' })).toBeTruthy();
    expect(left().getByText('02 / 03')).toBeTruthy();
    key('ArrowDown', true);
    key('ArrowDown', true); // stops at the last group
    expect(screen.getByRole('heading', { name: 'Unsorted' })).toBeTruthy();
    key('ArrowUp', true);
    expect(screen.getByRole('heading', { name: 'Wiring' })).toBeTruthy();
  });

  it('⌥⏎ marks the group Reviewed and goes on; Reviewed survives leaving and coming back', async () => {
    await written();
    key('Enter', true);
    expect(screen.getByRole('heading', { name: 'Wiring' })).toBeTruthy();
    const marks = within(screen.getByRole('navigation', { name: 'Groups' })).getAllByRole('button');
    expect(marks[0]!.getAttribute('aria-label')).toBe('01 Foundations, reviewed');
    cleanup();
    pane();
    // Back where it was left (#199), then up to the group it reviewed.
    await screen.findByRole('heading', { name: 'Wiring' });
    key('ArrowUp', true);
    expect(screen.getByRole('heading', { name: 'Foundations' })).toBeTruthy();
    expect((left().getByRole('checkbox', { name: 'Reviewed' }) as HTMLInputElement).checked).toBe(true);
    // A reviewed file folds its diff away.
    expect(right().getByText('Reviewed.')).toBeTruthy();
    // Unticking the group unticks its files, and never moves.
    fireEvent.click(left().getByRole('checkbox', { name: 'Reviewed' }));
    expect((left().getByRole('checkbox', { name: 'Reviewed' }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole('heading', { name: 'Foundations' })).toBeTruthy();
  });

  it('ticks a file Reviewed from its diff and moves to the next file to read', async () => {
    await written();
    fireEvent.click(right().getByRole('checkbox', { name: 'Reviewed' }));
    expect(left().getByRole('button', { name: /b\.ts/ }).getAttribute('aria-current')).toBe('true');
    expect(left().getByRole('button', { name: /a\.ts/ }).getAttribute('data-reviewed')).toBe('true');
  });

  it('says which files changed since the guide was written, offers Rewrite, and puts new blocks in Unsorted', async () => {
    saveGuide(task.id, {
      diffHash: diff.hash,
      writtenAt: Date.now(),
      base: 'main',
      groups: [{ title: 'Everything', summary: 'All of it.', blocks: [...diff.order] }],
      files: fileBlockIndex(diff),
      fallback: null,
    });
    const moved = makeDiff(20);
    loaded = { ...loaded, diff: moved };
    pane();
    // The news leads, so a narrow pane cuts the base, not it; only the text is announced.
    await screen.findByRole('heading', { name: 'Everything' });
    const notice = screen.getAllByRole('status').find((s) => s.classList.contains('gd-meta-text'))!;
    expect(notice.textContent).toMatch(/^1 file changed since it was written .* · new changes are under Unsorted · branch vs main$/);
    expect(within(notice).queryByRole('button')).toBeNull();
    const marks = within(screen.getByRole('navigation', { name: 'Groups' })).getAllByRole('button');
    expect(marks.map((m) => m.getAttribute('aria-label'))).toEqual(['01 Everything', '02 Unsorted']);
    // One Rewrite, in the one row that says the guide is out of date (#197).
    expect(screen.getAllByRole('button', { name: 'Rewrite' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Rewrite' }).className).toContain('gd-btn-primary');
  });

  it('a failed write says why, keeps nothing, and offers Try Again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    reply = () => ({ code: null, stdout: '', stderr: '', timedOut: true });
    pane();
    fireEvent.click(await screen.findByRole('button', { name: 'Write Guide' }));
    expect(await screen.findByText('Claude Code took too long')).toBeTruthy();
    expect(screen.getByText(/Nothing was saved/)).toBeTruthy();
    reply = () => ({
      code: 0,
      stdout: JSON.stringify({
        type: 'result',
        structured_output: { groups: [{ title: 'Second try', summary: '', blocks: [ids.a1] }] },
      }),
      stderr: '',
      timedOut: false,
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    });
    expect(await screen.findByRole('heading', { name: 'Second try' })).toBeTruthy();
  });

  it('filters to uncommitted files', async () => {
    await written();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Uncommitted Only' }));
    // Only b.ts is uncommitted: Foundations keeps it, Wiring and Unsorted drop out.
    expect(left().queryByRole('button', { name: /a\.ts/ })).toBeNull();
    expect(left().getByRole('button', { name: /b\.ts/ })).toBeTruthy();
    expect(within(screen.getByRole('navigation', { name: 'Groups' })).getAllByRole('button')).toHaveLength(1);
  });
});

describe('GuidePane keeps your place (#199)', () => {
  it('leaving for another task and coming back keeps the group and the file, with no "Reading" in between', async () => {
    await written();
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Groups' })).getAllByRole('button')[0]!);
    fireEvent.click(left().getByRole('button', { name: /b\.ts/ }));
    key('ArrowDown', true);
    expect(screen.getByRole('heading', { name: 'Wiring' })).toBeTruthy();
    key('ArrowUp', true);
    expect(left().getByRole('button', { name: /b\.ts/ }).getAttribute('aria-current')).toBe('true');
    key('ArrowDown', true);

    // The pane goes when another task is selected (App keys it per task).
    cleanup();
    pane();
    expect(screen.queryByText(/Reading the branch/)).toBeNull();
    expect(screen.getByRole('heading', { name: 'Wiring' })).toBeTruthy();
    key('ArrowUp', true);
    expect(left().getByRole('button', { name: /b\.ts/ }).getAttribute('aria-current')).toBe('true');
  });

  it('with no place kept, opens at the first group still to review', async () => {
    await written();
    fireEvent.click(left().getByRole('checkbox', { name: 'Reviewed' }));
    cleanup();
    // A restart: memory is gone, the guide and its Reviewed marks are not.
    resetGuideStoreForTests();
    pane();
    expect(await screen.findByRole('heading', { name: 'Wiring' })).toBeTruthy();
  });

  it('keeps the group by name, not number, across Uncommitted Only', async () => {
    await written();
    key('ArrowDown', true);
    expect(screen.getByRole('heading', { name: 'Wiring' })).toBeTruthy();
    // Only b.ts is uncommitted, so Wiring (a.ts) is filtered out, then back.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Uncommitted Only' }));
    expect(screen.getByRole('heading', { name: 'Foundations' })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Uncommitted Only' }));
    expect(screen.getByRole('heading', { name: 'Wiring' })).toBeTruthy();
  });

  it('Rewrite writes for the branch as it is now, not the read on screen', async () => {
    const { loadGuide } = await import('./store');
    await written();
    // The branch moves on while the pane still shows the earlier read.
    const moved = makeDiff(20);
    loaded = { ...loaded, diff: moved };
    fireEvent.click(screen.getByRole('button', { name: 'Rewrite' }));
    await waitFor(() => expect(loadGuide(task.id)?.diffHash).toBe(moved.hash));
  });
});

describe('Reviewed moves you on (#201)', () => {
  const rail = () => within(screen.getByRole('navigation', { name: 'Groups' }));
  const said = () =>
    screen
      .getAllByRole('status')
      .map((s) => s.textContent)
      .join('|');

  it('picks the next group not yet reviewed: after this one, then any skipped before it', () => {
    const done = [true, false, true, false];
    const at = (i: number) => nextToReview([0, 1, 2, 3], i, (g) => done[g]!);
    expect(at(1)).toBe(3);
    expect(at(3)).toBe(1);
    expect(at(0)).toBe(1);
    expect(nextToReview([0, 1], 0, () => true)).toBeNull();
    expect(nextToReview([0], 0, () => false)).toBeNull();
  });

  it('⌥⏎ skips groups already reviewed, wraps to one skipped, and stays once all are done', async () => {
    await written();
    key('ArrowDown', true); // skip Foundations
    key('Enter', true);
    expect(screen.getByRole('heading', { name: 'Unsorted' })).toBeTruthy();
    expect(said()).toContain('Group 3 of 3: Unsorted');
    key('Enter', true);
    expect(screen.getByRole('heading', { name: 'Foundations' })).toBeTruthy();
    expect(rail().getByText('2 of 3 groups reviewed')).toBeTruthy();
    key('Enter', true);
    // Nothing left: it stays, and says so.
    expect(screen.getByRole('heading', { name: 'Foundations' })).toBeTruthy();
    expect(left().getByText('All 3 groups reviewed')).toBeTruthy();
    expect(said()).toContain('All 3 groups reviewed');
  });

  it('ticking the last file still to read finishes the group and moves to the next', async () => {
    await written();
    fireEvent.click(right().getByRole('checkbox', { name: 'Reviewed' })); // a.ts, on to b.ts
    expect(screen.getByRole('heading', { name: 'Foundations' })).toBeTruthy();
    fireEvent.click(right().getByRole('checkbox', { name: 'Reviewed' })); // b.ts, the last
    expect(screen.getByRole('heading', { name: 'Wiring' })).toBeTruthy();
    expect(rail().getAllByRole('button')[0]!.getAttribute('aria-label')).toBe('01 Foundations, reviewed');
  });

  it('the group’s own Reviewed box moves on too', async () => {
    await written();
    fireEvent.click(left().getByRole('checkbox', { name: 'Reviewed' }));
    expect(screen.getByRole('heading', { name: 'Wiring' })).toBeTruthy();
  });

  it('arrives at the first file still to read, not a reviewed one picked earlier', async () => {
    await written();
    fireEvent.click(left().getByRole('button', { name: /b\.ts/ }));
    fireEvent.click(right().getByRole('checkbox', { name: 'Reviewed' })); // b.ts, on to a.ts
    fireEvent.click(left().getByRole('button', { name: /b\.ts/ })); // back on the reviewed one
    key('ArrowDown', true);
    key('Enter', true); // Wiring, on to Unsorted
    key('Enter', true); // Unsorted, wraps to Foundations
    expect(screen.getByRole('heading', { name: 'Foundations' })).toBeTruthy();
    expect(left().getByRole('button', { name: /a\.ts/ }).getAttribute('aria-current')).toBe('true');
  });

  it('a click on the rail says nothing more than the button it is', async () => {
    await written();
    fireEvent.click(rail().getAllByRole('button')[1]!);
    expect(screen.getByRole('heading', { name: 'Wiring' })).toBeTruthy();
    expect(said()).not.toContain('Group 2 of 3');
    expect(rail().getAllByRole('button')[1]!.getAttribute('title')).toBe('02 Wiring');
  });
});
