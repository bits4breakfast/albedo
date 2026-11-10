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
import type { Guide } from './validate';

let loaded: LoadedBranchDiff;
vi.mock('./branchDiff', () => ({ loadBranchDiff: async () => loaded }));
let openComments: Array<{ path: string; lineStart: number; anchorText: string; resolvedAt: number | null }> = [];
vi.mock('./commentMarks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./commentMarks')>()),
  useOpenComments: () => openComments,
}));
let waitingCode: Array<{ id: number }> = [];
vi.mock('../ui/transcript/codeComments', () => ({ useWaitingCodeComments: () => waitingCode }));
vi.mock('../ui/transcript/drafts', () => ({ useComments: () => [] }));
const sendAsked: number[] = [];
vi.mock('../ui/transcript/composerBridge', () => ({ sendWaitingComments: (id: number) => (sendAsked.push(id), true) }));
vi.mock('./repoFiles', () => ({ repoFiles: async () => new Set<string>() }));
vi.mock('../ui/editor/diffComments', () => ({
  useDiffComments: () => ({ annotations: null, notice: null, clearNotice: () => {}, bar: null }),
}));

const { default: GuidePane, nextToReview, resetGuideViewsForTests } = await import('./GuidePane');
const { resetGuideStoreForTests, saveGuide } = await import('./store');
const { setOneshotRunner } = await import('./writer');
const queuedCi = await import('../ui/transcript/ciFailure');

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
  resetGuideViewsForTests();
  queuedCi.__resetQueuedCi();
  openComments = [];
  waitingCode = [];
  sendAsked.length = 0;
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
    // A reviewed file still shows its diff, ticked (#228).
    expect(right().queryByText('Reviewed.')).toBeNull();
    expect(right().queryByRole('button', { name: 'Show Diff' })).toBeNull();
    expect((right().getByRole('checkbox', { name: 'Reviewed' }) as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Diff' }).querySelector('.tx-d-code')).not.toBeNull());
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

  it('says which files changed since the guide was written, offers Rewrite, and keeps changes in their groups (#248)', async () => {
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
    expect(notice.textContent).toMatch(/^1 file changed since it was written .* · shown in their groups, to review again · branch vs main$/);
    expect(within(notice).queryByRole('button')).toBeNull();
    const marks = within(screen.getByRole('navigation', { name: 'Groups' })).getAllByRole('button');
    expect(marks.map((m) => m.getAttribute('aria-label'))).toEqual(['01 Everything']);
    // One Rewrite, in the one row that says the guide is out of date (#197).
    expect(screen.getAllByRole('button', { name: 'Rewrite' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Rewrite' }).className).toContain('gd-btn-primary');
  });

  it('a reviewed group with a file changed since goes back to unreviewed, the file tagged (#248)', async () => {
    const { setReviewed, reviewedKey } = await import('./store');
    saveGuide(task.id, {
      diffHash: diff.hash,
      writtenAt: Date.now(),
      base: 'main',
      groups: [
        { title: 'Alpha', summary: '', blocks: [ids.a1, ids.a2] },
        { title: 'Rest', summary: '', blocks: [ids.b1, ids.c1] },
      ],
      files: fileBlockIndex(diff),
      fallback: null,
    });
    // Everything reviewed, as the owner had it.
    setReviewed(task.id, [reviewedKey('src/a.ts', [ids.a1, ids.a2]), reviewedKey('src/b.ts', [ids.b1]), reviewedKey('src/c.ts', [ids.c1])], true);
    // Then src/c.ts changes: its one hunk gets a new id.
    loaded = { ...loaded, diff: makeDiff(20) };
    pane();
    // It opens on the group still to review.
    await screen.findByRole('heading', { name: 'Rest' });
    const rail = within(screen.getByRole('navigation', { name: 'Groups' }));
    // No Unsorted, and Rest -- which holds the change -- is not Reviewed.
    expect(rail.getAllByRole('button').map((m) => m.getAttribute('aria-label'))).toEqual(['01 Alpha, reviewed', '02 Rest']);
    // The changed file is tagged; the unchanged one beside it is not.
    const c = left().getByRole('button', { name: /c\.ts/ });
    expect(c.textContent).toContain('changed since review');
    expect(c.hasAttribute('data-reviewed')).toBe(false);
    expect(left().getByRole('button', { name: /b\.ts/ }).textContent).not.toContain('changed since review');
  });

  it('says how big the whole change is, right after the base (#250)', async () => {
    saveGuide(task.id, {
      diffHash: diff.hash,
      writtenAt: Date.now(),
      base: 'main',
      groups: [{ title: 'Everything', summary: '', blocks: [...diff.order] }],
      files: fileBlockIndex(diff),
      fallback: null,
    });
    pane();
    await screen.findByRole('heading', { name: 'Everything' });
    // src/a.ts two lines, b.ts and c.ts one each: every edit is one in, one out.
    const totals = screen.getByRole('note', { name: /files changed/ });
    expect(totals.getAttribute('aria-label')).toBe('3 files changed, 4 lines added, 4 removed, branch vs main');
    expect(totals.textContent).toBe('· 3 files+4−4');
    // The whole change, not the Uncommitted Only filter's (only src/b.ts here).
    fireEvent.click(screen.getByRole('checkbox', { name: 'Uncommitted Only' }));
    expect(screen.getByRole('note', { name: /files changed/ }).getAttribute('aria-label')).toMatch(/^3 files changed/);
  });

  it('shows where comments are: a count on the file, in its diff header, and a dot on the group in the rail (#252)', async () => {
    saveGuide(task.id, {
      diffHash: diff.hash,
      writtenAt: Date.now(),
      base: 'main',
      groups: [
        { title: 'Foundations', summary: '', blocks: [ids.a1, ids.b1] },
        { title: 'Wiring', summary: '', blocks: [ids.a2, ids.c1] },
      ],
      files: fileBlockIndex(diff),
      fallback: null,
    });
    // Two on src/b.ts, one on src/c.ts, one resolved (never counted).
    openComments = [
      { path: 'src/b.ts', lineStart: 5, anchorText: 'line 5 beta', resolvedAt: null },
      { path: 'src/b.ts', lineStart: 6, anchorText: 'line 6', resolvedAt: null },
      { path: 'src/c.ts', lineStart: 5, anchorText: 'line 5 gamma', resolvedAt: null },
      { path: 'src/a.ts', lineStart: 3, anchorText: 'line 3 alpha', resolvedAt: 7 },
    ];
    pane();
    await screen.findByRole('heading', { name: 'Foundations' });
    const rail = within(screen.getByRole('navigation', { name: 'Groups' }));
    // The counts arrive once the comments load, after the heading: wait for
    // them everywhere they show, not only in the diff header (#305 did that one).
    await waitFor(() => expect(rail.getAllByRole('button')[0]!.getAttribute('aria-label')).toBe('01 Foundations, 2 comments'));
    const [one, two] = rail.getAllByRole('button');
    expect(one!.getAttribute('aria-label')).toBe('01 Foundations, 2 comments');
    expect(one!.hasAttribute('data-comments')).toBe(true);
    expect(two!.getAttribute('aria-label')).toBe('02 Wiring, 1 comment');
    // The file row says it; the one without comments says nothing.
    expect(await within(left().getByRole('button', { name: /b\.ts/ })).findByRole('img', { name: '2 comments' })).toBeTruthy();
    expect(within(left().getByRole('button', { name: /a\.ts/ })).queryByRole('img', { name: /comment/ })).toBeNull();
    // Open src/b.ts: its diff header says it too.
    fireEvent.click(left().getByRole('button', { name: /b\.ts/ }));
    // The diff header's count arrives after the file's comments load, which
    // is a tick later under a busy full-suite run: wait for it, don't assume.
    expect(await right().findByRole('img', { name: '2 comments' })).toBeTruthy();
  });

  describe('Send Comments (#254)', () => {
    const save = (hash = diff.hash) =>
      saveGuide(task.id, {
        diffHash: hash,
        writtenAt: Date.now(),
        base: 'main',
        groups: [{ title: 'Everything', summary: '', blocks: [...diff.order] }],
        files: fileBlockIndex(diff),
        fallback: null,
      });

    it('none waiting: no button, Rewrite as before', async () => {
      save();
      pane();
      await screen.findByRole('heading', { name: 'Everything' });
      expect(screen.queryByRole('button', { name: /^Send \d/ })).toBeNull();
    });

    it('comments waiting: Send N Comments leads the row; a click sends them (and the shell shows the transcript)', async () => {
      save();
      waitingCode = [{ id: 1 }, { id: 2 }];
      pane();
      await screen.findByRole('heading', { name: 'Everything' });
      const send = screen.getByRole('button', { name: 'Send 2 Comments' });
      expect(send.className).toContain('gd-btn-primary');
      expect(screen.getByRole('button', { name: 'Rewrite' }).className).not.toContain('gd-btn-primary');
      // sendWaitingComments sends, then has the shell show the transcript.
      fireEvent.click(send);
      expect(sendAsked).toEqual([task.id]);
    });

    it('⌘⏎ in the guide sends them too; in a comment box it never does (#256)', async () => {
      save();
      waitingCode = [{ id: 1 }];
      pane();
      await screen.findByRole('heading', { name: 'Everything' });
      const box = document.createElement('textarea');
      root().appendChild(box);
      fireEvent.keyDown(box, { code: 'Enter', key: 'Enter', metaKey: true });
      expect(sendAsked).toEqual([]);
      fireEvent.keyDown(root(), { code: 'Enter', key: 'Enter', metaKey: true });
      expect(sendAsked).toEqual([task.id]);
      expect(screen.getByRole('button', { name: 'Send 1 Comment' }).getAttribute('aria-keyshortcuts')).toBe('Meta+Enter');
    });

    it('a queued CI failure (#280) counts: Send CI Failure + N Comments, or Send CI Failure alone', async () => {
      const { observeCiQueue, removeQueuedCi } = queuedCi;
      const prAt = {
        number: 6102, url: '', title: '', state: 'open', headRefName: 'b', baseRefName: 'main', headSha: 'abc', mergedAt: null,
        review: null, checks: { kind: 'failing', failing: 1, total: 1 }, lines: [{ name: 'build', bucket: 'fail', url: null }],
      } as unknown as import('../gh/prStatus').PrStatus;
      observeCiQueue(task.id, prAt);
      save();
      waitingCode = [{ id: 1 }, { id: 2 }];
      pane();
      await screen.findByRole('heading', { name: 'Everything' });
      expect(screen.getByRole('button', { name: 'Send CI Failure + 2 Comments' })).toBeTruthy();
      cleanup();
      waitingCode = [];
      pane();
      await screen.findByRole('heading', { name: 'Everything' });
      fireEvent.click(screen.getByRole('button', { name: 'Send CI Failure' }));
      expect(sendAsked).toEqual([task.id]);
      removeQueuedCi(task.id, 'abc');
      await waitFor(() => expect(screen.queryByRole('button', { name: /^Send CI/ })).toBeNull());
    });

    it('⌘⏎ with nothing waiting does nothing', async () => {
      save();
      pane();
      await screen.findByRole('heading', { name: 'Everything' });
      fireEvent.keyDown(root(), { code: 'Enter', key: 'Enter', metaKey: true });
      expect(sendAsked).toEqual([]);
    });

    it('out of date: Rewrite stays the primary, Send is plain beside it', async () => {
      save('stale-hash');
      waitingCode = [{ id: 1 }];
      pane();
      await screen.findByRole('heading', { name: 'Everything' });
      expect(screen.getByRole('button', { name: 'Send 1 Comment' }).className).not.toContain('gd-btn-primary');
      expect(screen.getByRole('button', { name: 'Rewrite' }).className).toContain('gd-btn-primary');
    });
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

  it('a group opens at the last file opened in it, even one reviewed since', async () => {
    await written();
    fireEvent.click(left().getByRole('button', { name: /b\.ts/ }));
    fireEvent.click(right().getByRole('checkbox', { name: 'Reviewed' })); // b.ts, on to a.ts
    fireEvent.click(left().getByRole('button', { name: /b\.ts/ })); // back on the reviewed one
    key('ArrowDown', true);
    key('Enter', true); // Wiring, on to Unsorted
    key('Enter', true); // Unsorted, wraps to Foundations
    expect(screen.getByRole('heading', { name: 'Foundations' })).toBeTruthy();
    expect(left().getByRole('button', { name: /b\.ts/ }).getAttribute('aria-current')).toBe('true');
  });

  it('on a first visit, a group opens at its first file still to read', async () => {
    await written();
    fireEvent.click(right().getByRole('checkbox', { name: 'Reviewed' })); // a.ts
    cleanup();
    resetGuideStoreForTests(); // a restart: no place kept, the marks are
    pane();
    expect(await screen.findByRole('heading', { name: 'Foundations' })).toBeTruthy();
    expect(left().getByRole('button', { name: /b\.ts/ }).getAttribute('aria-current')).toBe('true');
  });

  it('with every file reviewed and none opened, a group opens at its first file', async () => {
    await written();
    fireEvent.click(left().getByRole('checkbox', { name: 'Reviewed' })); // all of Foundations
    cleanup();
    resetGuideStoreForTests(); // a restart: nothing opened is remembered
    pane();
    expect(await screen.findByRole('heading', { name: 'Wiring' })).toBeTruthy();
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Groups' })).getAllByRole('button')[0]!);
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

describe('file notes (#202, #264)', () => {
  const both = buildBranchDiff(
    [edited('src/a.ts', [3, 4, 5], 'alpha'), edited('src/b.ts', [5], 'beta'), edited('src/c.ts', [3, 4, 5], 'gamma')],
    statReason,
  );
  const save = (group: Partial<Guide['groups'][number]>) => {
    loaded = { ...loaded, diff: both };
    saveGuide(task.id, {
      diffHash: both.hash,
      writtenAt: Date.now(),
      base: 'main',
      groups: [{ title: 'Both', summary: 'S.', blocks: [...both.order], ...group }],
      files: fileBlockIndex(both),
      fallback: null,
    });
  };
  const why = () => screen.getByRole('region', { name: 'Diff' }).querySelector('.gd-diff-why');

  it('the list shows each file’s short line under its name; the open file’s why is under the diff’s header', async () => {
    save({
      notes: { 'src/a.ts': 'So every caller pages alike.', 'src/b.ts': 'registers it' },
      lines: { 'src/a.ts': 'Holds the page size', 'src/b.ts': 'registers it', 'src/c.ts': 'Line only' },
    });
    pane();
    await screen.findByRole('heading', { name: 'Both' });
    const a = left().getByRole('button', { name: /a\.ts/ });
    const line = within(a).getByText('Holds the page size');
    expect(line.className).toBe('gd-file-line');
    expect(line.getAttribute('title')).toBe('Holds the page size');
    // The why is never in the list.
    expect(left().queryByText('So every caller pages alike.')).toBeNull();
    // b.ts is +1 -1: neither text, its diff says it.
    expect(left().queryByText('registers it')).toBeNull();
    // a.ts is open: its why sits under the header, before the diff's scroll.
    const band = why()!;
    expect(band.textContent).toBe('WhySo every caller pages alike.');
    expect(band.previousElementSibling!.className).toBe('gd-diff-head');
    expect(right().getByText('Why').className).toBe('gd-diff-why-label');
    // c.ts has a line and no why: the pane shows nothing extra.
    fireEvent.click(left().getByRole('button', { name: /c\.ts/ }));
    await waitFor(() => expect(right().getByText('c.ts')).toBeTruthy());
    expect(why()).toBeNull();
  });

  it('the diff has one header row: the layout toggle sits beside the size, and the diff draws no head of its own', async () => {
    save({});
    pane();
    await screen.findByRole('heading', { name: 'Both' });
    const region = screen.getByRole('region', { name: 'Diff' });
    await waitFor(() => expect(region.querySelector('.tx-d-code')).not.toBeNull());
    expect(region.querySelector('.tx-d-head')).toBeNull();
    const toggle = right().getByRole('button', { name: 'Split View' });
    expect(toggle.textContent).toBe('Split');
    expect(toggle.parentElement!.className).toBe('gd-diff-head');
    expect(toggle.previousElementSibling!.className).toBe('gd-counts');
    expect(region.querySelector('.tx-d-unified')).not.toBeNull();
    fireEvent.click(toggle);
    expect(region.querySelector('.tx-d-split')).not.toBeNull();
    expect(right().getByRole('button', { name: 'Unified View' })).toBeTruthy();
  });

  it('a guide from before #264 (the why only): no text row in the list, the why in the pane', async () => {
    save({ notes: { 'src/a.ts': 'the value object' } });
    pane();
    await screen.findByRole('heading', { name: 'Both' });
    expect(left().queryByText('the value object')).toBeNull();
    expect(screen.getByRole('region', { name: 'Group' }).querySelector('.gd-file-line')).toBeNull();
    expect(why()!.textContent).toBe('Whythe value object');
  });

  it('a file with no note shows nothing extra in either place', async () => {
    save({ notes: {} });
    pane();
    await screen.findByRole('heading', { name: 'Both' });
    expect(screen.getByRole('region', { name: 'Group' }).querySelector('.gd-file-line')).toBeNull();
    expect(why()).toBeNull();
  });
});

describe('notes after the groups (#224)', () => {
  // Three groups of two files, each +3 -3: all are asked about.
  let big: BranchDiff;
  let calls: Array<{ group: string | null; answer: (o: ReturnType<typeof reply>) => void }>;
  const ok = (structured: unknown) => ({ code: 0, stdout: JSON.stringify({ type: 'result', is_error: false, structured_output: structured }), stderr: '', timedOut: false });
  beforeEach(() => {
    big = buildBranchDiff(
      ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts'].map((p) => edited(p, [3, 4, 5], 'x')),
      statReason,
    );
    loaded = { ...loaded, diff: big };
    const at = (p: string) => big.files.find((f) => f.path === p)!.blocks;
    saveGuide(task.id, {
      diffHash: big.hash,
      writtenAt: Date.now(),
      base: 'main',
      groups: [
        { title: 'First', summary: 'S1.', blocks: [...at('src/a.ts'), ...at('src/b.ts')] },
        { title: 'Second', summary: 'S2.', blocks: [...at('src/c.ts'), ...at('src/d.ts')] },
        { title: 'Third', summary: 'S3.', blocks: [...at('src/e.ts'), ...at('src/f.ts')] },
      ],
      files: fileBlockIndex(big),
      fallback: null,
    });
    calls = [];
    setOneshotRunner(
      (req) =>
        new Promise((answer) => {
          calls.push({ group: /^Group: (.*)$/m.exec(req.prompt)?.[1] ?? null, answer });
        }),
    );
  });

  it('shows the groups at once, a placeholder where each line will be, then the line and the why', async () => {
    pane();
    await screen.findByRole('heading', { name: 'First' });
    await waitFor(() => expect(calls.map((c) => c.group)).toEqual(['First']));
    expect(screen.getAllByTestId('note-pending')).toHaveLength(2);
    act(() =>
      calls[0]!.answer(
        ok({
          notes: [
            { path: 'src/a.ts', line: 'What a does', note: 'Why a changes.' },
            { path: 'src/b.ts', line: 'What b does', note: 'Why b changes.' },
          ],
        }),
      ),
    );
    await waitFor(() => expect(left().getByText('What a does').className).toBe('gd-file-line'));
    expect(screen.queryAllByTestId('note-pending')).toHaveLength(0);
    expect(left().queryByText('Why a changes.')).toBeNull();
    expect(right().getByText('Why a changes.')).toBeTruthy();
  });

  it('the group you move to is asked about next', async () => {
    pane();
    await screen.findByRole('heading', { name: 'First' });
    await waitFor(() => expect(calls).toHaveLength(1));
    // First is in flight; the reader skips ahead to Third, which goes before Second.
    key('ArrowDown', true);
    key('ArrowDown', true);
    expect(screen.getByRole('heading', { name: 'Third' })).toBeTruthy();
    expect(screen.getAllByTestId('note-pending')).toHaveLength(2);
    act(() => calls[0]!.answer(ok({ notes: [] })));
    await waitFor(() => expect(calls.map((c) => c.group)).toEqual(['First', 'Third']));
  });

  it('a failed group says so quietly, with Retry, and the guide stays', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    pane();
    await screen.findByRole('heading', { name: 'First' });
    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => calls[0]!.answer({ code: null, stdout: '', stderr: '', timedOut: true }));
    await waitFor(() => expect(left().getByText(/Notes could not be written/)).toBeTruthy());
    expect(screen.queryAllByTestId('note-pending')).toHaveLength(0);
    expect(screen.getByRole('heading', { name: 'First' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    // The others go on; then Retry puts First back.
    await waitFor(() => expect(calls).toHaveLength(2));
    act(() => calls[1]!.answer(ok({ notes: [] })));
    await waitFor(() => expect(calls).toHaveLength(3));
    act(() => calls[2]!.answer(ok({ notes: [] })));
    fireEvent.click(left().getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls.map((c) => c.group)).toEqual(['First', 'Second', 'Third', 'First']));
    expect(screen.getAllByTestId('note-pending')).toHaveLength(2);
    act(() => calls[3]!.answer(ok({ notes: [{ path: 'src/a.ts', line: 'Now written', note: 'Why, now written.' }] })));
    await waitFor(() => expect(left().getByText('Now written')).toBeTruthy());
    expect(left().queryByText(/Notes could not be written/)).toBeNull();
    warn.mockRestore();
  });
});

describe('⇧⌘G puts focus in the guide (#217)', () => {
  let typing: HTMLTextAreaElement;
  beforeEach(async () => {
    const { resetGuideFocusForTests } = await import('./openGuide');
    resetGuideFocusForTests();
    typing = document.createElement('textarea');
    typing.setAttribute('aria-label', 'message');
    document.body.appendChild(typing);
    typing.focus();
  });
  afterEach(() => typing.remove());

  const saved = () =>
    saveGuide(task.id, {
      diffHash: diff.hash,
      writtenAt: Date.now(),
      base: 'main',
      groups: [{ title: 'Everything', summary: 'All of it.', blocks: [...diff.order] }],
      files: fileBlockIndex(diff),
      fallback: null,
    });

  it('without the key, the guide leaves focus where someone is typing', async () => {
    saved();
    pane();
    await screen.findByRole('heading', { name: 'Everything' });
    expect(document.activeElement).toBe(typing);
  });

  it('the key takes focus from the message box into the guide, once the branch is read', async () => {
    const { requestGuide } = await import('./openGuide');
    saved();
    requestGuide(task.id, { focus: true });
    pane();
    await screen.findByRole('heading', { name: 'Everything' });
    await waitFor(() => expect(document.activeElement).toBe(root()));
    // Its keys now work: ↓ to the next file, sent where focus now is.
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown', code: 'ArrowDown' });
    expect(left().getByRole('button', { name: /b\.ts/ }).getAttribute('aria-current')).toBe('true');
  });

  it('pressed again with the guide already open, it focuses it again', async () => {
    const { requestGuide } = await import('./openGuide');
    saved();
    pane();
    await screen.findByRole('heading', { name: 'Everything' });
    typing.focus();
    act(() => void requestGuide(task.id, { focus: true }));
    // Waited for, not read at once: under load the pane's subscription to
    // focus requests can attach just after the request; React re-checks on
    // attaching and focus follows a moment later.
    await waitFor(() => expect(document.activeElement).toBe(root()));
  });

  it('with no guide yet, focus goes to Write Guide', async () => {
    const { requestGuide } = await import('./openGuide');
    requestGuide(task.id, { focus: true });
    pane();
    const write = await screen.findByRole('button', { name: 'Write Guide' });
    await waitFor(() => expect(document.activeElement).toBe(write));
  });

  it('another task’s request, or one that waited too long, takes nothing', async () => {
    const { requestGuide, takeGuideFocus, FOCUS_WINDOW_MS } = await import('./openGuide');
    saved();
    requestGuide(task.id + 1, { focus: true });
    pane();
    await screen.findByRole('heading', { name: 'Everything' });
    expect(document.activeElement).toBe(typing);
    requestGuide(task.id, { focus: true });
    expect(takeGuideFocus(task.id, Date.now() + FOCUS_WINDOW_MS + 1)).toBe(false);
    // Taken (and lapsed) once: nothing left to take.
    expect(takeGuideFocus(task.id)).toBe(false);
  });
});

describe('the Map (#288)', () => {
  const map = () => within(screen.getByRole('region', { name: 'Map' }));
  const mapKey = () => within(screen.getByRole('region', { name: 'Map key' }));

  it('Read · Map sits in the toolbar row; Map shows each file as a box, in its groups, and says why there are no arrows', async () => {
    await written();
    const view = screen.getByRole('group', { name: 'View' });
    expect(within(view).getByRole('button', { name: 'Read' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(view).getByRole('button', { name: 'Map' }));
    expect(within(view).getByRole('button', { name: 'Map' }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(map().getAllByRole('button')).toHaveLength(3));
    // a.ts is in two groups: one box, both named.
    expect(map().getByRole('button', { name: /^src\/a\.ts; Foundations and Wiring/ })).toBeTruthy();
    expect(mapKey().getAllByRole('button').map((b) => b.textContent)).toEqual(['Foundations2 files', 'Wiring1 file', 'Unsorted1 file']);
    expect(mapKey().getByText('None of these files imports another.')).toBeTruthy();
    // No rail and no diff while the map is up.
    expect(screen.queryByRole('navigation', { name: 'Groups' })).toBeNull();
  });

  it('a click on a box opens that file in Read, in its group', async () => {
    await written();
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    fireEvent.click(await map().findByRole('button', { name: /^src\/c\.ts;/ }));
    expect(await screen.findByRole('heading', { name: 'Unsorted' })).toBeTruthy();
    expect(left().getByRole('button', { name: /c\.ts/ }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: 'Read' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('a click on a group in the key opens that group in Read', async () => {
    await written();
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    fireEvent.click(await mapKey().findByRole('button', { name: /Wiring/ }));
    expect(await screen.findByRole('heading', { name: 'Wiring' })).toBeTruthy();
  });

  it('hovering or focusing a group in the key rings its boxes, and only those (#308)', async () => {
    await written();
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    const wiring = await mapKey().findByRole('button', { name: /Wiring/ });
    const box = (name: RegExp) => map().getByRole('button', { name });
    fireEvent.mouseEnter(wiring);
    expect(box(/^src\/a\.ts;/).hasAttribute('data-group-hot')).toBe(true);
    expect(box(/^src\/b\.ts;/).hasAttribute('data-group-hot')).toBe(false);
    expect(box(/^src\/c\.ts;/).hasAttribute('data-group-hot')).toBe(false);
    fireEvent.mouseLeave(wiring);
    expect(box(/^src\/a\.ts;/).hasAttribute('data-group-hot')).toBe(false);
    // Focus does the same, for the keyboard.
    fireEvent.focus(mapKey().getByRole('button', { name: /Foundations/ }));
    expect(box(/^src\/a\.ts;/).hasAttribute('data-group-hot')).toBe(true);
    expect(box(/^src\/b\.ts;/).hasAttribute('data-group-hot')).toBe(true);
    expect(box(/^src\/c\.ts;/).hasAttribute('data-group-hot')).toBe(false);
  });

  it('the file open in Read is the current box', async () => {
    await written();
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    const a = await map().findByRole('button', { name: /^src\/a\.ts;/ });
    expect(a.getAttribute('aria-current')).toBe('true');
    expect(map().getByRole('button', { name: /^src\/b\.ts;/ }).getAttribute('aria-current')).toBeNull();
  });

  it('Uncommitted Only applies to the map too, and the group keys stay Read’s', async () => {
    await written();
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    fireEvent.click(screen.getByLabelText('Uncommitted Only'));
    await waitFor(() => expect(map().getAllByRole('button')).toHaveLength(1));
    expect(map().getByRole('button', { name: /^src\/b\.ts;/ })).toBeTruthy();
    fireEvent.keyDown(root(), { code: 'ArrowDown', key: 'ArrowDown', altKey: true });
    expect(screen.getByRole('button', { name: 'Map' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('opening from the map keeps focus in the guide, so its keys work at once (#288 review)', async () => {
    await written();
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    const box = await map().findByRole('button', { name: /^src\/b\.ts;/ });
    box.focus();
    fireEvent.click(box);
    expect(document.activeElement).toBe(root());
    // b.ts is the second of Foundations' files: ↑ goes to the first.
    fireEvent.keyDown(document.activeElement!, { code: 'ArrowUp', key: 'ArrowUp' });
    expect(left().getByRole('button', { name: /a\.ts/ }).getAttribute('aria-current')).toBe('true');
    // From the key too.
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    const row = await within(screen.getByRole('region', { name: 'Map key' })).findByRole('button', { name: /Wiring/ });
    row.focus();
    fireEvent.click(row);
    expect(document.activeElement).toBe(root());
  });

  it('a row too narrow for everything puts Read · Map and Uncommitted Only in a ⋯ (#288 review)', async () => {
    const sw = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
    const cw = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get() { return this.classList.contains('gd-meta') ? 600 : 0; } });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.classList.contains('gd-meta') ? 500 : 0; } });
    try {
      await written();
      await waitFor(() => expect(screen.queryByRole('group', { name: 'View' })).toBeNull());
      expect(screen.queryByLabelText('Uncommitted Only')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'More guide actions' }));
      fireEvent.click(screen.getByRole('menuitemradio', { name: 'Map' }));
      expect(await screen.findByRole('region', { name: 'Map' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'More guide actions' }));
      expect(screen.getByRole('menuitemradio', { name: 'Map' }).getAttribute('aria-checked')).toBe('true');
      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Uncommitted Only' }));
      await waitFor(() => expect(map().getAllByRole('button')).toHaveLength(1));
    } finally {
      // jsdom keeps both on Element.prototype: dropping the overrides restores them.
      if (sw) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', sw);
      else delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
      if (cw) Object.defineProperty(HTMLElement.prototype, 'clientWidth', cw);
      else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    }
  });

  it('coming back to the task keeps the view it was left in', async () => {
    await written();
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    cleanup();
    pane();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Map' }).getAttribute('aria-pressed')).toBe('true'));
  });
});
