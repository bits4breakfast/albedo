/**
 * PHPantom, a PHP language server, used for NAVIGATION ONLY: Go to
 * Declaration, Find Usages and Go to Implementation in the editor. No
 * completion, no diagnostics, no formatting -- the editor's spec still says no
 * LSP features, and this is the narrow exception the owner chose: a jump
 * target, a list of usages and a list of implementations.
 *
 * Three requests, and only these are advertised: `textDocument/definition`,
 * `textDocument/references` and `textDocument/implementation`. PHPantom 0.11.1
 * has no type hierarchy (`typeHierarchy/prepareTypeHierarchy` is "Method not
 * found"), and its `implementation` answers all three questions a type is
 * asked -- see `implementation` below for what it returns.
 *
 * ## Optional
 *
 * Bundled inside the app by `build.sh --with-phpantom` (a Tauri sidecar), or
 * installed at `~/.albedo/bin/phpantom_lsp` by `scripts/install-phpantom.sh`;
 * the bundled copy is tried first. Albedo never downloads it. Absent, broken or
 * too slow, every caller gets null and `symbolNav.ts` answers with git grep,
 * which needs nothing installed.
 *
 * ## Lifecycle: only for PHP, only on demand
 *
 * A server starts the first time a `.php` file is opened in the editor or
 * navigated from, and never for anything else. One per worktree, at most
 * `MAX_SERVERS` at once (least recently used stops first), each stopped after
 * `IDLE_MS` without a request. There is nothing to clean up afterwards:
 * PHPantom keeps its index in memory only and writes nothing to disk, and it
 * exits on its own when its stdin closes, so even an Albedo crash leaves no
 * process behind. Measured on a 6.8k-file worktree: ready in ~1s, 30-65 MB.
 *
 * ## Staying fresh
 *
 * The index lives in the server's memory and only changes when it is told.
 * PHPantom does not watch the disk itself -- it relies on the client -- and
 * agents write files constantly from outside the editor. So every server has
 * a recursive watcher on its worktree, and every PHP file that changes is
 * reported. Measured: with no report, the server kept serving a usage that
 * had been deleted from disk.
 *
 * ## Configuration
 *
 * Albedo's own `.phpantom.toml` is written under `~/.albedo/phpantom/` and
 * the server is pointed at it with `XDG_CONFIG_HOME`, so nothing is written
 * into the user's repository or their own `~/.config`. It excludes `vendor/`
 * and turns off everything that is not navigation, including PHPantom's
 * PHPStan / PHPCS / PHPMD / Mago runners, which would otherwise start on save.
 */

import { Command, type Child } from '@tauri-apps/plugin-shell';
import { exists, mkdir, watch, writeTextFile, type UnwatchFn } from '@tauri-apps/plugin-fs';
import { Connection, type Transport } from './jsonrpc';

/** The name in `capabilities/default.json`'s shell scope. */
const SCOPE_NAME = 'phpantom';
/** The copy bundled inside the app by `build.sh --with-phpantom` (a Tauri sidecar). */
const SIDECAR_NAME = 'binaries/phpantom_lsp';
const BIN_RELATIVE = '.albedo/bin/phpantom_lsp';
const CONFIG_HOME_RELATIVE = '.albedo/phpantom';
/**
 * The config file. Its name starts with a dot, so `$HOME/.albedo/**` in
 * `capabilities/default.json` covers it only because `tauri.conf.json` turns
 * the fs plugin's `requireLiteralLeadingDot` off (#93).
 */
export const CONFIG_FILE_RELATIVE = `${CONFIG_HOME_RELATIVE}/phpantom_lsp/.phpantom.toml`;

export const MAX_SERVERS = 2;
export const IDLE_MS = 10 * 60_000;
/** A server not ready by then is reported unavailable for that request. */
export const READY_WAIT_MS = 4_000;
/** Watcher events are batched this long before being sent. */
const WATCH_DEBOUNCE_MS = 300;

