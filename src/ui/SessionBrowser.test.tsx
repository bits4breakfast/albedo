/**
 * @vitest-environment jsdom
 *
 * Past Sessions, a session whose folder and branch are both gone (#395): the
 * pane offers a worktree at the old path -- from origin when it still has the
 * branch, else a new branch from the base -- preselected, and resuming makes
 * it before the task exists.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PastSession } from '../db/sessions';
import type { ResumePlacePlan } from '../git/resumePlace';

const CWD = '/w/shop-worktree/412-use-max-availability';
const BRANCH = '412-use-max-availability';

const session: PastSession = {
  sessionId: 'sess-1',
  cwd: CWD,
  title: 'Use the max availability',
  branch: BRANCH,
  firstPrompt: null,
  topFiles: [],
  firstTs: 1,
  lastTs: 2,
  messageCount: 12,
  taskId: null,
  cwdExists: false,
};
const other: PastSession = {
  ...session,
  sessionId: 'sess-2',
  cwd: '/w/shop-worktree/388-tidy-rates',
  title: 'Tidy the rates',
  branch: '388-tidy-rates',
};
let rows: PastSession[] = [session];

const probeResumePlace = vi.fn<(cwd: string, branch: string | null) => Promise<ResumePlacePlan | null>>();
const recreateWorktree = vi.fn(async () => {});
const createTask = vi.fn(async (t: Record<string, unknown>) => ({ ...t, id: 9, sessionId: null }));

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: vi.fn(async () => false) }));
vi.mock('../db/sessions', () => ({ listPastSessions: vi.fn(async () => rows), PROMPT_CHARS: 120 }));
vi.mock('../capture', () => ({ importTranscripts: vi.fn(), listDiskSessions: vi.fn(async () => []) }));
vi.mock('../db', () => ({ createTask, adoptSessionIntoTask: vi.fn(async () => {}) }));
vi.mock('../capture/sessionLink', () => ({ linkTaskSession: vi.fn(async () => {}), newSessionId: () => 'fork-1' }));
vi.mock('../db/projects', () => ({ findProjectByRepo: vi.fn(async () => null) }));
vi.mock('../git/worktree', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../git/worktree')>()),
  listBranches: vi.fn(async () => ({ current: BRANCH })),
  repoRootFor: vi.fn(async () => '/w/shop'),
  defaultBranchOf: vi.fn(async () => 'main'),
}));
vi.mock('../git/resumePlace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../git/resumePlace')>()),
  probeResumePlace,
  recreateWorktree,
}));

const { default: SessionBrowser } = await import('./SessionBrowser');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  rows = [session];
});

const plan = (o: Partial<ResumePlacePlan>): ResumePlacePlan => ({
  repoPath: '/w/shop',
  branch: BRANCH,
  recreate: true,
  source: 'local',
  startPoint: null,
  origin: null,
  preselect: true,
  elsewhere: null,
  main: null,
  needsPrune: false,
  baseBranch: 'main',
  ...o,
});

async function openOn(p: ResumePlacePlan | null) {
  probeResumePlace.mockResolvedValue(p);
  const onResumed = vi.fn();
  render(<SessionBrowser open onClose={() => {}} onOpenTask={() => {}} onResumed={onResumed} />);
  fireEvent.click(await screen.findByText('Use the max availability'));
  await waitFor(() => expect(probeResumePlace).toHaveBeenCalledWith(CWD, BRANCH));
  return onResumed;
}

const warning = () => document.querySelector('.sb-warn')?.textContent?.replace(/\s+/g, ' ').trim();

describe('SessionBrowser, folder and branch both gone', () => {
  it('offers recreating from origin, preselected, and makes it before the task', async () => {
    const onResumed = await openOn(plan({ source: 'remote', startPoint: `origin/${BRANCH}`, origin: 'present' }));
    const radio = await screen.findByRole('radio', { name: /Recreate the Worktree Here from origin/ });
    expect((radio as HTMLInputElement).checked).toBe(true);
    expect(warning()).toBe(
      `That folder no longer exists, and neither does its local branch ${BRANCH}. It is still on origin.`,
    );
    expect(radio.closest('label')?.textContent?.replace(/\s+/g, ' ')).toContain(
      `on ${BRANCH}, tracking origin/${BRANCH}. The conversation's file paths line up exactly.`,
    );
    expect(screen.getByRole('radio', { name: 'Choose Another Folder…' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Recreate and Continue' }));
    await waitFor(() => expect(onResumed).toHaveBeenCalled());
    expect(recreateWorktree).toHaveBeenCalledWith(expect.objectContaining({ source: 'remote' }), CWD);
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: CWD, ownsWorktree: true, createdBranch: false, baseBranch: 'main' }),
    );
    expect(recreateWorktree.mock.invocationCallOrder[0]).toBeLessThan(createTask.mock.invocationCallOrder[0] ?? 0);
  });

  it('offers a new worktree from the base when origin lacks it too, and says the work may not be in it', async () => {
    const onResumed = await openOn(plan({ source: 'base', startPoint: 'origin/main', origin: 'absent' }));
    const radio = await screen.findByRole('radio', { name: /New Worktree Here from main/ });
    expect((radio as HTMLInputElement).checked).toBe(true);
    expect(warning()).toBe(`That folder no longer exists, and neither does its branch ${BRANCH}, here or on origin.`);
    expect(radio.closest('label')?.textContent?.replace(/\s+/g, ' ')).toContain(
      `A new branch ${BRANCH} from main, at the old path, so the file paths line up. The earlier work is only in it if it was merged into main.`,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Branch from It' }));
    await waitFor(() => expect(onResumed).toHaveBeenCalled());
    expect(recreateWorktree).toHaveBeenCalledWith(expect.objectContaining({ source: 'base' }), CWD);
    // Albedo cut this branch, so archiving may offer to delete it.
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ ownsWorktree: true, createdBranch: true }));
  });

  it('labels Continue for a new branch', async () => {
    await openOn(plan({ source: 'base', startPoint: 'main', origin: 'absent' }));
    expect(await screen.findByRole('button', { name: 'Create and Continue' })).toBeTruthy();
  });

  it('keeps today’s wording when the branch still exists', async () => {
    await openOn(plan({ source: 'local' }));
    const radio = await screen.findByRole('radio', { name: /^Recreate the Worktree Here(?! from)/ });
    expect((radio as HTMLInputElement).checked).toBe(true);
    expect(warning()).toBe(`That folder no longer exists. Its branch ${BRANCH} still does.`);
    expect(screen.getByRole('button', { name: 'Recreate and Continue' })).toBeTruthy();
  });

  it('offers only Choose Folder… when nothing can be made', async () => {
    await openOn(null);
    expect(screen.queryByRole('radiogroup', { name: 'Where to resume' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Choose Folder…' })).toBeTruthy();
    expect(warning()).toMatch(/^That folder no longer exists\. The conversation's file paths point at it/);
  });
});

describe('SessionBrowser, origin could not be asked', () => {
  it('recreates from the last fetch’s copy, and says so', async () => {
    await openOn(plan({ source: 'remote', startPoint: `origin/${BRANCH}`, origin: 'unknown' }));
    const radio = await screen.findByRole('radio', { name: /Recreate the Worktree Here from origin/ });
    expect((radio as HTMLInputElement).checked).toBe(true);
    expect(warning()).toBe(
      `That folder no longer exists, and neither does its local branch ${BRANCH}. Couldn't reach origin; using its copy from the last fetch.`,
    );
  });

  it('offers the base without choosing it, never calls the branch gone, and can ask again', async () => {
    await openOn(plan({ source: 'base', startPoint: 'main', origin: 'unknown', preselect: false }));
    const radio = await screen.findByRole('radio', { name: /New Worktree Here from main/ });
    expect((radio as HTMLInputElement).checked).toBe(false);
    expect(warning()).toBe(
      `That folder no longer exists, and neither does its local branch ${BRANCH}. Couldn't reach origin to check for ${BRANCH}. Try Again`,
    );
    expect(warning()).not.toMatch(/here or on/);
    // Nothing chosen yet, so nothing to continue with.
    expect((screen.getByRole('button', { name: 'Continue This Session' }) as HTMLButtonElement).disabled).toBe(true);

    probeResumePlace.mockResolvedValue(plan({ source: 'remote', startPoint: `origin/${BRANCH}`, origin: 'present' }));
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    await waitFor(() => expect(probeResumePlace).toHaveBeenCalledTimes(2));
    expect(((await screen.findByRole('radio', { name: /from origin/ })) as HTMLInputElement).checked).toBe(true);
    expect(warning()).toMatch(/It is still on origin\.$/);
  });

  it('choosing the base by hand makes it', async () => {
    const onResumed = await openOn(plan({ source: 'base', startPoint: 'main', origin: 'unknown', preselect: false }));
    fireEvent.click(await screen.findByRole('radio', { name: /New Worktree Here from main/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create and Continue' }));
    await waitFor(() => expect(onResumed).toHaveBeenCalled());
    expect(recreateWorktree).toHaveBeenCalledWith(expect.objectContaining({ source: 'base' }), CWD);
  });
});

describe('SessionBrowser while the probe is out', () => {
  function deferred() {
    let resolve: (p: ResumePlacePlan | null) => void = () => {};
    const promise = new Promise<ResumePlacePlan | null>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it('says it is checking origin, keeps Choose Folder…, then shows the options', async () => {
    const d = deferred();
    probeResumePlace.mockReturnValue(d.promise);
    render(<SessionBrowser open onClose={() => {}} onOpenTask={() => {}} onResumed={() => {}} />);
    fireEvent.click(await screen.findByText('Use the max availability'));
    await waitFor(() => expect(warning()).toBe(`That folder no longer exists. Checking origin for ${BRANCH}…`));
    expect(screen.getByRole('button', { name: 'Choose Folder…' })).toBeTruthy();
    expect(screen.queryByRole('radiogroup')).toBeNull();

    await act(async () => d.resolve(plan({ source: 'remote', startPoint: `origin/${BRANCH}`, origin: 'present' })));
    expect(warning()).toMatch(/It is still on origin\.$/);
    expect(screen.getByRole('radio', { name: /from origin/ })).toBeTruthy();
  });

  it('switching rows before the first probe answers never shows its answer under the other row', async () => {
    rows = [session, other];
    const first = deferred();
    const second = deferred();
    probeResumePlace.mockImplementation((cwd) => (cwd === CWD ? first.promise : second.promise));
    render(<SessionBrowser open onClose={() => {}} onOpenTask={() => {}} onResumed={() => {}} />);
    fireEvent.click(await screen.findByText('Use the max availability'));
    await waitFor(() => expect(probeResumePlace).toHaveBeenCalledWith(CWD, BRANCH));
    fireEvent.click(screen.getByText('Tidy the rates'));
    await waitFor(() => expect(probeResumePlace).toHaveBeenCalledWith(other.cwd, other.branch));
    expect(warning()).toBe('That folder no longer exists. Checking origin for 388-tidy-rates…');

    // The first row's answer lands late: ignored.
    await act(async () => first.resolve(plan({ source: 'remote', startPoint: `origin/${BRANCH}`, origin: 'present' })));
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(warning()).toBe('That folder no longer exists. Checking origin for 388-tidy-rates…');

    await act(async () =>
      second.resolve(plan({ branch: '388-tidy-rates', source: 'base', startPoint: 'main', origin: 'absent' })),
    );
    expect(warning()).toBe('That folder no longer exists, and neither does its branch 388-tidy-rates, here or on origin.');
    expect(screen.queryByRole('radio', { name: /from origin/ })).toBeNull();
  });
});
