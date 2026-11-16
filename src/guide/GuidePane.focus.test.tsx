// @vitest-environment jsdom
/**
 * The Review Guide's set-aside and careful files (#295), mounted: the Write
 * Guide screen's lists and Save as Project Defaults, the Set Aside group and
 * how it is counted, the careful marks in Read and Map, and Rewrite keeping
 * the lists a guide was written with.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Project, Task } from '../types';
import { buildBranchDiff, type BranchDiff } from './blocks';
import { statReason } from './budget';
import { edited } from './fixtures';
import type { LoadedBranchDiff } from './branchDiff';
import type { OneshotRequest } from './writer';

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
let project: Project | null;
const saved: Array<Partial<Project>> = [];
const projectListeners = new Set<() => void>();
vi.mock('../db/projects', () => ({
  getProject: async () => project,
  onProjectsChanged: (cb: () => void) => (projectListeners.add(cb), () => projectListeners.delete(cb)),
  updateProject: async (_id: number, patch: Partial<Project>) => {
    saved.push(patch);
    project = { ...project!, ...patch };
    for (const l of projectListeners) l();
  },
}));

const { default: GuidePane, resetGuideViewsForTests } = await import('./GuidePane');
const { resetGuideStoreForTests, loadGuide } = await import('./store');
const { setOneshotRunner } = await import('./writer');

const task = {
  id: 7, title: 't', projectId: 1, repoPath: '/r', baseBranch: 'main', branch: 'feat', worktreePath: '/wt',
  sessionId: null, ownsWorktree: true, createdBranch: true, kind: 'work', status: 'idle', createdAt: 0,
  lastActivityAt: null, seenAt: null,
} as unknown as Task;

const PATHS = ['src/a.ts', 'src/a.test.ts', 'src/db/migrations/1.sql', 'src/ui/x.css'];
let diff: BranchDiff;
let calls: OneshotRequest[];
/** The next this many grouping calls fail, as Claude Code reports an error. */
let failGroups = 0;
let prevRunner: ReturnType<typeof setOneshotRunner>;

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
  project = {
    id: 1, name: 'recipes', repoPath: '/r', worktreeRoot: '/wt', defaultBaseBranch: null, taskPromptTemplate: null,
    ciDetails: 'link', ciDetailsCommand: null, guideSetAside: null, guideCareful: null, createdAt: 0, archivedAt: null,
  };
  saved.length = 0;
  diff = buildBranchDiff(PATHS.map((p) => edited(p, [3, 4, 5, 6])), statReason);
  loaded = { diff, base: 'b', fromMergeBase: true, uncommitted: new Set() };
  calls = [];
  failGroups = 0;
  prevRunner = setOneshotRunner(async (req) => {
    calls.push(req);
    if (failGroups > 0 && JSON.parse(req.jsonSchema).required[0] === 'groups') {
      failGroups--;
      return { code: 1, stdout: JSON.stringify({ type: 'result', is_error: true, result: 'Overloaded.' }), stderr: '', timedOut: false };
    }
    const sent = diff.order.filter((x) => req.prompt.includes(`[${x}]`));
    return {
      code: 0,
      stdout: JSON.stringify({
        type: 'result',
        is_error: false,
        structured_output: {
          groups: [{ title: 'Code', summary: 'The change.', blocks: sent }],
          careful: [{ path: 'src/a.ts', reason: 'changes the session id written on restart' }],
        },
      }),
      stderr: '',
      timedOut: false,
    };
  });
});

afterEach(() => {
  cleanup();
  setOneshotRunner(prevRunner);
});

const pane = () => render(<GuidePane task={task} active />);
/** The grouping calls only: the notes calls (#224) come after, a group at a time. */
const groupCalls = () => calls.filter((c) => JSON.parse(c.jsonSchema).required[0] === 'groups');
const fileRow = (name: RegExp) => left().getAllByRole('button', { name }).find((b) => b.classList.contains('gd-file'))!;
const foot = () => document.querySelector('.gd-options-foot')?.textContent ?? '';
const left = () => within(screen.getByRole('region', { name: 'Group' }));
const rail = () => within(screen.getByRole('navigation', { name: 'Groups' }));

async function write() {
  pane();
  fireEvent.click(await screen.findByRole('button', { name: 'Write Guide' }));
  await screen.findByRole('heading', { name: 'Code' });
}