export const CONFIG_TOML = `# Written by Albedo on every server start; edits here are overwritten.
# Navigation only: everything else PHPantom can do is switched off.

[indexing]
exclude = ["vendor/", "node_modules/"]

[diagnostics]
workspace = false

[semantic_tokens]
mode = "off"

[phpstan]
command = ""

[phpcs]
command = ""

[phpmd]
command = ""

[mago]
command = ""

[formatting]
pint = ""
php-cs-fixer = ""
phpcbf = ""
`;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function isPhpPath(path: string): boolean {
  return /\.php$/i.test(path);
}

/** `file://` URI for an absolute path, each segment percent-encoded. */
export function fileUri(absolute: string): string {
  return `file://${absolute.split('/').map(encodeURIComponent).join('/')}`;
}

/** Worktree-relative path for a server URI, or null when it is outside `root`. */
export function relativeFromUri(root: string, uri: string): string | null {
  if (!uri.startsWith('file://')) return null;
  const absolute = decodeURIComponent(uri.slice('file://'.length));
  const base = root.endsWith('/') ? root : `${root}/`;
  return absolute.startsWith(base) ? absolute.slice(base.length) : null;
}

/** Whether a changed path matters to the server. */
export function isWatchedPath(root: string, absolute: string): boolean {
  const base = root.endsWith('/') ? root : `${root}/`;
  if (!absolute.startsWith(base)) return false;
  const rel = absolute.slice(base.length);
  if (/(^|\/)(\.git|vendor|node_modules)\//.test(rel)) return false;
  return isPhpPath(rel) || rel === 'composer.json' || rel === 'composer.lock' || rel === '.phpantom.toml';
}

/** LSP FileChangeType. */
export const CREATED = 1;
export const DELETED = 3;

/**
 * The change to report for a path. Always CREATED when the file exists:
 * PHPantom ignores a CHANGED for a file it has not parsed (so a new file
 * reported as CHANGED is lost), and re-reads an existing file reported as
 * CREATED correctly -- both measured. That makes the answer independent of
 * whatever kind FSEvents coalesced the event into.
 */
export function changeType(fileExists: boolean): number {
  return fileExists ? CREATED : DELETED;
}

export interface Location {
  /** Worktree-relative. */
  path: string;
  /** 1-based. */
  line: number;
}

interface LspLocation {
  uri?: string;
  targetUri?: string;
  range?: { start: { line: number } };
  targetSelectionRange?: { start: { line: number } };
  targetRange?: { start: { line: number } };
}

/** Location | Location[] | LocationLink[] | null, as the spec allows, into ours. */
export function toLocations(root: string, result: unknown): Location[] {
  const list = Array.isArray(result) ? result : result ? [result] : [];
  const out: Location[] = [];
  for (const raw of list as LspLocation[]) {
    const uri = raw.uri ?? raw.targetUri;
    const range = raw.range ?? raw.targetSelectionRange ?? raw.targetRange;
    if (!uri || !range) continue;
    const path = relativeFromUri(root, uri);
    if (path !== null) out.push({ path, line: range.start.line + 1 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// One server
// ---------------------------------------------------------------------------

export class PhpServer {
  private ready = false;
  private readyWaiters: Array<() => void> = [];
  private unwatch: UnwatchFn | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingChanges = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  lastUsed = Date.now();
  stopped = false;

  constructor(
    readonly root: string,
    private readonly child: Child,
    private readonly conn: Connection,
    private readonly onStopped: (server: PhpServer) => void,
  ) {}

  /** The server finished its full index. Called from the progress handler. */
  markReady(): void {
    if (this.ready) return;
    this.ready = true;
    for (const w of this.readyWaiters.splice(0)) w();
  }

  /** Resolves true once ready, false if `ms` passes first or it stops. */
  whenReady(ms: number): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    if (this.stopped) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.ready), ms);
      this.readyWaiters.push(() => {
        clearTimeout(timer);
        resolve(!this.stopped);
      });
    });
  }

  touch(): void {
    this.lastUsed = Date.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.stop(), IDLE_MS);
  }

  async startWatching(): Promise<void> {
    try {
      this.unwatch = await watch(
        this.root,
        (event) => {
          for (const p of event.paths) if (isWatchedPath(this.root, p)) this.pendingChanges.add(p);
          if (this.pendingChanges.size > 0 && !this.flushTimer) {
            this.flushTimer = setTimeout(() => void this.flushChanges(), WATCH_DEBOUNCE_MS);
          }
        },
        { recursive: true, delayMs: WATCH_DEBOUNCE_MS },
      );
    } catch (err) {
      // Without a watcher the index goes stale as soon as an agent writes a
      // file. Better no server than a confidently wrong one.
      console.error('[phpantom] cannot watch', this.root, err);
      noteStartFailure(err);
      await this.stop();
    }
  }

  private async flushChanges(): Promise<void> {
    this.flushTimer = null;
    const paths = [...this.pendingChanges];
    this.pendingChanges.clear();
    if (this.stopped || paths.length === 0) return;
    const changes = await Promise.all(
      paths.map(async (p) => ({ uri: fileUri(p), type: changeType(await exists(p).catch(() => false)) })),
    );
    this.conn.notify('workspace/didChangeWatchedFiles', { changes });
  }

  /**
   * Run one request against the editor's buffer as it is on screen (it may
   * hold unsaved edits, and the position was computed against it).
   *
   * The document is opened for the request and closed straight after. That
   * is deliberate: PHPantom ignores disk events for a document it holds open
   * -- the editor is assumed to be its source of truth -- so a document left
   * open would stop seeing the agent's writes to that file.
   */
  private async withDocument<T>(path: string, text: string, ask: (uri: string) => Promise<T>): Promise<T> {
    this.touch();
    const uri = fileUri(`${this.root}/${path}`);
    this.conn.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'php', version: 1, text } });
    try {
      return await ask(uri);
    } finally {
      this.conn.notify('textDocument/didClose', { textDocument: { uri } });
    }
  }

  definition(path: string, text: string, line0: number, character: number): Promise<Location[]> {
    return this.withDocument(path, text, async (uri) =>
      toLocations(
        this.root,
        await this.conn.request('textDocument/definition', { textDocument: { uri }, position: { line: line0, character } }),
      ),
    );
  }

  references(path: string, text: string, line0: number, character: number): Promise<Location[]> {
    return this.withDocument(path, text, async (uri) =>
      toLocations(
        this.root,
        await this.conn.request(
          'textDocument/references',
          { textDocument: { uri }, position: { line: line0, character }, context: { includeDeclaration: false } },
          30_000,
        ),
      ),
    );
  }

  /**
   * The types under a type. Measured on 0.11.1, transitively in every case:
   * on an interface, the non-abstract classes implementing it, directly or
   * through a parent (no abstract class, no interface extending it); on a
   * class, its non-abstract subclasses at any depth; on a trait, every class
   * and trait using it, directly, through another trait or through a parent.
   * On an interface under vendor/ (not indexed) it answered null, with and
   * without the exclusion. It also answers on a method; `symbolNav` asks only
   * on a type.
   */
  implementation(path: string, text: string, line0: number, character: number): Promise<Location[]> {
    return this.withDocument(path, text, async (uri) =>
      toLocations(
        this.root,
        await this.conn.request(
          'textDocument/implementation',
          { textDocument: { uri }, position: { line: line0, character } },
          30_000,
        ),
      ),
    );
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const w of this.readyWaiters.splice(0)) w();
    try {
      this.unwatch?.();
    } catch {
      /* already gone */
    }
    this.onStopped(this);
    try {
      // Polite first; the kill below is the guarantee.
      await this.conn.request('shutdown', null, 1_000);
      this.conn.notify('exit', null);
    } catch {
      /* it may already be gone */
    }
    this.conn.close(new Error('server stopped'));
    await this.child.kill().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

