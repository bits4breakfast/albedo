/**
 * Whether Claude Code will ask "Accessing workspace: … do you trust this
 * folder?" before it starts, and which tasks are sitting on that question.
 *
 * Neither of Albedo's channels can see the dialog: hooks run only once the
 * folder is trusted, and no transcript exists before the session starts. So
 * Albedo asks the question Claude Code itself asks, beforehand, of the same
 * file: `projects[<path>].hasTrustDialogAccepted` in `~/.claude.json`. By the
 * owner's decision (issue #42), that one flag is all this reads from that
 * file, and this is the only file that knows where it lives. Read only:
 * running `claude` processes rewrite that file constantly, and trusting a
 * folder is the user's decision, made in the terminal.
 *
 * Advisory. Anything unexpected -- no file, a half-written file, another
 * shape, a `CLAUDE_CONFIG_DIR` elsewhere -- answers "unknown", and unknown
 * shows nothing: the session starts exactly as it did before this existed.
 *
 * Which paths count, as Claude Code 2.1.305 decides it:
 *   - the project's config key: for a linked worktree, the main checkout
 *     (measured: accepting the dialog in a worktree wrote the flag on the
 *     main checkout's path, not the worktree's);
 *   - the folder itself and every folder above it, up to the top of its git
 *     working tree, or up to `/` outside a repository.
 * A folder trusted anywhere above a repository does not cover it.
 */

import { exists, readTextFile } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { git } from '../git/worktree';

/** Every path the config marks trusted, or null when the text is not that config. */
export function trustedFolders(configText: string): Set<string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configText);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const projects = (parsed as { projects?: unknown }).projects;
  if (projects === undefined) return new Set();
  if (typeof projects !== 'object' || projects === null || Array.isArray(projects)) return null;
  const out = new Set<string>();
  for (const [path, entry] of Object.entries(projects)) {
    if (typeof entry === 'object' && entry !== null && (entry as { hasTrustDialogAccepted?: unknown }).hasTrustDialogAccepted === true) {
      out.add(path);
    }
  }
  return out;
}

function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/**
 * The paths whose trust covers `folder`: itself, its parents up to `top`
 * (inclusive; `/` when null), and the project key when there is one.
 */
export function trustCandidates(folder: string, top: string | null, projectKey: string | null): string[] {
  const out: string[] = [];
  const stop = top === null ? null : trimSlash(top);
  let p = trimSlash(folder);
  for (;;) {
    out.push(p);
    if (p === stop || p === '/') break;
    // Outside the working tree it stops covering: a parent of the repo.
    if (stop !== null && !p.startsWith(`${stop}/`)) break;
    const cut = p.lastIndexOf('/');
    p = cut <= 0 ? '/' : p.slice(0, cut);
  }
  if (projectKey !== null && !out.includes(trimSlash(projectKey))) out.push(trimSlash(projectKey));
  return out;
}

async function gitPaths(folder: string): Promise<{ top: string | null; main: string | null }> {
  const r = await git(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], folder).catch(() => null);
  if (r === null || r.code !== 0) return { top: null, main: null };
  const [top, common] = r.stdout.split('\n').map((l) => l.trim());
  // A worktree's common dir is `<main checkout>/.git`; anything else (a bare
  // repo, a relocated gitdir) has no checkout to name, so the folder is the key.
  const main = common && common.endsWith('/.git') ? common.slice(0, -'/.git'.length) : null;
  return { top: top || null, main };
}

/**
 * Whether Claude Code trusts `folder` already: true, false, or null when
 * Albedo cannot tell. Never throws.
 */
export async function folderTrusted(folder: string): Promise<boolean | null> {
  try {
    const path = `${(await homeDir()).replace(/\/+$/, '')}/.claude.json`;
    if (!(await exists(path))) return null;
    const trusted = trustedFolders(await readTextFile(path));
    if (trusted === null) return null;
    const { top, main } = await gitPaths(folder);
    return trustCandidates(folder, top, main).some((p) => trusted.has(p));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Which tasks are waiting on the dialog
// ---------------------------------------------------------------------------

type Listener = (taskId: number, waiting: boolean) => void;

const waitingTasks = new Set<number>();
const listeners = new Set<Listener>();

/**
 * Set by the terminal when it starts `claude` in an untrusted folder; cleared
 * when the session starts (the first hook event only fires once the folder is
 * trusted) or the process ends.
 */
export function setTrustWaiting(taskId: number, waiting: boolean): void {
  if (waitingTasks.has(taskId) === waiting) return;
  if (waiting) waitingTasks.add(taskId);
  else waitingTasks.delete(taskId);
  for (const l of listeners) {
    try {
      l(taskId, waiting);
    } catch (err) {
      console.warn('[workspaceTrust] listener failed', err);
    }
  }
}

export function isTrustWaiting(taskId: number): boolean {
  return waitingTasks.has(taskId);
}

export function onTrustWaiting(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
