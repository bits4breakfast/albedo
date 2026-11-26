// @vitest-environment jsdom
/**
 * The review gate (#464): Create PR waits until the guide is written for the
 * branch as it is now and every counted group is Reviewed. Pure rules first,
 * then the store: a read of the branch decides "out of date", the commits
 * since the guide are counted, Set Aside does not count, and marks on blocks
 * that did not change survive a rewrite.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildBranchDiff, fileBlockIndex, type BranchDiff } from './blocks';
import { statReason } from './budget';
import { edited } from './fixtures';
import type { LoadedBranchDiff } from './branchDiff';
import { keepLastRead, resetGuideStoreForTests, reviewedKey, saveGuide, setReviewed } from './store';
import type { Guide } from './validate';
import {
  currentGate,
  freshGate,
  gateFrom,
  gatePasses,
  gateProgressText,
  gateReason,
  gateRowText,
  resetGateForTests,
  reviewCount,
  setGateReaderForTests,
  type GateTask,
} from './gate';

let data: Map<string, string>;
beforeEach(() => {
  data = new Map();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
  resetGuideStoreForTests();
  resetGateForTests();
});
afterEach(() => resetGateForTests());

const diffOf = (cAt = 5): BranchDiff =>
  buildBranchDiff([edited('src/a.ts', [3]), edited('src/b.ts', [5]), edited('src/c.ts', [cAt])], statReason);

/** Two groups: a+b, then c. */
function guideFor(diff: BranchDiff, over: Partial<Guide> = {}): Guide {
  const [a, b, c] = diff.order as [string, string, string];
  return {
    diffHash: diff.hash,
    writtenAt: 1,
    base: 'main',
    groups: [
      { title: 'One', summary: '', blocks: [a, b] },
      { title: 'Two', summary: '', blocks: [c] },
    ],
    files: fileBlockIndex(diff),
    fallback: null,
    head: 'a'.repeat(40),
    ...over,
  };
}

const loaded = (diff: BranchDiff): LoadedBranchDiff => ({ diff, base: 'b', fromMergeBase: true, uncommitted: new Set() });
const task: GateTask = {
  id: 3, kind: 'work', status: 'idle', repoPath: '/r', worktreePath: '/wt', branch: 'feat', baseBranch: 'main',
  reviewUrl: null, lastActivityAt: 1,
};

/** Mark a group's files Reviewed, as the pane does: one key per file, the group's blocks in it. */
function tick(taskId: number, diff: BranchDiff, ids: string[]): void {
  const byPath = new Map<string, string[]>();
  for (const id of ids) {
    const path = diff.blocks.get(id)!.path;
    byPath.set(path, [...(byPath.get(path) ?? []), id]);
  }
  setReviewed(taskId, [...byPath].map(([p, b]) => reviewedKey(p, b)), true);
}

describe('gateFrom', () => {
  const diff = diffOf();
  const g = guideFor(diff);
  const none = new Set<string>();

  it('no guide: Create PR waits, "no guide"', () => {
    const gate = gateFrom(null, loaded(diff), diff.hash, none, null, null);
    expect(gate).toEqual({ kind: 'no-guide' });
    expect(gatePasses(gate)).toBe(false);
    expect(gateProgressText(gate)).toBe('no guide');
  });

  it('a guide for the branch as it is, groups to review: "0 of 2"', () => {
    const gate = gateFrom(g, loaded(diff), diff.hash, none, null, null);
    expect(gate).toEqual({ kind: 'reviewing', reviewed: 0, total: 2 });
    expect(gateProgressText(gate)).toBe('0 of 2');
    expect(gateReason(gate)).toBe('2 of 2 groups are not marked Reviewed yet.');
  });

  it('every group Reviewed: Create PR', () => {
    const [a, b, c] = diff.order as [string, string, string];
    const marks = new Set([reviewedKey('src/a.ts', [a]), reviewedKey('src/b.ts', [b]), reviewedKey('src/c.ts', [c])]);
    const gate = gateFrom(g, loaded(diff), diff.hash, marks, null, null);
    expect(gate).toEqual({ kind: 'ready', total: 2 });
    expect(gatePasses(gate)).toBe(true);
  });

  it('the branch moved on since the guide: out of date, whatever is ticked', () => {
    const moved = diffOf(20);
    const gate = gateFrom(g, loaded(moved), moved.hash, none, null, 2);
    expect(gate).toEqual({ kind: 'stale', commitsSince: 2 });
    expect(gateProgressText(gate)).toBe('out of date');
    expect(gateReason(gate)).toMatch(/2 commits since it was written/);
    // Only the hash kept (the read let go): the same answer.
    expect(gateFrom(g, null, moved.hash, none, { reviewed: 2, total: 2 }, null).kind).toBe('stale');
  });

  it('the branch not read yet: checking, from the guide’s own count, never Create PR', () => {
    const gate = gateFrom(g, null, null, none, { reviewed: 2, total: 2 }, null);
    expect(gate).toEqual({ kind: 'checking', reviewed: 2, total: 2 });
    expect(gatePasses(gate)).toBe(false);
  });

  it('Set Aside does not count (#295)', () => {
    const focused = guideFor(diff, {
      groups: [{ title: 'One', summary: '', blocks: diff.order.slice(0, 2) }],
      focus: { setAside: ['src/c.ts'], careful: [] },
    });
    const [a, b] = diff.order as [string, string];
    const marks = new Set([reviewedKey('src/a.ts', [a]), reviewedKey('src/b.ts', [b])]);
    expect(reviewCount(focused, diff, marks)).toEqual({ reviewed: 1, total: 1 });
    expect(gateFrom(focused, loaded(diff), diff.hash, marks, null, null).kind).toBe('ready');
  });
});

