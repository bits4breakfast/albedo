/**
 * Frontend half of the pty bridge. Thin on purpose: it invokes the Rust
 * commands in src-tauri/src/pty.rs and turns the two `pty://*` events into
 * per-pty subscriptions.
 *
 * Callers get **bytes**, never base64 and never a string. Base64 exists only
 * because a Tauri event payload is JSON and a pty emits arbitrary bytes that
 * may split a UTF-8 codepoint or an escape sequence mid-sequence; decoding it
 * here keeps that an implementation detail of the bridge. Feed the bytes
 * straight to `xterm.write()`, which accepts a Uint8Array.
 *
 * Nothing in this module inspects the byte stream. Terminal output is opaque --
 * all structured data comes from the transcript (CLAUDE.md, "Two channels").
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type { PtyExitEvent, PtyOutputEvent, PtySpawnOptions } from '../types';

/**
 * Spawns a command on a new pty. Resolves to the id used by every other call.
 *
 * `command` is resolved by the user's **login shell**, not by Albedo's own
 * PATH, so a bare `'claude'` is found wherever a terminal tab would find it --
 * a bundled .app inherits a minimal PATH from Finder that does not include
 * `~/.local/bin`. Pass the command and its arguments separately; the Rust side
 * quotes each one, so spaces and quotes in a worktree path are safe.
 *
 * Rejects only if the pty could not be created (a missing `cwd`, say). A
 * command that does not exist spawns fine and then exits: the shell writes its
 * own "command not found" into the terminal, and `onPtyExit` fires with 127.
 */
export function spawnPty(opts: PtySpawnOptions): Promise<string> {
  return invoke<string>('pty_spawn', { opts });
}

/** Sends input to the pty. Keystrokes, pastes, control sequences -- all opaque. */
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

/** Signals the child. `pty://exit` still fires afterwards, so `onPtyExit` sees it. */
export function killPty(ptyId: string): Promise<void> {
  return invoke<void>('pty_kill', { ptyId });
}

/**
 * Subscribes to output from one pty. Returns an unsubscribe function.
 *
 * Note the events are global; the filter by `ptyId` is what makes this
 * per-terminal. Unsubscribing is safe to do immediately, even before the
 * underlying listener has finished registering.
 */
export function onPtyOutput(ptyId: string, cb: (bytes: Uint8Array) => void): () => void {
  return subscribe<PtyOutputEvent>('pty://output', (payload) => {
    if (payload.ptyId !== ptyId) return;
    cb(decodeBase64(payload.data));
  });
}

/**
 * Subscribes to the exit of one pty. `code` is null when the exit status could
 * not be determined (killed by a signal the OS did not report a code for).
 * Returns an unsubscribe function.
 */
export function onPtyExit(ptyId: string, cb: (code: number | null) => void): () => void {
  return subscribe<PtyExitEvent>('pty://exit', (payload) => {
    if (payload.ptyId !== ptyId) return;
    cb(payload.code);
  });
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * `listen` is async but the interface promises a synchronous unsubscribe, so
 * the registration is raced against the caller possibly unsubscribing first.
 * Two guards cover that: `cancelled` stops delivery immediately, and a listener
 * that resolves after cancellation is torn down on arrival.
 */
function subscribe<T>(event: string, handler: (payload: T) => void): () => void {
  let unlisten: UnlistenFn | null = null;
  let cancelled = false;

  listen<T>(event, (e) => {
    if (!cancelled) handler(e.payload);
  })
    .then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    })
    .catch((err: unknown) => {
      console.error(`pty: could not listen to ${event}`, err);
    });

  return () => {
    cancelled = true;
    const fn = unlisten;
    unlisten = null;
    if (fn) fn();
  };
}

/** base64 -> raw bytes. Deliberately not text: see the module comment. */
function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
