// @vitest-environment jsdom
/**
 * The Context step inside a write (#444): run first and kept with the guide,
 * reused by Rewrite while the settings hold, run again when asked, and never
 * in the way of the guide when it fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBranchDiff } from './blocks';
import { statReason } from './budget';
import { edited } from './fixtures';
import { contextKey, type ContextSettings } from './context';
import { guidesCodec, loadGuide, resetGuideStoreForTests, startWrite, writeStateOf, type ContextPlan } from './store';
import { GROUP_SYSTEM, setContextRunner, setOneshotRunner, type ContextRequest, type OneshotOutput, type OneshotRequest } from './writer';

const ok = (structured: unknown): OneshotOutput => ({
  code: 0,
  stdout: JSON.stringify({ type: 'result', structured_output: structured }),
  stderr: '',
  timedOut: false,
});

const settings: ContextSettings = { instructions: 'Find the ticket.', tools: ['mcp__tracker__get_issue'], model: 'sonnet', timeoutMs: 120_000 };
const input = async () => ({ title: 'T', branch: 'shop-128', pr: null, commits: [] });
const plan = (over: Partial<ContextPlan> = {}): ContextPlan => ({ settings, input, force: false, previous: null, ...over });

let data: Map<string, string>;
let guideCalls: OneshotRequest[];
let contextCalls: ContextRequest[];
let prevRunner: ReturnType<typeof setOneshotRunner>;
let prevContext: ReturnType<typeof setContextRunner>;
// Notes need a file of 5+ changed lines in a group of two files.
const diff = buildBranchDiff([edited('a.ts', [3, 4, 5, 6, 7, 8]), edited('b.ts', [3, 4, 5, 6, 7, 8])], statReason);

beforeEach(() => {
  data = new Map();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
  resetGuideStoreForTests();
  guideCalls = [];
  contextCalls = [];
  prevRunner = setOneshotRunner(async (req) => {
    guideCalls.push(req);
    return req.systemPrompt === GROUP_SYSTEM ? ok({ groups: [{ title: 'G', summary: 'S', blocks: diff.order }] }) : ok({ notes: [] });
  });
  prevContext = setContextRunner(async (req) => {
    contextCalls.push(req);
    return ok({ summary: 'Customers saw two emails.', sources: [{ name: 'Ticket SHOP-128' }] });
  });
});
afterEach(() => {
  setOneshotRunner(prevRunner);
  setContextRunner(prevContext);
  vi.restoreAllMocks();
});

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('a write with a Context step', () => {
  it('runs it first, keeps it with the guide, and gives it to the grouping and notes calls', async () => {
    const run = startWrite(1, diff, 'main', undefined, plan());
    expect(writeStateOf(1)).toMatchObject({ kind: 'writing' });
    await run;
    expect(contextCalls).toHaveLength(1);
    const g = loadGuide(1)!;
    expect(g.context).toMatchObject({ summary: 'Customers saw two emails.', sources: [{ name: 'Ticket SHOP-128' }], key: contextKey(settings) });
    expect(g.contextFailure).toBeUndefined();
    expect(guideCalls[0]!.prompt.startsWith("Background from the user's tools (may be incomplete):\nCustomers saw two emails.\n\n")).toBe(true);
    await settle();
    const notes = guideCalls.filter((c) => c.systemPrompt !== GROUP_SYSTEM);
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) expect(n.prompt.startsWith('Background from the user')).toBe(true);
  });

  it('shows the step while it runs, then the grouping', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    setContextRunner(async () => {
      await gate;
      return ok({ summary: 'S', sources: [] });
    });
    const run = startWrite(2, diff, 'main', undefined, plan());
    await settle();
    expect(writeStateOf(2)).toMatchObject({ kind: 'writing', context: { done: false } });
    release();
    await run;
    expect(writeStateOf(2)).toBeNull();
  });

  it('Rewrite reuses the guide’s Context while the settings are the same; a change, or force, runs it again', async () => {
    await startWrite(3, diff, 'main', undefined, plan());
    const first = loadGuide(3)!.context!;
    await startWrite(3, diff, 'main', undefined, plan({ previous: first }));
    expect(contextCalls).toHaveLength(1);
    expect(loadGuide(3)!.context).toEqual(first);
    await startWrite(3, diff, 'main', undefined, plan({ previous: first, settings: { ...settings, instructions: 'Read the support thread too.' } }));
    expect(contextCalls).toHaveLength(2);
    await startWrite(3, diff, 'main', undefined, plan({ previous: loadGuide(3)!.context!, settings: { ...settings, instructions: 'Read the support thread too.' }, force: true }));
    expect(contextCalls).toHaveLength(3);
  });

  it('a failure or timeout never blocks the guide: written without, and says why', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setContextRunner(async () => ({ code: null, stdout: '', stderr: '', timedOut: true }));
    await startWrite(4, diff, 'main', undefined, plan());
    const g = loadGuide(4)!;
    expect(g.groups).toHaveLength(1);
    expect(g.context).toBeUndefined();
    expect(g.contextFailure).toEqual({ key: contextKey(settings), reason: 'the step timed out after 2 min' });
    expect(guideCalls[0]!.prompt.startsWith('The change:')).toBe(true);
    expect(writeStateOf(4)).toBeNull();
    // A Rewrite after a failure runs it again: there is nothing to reuse.
    setContextRunner(async (req) => {
      contextCalls.push(req);
      return ok({ summary: 'S', sources: [] });
    });
    await startWrite(4, diff, 'main', undefined, plan({ previous: g.context ?? null }));
    expect(contextCalls).toHaveLength(1);
    expect(loadGuide(4)!.contextFailure).toBeUndefined();
  });

  it('with no plan, is exactly the write it was: no Context call, nothing added to the guide', async () => {
    await startWrite(5, diff, 'main');
    expect(contextCalls).toHaveLength(0);
    const g = loadGuide(5)!;
    expect('context' in g).toBe(false);
    expect('contextFailure' in g).toBe(false);
  });

  it('a stored Context is checked as it is read back: a bad one is dropped, not the guide', () => {
    const base = { diffHash: 'h', writtenAt: 1, base: 'main', groups: [], files: {}, fallback: null };
    const raw = JSON.stringify({
      1: { ...base, context: { summary: 42, sources: [], key: 'k', at: 1 } },
      2: { ...base, context: { summary: 'S', sources: [{ name: 'x', url: 'javascript:alert(1)' }], key: 'k', at: 1 } },
      3: { ...base, contextFailure: { key: 1 } },
    });
    const got = guidesCodec.decode(raw)!;
    expect(Object.keys(got)).toEqual(['1', '2', '3']);
    expect(got['1']!.context).toBeUndefined();
    expect(got['2']!.context!.sources).toEqual([{ name: 'x' }]);
    expect(got['3']!.contextFailure).toBeUndefined();
  });
});
