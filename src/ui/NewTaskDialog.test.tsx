/**
 * @vitest-environment jsdom
 *
 * The partial create: `createWorktree` succeeded, `createTask` threw. Before,
 * the worktree stayed on disk with no task naming it and every retry failed
 * `path-exists`. Now the dialog undoes it and says so.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('@tauri-apps/api/path', () => ({ homeDir: async () => '/Users/m' }));
vi.mock('./ProjectsDialog', () => ({ default: () => null }));
vi.mock('../capture/modelCatalog', () => ({
  loadModelChoices: async () => [],
  loadDefaultModel: async () => null,
}));
vi.mock('../db', () => ({
  createTask: vi.fn(async () => { throw new Error('database is locked'); }),
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
vi.mock('../git/worktree', async (orig) => ({
  ...(await orig<typeof import('../git/worktree')>()),
  createWorktree: vi.fn(async () => undefined),
  listBranches: vi.fn(async () => ({
    current: 'main',
    all: ['main', 'develop', 'origin/main', 'origin/anna/fix-tz'],
    locals: ['main', 'develop'],
    recentLocals: ['develop', 'main'],
    remoteRefs: ['origin/main', 'origin/anna/fix-tz'],
    remotes: ['origin'],
  })),
  fetchAll: vi.fn(async () => undefined),
  probeMainCheckout: vi.fn(async () => ({ path: '/Users/m/www/albedo', current: 'main', dirty: 0 })),
  switchCleanCheckout: vi.fn(async () => undefined),
  undoCreateWorktree: vi.fn(async () => null),
}));

const wt = await import('../git/worktree');
const db = await import('../db');
const ghMod = await import('../gh/gh');
const { NewTaskDialog } = await import('./NewTaskDialog');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function submitWithTitle(title: string) {
  const onCreated = vi.fn();
  render(<NewTaskDialog open onClose={() => {}} onCreated={onCreated} />);
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: title } });
  const create = screen.getByRole('button', { name: 'Create Worktree' });
  await waitFor(() => expect(create).not.toHaveProperty('disabled', true));
  fireEvent.click(create);
  return onCreated;
}

describe('NewTaskDialog partial create', () => {
  it('undoes the worktree it just created when the task row cannot be written', async () => {
    const onCreated = await submitWithTitle('Fix login');
    await waitFor(() => expect(wt.undoCreateWorktree).toHaveBeenCalledTimes(1));
    expect(vi.mocked(wt.undoCreateWorktree).mock.calls[0]?.[0]).toMatchObject({
      repoPath: '/Users/m/www/albedo',
      useExistingBranch: false,
    });
    expect(onCreated).not.toHaveBeenCalled();
    await screen.findByText('The task could not be saved');
    expect(screen.getByText(/has been removed again/)).toBeTruthy();
  });

  it('names what was left behind when the undo could not finish', async () => {
    vi.mocked(wt.undoCreateWorktree).mockResolvedValueOnce('The worktree at /x was left on disk.');
    await submitWithTitle('Fix login');
    await screen.findByText(/was left on disk/);
  });
});

describe('NewTaskDialog default project', () => {
  it('starts on the project tab the list is showing, not the last one used', async () => {
    const { listProjects } = await import('../db/projects');
    const base = { worktreeRoot: '/w', defaultBaseBranch: 'main' };
    vi.mocked(listProjects).mockResolvedValueOnce([
      { ...base, id: 1, name: 'albedo', repoPath: '/Users/m/www/albedo', createdAt: 1 },
      { ...base, id: 2, name: 'acme-store', repoPath: '/Users/m/www/acme-store', createdAt: 2 },
    ] as never);
    const prefs = await import('./projectPrefs');
    vi.mocked(prefs.readLastProjectId).mockReturnValueOnce(2);
    render(<NewTaskDialog open onClose={() => {}} onCreated={() => {}} defaultProjectId={1} />);
    await waitFor(() =>
      expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe('1'),
    );
  });
});

describe('NewTaskDialog existing branch and main checkout', () => {
  function created() {
    vi.mocked(db.createTask).mockImplementationOnce(async (t) => ({ ...t, id: 9 }) as never);
  }

  it('checks out a colleague\'s remote branch in a worktree, tracking it', async () => {
    created();
    const onCreated = vi.fn();
    render(<NewTaskDialog open onClose={() => {}} onCreated={onCreated} />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Existing' }));
    await waitFor(() => expect(wt.fetchAll).toHaveBeenCalledWith('/Users/m/www/albedo'));
    fireEvent.change(screen.getByLabelText('Branch to Check Out'), {
      target: { value: 'origin/anna/fix-tz' },
    });
    const create = screen.getByRole('button', { name: 'Create Worktree' });
    await waitFor(() => expect(create).not.toHaveProperty('disabled', true));
    fireEvent.click(create);
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(vi.mocked(wt.createWorktree).mock.calls[0]?.[0]).toMatchObject({
      branch: 'anna/fix-tz',
      baseBranch: 'origin/anna/fix-tz',
      track: true,
      useExistingBranch: false,
    });
    // Their branch, measured against the project's base; never Albedo's to delete.
    expect(vi.mocked(db.createTask).mock.calls[0]?.[0]).toMatchObject({
      title: 'anna/fix-tz',
      branch: 'anna/fix-tz',
      baseBranch: 'main',
      ownsWorktree: true,
      createdBranch: false,
    });
  });

  it('takes the base and the title from the branch\'s pull request', async () => {
    created();
    vi.mocked(ghMod.fetchPrBase).mockResolvedValue({ number: 42, title: 'Fix tz', base: 'develop' });
    const onCreated = vi.fn();
    render(<NewTaskDialog open onClose={() => {}} onCreated={onCreated} />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Existing' }));
    fireEvent.change(screen.getByLabelText('Branch to Check Out'), {
      target: { value: 'origin/anna/fix-tz' },
    });
    await screen.findByText('What pull request #42 merges into.');
    expect((screen.getByLabelText('Base Branch') as HTMLSelectElement).value).toBe('develop');
    fireEvent.click(screen.getByRole('button', { name: 'Create Worktree' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(ghMod.fetchPrBase).toHaveBeenCalledWith('anna/fix-tz', '/Users/m/www/albedo');
    expect(vi.mocked(db.createTask).mock.calls[0]?.[0]).toMatchObject({
      title: '#42 Fix tz',
      baseBranch: 'develop',
    });
    vi.mocked(ghMod.fetchPrBase).mockResolvedValue(null);
  });

  it('cuts a new branch in the main checkout instead of a worktree', async () => {
    created();
    const onCreated = vi.fn();
    render(<NewTaskDialog open onClose={() => {}} onCreated={onCreated} />);
    const main = await screen.findByRole('radio', { name: 'Main Checkout' });
    await waitFor(() => expect(main).not.toHaveProperty('disabled', true));
    fireEvent.click(main);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Fix login' } });
    const go = screen.getByRole('button', { name: 'Switch Main Checkout' });
    await waitFor(() => expect(go).not.toHaveProperty('disabled', true));
    fireEvent.click(go);
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(wt.createWorktree).not.toHaveBeenCalled();
    expect(vi.mocked(wt.switchCleanCheckout).mock.calls[0]?.[0]).toEqual({
      path: '/Users/m/www/albedo',
      branch: 'fix-login',
      from: 'main',
      track: false,
    });
    expect(vi.mocked(db.createTask).mock.calls[0]?.[0]).toMatchObject({
      worktreePath: '/Users/m/www/albedo',
      ownsWorktree: false,
      createdBranch: true,
      kind: 'work',
    });
  });

  it('does not offer a main checkout with uncommitted changes', async () => {
    vi.mocked(wt.probeMainCheckout).mockResolvedValueOnce({
      path: '/Users/m/www/albedo', current: 'main', dirty: 3,
    });
    render(<NewTaskDialog open onClose={() => {}} onCreated={() => {}} />);
    await screen.findByText(/has 3 uncommitted change/);
    expect(screen.getByRole('radio', { name: 'Main Checkout' })).toHaveProperty('disabled', true);
  });
});

describe('NewTaskDialog ⌘↩', () => {
  it('creates from any field, the prompt box included', async () => {
    vi.mocked(db.createTask).mockImplementationOnce(async (t) => ({ ...t, id: 9 }) as never);
    const onCreated = vi.fn();
    render(<NewTaskDialog open onClose={() => {}} onCreated={onCreated} />);
    const title = screen.getByLabelText('Title');
    fireEvent.change(title, { target: { value: 'Fix login' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create Worktree' })).not.toHaveProperty('disabled', true));
    fireEvent.keyDown(screen.getByLabelText('Model'), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });
});

describe('NewTaskDialog chat', () => {
  it('starts a chat in the main checkout as it is, dirty or not, running no git', async () => {
    vi.mocked(wt.probeMainCheckout).mockResolvedValueOnce({
      path: '/Users/m/www/albedo', current: 'polishing', dirty: 3,
    });
    vi.mocked(db.createTask).mockImplementationOnce(async (t) => ({ ...t, id: 9 }) as never);
    const onCreated = vi.fn();
    render(<NewTaskDialog open onClose={() => {}} onCreated={onCreated} />);
    const chat = await screen.findByRole('radio', { name: 'Chat — No Branch' });
    await waitFor(() => expect(chat).not.toHaveProperty('disabled', true));
    fireEvent.click(chat);
    // One calm sentence that it is the real folder, and no branch inputs.
    expect(screen.getByText(/Claude works in your real folder, \/Users\/m\/www\/albedo, on polishing as it is/)).toBeTruthy();
    expect(screen.queryByRole('radio', { name: 'Existing' })).toBeNull();
    expect(screen.queryByLabelText('Base Branch')).toBeNull();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'How does capture work?' } });
    const go = screen.getByRole('button', { name: 'Start Chat' });
    await waitFor(() => expect(go).not.toHaveProperty('disabled', true));
    fireEvent.click(go);
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(wt.createWorktree).not.toHaveBeenCalled();
    expect(wt.switchCleanCheckout).not.toHaveBeenCalled();
    expect(vi.mocked(db.createTask).mock.calls[0]?.[0]).toEqual({
      title: 'How does capture work?',
      projectId: 1,
      repoPath: '/Users/m/www/albedo',
      baseBranch: '',
      branch: '',
      worktreePath: '/Users/m/www/albedo',
      ownsWorktree: false,
      createdBranch: false,
      kind: 'chat',
    });
  });

  it('is not offered when the repository has no main checkout', async () => {
    vi.mocked(wt.probeMainCheckout).mockResolvedValueOnce(null);
    render(<NewTaskDialog open onClose={() => {}} onCreated={() => {}} />);
    const chat = await screen.findByRole('radio', { name: 'Chat — No Branch' });
    await waitFor(() => expect(wt.probeMainCheckout).toHaveBeenCalled());
    expect(chat).toHaveProperty('disabled', true);
  });

  it('says the main checkout was not changed when the row cannot be saved', async () => {
    const onCreated = vi.fn();
    render(<NewTaskDialog open onClose={() => {}} onCreated={onCreated} />);
    const chat = await screen.findByRole('radio', { name: 'Chat — No Branch' });
    await waitFor(() => expect(chat).not.toHaveProperty('disabled', true));
    fireEvent.click(chat);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Why?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start Chat' }));
    await screen.findByText('The task could not be saved');
    expect(screen.getByText(/Nothing was changed in the main checkout/)).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();
  });
});

describe('NewTaskDialog branch picker', () => {
  function created() {
    vi.mocked(db.createTask).mockImplementationOnce(async (t) => ({ ...t, id: 9 }) as never);
  }
  /** The Base Branch field once the branches are read. */
  async function baseField() {
    const base = screen.getByLabelText('Base Branch') as HTMLInputElement;
    await waitFor(() => expect(base.value).toBe('main'));
    expect(base.disabled).toBe(false);
    return base;
  }
  const options = () => within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent);

  it('filters as you type, and ↓ then Enter picks the base', async () => {
    render(<NewTaskDialog open onClose={() => {}} onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Fix login' } });
    const base = await baseField();
    act(() => base.focus());
    expect(base.getAttribute('aria-expanded')).toBe('true');
    // The project's default (also checked out), then locals by date, then remotes.
    expect(options()).toEqual(['mainProject default', 'develop', 'origin/main', 'origin/anna/fix-tz']);

    fireEvent.change(base, { target: { value: 'dev' } });
    expect(options()).toEqual(['develop']);
    const list = screen.getByRole('listbox');
    expect(within(list).getByText('dev').tagName).toBe('MARK');
    expect(base.getAttribute('aria-activedescendant')).toBeNull();

    fireEvent.keyDown(base, { key: 'ArrowDown' });
    const row = screen.getByRole('option', { name: 'develop' });
    expect(row.getAttribute('aria-selected')).toBe('true');
    expect(base.getAttribute('aria-activedescendant')).toBe(row.id);
    fireEvent.keyDown(base, { key: 'Enter' });

    expect(base.value).toBe('develop');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(base.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Create Worktree' }));
    await waitFor(() => expect(wt.createWorktree).toHaveBeenCalled());
    expect(vi.mocked(wt.createWorktree).mock.calls[0]?.[0]).toMatchObject({ baseBranch: 'develop' });
  });

  it('closes the list on the first Esc, restoring the base, and the dialog on the second', async () => {
    const onClose = vi.fn();
    render(<NewTaskDialog open onClose={onClose} onCreated={() => {}} />);
    const base = await baseField();
    act(() => base.focus());
    fireEvent.change(base, { target: { value: 'dev' } });
    fireEvent.keyDown(base, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(base.value).toBe('main');
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(base, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps typed text on blur only when it names a listed branch', async () => {
    render(<NewTaskDialog open onClose={() => {}} onCreated={() => {}} />);
    const base = await baseField();
    act(() => base.focus());
    fireEvent.change(base, { target: { value: 'nope' } });
    expect(screen.getByText('No branch matches “nope”.')).toBeTruthy();
    act(() => base.blur());
    expect(base.value).toBe('main');
    act(() => base.focus());
    fireEvent.change(base, { target: { value: 'origin/main' } });
    act(() => base.blur());
    expect(base.value).toBe('origin/main');
  });

  it('does not submit on Enter, or ⌘↩, while the list is open', async () => {
    created();
    const onCreated = vi.fn();
    render(<NewTaskDialog open onClose={() => {}} onCreated={onCreated} />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Existing' }));
    const field = screen.getByLabelText('Branch to Check Out') as HTMLInputElement;
    act(() => field.focus());
    fireEvent.change(field, { target: { value: 'origin/anna/fix-tz' } });
    const create = screen.getByRole('button', { name: 'Create Worktree' });
    await waitFor(() => expect(create).not.toHaveProperty('disabled', true));

    // Each closes the list on the branch typed, and creates nothing.
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: 'origin/anna/fix-tz' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(field.value).toBe('origin/anna/fix-tz');
    expect(wt.createWorktree).not.toHaveBeenCalled();

    // Closed, Enter is the field's submit again, as before.
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(vi.mocked(wt.createWorktree).mock.calls[0]?.[0]).toMatchObject({ branch: 'anna/fix-tz', track: true });
  });

  it('takes a branch to check out that is not listed', async () => {
    render(<NewTaskDialog open onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Existing' }));
    const field = screen.getByLabelText('Branch to Check Out') as HTMLInputElement;
    act(() => field.focus());
    expect(options()).toEqual(['mainProject default', 'develop', 'origin/anna/fix-tz']);
    fireEvent.change(field, { target: { value: 'origin/not-fetched' } });
    expect(screen.getByText('No listed branch matches; Enter keeps “origin/not-fetched”.')).toBeTruthy();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(screen.queryByRole('listbox')).toBeNull();
    act(() => field.blur());
    expect(field.value).toBe('origin/not-fetched');
    expect(screen.getByText('Not a branch git knows: pick one from the list, or fetch.')).toBeTruthy();
  });

  it('is disabled while the branches are read', async () => {
    vi.mocked(wt.listBranches).mockImplementationOnce(() => new Promise(() => {}));
    render(<NewTaskDialog open onClose={() => {}} onCreated={() => {}} />);
    await screen.findByText('Reading branches…');
    const base = screen.getByLabelText('Base Branch') as HTMLInputElement;
    expect(base.disabled).toBe(true);
    act(() => base.focus());
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
