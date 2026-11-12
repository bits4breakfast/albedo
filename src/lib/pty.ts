/**
 * Frontend half of the pty bridge. Thin on purpose: it invokes the Rust
 * commands in src-tauri/src/pty.rs, and hands each spawn's output and exit to
 * the handlers passed to {@link spawnPty}.
 *
 * Callers get **bytes**, never base64 and never a string. Base64 exists only
 * because an IPC message is JSON and a pty emits arbitrary bytes that may split
 * a UTF-8 codepoint or an escape sequence mid-sequence; decoding it here keeps
 * that an implementation detail of the bridge. Feed the bytes straight to
 * `xterm.write()`, which accepts a Uint8Array.
 *
 * Nothing in this module inspects the byte stream. Terminal output is opaque --
 * all structured data comes from the transcript (CLAUDE.md, "Two channels").
 *
 * Output is paced (#366): each chunk comes with a `done` callback for the
 * consumer to call once it has written the chunk (xterm's write callback), and
 * this module reports the byte counts back to Rust, which stops reading the pty
 * past ~1 MB unreported. It counts bytes; it never looks at them.
 */

import { Channel, invoke } from '@tauri-apps/api/core';

import type { PtySpawnOptions } from '../types';

/** One message on a spawn's channel. Mirrors `PtyEvent` in pty.rs. */
type PtyEvent = { kind: 'output'; data: string } | { kind: 'exit'; code: number | null };

/**
 * Processed bytes are reported in batches of at least this many, so a flood
 * costs one IPC call per 128 KB rather than one per chunk. Well under Rust's
 * 1 MB pause (`HIGH_WATER` in pty.rs), so the up to 128 KB not yet reported at
 * any moment never brings the reader near it on its own.
 */
export const ACK_BYTES = 128 * 1024;

export interface PtyHandlers {
  /**
   * Raw bytes, in order. Call `done` once they have been written -- for xterm,
   * pass it as `write`'s callback.
   *
   * Every delivered chunk's `done` MUST be called, once, even if the bytes are
   * thrown away (`writeOutput` in src/ui/terminalOutput.ts does this). Bytes
   * delivered and never reported stay counted in Rust for the rest of the
   * session and shrink the 1 MB window for good. A consumer that skips `done`
   * while the pty lives on reaches the pause and then stalls: each report that
   * does arrive (about one per 128 KB) re-arms the pause, which then waits the
   * full second before giving up -- a freeze of up to 1 s per ~128 KB. A
   * consumer that stops for good (it is unmounting) must kill the pty, or
   * `detach`, which reports whatever arrives afterwards itself.
   */
  onOutput: (bytes: Uint8Array, done: () => void) => void;
  /**
   * Fires once, after the last output. `code` is null when the exit status
   * could not be determined.
   */
  onExit: (code: number | null) => void;
}

export interface PtyHandle {
  id: string;
  /** Stops delivery to the handlers. Does not kill anything. */
  detach: () => void;
}

/**
 * Identifies this page load. Every pty is tagged with it, so that the next
 * page -- after a reload, which does not unmount React and so never ran a
 * single cleanup -- can kill this one's sessions without touching its own.
 */
const PAGE: string =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/**
 * Kill whatever a previous page left running, once, at startup.
 *
 * Without this a reload (Vite's full reload in `tauri dev`, or Cmd+R) orphans
 * every live pty, and reopening the task spawns a second `claude --resume` on
 * the same session alongside the first. Spawns wait for it, so the old copy is
 * gone before the new one starts. Never rejects: a failed sweep must not stop
 * the app from starting sessions.
 */
const sweep: Promise<void> = Promise.resolve()
  .then(() => invoke<void>('pty_kill_stale', { page: PAGE }))
  .catch((err: unknown) => {
    console.error("pty: could not kill the previous page's sessions", err);
  });

