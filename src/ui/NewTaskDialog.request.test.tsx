/**
 * @vitest-environment jsdom
 *
 * New Task opened from an approved session request (#157): the prompt is the
 * new task's unsent draft unless the user ticks "send", and a plain
 * follow-up still sends its prompt as before.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@tauri-apps/api/path', () => ({ homeDir: async () => '/Users/m' }));
vi.mock('./ProjectsDialog', () => ({ default: () => null }));
vi.mock('../capture/modelCatalog', () => ({
  loadModelChoices: async () => [],
  loadDefaultModel: async () => null,
}));
vi.mock('../db', () => ({
  createTask: vi.fn(async (t: object) => ({ ...t, id: 41 })),
  findTaskByWorktreePath: vi.fn(async () => null),
}));
vi.mock('../db/projects', () => ({
  listProjects: vi.fn(async () => [
    {
      id: 1,
      name: 'albedo',
      repoPath: '/Users/m/www/albedo',
      worktreeRoot: '/Users/m/agents/albedo',
      defaultBaseBranch: 'main',
      createdAt: 1,
    },
  ]),
}));
vi.mock('../gh/gh', () => ({ fetchPrBase: vi.fn(async () => null) }));
vi.mock('./projectPrefs', () => ({
  readLastProjectId: vi.fn(() => null),
  writeLastProjectId: vi.fn(),
}));
vi.mock('./taskModel', () => ({ setTaskModel: vi.fn() }));
vi.mock('./transcript/drafts', () => ({ saveDraft: vi.fn() }));
vi.mock('../git/worktree', async (orig) => ({
  ...(await orig<typeof import('../git/worktree')>()),
  createWorktree: vi.fn(async () => undefined),
  listBranches: vi.fn(async () => ({
    current: 'main',
    all: ['main'],
    locals: ['main'],
    recentLocals: ['main'],
    remoteRefs: [],
    remotes: ['origin'],
  })),
  fetchAll: vi.fn(async () => undefined),
  probeMainCheckout: vi.fn(async () => ({ path: '/Users/m/www/albedo', current: 'main', dirty: 0 })),
  switchCleanCheckout: vi.fn(async () => undefined),
  undoCreateWorktree: vi.fn(async () => null),
}));

const drafts = await import('./transcript/drafts');
const { NewTaskDialog } = await import('./NewTaskDialog');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const prompt = 'ExportTest fails one run in five.\nFind out why.';

async function create(request: boolean, tick = false) {
  const onCreated = vi.fn();
  render(
    <NewTaskDialog
      open
      onClose={() => {}}
      onCreated={onCreated}
      prefill={{ projectId: 1, title: 'Fix flaky export', prompt, ...(request ? { request: { id: 's1' } } : {}) }}
    />,
  );
  if (tick) fireEvent.click(await screen.findByLabelText('Send it when the session starts'));
  const button = await screen.findByRole('button', { name: 'Create Worktree' });
  await waitFor(() => expect(button).not.toHaveProperty('disabled', true));
  fireEvent.click(button);
  await waitFor(() => expect(onCreated).toHaveBeenCalled());
  return onCreated;
}

describe('NewTaskDialog from a session request', () => {
  it('says where it came from', async () => {
    render(
      <NewTaskDialog open onClose={() => {}} onCreated={() => {}} prefill={{ projectId: 1, title: 't', prompt, request: { id: 's1' } }} />,
    );
    expect(await screen.findByRole('heading', { name: 'New Task from Request' })).toBeTruthy();
    expect(screen.getByText(/Left unsent in the new task/)).toBeTruthy();
  });

  it('keeps the prompt as the new task\'s unsent draft, and sends nothing', async () => {
    const onCreated = await create(true);
    expect(drafts.saveDraft).toHaveBeenCalledWith(41, prompt, new Map());
    expect(onCreated.mock.calls[0]?.[1]).toBe('');
  });

  it('sends it at start instead when the user ticks the box', async () => {
    const onCreated = await create(true, true);
    expect(drafts.saveDraft).not.toHaveBeenCalled();
    expect(onCreated.mock.calls[0]?.[1]).toBe(prompt);
  });

  it('a follow-up (no request) still sends its prompt, as before', async () => {
    const onCreated = await create(false);
    expect(drafts.saveDraft).not.toHaveBeenCalled();
    expect(onCreated.mock.calls[0]?.[1]).toBe(prompt);
    expect(screen.queryByLabelText('Send it when the session starts')).toBeNull();
  });
});
