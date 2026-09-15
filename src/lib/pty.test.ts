/**
 * Runs without a Tauri host: both `@tauri-apps/api` entry points are mocked, so
 * what is under test is the bridge logic itself -- argument shape, per-pty
 * filtering, unsubscribe, and base64 -> bytes decoding.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, bus } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  bus: {
    handlers: new Map<string, Set<(e: { payload: unknown }) => void>>(),
  },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, handler: (e: { payload: unknown }) => void) => {
    const set = bus.handlers.get(name) ?? new Set<(e: { payload: unknown }) => void>();
    set.add(handler);
    bus.handlers.set(name, set);
    return Promise.resolve(() => {
      set.delete(handler);
    });
  },
}));

import { killPty, onPtyExit, onPtyOutput, resizePty, spawnPty, writePty } from './pty';

/** Delivers an event to every registered listener, as the Tauri bus would. */
function emit(name: string, payload: unknown): void {
  for (const handler of bus.handlers.get(name) ?? []) handler({ payload });
}

/** Lets the pending `listen()` promise inside `subscribe` settle. */
const settled = () => Promise.resolve();

function b64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  bus.handlers.clear();
});

describe('commands', () => {
  it('passes spawn options through as a single opts argument', async () => {
    invokeMock.mockResolvedValue('pty-1');
    const opts = { cwd: '/tmp', command: 'claude', args: ['--foo'], cols: 80, rows: 24 };

    await expect(spawnPty(opts)).resolves.toBe('pty-1');
    expect(invokeMock).toHaveBeenCalledWith('pty_spawn', { opts });
  });

  it('names its arguments the way the Rust commands expect', async () => {
    await writePty('pty-1', 'ls\r');
    expect(invokeMock).toHaveBeenCalledWith('pty_write', { ptyId: 'pty-1', data: 'ls\r' });

    await resizePty('pty-1', 120, 40);
    expect(invokeMock).toHaveBeenCalledWith('pty_resize', { ptyId: 'pty-1', cols: 120, rows: 40 });

    await killPty('pty-1');
    expect(invokeMock).toHaveBeenCalledWith('pty_kill', { ptyId: 'pty-1' });
  });
});

describe('onPtyOutput', () => {
  it('hands the caller decoded bytes, never base64', async () => {
    const seen: Uint8Array[] = [];
    onPtyOutput('pty-1', (bytes) => seen.push(bytes));
    await settled();

    // An incomplete UTF-8 sequence: exactly the case that makes the bridge
    // carry bytes instead of a string.
    emit('pty://output', { ptyId: 'pty-1', data: b64([0x1b, 0x5b, 0x41, 0xe2, 0x9c]) });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(Uint8Array);
    expect(Array.from(seen[0] ?? [])).toEqual([0x1b, 0x5b, 0x41, 0xe2, 0x9c]);
  });

  it('ignores output belonging to another pty', async () => {
    const seen: Uint8Array[] = [];
    onPtyOutput('pty-1', (bytes) => seen.push(bytes));
    await settled();

    emit('pty://output', { ptyId: 'pty-2', data: b64([0x61]) });
    expect(seen).toHaveLength(0);
  });

  it('stops delivering once unsubscribed', async () => {
    const seen: Uint8Array[] = [];
    const off = onPtyOutput('pty-1', (bytes) => seen.push(bytes));
    await settled();

    emit('pty://output', { ptyId: 'pty-1', data: b64([0x61]) });
    off();
    emit('pty://output', { ptyId: 'pty-1', data: b64([0x62]) });

    expect(seen).toHaveLength(1);
  });

  it('survives an unsubscribe that happens before listen() resolves', async () => {
    const seen: Uint8Array[] = [];
    const off = onPtyOutput('pty-1', (bytes) => seen.push(bytes));
    off();
    await settled();

    emit('pty://output', { ptyId: 'pty-1', data: b64([0x61]) });
    expect(seen).toHaveLength(0);
    expect(bus.handlers.get('pty://output')?.size ?? 0).toBe(0);
  });
});

describe('onPtyExit', () => {
  it('reports the exit code for its own pty only', async () => {
    const codes: (number | null)[] = [];
    onPtyExit('pty-1', (code) => codes.push(code));
    await settled();

    emit('pty://exit', { ptyId: 'pty-2', code: 1 });
    emit('pty://exit', { ptyId: 'pty-1', code: 0 });
    expect(codes).toEqual([0]);
  });

  it('passes a null code through unchanged', async () => {
    const codes: (number | null)[] = [];
    onPtyExit('pty-1', (code) => codes.push(code));
    await settled();

    emit('pty://exit', { ptyId: 'pty-1', code: null });
    expect(codes).toEqual([null]);
  });
});
