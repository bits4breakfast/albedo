/**
 * @vitest-environment jsdom
 *
 * What's New: the dialog a person sees after an update, and the launch
 * behaviour behind it (app/useWhatsNew.ts) -- when it appears, when it waits,
 * and what dismissing it remembers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import type { BuildCommit, BuildInfo } from '../lib/build';
import type { SeenBuild, WhatsNewList } from './whatsNew';

vi.mock('../lib/openUrl', () => ({ openExternal: vi.fn(async () => {}) }));

const { default: WhatsNewDialog } = await import('./WhatsNewDialog');
const { default: useWhatsNew } = await import('./app/useWhatsNew');
const { openExternal } = await import('../lib/openUrl');
const { default: Header } = await import('./Header');

const REPO = 'https://github.com/bits4breakfast/albedo';

const changes: BuildCommit[] = [
  { sha: 'c000003', subject: 'Outbox: hold messages during a running turn', pr: 71 },
  { sha: 'c000002', subject: 'Editor header: one row, the file named once (#57)', pr: 68 },
  { sha: 'c000001', subject: 'Fix a typo', pr: null },
];

function list(over: Partial<WhatsNewList> = {}): WhatsNewList {
  return {
    changes,
    since: { sha: 'c000000', at: '2026-10-29T08:00:00Z' },
    dirty: false,
    builtAt: '2026-10-30T10:00:00Z',
    repo: REPO,
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('WhatsNewDialog', () => {
  it('lists each change by title, its PR number a link to the PR', () => {
    render(<WhatsNewDialog list={list()} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: "What's New" });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(within(dialog).getByText(/3 changes since the build you last ran on/)).toBeTruthy();

    const items = within(dialog).getAllByRole('listitem');
    expect(items.map((li) => li.querySelector('.wn-subject')?.textContent)).toEqual(changes.map((c) => c.subject));

    fireEvent.click(within(items[0]!).getByRole('button', { name: '#71' }));
    expect(openExternal).toHaveBeenCalledWith(`${REPO}/pull/71`);
    // A direct commit has no number to show.
    expect(items[2]!.querySelector('.wn-pr, .wn-pr-plain')).toBeNull();
    expect(within(dialog).queryByText('Plus uncommitted changes')).toBeNull();
  });

  it('shows a PR number without a link when the remote is not GitHub', () => {
    render(<WhatsNewDialog list={list({ repo: null })} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: '#71' })).toBeNull();
    expect(screen.getByText('#71').className).toBe('wn-pr-plain');
  });

  it('says so when the build had uncommitted changes, and when earlier changes are not listed', () => {
    render(<WhatsNewDialog list={list({ dirty: true, since: null })} onClose={() => {}} />);
    expect(screen.getByText('Plus uncommitted changes')).toBeTruthy();
    expect(screen.getByText(/The latest 3 changes; earlier ones aren't listed/)).toBeTruthy();
  });

  it('Done, Escape and a click outside each dismiss it', () => {
    const onClose = vi.fn();
    const { container } = render(<WhatsNewDialog list={list()} onClose={onClose} />);
    const done = screen.getByRole('button', { name: 'Done' });
    expect(document.activeElement).toBe(done);
    fireEvent.click(done);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.mouseDown(container.querySelector('.wt-overlay')!);
    // A click inside does not.
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});

describe('useWhatsNew', () => {
  const history: BuildCommit[] = [...changes, { sha: 'c000000', subject: 'Before', pr: 60 }];
  const build: BuildInfo = { sha: 'c000003', dirty: false, at: '2026-10-30T10:00:00Z', repo: REPO, history };

  function memory(initial: SeenBuild | null) {
    let value = initial;
    const writes: SeenBuild[] = [];
    return {
      writes,
      store: {
        read: () => value,
        write: (v: SeenBuild) => {
          value = v;
          writes.push(v);
        },
      },
    };
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('first launch: remembers the build and shows nothing', () => {
    const m = memory(null);
    const { result } = renderHook(() => useWhatsNew({ hold: false, build, store: m.store, busy: () => false }));
    act(() => void vi.advanceTimersByTime(5000));
    expect(result.current.open).toBeNull();
    expect(m.writes).toEqual([{ sha: build.sha, at: build.at, from: null }]);
    // The ⋯ item still has something to show: the latest few.
    expect(result.current.available).toBe(true);
  });

  it('a new build: waits while something needs attention, then shows; dismissing remembers it', () => {
    const m = memory({ sha: 'c000000', at: '2026-10-29T08:00:00Z', from: null });
    let busy = true;
    const { result, rerender } = renderHook(({ hold }) => useWhatsNew({ hold, build, store: m.store, busy: () => busy }), {
      initialProps: { hold: false },
    });
    act(() => void vi.advanceTimersByTime(4000));
    expect(result.current.open).toBeNull(); // a dialog or the waiting card is up

    busy = false;
    rerender({ hold: true });
    act(() => void vi.advanceTimersByTime(4000));
    expect(result.current.open).toBeNull(); // the selected task is waiting on you

    rerender({ hold: false });
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current.open?.changes.map((c) => c.pr)).toEqual([71, 68, null]);
    expect(m.writes).toEqual([]); // shown is not seen

    act(() => result.current.dismiss());
    expect(result.current.open).toBeNull();
    expect(m.writes).toEqual([
      { sha: build.sha, at: build.at, from: { sha: 'c000000', at: '2026-10-29T08:00:00Z' } },
    ]);

    // The ⋯ item brings the same list back.
    act(() => result.current.reopen());
    expect(result.current.open?.changes).toHaveLength(3);
    expect(result.current.open?.since?.sha).toBe('c000000');
  });

  it('the same build again: nothing, and nothing written', () => {
    const m = memory({ sha: build.sha, at: build.at, from: null });
    const { result } = renderHook(() => useWhatsNew({ hold: false, build, store: m.store, busy: () => false }));
    act(() => void vi.advanceTimersByTime(5000));
    expect(result.current.open).toBeNull();
    expect(m.writes).toEqual([]);
  });
});

describe("the ⋯ item", () => {
  const props = {
    onReconcile: () => {},
    onProjects: () => {},
    onSessions: () => {},
    onShortcuts: () => {},
    blockedCount: 0,
    theme: 'system' as const,
    onThemeChange: () => {},
  };

  it("reopens What's New from the header's ⋯ menu", () => {
    const onWhatsNew = vi.fn();
    render(<Header {...props} onWhatsNew={onWhatsNew} />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: "What's New…" }));
    expect(onWhatsNew).toHaveBeenCalledTimes(1);
  });

  it('is there but disabled when the build has no history to list', () => {
    render(<Header {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect((screen.getByRole('menuitem', { name: "What's New…" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