const servers = new Map<string, Promise<PhpServer | null>>();
/**
 * What each start came to, once it has. A start still under way is never
 * waited on by anything but its own caller: not by a stop, and not by another
 * worktree's start (two starting at once would each wait on the other).
 */
const settled = new WeakMap<Promise<PhpServer | null>, PhpServer | null>();
let home: string | null = null;

// ---------------------------------------------------------------------------
// Start failures, said once
// ---------------------------------------------------------------------------

/**
 * Why the first start that failed did, until the user has seen it. Not installed is not
 * a failure: the server is optional and git grep is the expected answer then.
 * Anything else used to be a `console.warn` only, and navigation fell back to
 * git grep for months without anyone knowing (docs/REGRESSIONS.md, "Cleanup
 * paths"). One per run: the cause is the same for every worktree.
 */
let startFailure: string | null = null;
let failureDismissed = false;
const failureListeners = new Set<() => void>();

function noteStartFailure(err: unknown): void {
  if (startFailure !== null) return;
  startFailure = err instanceof Error ? err.message : String(err);
  for (const l of failureListeners) l();
}

/** Why PHPantom couldn't start, while that is still to be said; else null. */
export function phpantomFailure(): string | null {
  return failureDismissed ? null : startFailure;
}

export function subscribePhpantomFailure(listener: () => void): () => void {
  failureListeners.add(listener);
  return () => failureListeners.delete(listener);
}

