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
const db = await import('../db');
type NewTaskPrefill = import('./followUp').NewTaskPrefill;
type SpinOutSource = import('./followUp').SpinOutSource;
const { NewTaskDialog } = await import('./NewTaskDialog');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const prompt = 'ExportTest fails one run in five.\nFind out why.';

async function create(request: boolean, untick = false) {
  const onCreated = vi.fn();
  render(
    <NewTaskDialog
      open
      onClose={() => {}}
      onCreated={onCreated}
      prefill={{ projectId: 1, title: 'Fix flaky export', prompt, ...(request ? { request: { id: 's1' } } : {}) }}
    />,
  );
  if (untick) fireEvent.click(await screen.findByLabelText('Send the first message'));
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
    expect(screen.getByText('Sent once, when the session starts.')).toBeTruthy();
    expect((screen.getByLabelText('Send the first message') as HTMLInputElement).checked).toBe(true);
  });

  it('sends the prompt when the session starts, by default (#188)', async () => {
    const onCreated = await create(true);
    expect(drafts.saveDraft).not.toHaveBeenCalled();
    expect(onCreated.mock.calls[0]?.[1]).toBe(prompt);
  });

  it("keeps it as the new task's unsent draft instead when the user unticks the box", async () => {
    const onCreated = await create(true, true);
    expect(drafts.saveDraft).toHaveBeenCalledWith(41, prompt, new Map());
    expect(onCreated.mock.calls[0]?.[1]).toBe('');
  });

  it('a follow-up (no request) still sends its prompt, as before, with no spin-out controls', async () => {
    const onCreated = await create(false);
    expect(drafts.saveDraft).not.toHaveBeenCalled();
    expect(onCreated.mock.calls[0]?.[1]).toBe(prompt);
    expect(onCreated.mock.calls[0]?.[2]).toBeUndefined();
    expect(screen.queryByRole('radiogroup', { name: 'Start From' })).toBeNull();
    expect(db.createTask).toHaveBeenCalledWith(expect.objectContaining({ spunFromTaskId: null }));
  });

  it('a follow-up (no request) keeps its prompt label and no send box', async () => {
    const onCreated = await create(false);
    expect(drafts.saveDraft).not.toHaveBeenCalled();
    expect(onCreated.mock.calls[0]?.[1]).toBe(prompt);
    expect(screen.queryByLabelText('Send the first message')).toBeNull();
  });
});