/**
 * Spawns a command on a new pty. Resolves to its id and a way to detach.
 *
 * `command` is resolved by the user's **login shell**, not by Albedo's own
 * PATH, so a bare `'claude'` is found wherever a terminal tab would find it --
 * a bundled .app inherits a minimal PATH from Finder that does not include
 * `~/.local/bin`. Pass the command and its arguments separately; the Rust side
 * quotes each one, so spaces and quotes in a worktree path are safe.
 *
 * The handlers travel WITH the spawn, on a channel that exists before the child
 * does, so nothing it emits can be lost -- with global events, a `--resume`
 * that was rejected and exited in milliseconds could finish before anyone was
 * listening. They are never called before this promise has resolved and the
 * caller's `await` has resumed, so a handler may rely on the id the caller
 * stored; anything that arrived earlier is held and replayed in order.
 *
 * Rejects only if the pty could not be created (a missing `cwd`, say). A
 * command that does not exist spawns fine and then exits: the shell writes its
 * own "command not found" into the terminal, and `onExit` fires with 127.
 */
export async function spawnPty(opts: PtySpawnOptions, handlers: PtyHandlers): Promise<PtyHandle> {
  await sweep;

  let held: PtyEvent[] | null = [];
  let detached = false;
  // Assigned when pty_spawn resolves; nothing is delivered (or acked) before.
  let id = '';
  let unreported = 0;
  let ackFailed = false;
  // The only path to Rust's count (`HIGH_WATER` in pty.rs): it moves only
  // when the consumer calls `done`, so every delivered chunk must reach here
  // exactly once -- see `PtyHandlers.onOutput`.
  const processed = (n: number) => {
    unreported += n;
    if (unreported < ACK_BYTES) return;
    const bytes = unreported;
    unreported = 0;
    invoke<void>('pty_ack', { ptyId: id, bytes }).catch((err: unknown) => {
      // Once per pty: a flood would otherwise log hundreds of these. Rust
      // stops waiting on its own, so a lost ack costs pacing, not the session.
      if (ackFailed) return;
      ackFailed = true;
      console.warn('pty: could not acknowledge output', err);
    });
  };
  const deliver = (ev: PtyEvent) => {
    if (ev.kind === 'output') {
      const bytes = decodeBase64(ev.data);
      // Dropped output counts as processed: a detached consumer must never
      // keep the process paused.
      if (detached) {
        processed(bytes.length);
        return;
      }
      let called = false;
      handlers.onOutput(bytes, () => {
        if (called) return;
        called = true;
        processed(bytes.length);
      });
    } else if (!detached) {
      handlers.onExit(ev.code);
    }
  };

  const events = new Channel<PtyEvent>();
  events.onmessage = (ev) => {
    if (held) held.push(ev);
    else deliver(ev);
  };

  id = await invoke<string>('pty_spawn', { opts, page: PAGE, events });

  // A macrotask, so it runs after the caller's continuation (a microtask) has
  // stored the id. Messages keep queueing behind `held` until then.
  setTimeout(() => {
    const queued = held ?? [];
    held = null;
    for (const ev of queued) deliver(ev);
  }, 0);

  return {
    id,
    detach: () => {
      detached = true;
    },
  };
}

/**
 * Sends input to the pty. Keystrokes, pastes, control sequences -- all opaque.
 * Resolves once queued, in call order; the Rust side never blocks on a write.
 */
export function writePty(ptyId: string, data: string): Promise<void> {
  return invoke<void>('pty_write', { ptyId, data });
}

/**
 * Tells the child the window changed size.
 *
 * Safe to call at any point in a pty's life: a resize for an id that is gone
 * (or not registered yet) resolves rather than rejecting, so a ResizeObserver
 * firing during spawn or after exit does not need to be guarded.
 */
export function resizePty(ptyId: string, cols: number, rows: number): Promise<void> {
  return invoke<void>('pty_resize', { ptyId, cols, rows });
}

/**
 * Signals the child's whole process group -- SIGHUP, then SIGKILL after a
 * grace -- so nothing it backgrounded survives. The spawn's `onExit` still
 * fires afterwards.
 */
export function killPty(ptyId: string): Promise<void> {
  return invoke<void>('pty_kill', { ptyId });
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/** base64 -> raw bytes. Deliberately not text: see the module comment. */
function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
