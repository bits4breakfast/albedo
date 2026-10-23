/**
 * The server pool, through its public entry points, with Tauri's shell and
 * fs plugins faked. A fake child answers `initialize` and reports its index
 * ready, which is all the pool needs from a real server.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Deframer, frame } from './jsonrpc';

type Handler = (...args: unknown[]) => void;
const spawned: Array<{ program: string; killed: boolean }> = [];
let sidecarAvailable = true;
let installed = true;
/** Set to refuse the config write, as the fs scope did before #73. */
let configError: Error | null = null;

class FakeCommand {
  private handlers = new Map<string, Handler[]>();
  stdout = { on: (_: string, h: Handler) => this.on('stdout', h) };
  constructor(
    private program: string,
    private sidecar: boolean,
  ) {}
  on(event: string, h: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), h]);
    return this;
  }
  private emit(event: string, ...args: unknown[]) {
    for (const h of this.handlers.get(event) ?? []) h(...args);
  }
  async spawn() {
    if (this.sidecar && !sidecarAvailable) throw new Error('sidecar not allowed');
    const record = { program: this.program, killed: false };
    spawned.push(record);
    const deframer = new Deframer();
    return {
      pid: spawned.length,
      write: async (bytes: Uint8Array) => {
        for (const msg of deframer.push(bytes)) {
          if (msg.method === 'initialize') {
            queueMicrotask(() => {
              this.emit('stdout', frame({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } }));
              this.emit('stdout', frame({ jsonrpc: '2.0', method: '$/progress', params: { token: 'phpantom/full-index', value: { kind: 'end' } } }));
            });
          } else if (msg.method === 'shutdown') {
            queueMicrotask(() => this.emit('stdout', frame({ jsonrpc: '2.0', id: msg.id, result: null })));
          }
        }
      },
      kill: async () => {
        record.killed = true;
      },
    };
  }
}

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: {
    sidecar: (program: string) => new FakeCommand(program, true),
    create: (program: string) => new FakeCommand(program, false),
  },
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn(async () => installed),
  mkdir: vi.fn(async () => {}),
  writeTextFile: vi.fn(async () => {
    if (configError) throw configError;
  }),
  watch: vi.fn(async () => () => {}),
}));
vi.mock('@tauri-apps/api/path', () => ({ homeDir: async () => '/home/me' }));

const { phpantomFor, stopPhpantom, MAX_SERVERS, phpantomFailure, dismissPhpantomFailure, subscribePhpantomFailure } =
  await import('./phpantom');

afterEach(async () => {
  for (const root of ['/wt/a', '/wt/b', '/wt/c']) await stopPhpantom(root);
  spawned.length = 0;
  sidecarAvailable = true;
  installed = true;
  configError = null;
});

describe('PHPantom pool', () => {
  it('starts a server and it becomes ready (no wait on itself)', async () => {
    const server = await phpantomFor('/wt/a');
    expect(server).not.toBeNull();
    await expect(server!.whenReady(1000)).resolves.toBe(true);
  });

  it('prefers the copy bundled in the app', async () => {
    await phpantomFor('/wt/a');
    expect(spawned.map((s) => s.program)).toEqual(['binaries/phpantom_lsp']);
  });

  it('falls back to the installed copy, and to nothing when there is neither', async () => {
    sidecarAvailable = false;
    expect(await phpantomFor('/wt/a')).not.toBeNull();
    expect(spawned.map((s) => s.program)).toEqual(['phpantom']);
    installed = false;
    expect(await phpantomFor('/wt/b')).toBeNull();
  });

  it('shares one start per worktree', async () => {
    const [x, y] = await Promise.all([phpantomFor('/wt/a'), phpantomFor('/wt/a')]);
    expect(x).toBe(y);
    expect(spawned).toHaveLength(1);
  });

  it(`keeps at most ${MAX_SERVERS} running, stopping the least recently used`, async () => {
    const a = await phpantomFor('/wt/a');
    await new Promise((r) => setTimeout(r, 2));
    const b = await phpantomFor('/wt/b');
    await new Promise((r) => setTimeout(r, 2));
    b!.touch();
    await phpantomFor('/wt/c');
    expect(a!.stopped).toBe(true);
    expect(b!.stopped).toBe(false);
    expect(spawned[0]!.killed).toBe(true);
  });

  it('starts two worktrees at once without either waiting on the other', async () => {
    const [a, b] = await Promise.all([phpantomFor('/wt/a'), phpantomFor('/wt/b')]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  it('stops a server whose start was still under way once it lands, without waiting for it', async () => {
    const starting = phpantomFor('/wt/a');
    await stopPhpantom('/wt/a');
    expect(spawned).toHaveLength(0);
    const server = await starting;
    expect(server).not.toBeNull();
    await vi.waitFor(() => expect(spawned[0]!.killed).toBe(true));
  });
});

// Last: what a failure says is kept for the rest of the run, as in the app.
describe('PHPantom pool, when a start fails (#73)', () => {
  it('resolves null rather than rejecting, and stopping it resolves', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    configError = new Error('forbidden path: /home/me/.albedo/phpantom/phpantom_lsp/.phpantom.toml');
    const starting = phpantomFor('/wt/a');
    await expect(stopPhpantom('/wt/a')).resolves.toBeUndefined();
    await expect(starting).resolves.toBeNull();
    await expect(stopPhpantom('/wt/a')).resolves.toBeUndefined();
    expect(spawned).toHaveLength(0);
  });

  it('is not remembered: the next ask starts again', async () => {
    expect(await phpantomFor('/wt/a')).not.toBeNull();
  });

  it('says why once, until dismissed', async () => {
    expect(phpantomFailure()).toMatch(/forbidden path/);
    configError = new Error('a second, different failure');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await phpantomFor('/wt/b')).toBeNull();
    expect(phpantomFailure()).toMatch(/forbidden path/);

    const listener = vi.fn();
    const unsubscribe = subscribePhpantomFailure(listener);
    dismissPhpantomFailure();
    unsubscribe();
    expect(listener).toHaveBeenCalledOnce();
    expect(phpantomFailure()).toBeNull();
  });
});
