/**
 * @vitest-environment jsdom
 *
 * A queued CI failure's details (#280, step 2), through the PR watch: the
 * item is listed at once and fills in; fetched once per failure, again only
 * when the failure changes; a failed fetch leaves names and links and says
 * why; an answer for a failure that moved on is dropped; nothing is sent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../Terminal', () => ({
  submitPty: vi.fn(async () => true),
  startPty: vi.fn(() => false),
  hasLivePty: vi.fn(() => true),
  ptyLiveSince: vi.fn(() => null),
  canResume: vi.fn(() => false),
  onPtyPresenceChange: vi.fn(() => () => {}),
}));

const projects = vi.hoisted(() => ({ byId: new Map<number, unknown>() }));
vi.mock('../../db/projects', () => ({
  getProject: vi.fn(async (id: number) => projects.byId.get(id) ?? null),
}));

const { submitPty } = await import('../Terminal');
const { __setAttentionBackend } = await import('../attention');
const { observeCi, resetCiNoticesForTests } = await import('../ciNotice');
const { parsePrView } = await import('../../gh/prStatus');
const { __resetOutbox, heldFor } = await import('./outbox');
const { __resetDrafts, getDraft } = await import('./drafts');
const { composeMessage } = await import('./codeComments');
const { __resetQueuedCi, formatCiFailure, queuedCiOf, removeQueuedCi, setQueuedCiDetails, detailsKey } = await import('./ciFailure');
const { __resetCiDetailsQueue, fetchQueuedCiDetails, lastFailureIn } = await import('./ciDetailsQueue');
const { setCiShellRunner } = await import('../../gh/ciDetailsRun');
type PrStatus = import('../../gh/prStatus').PrStatus;
type ShellOutcome = import('../../gh/ciDetailsRun').ShellOutcome;
type Project = import('../../types').Project;

const SHA_A = 'abc1234def5678900000000000000000000000aa';
const SHA_B = 'bcd2345ef67890100000000000000000000000bb';

type Run = { name: string; conclusion?: string | null };
function pr(sha: string, runs: Run[]): PrStatus {
  return parsePrView(
    JSON.stringify({
      number: 14,
      state: 'OPEN',
      headRefName: 'fix-fractions',
      headRefOid: sha,
      statusCheckRollup: runs.map((r) => ({
        __typename: 'CheckRun',
        name: r.name,
        status: r.conclusion ? 'COMPLETED' : 'IN_PROGRESS',
        conclusion: r.conclusion ?? null,
        detailsUrl: `https://ci.example/job/${r.name}`,
      })),
    }),
  ) as PrStatus;
}
const failing = (sha = SHA_A, names = ['build', 'lint']) =>
  pr(sha, [...names.map((name) => ({ name, conclusion: 'FAILURE' })), { name: 'types', conclusion: 'SUCCESS' }]);

const PROJECT: Project = {
  id: 3,
  name: 'recipe-app',
  repoPath: '/repo/recipe-app',
  worktreeRoot: '/wt/recipe-app',
  defaultBaseBranch: null,
  taskPromptTemplate: null,
  ciDetails: 'command',
  ciDetailsCommand: './scripts/ci-details.sh',
  createdAt: 0,
  archivedAt: null,
};
const T = { id: 7, title: 'Fix fractions', projectId: 3, worktreePath: '/wt/recipe-app/fix-fractions', repoPath: '/repo/recipe-app' };

const OUTPUT = JSON.stringify({
  checks: [
    { name: 'build', step: 'Run tests', log: 'FAIL src/recipes/fractions.test.ts\n  Expected: "⅓ cup"\n  Received: "0.33 cup"' },
    { name: 'lint', step: 'eslint' },
  ],
});

/** A shell whose runs are answered by hand, in order. */
function shell() {
  const runs: { cwd: string; input: string; answer: (o: Partial<ShellOutcome>) => void }[] = [];
  setCiShellRunner(
    (_script, { cwd, input }) =>
      new Promise<ShellOutcome>((resolve) => {
        runs.push({ cwd, input, answer: (o) => resolve({ code: 0, stdout: '', stderr: '', timedOut: false, ...o }) });
      }),
  );
  return runs;
}