describe('the Write Guide screen (#295)', () => {
  it('shows the project’s lists, says what they match here, and writes with them', async () => {
    pane();
    const aside = (await screen.findByLabelText(/^Set Aside/)) as HTMLTextAreaElement;
    expect(aside.value).toContain('**/*.test.*');
    expect(screen.getByText('2 files here: a.test.ts, x.css')).toBeTruthy();
    expect(screen.getByText('1 file here: 1.sql')).toBeTruthy();
    await waitFor(() => expect(foot()).toContain('The defaults of project recipes.'));
    fireEvent.click(screen.getByRole('button', { name: 'Write Guide' }));
    await screen.findByRole('heading', { name: 'Code' });
    expect(groupCalls()).toHaveLength(1);
    expect(groupCalls()[0]!.prompt).not.toContain('a.test.ts');
    expect(groupCalls()[0]!.prompt).not.toContain('x.css');
    expect(loadGuide(task.id)?.focus?.setAside).toContain('**/*.test.*');
  });

  it('a change applies to this guide only, until saved as the project’s defaults', async () => {
    pane();
    const aside = (await screen.findByLabelText(/^Set Aside/)) as HTMLTextAreaElement;
    fireEvent.change(aside, { target: { value: '*.css' } });
    expect(screen.getByText('Changed for this guide only.')).toBeTruthy();
    expect(screen.getByText('1 file here: x.css')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(((await screen.findByLabelText(/^Set Aside/)) as HTMLTextAreaElement).value).toContain('**/*.test.*');
    fireEvent.change(screen.getByLabelText(/^Set Aside/), { target: { value: '*.css' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save as Project Defaults' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]!.guideSetAside).toEqual(['*.css']);
    await waitFor(() => expect(foot()).toContain('The defaults of project recipes.'));
    fireEvent.click(screen.getByRole('button', { name: 'Write Guide' }));
    await screen.findByRole('heading', { name: 'Code' });
    expect(groupCalls()[0]!.prompt).toContain('a.test.ts');
    expect(groupCalls()[0]!.prompt).not.toContain('x.css');
  });

  it('a task with no project offers no Save', async () => {
    project = null;
    pane();
    fireEvent.change(await screen.findByLabelText(/^Set Aside/), { target: { value: '' } });
    expect(screen.getByText('Changed for this guide only.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save as Project Defaults' })).toBeNull();
  });
});

describe('Set Aside (#295)', () => {
  it('is its own group, last, outside the guide’s count, and reachable', async () => {
    await write();
    const marks = rail().getAllByRole('button');
    expect(marks.map((m) => m.getAttribute('aria-label'))).toEqual(['01 Code', 'Set Aside']);
    expect(marks[1]!.hasAttribute('data-aside')).toBe(true);
    expect(left().getByText('01 / 01')).toBeTruthy();
    fireEvent.click(marks[1]!);
    expect(screen.getByRole('heading', { name: 'Set Aside' })).toBeTruthy();
    expect(left().getByText('Not counted')).toBeTruthy();
    expect(left().getByRole('button', { name: /a\.test\.ts/ }).textContent).toContain('Matches **/*.test.*');
    expect(left().getByRole('button', { name: /x\.css/ }).textContent).toMatch(/Matches \*\.\{css,scss,/);
  });

  it('reviewing every counted group says all are reviewed and never moves into Set Aside', async () => {
    // One counted group, Code; Set Aside after it.
    await write();
    fireEvent.click(left().getByRole('checkbox', { name: 'Reviewed' }));
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Code');
    expect(await screen.findByText('All 1 group reviewed')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Groups' }).textContent).toContain('1 of 1 groups reviewed');
    // Next still reaches it.
    fireEvent.click(left().getByRole('button', { name: 'Next ›' }));
    expect(screen.getByRole('heading', { name: 'Set Aside' })).toBeTruthy();
  });
});

describe('review carefully (#295)', () => {
  it('marks a file in its row, at the top of its group, and under the diff’s header, with why in words', async () => {
    await write();
    const row = fileRow(/^a\.ts/);
    expect(row.textContent).toContain('Review carefully: changes the session id written on restart');
    expect(row.querySelector('.gd-careful-icon')).not.toBeNull();
    const head = document.querySelector<HTMLElement>('.gd-careful-head')!;
    expect(within(head).getByRole('button', { name: 'a.ts' })).toBeTruthy();
    expect(within(head).getByRole('button', { name: '1.sql' })).toBeTruthy();
    const migration = fileRow(/^1\.sql/);
    expect(migration.textContent).toContain('Matches **/migrations/**');
    fireEvent.click(within(head).getByRole('button', { name: '1.sql' }));
    await waitFor(() => expect(screen.getByRole('region', { name: 'Diff' }).textContent).toContain('CarefulMatches **/migrations/**'));
  });

  it('the Map flags the box and lists the file in its key, with why', async () => {
    await write();
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    const key = within(await screen.findByRole('list', { name: 'Files to review carefully' }));
    expect(key.getByRole('button', { name: /^a\.ts/ }).textContent).toContain('changes the session id written on restart');
    const box = await screen.findByRole('button', { name: /^src\/a\.ts;.*review carefully: changes the session id/ });
    expect(box.querySelector('.gd-careful-icon')).not.toBeNull();
    const asideKey = within(screen.getByRole('list', { name: 'Groups' })).getByRole('button', { name: /Set Aside/ });
    expect(asideKey.querySelector('[data-colour="aside"]')).not.toBeNull();
  });
});

describe('Rewrite (#295)', () => {
  it('keeps the lists the guide was written with, whatever the project says now', async () => {
    pane();
    fireEvent.change(await screen.findByLabelText(/^Set Aside/), { target: { value: '*.css' } });
    fireEvent.click(screen.getByRole('button', { name: 'Write Guide' }));
    await screen.findByRole('heading', { name: 'Code' });
    fireEvent.click(screen.getByRole('button', { name: 'Rewrite' }));
    await waitFor(() => expect(groupCalls()).toHaveLength(2));
    expect(groupCalls()[1]!.prompt).toContain('a.test.ts');
    expect(groupCalls()[1]!.prompt).not.toContain('x.css');
  });

  it('Rewrite With Other Options… opens the lists filled with the guide’s, and Cancel goes back', async () => {
    pane();
    fireEvent.change(await screen.findByLabelText(/^Set Aside/), { target: { value: '*.css' } });
    fireEvent.click(screen.getByRole('button', { name: 'Write Guide' }));
    await screen.findByRole('heading', { name: 'Code' });
    fireEvent.click(screen.getByRole('button', { name: 'More guide actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rewrite With Other Options…' }));
    expect(((await screen.findByLabelText(/^Set Aside/)) as HTMLTextAreaElement).value).toBe('*.css');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('heading', { name: 'Code' });
    expect(groupCalls()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'More guide actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rewrite With Other Options…' }));
    fireEvent.change(await screen.findByLabelText(/^Set Aside/), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rewrite Guide' }));
    await waitFor(() => expect(groupCalls()).toHaveLength(2));
    expect(groupCalls()[1]!.prompt).toContain('x.css');
    await screen.findByRole('heading', { name: 'Code' });
  });
});

describe('the typed lists are kept until a write succeeds (#295 review)', () => {
  it('Try Again after a failed write uses the lists as typed, not the defaults', async () => {
    failGroups = 1;
    pane();
    fireEvent.change(await screen.findByLabelText(/^Set Aside/), { target: { value: '*.css' } });
    fireEvent.click(screen.getByRole('button', { name: 'Write Guide' }));
    await screen.findByText('Couldn’t write the guide');
    expect((screen.getByLabelText(/^Set Aside/) as HTMLTextAreaElement).value).toBe('*.css');
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    await screen.findByRole('heading', { name: 'Code' });
    expect(groupCalls()).toHaveLength(2);
    expect(groupCalls()[1]!.prompt).toContain('a.test.ts');
    expect(groupCalls()[1]!.prompt).not.toContain('x.css');
    expect(loadGuide(task.id)?.focus?.setAside).toEqual(['*.css']);
  });

  it('a failed Rewrite With Other Options… stays on its screen, and Try Again uses what was typed', async () => {
    await write();
    fireEvent.click(screen.getByRole('button', { name: 'More guide actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rewrite With Other Options…' }));
    failGroups = 1;
    fireEvent.change(await screen.findByLabelText(/^Set Aside/), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rewrite Guide' }));
    await screen.findByText('Couldn’t write the guide');
    expect((screen.getByLabelText(/^Set Aside/) as HTMLTextAreaElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    await waitFor(() => expect(loadGuide(task.id)?.focus?.setAside).toEqual([]));
    expect(groupCalls().at(-1)!.prompt).toContain('x.css');
    await screen.findByRole('heading', { name: 'Code' });
    expect(screen.queryByLabelText(/^Set Aside/)).toBeNull();
  });

  it('Rewrite With Other Options… survives a task switch (the pane remounts), with what was typed', async () => {
    await write();
    fireEvent.click(screen.getByRole('button', { name: 'More guide actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rewrite With Other Options…' }));
    fireEvent.change(await screen.findByLabelText(/^Set Aside/), { target: { value: '*.snap' } });
    cleanup();
    pane();
    expect(((await screen.findByLabelText(/^Set Aside/)) as HTMLTextAreaElement).value).toBe('*.snap');
    expect(screen.getByRole('button', { name: 'Rewrite Guide' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('heading', { name: 'Code' });
  });
});

describe('every file set aside (#295 review)', () => {
  it('says there is nothing to review, with no rail count and no “All 0”', async () => {
    diff = buildBranchDiff(['src/a.test.ts', 'src/ui/x.css'].map((p) => edited(p, [3])), statReason);
    loaded = { diff, base: 'b', fromMergeBase: true, uncommitted: new Set() };
    pane();
    fireEvent.click(await screen.findByRole('button', { name: 'Write Guide' }));
    await screen.findByRole('heading', { name: 'Set Aside' });
    expect(groupCalls()).toHaveLength(0);
    expect(left().getByText('Nothing to review: every file is set aside')).toBeTruthy();
    expect(screen.queryByText(/All 0/)).toBeNull();
    expect(document.querySelector('.gd-rail-count')).toBeNull();
    expect(document.querySelector('.gd-banner')).toBeNull();
  });
});
