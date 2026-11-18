// @vitest-environment jsdom
/**
 * The Context step in the pane (#444): the section at the top of a guide,
 * the failure banner and its Try Again, the ⋯ item, and the sheet where a
 * project's instructions and tools are set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Project, Task } from '../types';
import { buildBranchDiff, type BranchDiff } from './blocks';
import { statReason } from './budget';
import { edited } from './fixtures';
import type { LoadedBranchDiff } from './branchDiff';
import type { ContextRequest, OneshotRequest } from './writer';

let loaded: LoadedBranchDiff;
vi.mock('./branchDiff', () => ({ loadBranchDiff: async () => loaded }));
vi.mock('../ui/transcript/codeComments', () => ({ useWaitingCodeComments: () => [] }));
vi.mock('../ui/transcript/drafts', () => ({ useComments: () => [] }));
vi.mock('../ui/transcript/composerBridge', () => ({ sendWaitingComments: () => true }));
vi.mock('./repoFiles', () => ({ repoFiles: async () => new Set<string>() }));
vi.mock('../ui/editor/diffComments', () => ({
  useDiffComments: () => ({ annotations: null, notice: null, clearNotice: () => {}, bar: null }),
}));
vi.mock('../gh/prStore', () => ({ getPrStatus: () => null, usePrStatus: () => null }));
vi.mock('../git/stackBase', () => ({ detectStackBase: async () => null }));
vi.mock('../gh/gh', () => ({ gh: async () => null }));
const opened = vi.hoisted(() => [] as string[]);
vi.mock('../lib/openUrl', () => ({ openExternal: async (u: string) => void opened.push(u) }));
let project: Project | null;
vi.mock('../db/projects', () => ({
  getProject: async () => project,
  onProjectsChanged: () => () => {},
  updateProject: async () => {},
}));

const { default: GuidePane, resetGuideViewsForTests } = await import('./GuidePane');
const { resetGuideStoreForTests, loadGuide, saveGuide } = await import('./store');
const { setOneshotRunner, setContextRunner } = await import('./writer');
const { setContextFiles, resetContextSettingsForTests } = await import('./context');

const task = {
  id: 7, title: 'Send the confirmation once', projectId: 1, repoPath: '/r', baseBranch: 'main', branch: 'shop-128', worktreePath: '/wt',
  sessionId: null, ownsWorktree: true, createdBranch: true, kind: 'work', status: 'idle', createdAt: 0,
  lastActivityAt: null, seenAt: null,
} as unknown as Task;

const settings = { instructions: 'Find the ticket.', tools: ['mcp__tracker__get_issue'], model: 'sonnet' as const, timeoutMs: 120_000 };
let diff: BranchDiff;
let calls: OneshotRequest[];
let contextCalls: ContextRequest[];
let disk: Map<number, string>;
let prevRunner: ReturnType<typeof setOneshotRunner>;
let prevContext: ReturnType<typeof setContextRunner>;
let prevFiles: ReturnType<typeof setContextFiles>;

const result = (structured: unknown) => ({
  code: 0,
  stdout: JSON.stringify({ type: 'result', is_error: false, structured_output: structured }),
  stderr: '',
  timedOut: false,
});

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
  resetContextSettingsForTests();
  opened.length = 0;
  project = {
    id: 1, name: 'shop-api', repoPath: '/r', worktreeRoot: '/wt', defaultBaseBranch: null, taskPromptTemplate: null,
    ciDetails: 'link', ciDetailsCommand: null, guideSetAside: null, guideCareful: null, createdAt: 0, archivedAt: null,
  };
  diff = buildBranchDiff([edited('src/OrderMailer.php', [3, 4, 5, 6])], statReason);
  loaded = { diff, base: 'b', fromMergeBase: true, uncommitted: new Set() };
  calls = [];
  contextCalls = [];
  disk = new Map([[1, JSON.stringify(settings)]]);
  prevFiles = setContextFiles({ read: async (id) => disk.get(id) ?? null, write: async (id, json) => void disk.set(id, json) });
  prevRunner = setOneshotRunner(async (req) => {
    calls.push(req);
    return JSON.parse(req.jsonSchema).required[0] === 'groups'
      ? result({ groups: [{ title: 'Send the confirmation once per order', summary: 'S.', blocks: diff.order }] })
      : result({ notes: [] });
  });
  prevContext = setContextRunner(async (req) => {
    contextCalls.push(req);
    return result({
      summary: 'Customers saw the same order confirmation sent twice.',
      sources: [{ name: 'Ticket SHOP-128', url: 'https://tracker.example/SHOP-128' }, { name: 'Support conversation · 3' }],
    });
  });
});

afterEach(() => {
  cleanup();
  setOneshotRunner(prevRunner);
  setContextRunner(prevContext);
  setContextFiles(prevFiles);
  vi.restoreAllMocks();
});

const pane = () => render(<GuidePane task={task} active />);
const groupCalls = () => calls.filter((c) => JSON.parse(c.jsonSchema).required[0] === 'groups');

describe('the Context step in the guide (#444)', () => {
  it('runs before the guide is written, and shows its answer and sources at the top', async () => {
    pane();
    fireEvent.click(await screen.findByRole('button', { name: 'Write Guide' }));
    const section = await screen.findByRole('region', { name: 'Context' });
    expect(contextCalls).toHaveLength(1);
    expect(contextCalls[0]!.prompt).toContain('Task title: Send the confirmation once');
    expect(groupCalls()[0]!.prompt).toContain('Customers saw the same order confirmation sent twice.');
    expect(within(section).getByText('Customers saw the same order confirmation sent twice.')).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Ticket SHOP-128' }));
    expect(opened).toEqual(['https://tracker.example/SHOP-128']);
    // A source without a link is text, not a control.
    expect(within(section).queryByRole('button', { name: 'Support conversation · 3' })).toBeNull();
    expect(within(section).getByText('Support conversation · 3')).toBeTruthy();
  });

  it('Rewrite reuses it; Edit… with changed words writes it again with a fresh one', async () => {
    pane();
    fireEvent.click(await screen.findByRole('button', { name: 'Write Guide' }));
    await screen.findByRole('region', { name: 'Context' });
    fireEvent.click(screen.getByRole('button', { name: 'Rewrite' }));
    await waitFor(() => expect(groupCalls()).toHaveLength(2));
    expect(contextCalls).toHaveLength(1);
    fireEvent.click(within(await screen.findByRole('region', { name: 'Context' })).getByRole('button', { name: 'Edit…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review Guide Context · shop-api' });
    fireEvent.change(within(dialog).getByLabelText('Also look up'), { target: { value: 'Find the ticket, and the support thread.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(contextCalls).toHaveLength(2));
    await waitFor(() => expect(groupCalls()).toHaveLength(3));
    expect(JSON.parse(disk.get(1)!).instructions).toBe('Find the ticket, and the support thread.');
  });

  it('a failure says so above the guide written without it, and Try Again runs it again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setContextRunner(async (req) => {
      contextCalls.push(req);
      return { code: null, stdout: '', stderr: '', timedOut: true };
    });
    pane();
    fireEvent.click(await screen.findByRole('button', { name: 'Write Guide' }));
    expect(
      await screen.findByText('Context wasn’t added: the step timed out after 2 min. The guide below is written without it.'),
    ).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Context' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Send the confirmation once per order' })).toBeTruthy();
    expect(groupCalls()[0]!.prompt.startsWith('The change:')).toBe(true);
    setContextRunner(async (req) => {
      contextCalls.push(req);
      return result({ summary: 'Found it.', sources: [] });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    await screen.findByRole('region', { name: 'Context' });
    expect(contextCalls).toHaveLength(2);
    expect(loadGuide(7)!.contextFailure).toBeUndefined();
  });

  it('is not run, and the guide is as before, when the project has no instructions', async () => {
    disk.clear();
    pane();
    fireEvent.click(await screen.findByRole('button', { name: 'Write Guide' }));
    await screen.findByRole('heading', { name: 'Send the confirmation once per order' });
    expect(contextCalls).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'Context' })).toBeNull();
    expect(groupCalls()[0]!.prompt.startsWith('The change:')).toBe(true);
  });
});

describe('the sheet (#444)', () => {
  it('opens from ⋯, takes MCP names only, and saves per project', async () => {
    disk.clear();
    saveGuide(7, {
      diffHash: diff.hash, writtenAt: 1, base: 'main', groups: [{ title: 'G', summary: '', blocks: diff.order, notes: {} }],
      files: { 'src/OrderMailer.php': diff.order }, fallback: null,
    });
    pane();
    fireEvent.click(await screen.findByRole('button', { name: 'More guide actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Review Guide Context…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review Guide Context · shop-api' });
    const box = await within(dialog).findByLabelText('Tools it may use');
    fireEvent.change(box, { target: { value: 'Bash' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(within(dialog).getByRole('alert').textContent).toBe('Bash isn’t an MCP tool or server name. They start with mcp__.');
    fireEvent.change(box, { target: { value: 'mcp__tracker__get_issue mcp__support' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(within(dialog).getByRole('button', { name: 'Remove mcp__support' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove mcp__support' }));
    fireEvent.change(within(dialog).getByLabelText('Also look up'), { target: { value: 'Find the ticket.' } });
    fireEvent.change(within(dialog).getByLabelText('Model'), { target: { value: 'haiku' } });
    fireEvent.change(within(dialog).getByLabelText('Time limit'), { target: { value: '300000' } });
    expect(within(dialog).getByText('What it is given, and the fixed part of the prompt')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(JSON.parse(disk.get(1)!)).toEqual({ version: 1, instructions: 'Find the ticket.', tools: ['mcp__tracker__get_issue'], model: 'haiku', timeoutMs: 300_000 });
    // Saved from ⋯, not Edit…: nothing is rewritten on its own.
    expect(contextCalls).toHaveLength(0);
    expect(groupCalls()).toHaveLength(0);
  });

  it('needs a tool for its instructions, and tries them on the selected task without saving', async () => {
    disk.clear();
    pane();
    fireEvent.click(await screen.findByRole('button', { name: 'Review Guide Context…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(await within(dialog).findByLabelText('Also look up'), { target: { value: 'Find the ticket.' } });
    expect(within(dialog).getByText('Add a tool it may use, or leave the instructions empty.')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    const box = within(dialog).getByLabelText('Tools it may use');
    fireEvent.change(box, { target: { value: 'mcp__tracker__get_issue' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try on the selected task' }));
    expect(await within(dialog).findByText('Customers saw the same order confirmation sent twice.')).toBeTruthy();
    expect(contextCalls[0]).toMatchObject({ tools: ['mcp__tracker__get_issue'], model: 'sonnet' });
    expect(disk.has(1)).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
