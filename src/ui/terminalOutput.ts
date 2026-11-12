import type { Terminal as XTerm } from '@xterm/xterm';

/**
 * Writes pty output into xterm and calls `done` once xterm has processed it,
 * which is what paces the pty (#366, src/lib/pty.ts). Shared by both terminals
 * so neither can forget the callback and quietly lose the pacing.
 *
 * A write that throws (the terminal was disposed, or xterm refusing data past
 * its own 50 MB backlog) still calls `done`: those bytes are as finished as
 * they will ever be, and an unreported count would hold the pty until Rust
 * stops waiting on its own.
 */
export function writeOutput(term: Pick<XTerm, 'write'>, bytes: Uint8Array, done: () => void): void {
  try {
    term.write(bytes, done);
  } catch {
    done();
  }
}
