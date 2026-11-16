// @vitest-environment jsdom
/**
 * "Review a PR…" (#386), driven through the rendered button and field in the
 * Reviewing tab (REGRESSIONS: "The affordance was never drawn"), with gh
 * behind its runner seam: what is asked and when, what the dropdown says
 * while it waits or when gh fails, the keyboard, and that a PR chosen here
 * opens exactly as a row's does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Project, Task } from '../types';
import { setGhRunner, type GhResult, type GhRunner } from '../gh/gh';
import { OPEN_PRS_SEARCH } from '../gh/openPrs';
import { dropdownPlace, SEARCH_DEBOUNCE_MS } from './ReviewAnyPr';

const opened = vi.hoisted(() => ({ calls: [] as string[], fail: null as string | null, hold: null as Promise<void> | null }));
vi.mock('./openReview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./openReview')>()),
  openReviewTask: async (_project: unknown, pr: { url: string; title: string }) => {
    opened.calls.push(pr.url);
    if (opened.hold) await opened.hold;
    if (opened.fail) throw new Error(opened.fail);
    return { ...reviewTask, id: 99, title: pr.title, reviewUrl: pr.url };
  },
}));

Element.prototype.scrollIntoView = () => {};

const { default: ReviewList } = await import('./ReviewList');
const { KEYS } = await import('./persisted');
const { keepEscapeFromLeavingFullscreen } = await import('../lib/escapeKeepsFullscreen');

const project = { id: 1, name: 'relay', repoPath: '/r/relay' } as Project;
const URL = (n: number) => `https://github.com/acme/relay/pull/${n}`;
const reviewTask = {
  id: 7, title: 'Cache the currency table', projectId: 1, repoPath: '/r/relay', sessionId: null, createdBranch: true,
  baseBranch: 'main', ownsWorktree: true, kind: 'work', status: 'idle', createdAt: 1, lastActivityAt: 1, seenAt: 1,
  summary: null, branch: 'review/415', worktreePath: '/w/review-415', reviewUrl: URL(415),
} as Task;

function node(number: number, title: string, author = 'dana', state = 'OPEN') {
  return {
    number, title, url: URL(number), isDraft: false, createdAt: '2026-11-01T10:00:00Z', updatedAt: `2026-11-0${(number % 9) + 1}T10:00:00Z`,
    baseRefName: 'main', headRefOid: `h${number}`, state, author: { login: author }, commits: { totalCount: 2 },
  };
}
const RECENT = [
  node(418, 'Retry webhooks with backoff'),
  node(415, 'Cache the currency table', 'sam'),
  node(412, 'Fix timezone in the daily report'),
];
const list = (nodes: unknown[]) => ({ code: 0, stdout: JSON.stringify({ data: { search: { issueCount: nodes.length, nodes } } }), stderr: '' });

let calls: string[][];
let answer: (args: string[]) => GhResult | Promise<GhResult>;
let prevGh: GhRunner;
let data: Map<string, string>;
const onSelect = vi.fn();
const onOpened = vi.fn();

beforeEach(() => {
  data = new Map();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
    },
  });
  calls = [];
  answer = (args) => {
    const q = args.find((a) => a.startsWith('q='));
    if (q === `q=${OPEN_PRS_SEARCH}`) return list(RECENT);
    return list([]);
  };
  prevGh = setGhRunner(async (_p, args) => {
    calls.push(args);
    return answer(args);
  });
  opened.calls.length = 0;
  opened.fail = null;
  opened.hold = null;
  onSelect.mockClear();
  onOpened.mockClear();
});

afterEach(() => {
  cleanup();
  setGhRunner(prevGh);
  vi.useRealTimers();
});

const searches = () => calls.map((a) => a.find((x) => x.startsWith('q=') || x.startsWith('number=')));

function ui(reviewTasks: Task[] = [reviewTask], shown: Project = project) {
  return (
    <ReviewList
      project={shown}
      state={{ kind: 'ready', list: { viewer: 'me', prs: [] } }}
      groups={[]}
      reviewTasks={reviewTasks}
      selectedId={null}
      onSelect={onSelect}
      onOpened={onOpened}
      age={() => '2h'}
    />
  );
}

async function openDropdown() {
  const r = render(ui());
  fireEvent.click(screen.getByRole('button', { name: /Review a PR…/ }));
  await screen.findByText('Recently updated · open');
  return r;
}

const field = () => screen.getByRole('combobox', { name: /Search open pull requests/ });
const options = () => screen.queryAllByRole('option');

describe('Review a PR… (#386)', () => {
  it('opens on the 10 most recent open PRs by others: one search, the field focused, each row number, title, author, age', async () => {
    await openDropdown();
    expect(searches()).toEqual([`q=${OPEN_PRS_SEARCH}`]);
    expect(document.activeElement).toBe(field());
    const rows = options();
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain('#418');
    expect(rows[0]!.textContent).toContain('Retry webhooks with backoff');
    expect(rows[0]!.textContent).toContain('dana');
    expect(rows[0]!.textContent).toContain('2h');
    expect(rows[0]!.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('↑↓ to move · Return opens as a review task · Esc closes')).toBeTruthy();
  });

  it('says it is asking while GitHub has not answered, never an empty list', async () => {
    let release: (r: GhResult) => void = () => {};
    answer = () => new Promise((res) => (release = res));
    render(ui());
    fireEvent.click(screen.getByRole('button', { name: /Review a PR…/ }));
    expect(await screen.findByText('Asking GitHub…')).toBeTruthy();
    await act(async () => release(list(RECENT)));
    expect(await screen.findByText('Recently updated · open')).toBeTruthy();
  });

  it('a gh failure is a line in the dropdown, in gh’s words', async () => {
    answer = () => ({ code: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run: gh auth login' });
    render(ui());
    fireEvent.click(screen.getByRole('button', { name: /Review a PR…/ }));
    const line = await screen.findByText(/^Couldn't ask GitHub: To get started/);
    expect(line.getAttribute('data-failed')).toBe('true');
    expect(options()).toHaveLength(0);
  });

  it('typing is debounced: one search, for what was typed last, after the pause', async () => {
    await openDropdown();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.change(field(), { target: { value: 'w' } });
    fireEvent.change(field(), { target: { value: 'web' } });
    fireEvent.change(field(), { target: { value: 'webhooks' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1);
    });
    expect(calls).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(searches()).toEqual([`q=${OPEN_PRS_SEARCH}`, `q=${OPEN_PRS_SEARCH} in:title webhooks`]);
    expect(screen.getByText('Typing a number (412 or #412) finds that PR, even past the first 10')).toBeTruthy();
  });

  it('text finds titles on GitHub, and part of a word among the recent ones; the words are marked', async () => {
    answer = (args) => {
      const q = args.find((a) => a.startsWith('q='));
      if (q === `q=${OPEN_PRS_SEARCH}`) return list(RECENT);
      // GitHub matches whole words: "time" finds only this one.
      return list([node(371, 'Show time in the user’s locale', 'kim')]);
    };
    await openDropdown();
    fireEvent.change(field(), { target: { value: 'time' } });
    // GitHub's count and the part-word one, each for what it is.
    expect(await screen.findByText('1 open PR matches · 1 more recent has “time” in a word')).toBeTruthy();
    const rows = options();
    expect(rows.map((r) => r.textContent?.slice(0, 4))).toEqual(['#412', '#371']);
    const marks = rows.map((r) => [...r.querySelectorAll('mark')].map((m) => m.textContent));
    expect(marks).toEqual([['time'], ['time']]);
  });

  it('a number finds that PR exactly', async () => {
    answer = (args) =>
      args.includes('number=9001')
        ? { code: 0, stdout: JSON.stringify({ data: { viewer: { login: 'me' }, repository: { pullRequest: node(9001, 'Old one') } } }), stderr: '' }
        : list(RECENT);
    await openDropdown();
    fireEvent.change(field(), { target: { value: '#9001' } });
    expect(await screen.findByText('Open PR #9001')).toBeTruthy();
    expect(options().map((r) => r.textContent?.slice(0, 5))).toEqual(['#9001']);
    expect(searches()[1]).toBe('number=9001');
  });

  it('says so for a number that is closed, missing or yours, with no row to open', async () => {
    const pr = (p: unknown) => ({ code: 0, stdout: JSON.stringify({ data: { viewer: { login: 'me' }, repository: { pullRequest: p } } }), stderr: '' });
    answer = (args) => {
      if (args.includes('number=7')) return pr(node(7, 'Gone', 'dana', 'CLOSED'));
      if (args.includes('number=8')) return pr(null);
      if (args.includes('number=9')) return pr(node(9, 'Mine', 'me'));
      return list(RECENT);
    };
    await openDropdown();
    fireEvent.change(field(), { target: { value: '7' } });
    expect(await screen.findByText('#7 is closed.')).toBeTruthy();
    expect(options()).toHaveLength(0);
    fireEvent.change(field(), { target: { value: '8' } });
    expect(await screen.findByText('No pull request #8 in relay.')).toBeTruthy();
    fireEvent.change(field(), { target: { value: '9' } });
    expect(await screen.findByText("#9 is yours: GitHub doesn't let you review your own PRs.")).toBeTruthy();
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(opened.calls).toEqual([]);
  });

  it('choosing a PR checks it out as a review task, as a row does: opened, marked seen, never on GitHub', async () => {
    await openDropdown();
    fireEvent.click(options()[0]!);
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith(expect.objectContaining({ id: 99, reviewUrl: URL(418) })));
    expect(opened.calls).toEqual([URL(418)]);
    expect(JSON.parse(data.get(KEYS.reviewSeen)!)[URL(418)]).toMatchObject({ head: 'h418', commits: 2 });
    // The dropdown is gone; nothing but the search went to gh.
    expect(options()).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it('a PR that has a review task says so, and choosing it selects that task, not a second checkout', async () => {
    await openDropdown();
    const row = options()[1]!;
    expect(within(row).getByText('Review task')).toBeTruthy();
    expect(within(options()[0]!).queryByText('Review task')).toBeNull();
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    expect(row.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(7);
    expect(opened.calls).toEqual([]);
    expect(onOpened).not.toHaveBeenCalled();
  });

  it('↑/↓ move the highlight round the list, and Return opens the highlighted one', async () => {
    await openDropdown();
    fireEvent.keyDown(field(), { key: 'ArrowUp' });
    expect(options()[2]!.getAttribute('aria-selected')).toBe('true');
    expect(field().getAttribute('aria-activedescendant')).toBe(options()[2]!.id);
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    fireEvent.keyDown(field(), { key: 'Enter' });
    await waitFor(() => expect(opened.calls).toEqual([URL(412)]));
  });

  it('Return before GitHub answers what is typed opens nothing from the list before it', async () => {
    await openDropdown();
    fireEvent.change(field(), { target: { value: '412' } });
    // The recent list is still drawn, its first row highlighted: not an answer to "412".
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(screen.getByText('Asking GitHub…')).toBeTruthy();
    expect(opened.calls).toEqual([]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('Esc closes the dropdown only: handled, so full screen stays, and focus goes back to the button', async () => {
    const off = keepEscapeFromLeavingFullscreen();
    const onWindowEsc = vi.fn();
    window.addEventListener('keydown', onWindowEsc);
    try {
      await openDropdown();
      const notPrevented = fireEvent.keyDown(field(), { key: 'Escape' });
      expect(notPrevented).toBe(false);
      expect(options()).toHaveLength(0);
      expect(screen.queryByRole('combobox')).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: /Review a PR…/ }));
      // Not passed on to the window's own Escape handlers (a menu, a pane).
      expect(onWindowEsc).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', onWindowEsc);
      off();
    }
  });

  it('a press outside closes it; opening again asks again', async () => {
    await openDropdown();
    fireEvent.pointerDown(document.body);
    expect(options()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /Review a PR…/ }));
    await screen.findByText('Recently updated · open');
    expect(calls).toHaveLength(2);
  });

  it('a checkout that fails says so under the button, in git’s words', async () => {
    opened.fail = 'fatal: couldn’t find remote ref';
    await openDropdown();
    fireEvent.click(options()[0]!);
    expect((await screen.findByRole('alert')).textContent).toBe('Could not check out #418: fatal: couldn’t find remote ref');
  });

  it('the task it opened is listed last, with the review tasks whose PR is not asking for you', async () => {
    const r = await openDropdown();
    fireEvent.click(options()[0]!);
    await waitFor(() => expect(onOpened).toHaveBeenCalled());
    r.rerender(ui([reviewTask, { ...reviewTask, id: 99, title: 'Retry webhooks with backoff', reviewUrl: URL(418) }]));
    const group = screen.getByRole('group', { name: /Closed or No Longer Asked/ });
    expect(within(group).getByText('Retry webhooks with backoff')).toBeTruthy();
  });

  it('is not offered where nothing can be opened (no onOpened)', () => {
    render(
      <ReviewList
        project={project}
        state={{ kind: 'ready', list: { viewer: 'me', prs: [] } }}
        groups={[]}
        reviewTasks={[]}
        selectedId={null}
        onSelect={onSelect}
        age={() => '2h'}
      />,
    );
    expect(screen.queryByRole('button', { name: /Review a PR…/ })).toBeNull();
  });
});

describe('review fixes (#388)', () => {
  const other = { id: 2, name: 'ledger', repoPath: '/r/ledger' } as Project;

  it('the status never adds part-word matches into GitHub’s count', async () => {
    answer = (args) => {
      const q = args.find((a) => a.startsWith('q='));
      if (q === `q=${OPEN_PRS_SEARCH}`) return list(RECENT);
      if (q?.endsWith('in:title time')) return list([]);
      // 24 match on GitHub, 1 of them returned.
      return { code: 0, stdout: JSON.stringify({ data: { search: { issueCount: 24, nodes: [node(300, 'Retry the cache')] } } }), stderr: '' };
    };
    await openDropdown();
    fireEvent.change(field(), { target: { value: 'time' } });
    expect(await screen.findByText('1 recent PR has “time” in a word')).toBeTruthy();
    fireEvent.change(field(), { target: { value: 'Retry' } });
    expect(await screen.findByText('24 open PRs match, the 1 most recent shown · 1 more recent has “Retry” in a word')).toBeTruthy();
  });

  it('a checkout error under the button stays with its project, and goes when the dropdown opens again', async () => {
    opened.fail = 'fatal: no such ref';
    const r = await openDropdown();
    fireEvent.click(options()[0]!);
    expect((await screen.findByRole('alert')).textContent).toBe('Could not check out #418: fatal: no such ref');
    // Another project: not its error.
    r.rerender(ui([], other));
    expect(screen.queryByRole('alert')).toBeNull();
    // Back: still there, until a new search starts.
    r.rerender(ui());
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Review a PR…/ }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('"Checking out #n…" stays with its project too', async () => {
    let release: () => void = () => {};
    opened.hold = new Promise<void>((res) => (release = res));
    const r = await openDropdown();
    fireEvent.click(options()[0]!);
    expect(await screen.findByText('Checking out #418…')).toBeTruthy();
    r.rerender(ui([], other));
    expect(screen.queryByText('Checking out #418…')).toBeNull();
    await act(async () => release());
  });

  it('a project switch while open closes it and asks the new repo nothing', async () => {
    const r = await openDropdown();
    r.rerender(ui([], other));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('closes when the list holding the button scrolls, not when its own list or another pane does', async () => {
    const scroller = document.createElement('div');
    document.body.appendChild(scroller);
    const r = render(ui(), { container: scroller });
    fireEvent.click(screen.getByRole('button', { name: /Review a PR…/ }));
    await screen.findByText('Recently updated · open');
    fireEvent.scroll(screen.getByRole('listbox'));
    const pane = document.createElement('div');
    document.body.appendChild(pane);
    fireEvent.scroll(pane);
    expect(screen.queryByRole('combobox')).not.toBeNull();
    fireEvent.scroll(scroller);
    expect(screen.queryByRole('combobox')).toBeNull();
    r.unmount();
    scroller.remove();
    pane.remove();
  });

  it('after choosing with Return, focus is back on the button', async () => {
    await openDropdown();
    // #415 has a review task: selecting it moves focus nowhere here.
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(7);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Review a PR…/ }));
  });

  it('after a checkout chosen with Return, focus comes back to the button once it is enabled again', async () => {
    let release: () => void = () => {};
    opened.hold = new Promise<void>((res) => (release = res));
    await openDropdown();
    fireEvent.keyDown(field(), { key: 'Enter' });
    const button = screen.getByRole('button', { name: /Review a PR…/ }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(true));
    // WebKit drops focus from a control that is disabled; jsdom keeps it (and
    // will not blur a disabled button), so lose it the way the app would.
    const elsewhere = document.body.appendChild(document.createElement('input'));
    elsewhere.focus();
    elsewhere.remove();
    expect(document.activeElement).toBe(document.body);
    // Released outside act, as in the app: the checkout's promise settles
    // before React has drawn the button enabled again.
    release();
    await waitFor(() => expect(onOpened).toHaveBeenCalled());
    await waitFor(() => expect(button.disabled).toBe(false));
    await waitFor(() => expect(document.activeElement).toBe(button));
  });
});

describe('focus after a checkout, whichever settles first', () => {
  it('when the button is drawn enabled before the checkout’s promise settles', async () => {
    let release: () => void = () => {};
    opened.hold = new Promise<void>((res) => (release = res));
    await openDropdown();
    fireEvent.keyDown(field(), { key: 'Enter' });
    const button = screen.getByRole('button', { name: /Review a PR…/ }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(true));
    const elsewhere = document.body.appendChild(document.createElement('input'));
    elsewhere.focus();
    elsewhere.remove();
    // Inside act the state updates are drawn first, then the promise settles.
    await act(async () => release());
    expect(button.disabled).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(button));
  });
});

describe('where the dropdown goes', () => {
  it('under the button, 420px wide even from a narrower sidebar, inside the window', () => {
    // The sidebar at its minimum: the button is narrower than the list.
    expect(dropdownPlace({ left: 18, bottom: 100, width: 184 }, { width: 1200, height: 800 })).toEqual({
      left: 18, top: 104, width: 420, maxHeight: 688,
    });
    // At least the button's width.
    expect(dropdownPlace({ left: 18, bottom: 100, width: 464 }, { width: 1200, height: 800 }).width).toBe(464);
    // A window narrower than the list: it fits, 8px from each edge.
    expect(dropdownPlace({ left: 300, bottom: 100, width: 184 }, { width: 400, height: 800 })).toMatchObject({ left: 8, width: 384 });
  });
});
