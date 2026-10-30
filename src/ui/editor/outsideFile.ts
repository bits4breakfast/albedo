/**
 * Opening a file outside the task's worktree (#143).
 *
 * `resolveInWorktree` (src/lib/paths.ts) is still the boundary for everything
 * a transcript names: a path outside the worktree never resolves there, and
 * nothing here changes that. What changes is that a person may now *ask* for
 * such a file, and the editor opens it -- with access granted for that one
 * file, from that ask.
 *
 * THE RULE: a grant is made only from a click or a keyboard activation on the
 * path. Not from rendering a transcript, not from a prefetch, not from a tab
 * restored when a task is shown again. The ask travels as the identity of the
 * request object: `PathLink` asks App to open a file with `activated`, App
 * marks the exact request object it hands to the editor, and the editor grants
 * only for a marked object. A restored tab is a new object, so it is never
 * marked: it shows the file's path and an Open button, and the click on that
 * button is the ask. A file already granted earlier in this run reopens
 * without asking again -- no new grant is made, the old one still stands.
 *
 * The Rust side (`allow_outside_file` in src-tauri/src/fsscope.rs) resolves
 * `~`, relative paths and symlinks, refuses folders, missing, unreadable and
 * special files, Albedo's and Claude Code's own data and known secret stores,
 * and grants the one canonical path as a literal fs-scope entry.
 */

import type { OpenFileRequest } from '../../types';
import type { ResolvedPath } from '../../lib/paths';

// ---------------------------------------------------------------------------
// The click, carried on the request
// ---------------------------------------------------------------------------

const activated = new WeakSet<OpenFileRequest>();

/** This request object came from a click or a key on its path. App only. */
export function markUserActivated(request: OpenFileRequest): void {
  activated.add(request);
}

/** Did this exact request object come from a click or key on its path? */
export function isUserActivated(request: OpenFileRequest | null): boolean {
  return request !== null && activated.has(request);
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

export type OutsideRefusalKind = 'invalid' | 'missing' | 'unreadable' | 'directory' | 'special' | 'denied';

export interface OutsideRefusal {
  kind: OutsideRefusalKind;
  /** Canonical once the path could be resolved; as asked otherwise. */
  path: string;
  message: string;
}

const KINDS: ReadonlySet<string> = new Set(['invalid', 'missing', 'unreadable', 'directory', 'special', 'denied']);

/** The Rust refusal, or an unreadable one carrying whatever else came back. */
export function asRefusal(err: unknown, path: string): OutsideRefusal {
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>;
    if (typeof e.kind === 'string' && KINDS.has(e.kind) && typeof e.message === 'string') {
      return {
        kind: e.kind as OutsideRefusalKind,
        path: typeof e.path === 'string' && e.path !== '' ? e.path : path,
        message: e.message,
      };
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  return { kind: 'unreadable', path, message };
}

/** One plain sentence for the editor's body. */
export function refusalText(r: OutsideRefusal): string {
  switch (r.kind) {
    case 'missing':
      return `${r.path} does not exist.`;
    case 'unreadable':
      return `${r.path} can’t be read: ${r.message}.`;
    case 'directory':
      return `${r.path} is a folder, not a file.`;
    case 'special':
      return `${r.path} is not a regular file, so it is not opened.`;
    case 'denied':
      return `${r.message}.`;
    case 'invalid':
      return `${r.path} is not a file path Albedo can open (${r.message}).`;
    default: {
      const unhandled: never = r.kind;
      return String(unhandled);
    }
  }
}

/** Files granted this run: worktree + path as asked → the canonical file. */
const granted = new Map<string, string>();
const keyOf = (worktree: string, raw: string) => `${worktree}\u0000${raw.trim()}`;

/** Test hook. */
export function resetOutsideGrants(): void {
  granted.clear();
}

export type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

export type GrantResult = { ok: true; absolute: string } | { ok: false; refusal: OutsideRefusal };

/**
 * Ask the Rust side for this one file. Call ONLY from a click or key on the
 * path -- see the rule at the top. Remembered for the run on success.
 */
export async function grantOutsideFile(worktree: string, raw: string, invoke: Invoke = tauriInvoke): Promise<GrantResult> {
  try {
    const absolute = await invoke<string>('allow_outside_file', { path: raw.trim(), base: worktree });
    if (typeof absolute !== 'string' || !absolute.startsWith('/')) {
      return { ok: false, refusal: { kind: 'unreadable', path: raw, message: 'no path came back' } };
    }
    granted.set(keyOf(worktree, raw), absolute);
    return { ok: true, absolute };
  } catch (err) {
    return { ok: false, refusal: asRefusal(err, raw) };
  }
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** What the editor shows for a request. */
export type OpenDecision =
  | { kind: 'inside'; target: ResolvedPath }
  /** Outside, and granted: open it like any file. */
  | { kind: 'outside'; absolute: string }
  /** Outside, and nobody clicked it: say so, offer Open. */
  | { kind: 'ask'; path: string }
  | { kind: 'refused'; refusal: OutsideRefusal };

export interface DecideDeps {
  resolveInside: (worktree: string, raw: string) => Promise<ResolvedPath | null>;
  /** Grants; called only when the request carries a click. */
  grant: (worktree: string, raw: string) => Promise<GrantResult>;
}

/**
 * Inside the worktree resolves as it always has. Outside, a file granted
 * earlier this run opens; a request carrying a click is granted; anything
 * else asks for a click.
 */
export async function decideOpen(
  worktree: string,
  raw: string,
  userActivated: boolean,
  deps: DecideDeps,
): Promise<OpenDecision> {
  const inside = await deps.resolveInside(worktree, raw);
  if (inside) return { kind: 'inside', target: inside };
  const before = granted.get(keyOf(worktree, raw));
  if (before !== undefined) return { kind: 'outside', absolute: before };
  if (!userActivated) return { kind: 'ask', path: raw };
  const result = await deps.grant(worktree, raw);
  return result.ok ? { kind: 'outside', absolute: result.absolute } : { kind: 'refused', refusal: result.refusal };
}