/** Let the project read and the fetch's own awaits settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

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
  projects.byId = new Map([[3, PROJECT]]);
  __resetQueuedCi();
  __resetCiDetailsQueue();
  __resetOutbox();
  __resetDrafts();
  resetCiNoticesForTests();
  __setAttentionBackend(() => {}, true, () => {});
  vi.mocked(submitPty).mockClear();
});
afterEach(() => {
  __setAttentionBackend(null);
});

describe('fetched once, when the failure is queued', () => {
  it('lists the item at once, says it is fetching, then fills it in -- and sends nothing', async () => {
    const runs = shell();
    observeCi(T, failing(), null);
    expect(queuedCiOf(7)?.checks.map((c) => c.name)).toEqual(['build', 'lint']); // listed before any answer
    await settle();
    expect(queuedCiOf(7)?.details).toEqual({ state: 'fetching' });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.cwd).toBe('/wt/recipe-app/fix-fractions');
    expect(JSON.parse(runs[0]!.input).checks.map((c: { name: string }) => c.name)).toEqual(['build', 'lint']);
    runs[0]!.answer({ stdout: OUTPUT });
    await settle();
    expect(queuedCiOf(7)?.details).toEqual({
      state: 'ready',
      checks: [
        { name: 'build', step: 'Run tests', log: ['FAIL src/recipes/fractions.test.ts', '  Expected: "⅓ cup"', '  Received: "0.33 cup"'], more: 0 },
        { name: 'lint', step: 'eslint', log: [], more: 0 },
      ],
    });
    // Queued is all it is, details or not.
    expect(submitPty).not.toHaveBeenCalled();
    expect(heldFor(7)).toEqual([]);
    expect(getDraft(7)).toBeNull();
  });

  it('never again for the same failure', async () => {
    const runs = shell();
    observeCi(T, failing(), null);
    await settle();
    runs[0]!.answer({ stdout: OUTPUT });
    await settle();
    observeCi(T, failing(), null);
    observeCi(T, failing(), null);
    await settle();
    expect(runs).toHaveLength(1);
  });

  it('not twice while one fetch is under way', async () => {
    const runs = shell();
    observeCi(T, failing(), null);
    observeCi(T, failing(), null);
    await settle();
    observeCi(T, failing(), null);
    await settle();
    expect(runs).toHaveLength(1);
  });

  it('again when the failure changes: a check joins, or a push', async () => {
    const runs = shell();
    observeCi(T, failing(SHA_A, ['build']), null);
    await settle();
    runs[0]!.answer({ stdout: OUTPUT });
    await settle();
    observeCi(T, failing(SHA_A, ['build', 'lint']), null);
    await settle();
    expect(runs).toHaveLength(2);
    expect(queuedCiOf(7)?.details).toEqual({ state: 'fetching' });
    runs[1]!.answer({ stdout: OUTPUT });
    await settle();
    observeCi(T, pr(SHA_B, [{ name: 'build' }]), null); // pushed: running
    observeCi(T, failing(SHA_B), null);
    await settle();
    expect(runs).toHaveLength(3);
  });

  it('not when a check only leaves (rerun to green): what was fetched stays', async () => {
    const runs = shell();
    observeCi(T, failing(), null);
    await settle();
    runs[0]!.answer({ stdout: OUTPUT });
    await settle();
    observeCi(T, failing(SHA_A, ['build']), null);
    await settle();
    expect(runs).toHaveLength(1);
    expect(queuedCiOf(7)?.details?.state).toBe('ready');
    expect(formatCiFailure(queuedCiOf(7)!)).toContain('step: Run tests');
  });

  it('a project on name and link only fetches nothing, and the item is as step 1 drew it', async () => {
    const runs = shell();
    projects.byId.set(3, { ...PROJECT, ciDetails: 'link' });
    observeCi(T, failing(), null);
    await settle();
    expect(runs).toHaveLength(0);
    expect(queuedCiOf(7)?.details).toEqual({ state: 'none' });
    expect(formatCiFailure(queuedCiOf(7)!)).toBe(
      'CI failed on PR #14 (abc1234):\n- build: failed — https://ci.example/job/build\n- lint: failed — https://ci.example/job/lint',
    );
  });

  it('a task with no project is name and link only', async () => {
    const runs = shell();
    observeCi({ ...T, projectId: null }, failing(), null);
    await settle();
    expect(runs).toHaveLength(0);
    expect(queuedCiOf(7)?.details).toEqual({ state: 'none' });
  });
});

describe('a fetch that fails still leaves the item, saying why', () => {
  it('the item keeps names and links, and the message says the details could not be fetched', async () => {
    const runs = shell();
    observeCi(T, failing(), null);
    await settle();
    runs[0]!.answer({ code: 2, stderr: 'no token' });
    await settle();
    expect(queuedCiOf(7)?.details).toEqual({ state: 'failed', reason: 'the command exited with 2: no token' });
    expect(formatCiFailure(queuedCiOf(7)!)).toBe(
      [
        'CI failed on PR #14 (abc1234):',
        '- build: failed — https://ci.example/job/build',
        '- lint: failed — https://ci.example/job/lint',
        'Details could not be fetched: the command exited with 2: no token.',
      ].join('\n'),
    );
  });

  it('a fetcher that throws reads as failed, not as a stuck "fetching"', async () => {
    observeCi({ id: 7, title: 't' }, failing(), null); // queued, not fetched for
    const item = queuedCiOf(7)!;
    await fetchQueuedCiDetails(T, item, {
      getProject: async () => PROJECT,
      fetch: async () => {
        throw new Error('gh vanished');
      },
    });
    expect(queuedCiOf(7)?.details).toEqual({ state: 'failed', reason: 'gh vanished' });
  });
});

describe('an answer for a failure that moved on is dropped', () => {
  it('removed (or sent) before the answer came: nothing comes back', async () => {
    const runs = shell();
    observeCi(T, failing(), null);
    await settle();
    removeQueuedCi(7, SHA_A);
    runs[0]!.answer({ stdout: OUTPUT });
    await settle();
    expect(queuedCiOf(7)).toBeNull();
  });

  it('another commit, or a check the fetch did not ask about', () => {
    observeCi({ id: 7, title: 't' }, failing(SHA_A, ['build', 'lint']), null);
    const stale = detailsKey({ sha: SHA_A, checks: [{ name: 'build', conclusion: 'failed', url: null }] });
    setQueuedCiDetails(7, stale, { state: 'failed', reason: 'x' });
    expect(queuedCiOf(7)?.details).toBeUndefined();
    setQueuedCiDetails(7, detailsKey({ sha: SHA_B, checks: queuedCiOf(7)!.checks }), { state: 'failed', reason: 'x' });
    expect(queuedCiOf(7)?.details).toBeUndefined();
    setQueuedCiDetails(7, detailsKey(queuedCiOf(7)!), { state: 'failed', reason: 'x' });
    expect(queuedCiOf(7)?.details).toEqual({ state: 'failed', reason: 'x' });
  });
});

describe('across a restart', () => {
  it('a fetch the app quit in the middle of is asked again; a finished one is kept', async () => {
    const runs = shell();
    observeCi(T, failing(), null);
    await settle();
    expect(queuedCiOf(7)?.details).toEqual({ state: 'fetching' });
    __resetQueuedCi(); // read back from storage, as on launch
    __resetCiDetailsQueue();
    expect(queuedCiOf(7)?.details).toBeUndefined();
    observeCi(T, failing(), null);
    await settle();
    expect(runs).toHaveLength(2);
    runs[1]!.answer({ stdout: OUTPUT });
    await settle();
    __resetQueuedCi();
    expect(queuedCiOf(7)?.details?.state).toBe('ready');
    observeCi(T, failing(), null);
    await settle();
    expect(runs).toHaveLength(2);
  });
});

describe('what Claude gets', () => {
  it('each check with its step and log tail, as the mock shows', async () => {
    const runs = shell();
    observeCi(T, failing(), null);
    await settle();
    const log = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join('\n');
    runs[0]!.answer({
      stdout: JSON.stringify({ checks: [{ name: 'build', step: 'Run tests', log }, { name: 'lint', step: 'eslint', log: 'a.ts:1 no-unused-vars' }] }),
    });
    await settle();
    const body = composeMessage([], 'Comments:', [], 'Please fix.', queuedCiOf(7));
    expect(body).toBe(
      [
        'CI failed on PR #14 (abc1234):',
        '- build: failed — https://ci.example/job/build',
        '  step: Run tests',
        '  log (last 40 lines):',
        ...Array.from({ length: 40 }, (_, i) => `    line ${i + 6}`),
        '- lint: failed — https://ci.example/job/lint',
        '  step: eslint',
        '  log:',
        '    a.ts:1 no-unused-vars',
        '',
        'Please fix.',
      ].join('\n'),
    );
  });

  it('while still fetching: names and links only', async () => {
    shell();
    observeCi(T, failing(), null);
    await settle();
    expect(queuedCiOf(7)?.details).toEqual({ state: 'fetching' });
    expect(formatCiFailure(queuedCiOf(7)!)).toBe(
      'CI failed on PR #14 (abc1234):\n- build: failed — https://ci.example/job/build\n- lint: failed — https://ci.example/job/lint',
    );
  });
});

describe('the failure "Test on the Last Failure" runs on', () => {
  const task = (id: number, over: Record<string, unknown> = {}) => ({
    id,
    title: `T${id}`,
    worktreePath: `/wt/${id}`,
    repoPath: '/repo',
    kind: 'work' as const,
    status: 'idle' as const,
    ...over,
  });
  const item = (queuedAt: number) => ({ prNumber: queuedAt, sha: SHA_A, queuedAt, checks: [{ name: 'build', conclusion: 'failed', url: null }] });

  it('the most recently queued one first', () => {
    const queued = new Map([
      [1, item(10)],
      [2, item(30)],
    ]);
    const last = lastFailureIn([task(1), task(2)], (id) => queued.get(id) ?? null, () => undefined);
    expect(last?.task.id).toBe(2);
    expect(last?.failure.prNumber).toBe(30);
  });

  it('else a PR the store last read as failing, whose failure was already sent', () => {
    const last = lastFailureIn([task(1), task(2)], () => null, (id) => (id === 2 ? failing(SHA_B) : null));
    expect(last).toEqual({
      task: expect.objectContaining({ id: 2 }),
      failure: {
        prNumber: 14,
        sha: SHA_B,
        checks: [
          { name: 'build', conclusion: 'failed', url: 'https://ci.example/job/build' },
          { name: 'lint', conclusion: 'failed', url: 'https://ci.example/job/lint' },
        ],
      },
    });
  });

  it('never a chat or an archived task; null when there is none', () => {
    const queued = () => item(1);
    expect(lastFailureIn([task(1, { kind: 'chat' }), task(2, { status: 'archived' })], queued, () => failing())).toBeNull();
    expect(lastFailureIn([task(1)], () => null, () => null)).toBeNull();
  });
});
