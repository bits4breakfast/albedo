/**
 * @vitest-environment jsdom
 *
 * ModelPicker's reads (#364): it asks for its session's model when its own
 * session's rows land, never for another session's, and two pickers on one
 * session (the task bar's and the hidden composer's, in PTY mode) share one
 * read per event.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Task } from '../types';

const h = vi.hoisted(() => ({
  listeners: new Set<(u: { sessionId: string }) => void>(),
  reads: [] as string[],
  models: new Map<string, string | null>(),
  /** While set, reads wait on it: a query still in flight. */
  gate: null as Promise<void> | null,
}));

vi.mock('../capture', () => ({
  onCaptureUpdate: (cb: (u: { sessionId: string }) => void) => {
    h.listeners.add(cb);
    return () => void h.listeners.delete(cb);
  },
  contextUsage: async (sessionId: string) => {
    h.reads.push(sessionId);
    if (h.gate) await h.gate;
    const model = h.models.get(sessionId) ?? null;
    return model === null ? null : { model };
  },
}));
vi.mock('../capture/modelCatalog', () => ({
  loadModelChoices: async () => [
    { id: 'opus', name: 'Opus' },
    { id: 'sonnet', name: 'Sonnet' },
  ],
  loadDefaultModel: async () => 'claude-default-model',
}));
const sends = vi.hoisted(() => [] as unknown[][]);
vi.mock('./transcript/send', () => ({
  sendToSession: async (...args: unknown[]) => {
    sends.push(args);
    return 'sent';
  },
  useSendsWait: () => false,
  onSessionSubmit: () => () => {},
}));
vi.mock('./taskModel', () => ({ getTaskModel: () => null, setTaskModel: () => {} }));

const { default: ModelPicker } = await import('./ModelPicker');

function task(over: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: 'T',
    projectId: 1,
    repoPath: '/r',
    baseBranch: 'main',
    branch: 'b',
    worktreePath: '/w',
    sessionId: 's-1',
    ownsWorktree: true,
    createdBranch: true,
    kind: 'work',
    status: 'idle',
    createdAt: 0,
    lastActivityAt: 0,
    seenAt: null,
    summary: null,
    reviewUrl: null,
    apiError: null,
    apiErrorText: null,
    spunFromTaskId: null,
    ...over,
  };
}

const emit = (sessionId: string) => {
  for (const l of [...h.listeners]) l({ sessionId });
};

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  h.gate = null;
  h.reads = [];
  h.models = new Map([['s-1', 'claude-opus-4-1']]);
});
afterEach(() => {
  cleanup();
  h.listeners.clear();
});

describe('ModelPicker reads (#364)', () => {
  it("reads again on its own session's rows, and shows what it reads", async () => {
    render(<ModelPicker task={task()} />);
    await flush();
    expect(h.reads).toEqual(['s-1']);
    expect((screen.getByRole('combobox', { name: 'Change model' }) as HTMLSelectElement).value).toBe('opus');

    h.models.set('s-1', 'claude-sonnet-4-5');
    act(() => emit('s-1'));
    await flush();
    expect(h.reads).toEqual(['s-1', 's-1']);
    expect((screen.getByRole('combobox', { name: 'Change model' }) as HTMLSelectElement).value).toBe('sonnet');
  });

  it("does not read for another session's rows", async () => {
    render(<ModelPicker task={task()} />);
    await flush();
    h.reads = [];
    act(() => {
      emit('s-2');
      emit('s-3');
    });
    await flush();
    expect(h.reads).toEqual([]);
  });

  it('follows the session it is moved to (a /clear), and ignores the old one', async () => {
    const { rerender } = render(<ModelPicker task={task()} />);
    await flush();
    h.models.set('s-new', 'claude-sonnet-4-5');
    rerender(<ModelPicker task={task({ sessionId: 's-new' })} />);
    await flush();
    expect(h.reads).toEqual(['s-1', 's-new']);
    h.reads = [];
    act(() => emit('s-1'));
    await flush();
    expect(h.reads).toEqual([]);
    act(() => emit('s-new'));
    await flush();
    expect(h.reads).toEqual(['s-new']);
  });

  it('two pickers on one session share one read per event', async () => {
    render(
      <>
        <ModelPicker task={task()} />
        <ModelPicker task={task()} />
      </>,
    );
    await flush();
    expect(h.reads).toEqual(['s-1']);
    h.reads = [];
    h.models.set('s-1', 'claude-sonnet-4-5');
    act(() => emit('s-1'));
    await flush();
    expect(h.reads).toEqual(['s-1']);
    const values = screen.getAllByRole('combobox', { name: 'Change model' }).map((s) => (s as HTMLSelectElement).value);
    expect(values).toEqual(['sonnet', 'sonnet']);
  });

  it('a later event reads again: only a read in flight is shared', async () => {
    render(<ModelPicker task={task()} />);
    await flush();
    act(() => emit('s-1'));
    await flush();
    act(() => emit('s-1'));
    await flush();
    expect(h.reads).toEqual(['s-1', 's-1', 's-1']);
  });

  it('an event while a read is still in flight reads again: the first may predate its rows', async () => {
    render(
      <>
        <ModelPicker task={task()} />
        <ModelPicker task={task()} />
      </>,
    );
    await flush();
    h.reads = [];
    let open = () => {};
    h.gate = new Promise<void>((r) => (open = r));
    act(() => emit('s-1'));
    await flush();
    expect(h.reads).toEqual(['s-1']);
    act(() => emit('s-1'));
    await flush();
    expect(h.reads).toEqual(['s-1', 's-1']);
    h.models.set('s-1', 'claude-sonnet-4-5');
    h.gate = null;
    await act(async () => open());
    await flush();
    const values = screen.getAllByRole('combobox', { name: 'Change model' }).map((s) => (s as HTMLSelectElement).value);
    expect(values).toEqual(['sonnet', 'sonnet']);
  });

  it('a session with no reply yet shows the stand-in, marked as assumed', async () => {
    h.models.set('s-1', null);
    render(<ModelPicker task={task()} />);
    await flush();
    expect(screen.getByText('default-model')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Change model' }).getAttribute('title')).toMatch(
      /^Probably claude-default-model: confirmed on the first reply\./,
    );
  });
});

describe('ModelPicker sends', () => {
  it('labels its /model as from the model picker, for the echo (#384)', async () => {
    sends.length = 0;
    render(<ModelPicker task={task()} />);
    await flush();
    fireEvent.change(screen.getByRole('combobox', { name: 'Change model' }), { target: { value: 'sonnet' } });
    await flush();
    expect(sends).toEqual([[1, '/model sonnet', 'the model picker']]);
  });

  it('stands down while a /compact Albedo sent runs, saying "Compacting now" (#384)', async () => {
    const { __setCommandEcho, __resetCommandEchoes } = await import('./transcript/commandEcho');
    render(<ModelPicker task={task()} />);
    await flush();
    const select = screen.getByRole('combobox', { name: 'Change model' }) as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    act(() => __setCommandEcho(1, { text: '/compact', from: 'Compact Now', at: Date.now(), compact: true, noReply: false }));
    expect(select.disabled).toBe(true);
    expect(select.title).toMatch(/Compacting now$/);
    __resetCommandEchoes();
  });
});