/** Seen: not shown again this run. */
export function dismissPhpantomFailure(): void {
  if (failureDismissed) return;
  failureDismissed = true;
  for (const l of failureListeners) l();
}

async function homeDir(): Promise<string> {
  if (home === null) {
    const { homeDir: resolve } = await import('@tauri-apps/api/path');
    home = (await resolve()).replace(/\/$/, '');
  }
  return home;
}

/** Whether the binary is installed. Cheap; checked on every start. */
export async function phpantomInstalled(): Promise<boolean> {
  return exists(`${await homeDir()}/${BIN_RELATIVE}`).catch(() => false);
}

async function writeConfig(): Promise<string> {
  const base = await homeDir();
  const configHome = `${base}/${CONFIG_HOME_RELATIVE}`;
  await mkdir(`${configHome}/phpantom_lsp`, { recursive: true });
  await writeTextFile(`${base}/${CONFIG_FILE_RELATIVE}`, CONFIG_TOML);
  return configHome;
}

/**
 * Stop least-recently-used servers until there is room for one more. Only
 * servers already running count: the worktree being started is the very
 * start waiting here, and another one still starting may be waiting on this
 * one. Two starting at once can briefly make it one more than the cap.
 */
async function evictToFit(starting: string): Promise<void> {
  const live = [...servers.entries()]
    .filter(([root]) => root !== starting)
    .map(([, p]) => settled.get(p))
    .filter((s): s is PhpServer => s != null && !s.stopped);
  live.sort((a, b) => a.lastUsed - b.lastUsed);
  while (live.length >= MAX_SERVERS) await live.shift()!.stop();
}

