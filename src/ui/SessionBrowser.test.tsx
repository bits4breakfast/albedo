/**
 * @vitest-environment jsdom
 *
 * Past Sessions, a session whose folder and branch are both gone (#395): the
 * pane offers a worktree at the old path -- from origin when it still has the
 * branch, else a new branch from the base -- preselected, and resuming makes
 * it before the task exists.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const probeResumePlace = vi.fn<(cwd: string, branch: string | null) => Promise<ResumePlacePlan | null>>();
const recreateWorktree = vi.fn(async () => {});
const createTask = vi.fn(async (t: Record<string, unknown>) => ({ ...t, id: 9, sessionId: null }));

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: vi.fn(async () => false) }));
vi.mock('../db/sessions', () => ({ listPastSessions: vi.fn(async () => [session]), PROMPT_CHARS: 120 }));
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
});

const plan = (o: Partial<ResumePlacePlan>): ResumePlacePlan => ({
  repoPath: '/w/shop',
  branch: BRANCH,
  recreate: true,
  source: 'local',
  startPoint: null,
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
    const onResumed = await openOn(plan({ source: 'remote', startPoint: `origin/${BRANCH}` }));
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
    const onResumed = await openOn(plan({ source: 'base', startPoint: 'origin/main' }));
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
    await openOn(plan({ source: 'base', startPoint: 'main' }));
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