describe('gateRowText (My Review rows)', () => {
  it('says what is left before the PR', () => {
    expect(gateRowText({ kind: 'no-guide' }, null)).toBe('no guide yet');
    expect(gateRowText({ kind: 'reviewing', reviewed: 4, total: 6 }, null)).toBe('4 of 6 reviewed');
    expect(gateRowText({ kind: 'checking', reviewed: 4, total: 6 }, null)).toBe('4 of 6 reviewed');
    expect(gateRowText({ kind: 'stale', commitsSince: 1 }, null)).toBe('guide out of date');
    expect(gateRowText({ kind: 'ready', total: 6 }, null)).toBe('reviewed · Create PR');
    expect(gateRowText({ kind: 'ready', total: 6 }, 'draft')).toBe('draft PR');
  });
});

describe('the gate from the stores', () => {
  it('follows the last read of the branch: reviewed, then a commit makes it out of date', async () => {
    const diff = diffOf();
    saveGuide(task.id, guideFor(diff));
    expect(currentGate(task.id).kind).toBe('checking');
    keepLastRead(task.id, loaded(diff));
    expect(currentGate(task.id)).toEqual({ kind: 'reviewing', reviewed: 0, total: 2 });
    tick(task.id, diff, diff.order.slice(0, 2));
    expect(currentGate(task.id)).toEqual({ kind: 'reviewing', reviewed: 1, total: 2 });
    tick(task.id, diff, diff.order.slice(2));
    expect(currentGate(task.id)).toEqual({ kind: 'ready', total: 2 });

    // A commit lands: read afresh, out of date, counted from the guide's head.
    const moved = diffOf(20);
    const counted: string[] = [];
    setGateReaderForTests(async () => loaded(moved), async (_wt, from) => (counted.push(from), 3));
    expect(await freshGate(task)).toEqual({ kind: 'stale', commitsSince: 3 });
    expect(counted).toEqual(['a'.repeat(40)]);
  });

  it('keeps the marks on blocks that did not change across a rewrite', () => {
    const diff = diffOf();
    saveGuide(task.id, guideFor(diff));
    tick(task.id, diff, diff.order.slice(0, 2));
    // c.ts changed; the guide is rewritten for it.
    const moved = diffOf(20);
    saveGuide(task.id, guideFor(moved, { writtenAt: 2 }));
    keepLastRead(task.id, loaded(moved));
    // One stays Reviewed (a, b unchanged); Two holds the new block.
    expect(currentGate(task.id)).toEqual({ kind: 'reviewing', reviewed: 1, total: 2 });
  });

  it('a read that fails reads as not known, never as Create PR', async () => {
    const diff = diffOf();
    saveGuide(task.id, guideFor(diff));
    setGateReaderForTests(async () => {
      throw new Error('boom');
    });
    expect((await freshGate(task)).kind).toBe('checking');
  });
});
