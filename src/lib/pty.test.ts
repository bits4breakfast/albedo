/**
 * Runs without a Tauri host: `@tauri-apps/api/core` is mocked, so what is under
 * test is the bridge logic itself -- argument shape, the startup sweep, the
 * per-spawn channel, detach, and base64 -> bytes decoding.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, calls, channels } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  /** Every invoke since import -- unlike the mock, never reset. */
  calls: [] as Array<[string, Record<string, unknown> | undefined]>,
  channels: [] as Array<{ onmessage: (m: unknown) => void }>,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    calls.push([cmd, args]);
    return invokeMock(cmd, args);
  },
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
    constructor() {
      channels.push(this);
    }
  },
}));

import { ACK_BYTES, killPty, resizePty, spawnPty, writePty, type PtyHandlers } from './pty';

const opts = { cwd: '/tmp', command: 'claude', args: ['--foo'], cols: 80, rows: 24 };

/** Lets the bridge's deferred replay run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function b64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

function recorder() {
  const out: number[][] = [];
  const exits: (number | null)[] = [];
  const handlers: PtyHandlers = {
    onOutput: (bytes) => out.push(Array.from(bytes)),
    onExit: (code) => exits.push(code),
  };
  return { out, exits, handlers };
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) =>
    Promise.resolve(cmd === 'pty_spawn' ? 'pty-1' : undefined),
  );
  channels.length = 0;
});

describe('startup sweep', () => {
  it('kills the previous page once, and spawns carry the same page token', async () => {
    const sweeps = calls.filter(([cmd]) => cmd === 'pty_kill_stale');
    expect(sweeps).toHaveLength(1);
    const page = sweeps[0]?.[1]?.page;
    expect(typeof page).toBe('string');

    await spawnPty(opts, recorder().handlers);
    const spawn = calls.find(([cmd]) => cmd === 'pty_spawn');
    expect(spawn?.[1]).toMatchObject({ opts, page });
    expect(calls.indexOf(sweeps[0]!)).toBeLessThan(calls.indexOf(spawn!));
  });
});

describe('commands', () => {
  it('names its arguments the way the Rust commands expect', async () => {
    await writePty('pty-1', 'ls\r');
    expect(invokeMock).toHaveBeenCalledWith('pty_write', { ptyId: 'pty-1', data: 'ls\r' });

    await resizePty('pty-1', 120, 40);
    expect(invokeMock).toHaveBeenCalledWith('pty_resize', { ptyId: 'pty-1', cols: 120, rows: 40 });

    await killPty('pty-1');
    expect(invokeMock).toHaveBeenCalledWith('pty_kill', { ptyId: 'pty-1' });
  });
});

describe('spawnPty', () => {
  it('hands the caller decoded bytes, never base64', async () => {
    const r = recorder();
    const handle = await spawnPty(opts, r.handlers);
    expect(handle.id).toBe('pty-1');
    await tick();

    // An incomplete UTF-8 sequence: exactly the case that makes the bridge
    // carry bytes instead of a string.
    channels[0]?.onmessage({ kind: 'output', data: b64([0x1b, 0x5b, 0x41, 0xe2, 0x9c]) });
    expect(r.out).toEqual([[0x1b, 0x5b, 0x41, 0xe2, 0x9c]]);
  });

  it('keeps what arrives before the spawn resolves, and replays it after the caller resumes', async () => {
    // A rejected --resume: output and exit both land before pty_spawn returns.
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd !== 'pty_spawn') return Promise.resolve(undefined);
      channels[0]?.onmessage({ kind: 'output', data: b64([0x61]) });
      channels[0]?.onmessage({ kind: 'exit', code: 1 });
      return Promise.resolve('pty-1');
    });

    const order: string[] = [];
    const handlers: PtyHandlers = {
      onOutput: () => order.push('output'),
      onExit: (code) => order.push(`exit ${code}`),
    };
    await spawnPty(opts, handlers);
    order.push('caller resumed');
    await tick();

    expect(order).toEqual(['caller resumed', 'output', 'exit 1']);
  });

  it('passes a null exit code through unchanged', async () => {
    const r = recorder();
    await spawnPty(opts, r.handlers);
    await tick();
    channels[0]?.onmessage({ kind: 'exit', code: null });
    expect(r.exits).toEqual([null]);
  });

  it('stops delivering once detached', async () => {
    const r = recorder();
    const handle = await spawnPty(opts, r.handlers);
    await tick();

    channels[0]?.onmessage({ kind: 'output', data: b64([0x61]) });
    handle.detach();
    channels[0]?.onmessage({ kind: 'output', data: b64([0x62]) });
    channels[0]?.onmessage({ kind: 'exit', code: 0 });

    expect(r.out).toEqual([[0x61]]);
    expect(r.exits).toEqual([]);
  });

  it('gives each spawn its own channel', async () => {
    const a = recorder();
    const b = recorder();
    await spawnPty(opts, a.handlers);
    await spawnPty(opts, b.handlers);
    await tick();

    channels[1]?.onmessage({ kind: 'exit', code: 2 });
    expect(a.exits).toEqual([]);
    expect(b.exits).toEqual([2]);
  });
});

describe('output pacing (#366)', () => {
  /** A chunk of `n` zero bytes, as the channel carries it. */
  const chunk = (n: number) => ({ kind: 'output', data: btoa('\0'.repeat(n)) });
  const acks = () => invokeMock.mock.calls.filter(([cmd]) => cmd === 'pty_ack').map(([, args]) => args);

  /** Spawns with a consumer that keeps each chunk's `done` for the test. */
  async function spawnHolding() {
    const pending: Array<() => void> = [];
    const handle = await spawnPty(opts, {
      onOutput: (_bytes, done) => pending.push(done),
      onExit: () => {},
    });
    await tick();
    return { handle, pending };
  }

  it('reports processed bytes only once the consumer is done with them, in batches', async () => {
    const { pending } = await spawnHolding();
    const half = ACK_BYTES / 2;
    channels[0]?.onmessage(chunk(half));
    channels[0]?.onmessage(chunk(half));
    channels[0]?.onmessage(chunk(half));
    expect(acks()).toEqual([]);

    pending[0]?.();
    expect(acks()).toEqual([]); // under a batch
    pending[1]?.();
    expect(acks()).toEqual([{ ptyId: 'pty-1', bytes: ACK_BYTES }]);
    pending[2]?.();
    expect(acks()).toHaveLength(1);
  });

  it('counts a chunk once however often its done is called', async () => {
    const { pending } = await spawnHolding();
    channels[0]?.onmessage(chunk(ACK_BYTES - 1));
    pending[0]?.();
    pending[0]?.();
    expect(acks()).toEqual([]);
    channels[0]?.onmessage(chunk(1));
    pending[1]?.();
    expect(acks()).toEqual([{ ptyId: 'pty-1', bytes: ACK_BYTES }]);
  });

  it('reports output dropped after detach as processed, so it never holds the pty', async () => {
    const { handle } = await spawnHolding();
    handle.detach();
    channels[0]?.onmessage(chunk(ACK_BYTES));
    expect(acks()).toEqual([{ ptyId: 'pty-1', bytes: ACK_BYTES }]);
  });

  it('reports output held before the spawn resolved under the real id', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd !== 'pty_spawn') return Promise.resolve(undefined);
      channels[0]?.onmessage(chunk(ACK_BYTES));
      return Promise.resolve('pty-7');
    });
    const handle = await spawnPty(opts, { onOutput: (_b, done) => done(), onExit: () => {} });
    expect(acks()).toEqual([]);
    await tick();
    expect(handle.id).toBe('pty-7');
    expect(acks()).toEqual([{ ptyId: 'pty-7', bytes: ACK_BYTES }]);
  });

  it('a failed report is logged once and never thrown into the consumer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    invokeMock.mockImplementation((cmd: string) =>
      cmd === 'pty_ack' ? Promise.reject(new Error('ipc')) : Promise.resolve(cmd === 'pty_spawn' ? 'pty-1' : undefined),
    );
    const handle = await spawnPty(opts, { onOutput: (_b, done) => done(), onExit: () => {} });
    await tick();
    channels[0]?.onmessage(chunk(ACK_BYTES));
    channels[0]?.onmessage(chunk(ACK_BYTES));
    await tick();
    expect(acks()).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(handle.id).toBe('pty-1');
    warn.mockRestore();
  });
});