async function start(root: string): Promise<PhpServer | null> {
  const configHome = await writeConfig();
  const options = {
    cwd: root,
    encoding: 'raw' as const,
    // The plugin cannot clear an environment and add to it at once, so the
    // inherited one is kept and the Anthropic credentials are blanked: the
    // rule is that no process Albedo spawns carries them (see pty.rs).
    env: { XDG_CONFIG_HOME: configHome, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' },
  };
  // The copy bundled in the app first (pinned with this build), then one the
  // user installed. A build without the bundled copy refuses the sidecar
  // spawn at once, which is how its absence shows.
  const candidates: Array<() => Command<Uint8Array>> = [() => Command.sidecar(SIDECAR_NAME, ['--stdio'], options)];
  if (await phpantomInstalled()) candidates.push(() => Command.create(SCOPE_NAME, ['--stdio'], options));

  let server: PhpServer | null = null;
  let child: Child | null = null;
  const transport: Transport = {
    write: async (bytes) => {
      if (!child) throw new Error('phpantom is not running');
      await child.write(bytes);
    },
  };
  const conn = new Connection(
    transport,
    // registerCapability, workDoneProgress/create, configuration: all
    // acknowledged. The watcher is ours regardless of what it registers.
    (method) => (method === 'workspace/configuration' ? [] : null),
    (method, params) => {
      const p = params as { token?: string; value?: { kind?: string } } | undefined;
      if (method === '$/progress' && p?.token === 'phpantom/full-index' && p.value?.kind === 'end') server?.markReady();
    },
  );
  for (const make of candidates) {
    const command = make();
    command.stdout.on('data', (chunk) => conn.receive(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)));
    command.on('close', () => {
      conn.close(new Error('phpantom exited'));
      void server?.stop();
    });
    command.on('error', (err) => console.error('[phpantom]', err));
    try {
      child = await command.spawn();
      break;
    } catch {
      /* not this one: try the next */
    }
  }
  // Neither bundled nor installed: git grep answers, as it always could.
  if (!child) return null;
  await evictToFit(root);
  server = new PhpServer(root, child, conn, (s) => {
    if (servers.get(s.root) && s === server) servers.delete(s.root);
  });

  try {
    await conn.request(
      'initialize',
      {
        processId: null,
        rootUri: fileUri(root),
        workspaceFolders: [{ uri: fileUri(root), name: root.split('/').pop() ?? root }],
        capabilities: {
          window: { workDoneProgress: true },
          workspace: { didChangeWatchedFiles: { dynamicRegistration: true }, workspaceFolders: true },
          textDocument: {
            synchronization: { didSave: false },
            definition: { linkSupport: false },
            references: {},
            implementation: { linkSupport: false },
          },
        },
        initializationOptions: { indexing: { exclude: ['vendor/', 'node_modules/'] } },
      },
      10_000,
    );
    conn.notify('initialized', {});
  } catch (err) {
    console.error('[phpantom] initialize failed', err);
    noteStartFailure(err);
    await server.stop();
    return null;
  }
  server.touch();
  await server.startWatching();
  return server.stopped ? null : server;
}

/**
 * The server for a worktree, starting it if needed. Callers must only ask for
 * PHP files: that is the rule, and `symbolNav` and the editor both check.
 * Resolves null when PHPantom is not installed or failed to start; it never
 * rejects, so nothing that awaits it -- a lookup, a stop, an archive -- can be
 * failed by an optional server.
 */
export function phpantomFor(root: string): Promise<PhpServer | null> {
  const existing = servers.get(root);
  if (existing) return existing;
  const started = start(root).catch((err: unknown) => {
    console.warn('[phpantom] could not start; git grep answers instead:', err);
    noteStartFailure(err);
    return null;
  });
  servers.set(root, started);
  void started.then((s) => {
    settled.set(started, s);
    if ((s === null || s.stopped) && servers.get(root) === started) servers.delete(root);
  });
  return started;
}

/** Start a worktree's server ahead of the first ⌘B, without waiting for it. */
export function warmPhpantom(root: string): void {
  void phpantomFor(root);
}

/**
 * Stop a worktree's server: on archive, or when the worktree goes away.
 * Never throws, and never waits on a start: a running server is stopped here,
 * one still starting is stopped whenever it gets there. Cleanup of an optional
 * server must not hold up or fail the action it is part of.
 */
export async function stopPhpantom(root: string): Promise<void> {
  const entry = servers.get(root);
  if (!entry) return;
  servers.delete(root);
  const stop = (s: PhpServer | null | undefined) =>
    s?.stop().catch((err: unknown) => console.warn('[phpantom] stop failed', root, err));
  if (settled.has(entry)) await stop(settled.get(entry));
  else void entry.then(stop);
}