describe('NewTaskDialog spinning a task out (#332)', () => {
  const source = (over: Partial<SpinOutSource> = {}): SpinOutSource => ({
    taskId: 3,
    title: 'Ticket triage',
    sessionId: 'sess-triage',
    kind: 'work',
    start: 'brief',
    ...over,
  });

  function open(prefill: NewTaskPrefill) {
    const onCreated = vi.fn();
    render(<NewTaskDialog open onClose={() => {}} onCreated={onCreated} prefill={prefill} />);
    return onCreated;
  }
  const fromRequest = (from: SpinOutSource): NewTaskPrefill => ({
    projectId: 1,
    title: 'Refund not applied',
    prompt,
    request: { id: 's1' },
    from,
  });

  async function submit(onCreated: ReturnType<typeof vi.fn>, name = 'Create Worktree') {
    const button = await screen.findByRole('button', { name });
    await waitFor(() => expect(button).not.toHaveProperty('disabled', true));
    fireEvent.click(button);
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  }

  const option = (name: string) => screen.getByRole('radio', { name }) as HTMLButtonElement;

  it('from a request: Start From preselects the brief, Send is on, and Create starts fresh, linked to the asking task', async () => {
    const onCreated = open(fromRequest(source()));
    await screen.findByRole('radiogroup', { name: 'Start From' });
    expect(option('The Brief').getAttribute('aria-checked')).toBe('true');
    expect(option('Fork This Conversation').getAttribute('aria-checked')).toBe('false');
    expect((screen.getByLabelText('Send the first message') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByLabelText('First Message')).toBeTruthy();
    await submit(onCreated);
    expect(onCreated.mock.calls[0]?.[1]).toBe(prompt);
    expect(onCreated.mock.calls[0]?.[2]).toBeUndefined();
    expect(db.createTask).toHaveBeenCalledWith(expect.objectContaining({ spunFromTaskId: 3 }));
  });

  it("preselects Claude's suggestion of a fork, and Create forks the asking task's session with the brief after it", async () => {
    const onCreated = open(fromRequest(source({ start: 'fork' })));
    await screen.findByRole('radiogroup', { name: 'Start From' });
    expect(option('Fork This Conversation').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Sent once, after the copied conversation.')).toBeTruthy();
    await submit(onCreated);
    expect(onCreated.mock.calls[0]?.[1]).toBe(prompt);
    expect(onCreated.mock.calls[0]?.[2]).toBe('sess-triage');
  });

  it('the user can switch to a fork, and back', async () => {
    const onCreated = open(fromRequest(source()));
    await screen.findByRole('radiogroup', { name: 'Start From' });
    fireEvent.click(option('Fork This Conversation'));
    expect(option('Fork This Conversation').getAttribute('aria-checked')).toBe('true');
    await submit(onCreated);
    expect(onCreated.mock.calls[0]?.[2]).toBe('sess-triage');
  });

  it('offers no fork when the asking task has no session, and says why', async () => {
    open(fromRequest(source({ sessionId: null, start: 'fork' })));
    await screen.findByRole('radiogroup', { name: 'Start From' });
    const fork = option('Fork This Conversation');
    expect(fork.disabled).toBe(true);
    expect(fork.title).toBe('“Ticket triage” has no session to copy yet.');
    expect(option('The Brief').getAttribute('aria-checked')).toBe('true');
  });

  it('a fork may go to a new worktree: nothing ties it to the source folder', async () => {
    open(fromRequest(source({ start: 'fork' })));
    await screen.findByRole('radiogroup', { name: 'Start From' });
    expect(option('Fork This Conversation').disabled).toBe(false);
    expect((await screen.findByRole('radio', { name: 'New Worktree' })).getAttribute('aria-checked')).toBe('true');
  });

  it('Fork Conversation…: always a fork, said rather than asked; empty box; nothing sent unless ticked', async () => {
    const onCreated = open({ projectId: 1, title: 'Ticket triage (fork)', prompt: '', from: source({ start: 'fork' }) });
    expect(await screen.findByRole('heading', { name: 'Fork Conversation' })).toBeTruthy();
    expect(screen.queryByRole('radiogroup', { name: 'Start From' })).toBeNull();
    expect(screen.getByText(/^A copy of “Ticket triage”’s conversation/)).toBeTruthy();
    expect((screen.getByLabelText('Send the first message') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('First Message') as HTMLTextAreaElement).value).toBe('');
    await submit(onCreated);
    expect(onCreated.mock.calls[0]?.[1]).toBe('');
    expect(onCreated.mock.calls[0]?.[2]).toBe('sess-triage');
    expect(drafts.saveDraft).not.toHaveBeenCalled();
    expect(db.createTask).toHaveBeenCalledWith(expect.objectContaining({ spunFromTaskId: 3, kind: 'work' }));
  });

  it('Fork Conversation… of a chat asks the kind, starting from Chat', async () => {
    const onCreated = open({ projectId: 1, title: 'Ask about retries (fork)', prompt: '', from: source({ kind: 'chat', start: 'fork' }) });
    const chat = await screen.findByRole('radio', { name: 'Chat — No Branch' });
    await waitFor(() => expect(chat.getAttribute('aria-checked')).toBe('true'));
    await submit(onCreated, 'Start Chat');
    expect(onCreated.mock.calls[0]?.[2]).toBe('sess-triage');
    expect(db.createTask).toHaveBeenCalledWith(expect.objectContaining({ spunFromTaskId: 3, kind: 'chat' }));
  });
});
