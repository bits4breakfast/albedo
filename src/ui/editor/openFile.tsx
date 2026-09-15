/**
 * The app-wide "open this file" entry point.
 *
 * The spec is explicit that the entry point is not a tree: any path rendered
 * anywhere in the transcript is clickable. That means the transcript renderer,
 * the diff view and the touched-files list all need to ask for a file without
 * knowing what the editor is or where it lives, which is what the context
 * below is for. The shell provides it; everyone else calls `useOpenFile()`.
 */

import { createContext, useContext } from 'react';
import type { OpenFileRequest } from '../../types';
import { resolveInWorktree } from '../../lib/paths';

/**
 * Default is a no-op with a warning rather than a throw: a renderer mounted
 * outside the provider (a test, a storybook) should still render its links,
 * it just cannot open them.
 */
function unprovided(req: OpenFileRequest): void {
  console.warn('openFile: no FileOpenContext provider above this component', req.path);
}

export const FileOpenContext = createContext<(req: OpenFileRequest) => void>(unprovided);
FileOpenContext.displayName = 'FileOpenContext';

/** Ask the shell to open a file. Honours `line` when the source had one. */
export function useOpenFile(): (req: OpenFileRequest) => void {
  return useContext(FileOpenContext);
}

// ---------------------------------------------------------------------------
// The escape hatch
// ---------------------------------------------------------------------------

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Open the file in PHPStorm, on the same worktree path the built-in editor
 * uses -- the spec's escape hatch for anything that is more than a light edit.
 *
 * Two attempts, in order:
 *
 * 1. The `phpstorm` CLI, which is the only one that can honour a line number.
 * 2. `open -a PhpStorm <path>`, for machines where the CLI launcher was never
 *    installed. This one cannot jump to a line -- macOS `open` has no way to
 *    pass one through -- so the file opens at the top.
 *
 * Arguments are always passed as an array. A worktree path with a space in it
 * would otherwise be split into two arguments by the shell, and quoting a path
 * that came from a transcript into a command string is how you get an argument
 * injection. Rejects with a message naming both failures when neither works;
 * the caller surfaces it rather than letting the click do nothing.
 */
export async function openInPhpStorm(
  worktreePath: string,
  relPath: string,
  line?: number | null,
): Promise<void> {
  // Same boundary as everything else: never hand an unresolved transcript path
  // to another process.
  const resolved = await resolveInWorktree(worktreePath, relPath);
  if (!resolved) {
    throw new Error(`${relPath} is outside this task's worktree`);
  }

  const { Command } = await import('@tauri-apps/plugin-shell');
  const target = resolved.absolute;
  const at = typeof line === 'number' && Number.isInteger(line) && line > 0 ? line : null;

  let cliFailure: string;
  try {
    const args = at === null ? [target] : ['--line', String(at), target];
    const out = await Command.create('phpstorm', args).execute();
    if (out.code === 0) return;
    cliFailure = `phpstorm exited ${out.code}${out.stderr ? `: ${out.stderr.trim()}` : ''}`;
  } catch (err) {
    cliFailure = message(err);
  }

  try {
    const out = await Command.create('open', ['-a', 'PhpStorm', target]).execute();
    if (out.code === 0) return;
    throw new Error(`open exited ${out.code}${out.stderr ? `: ${out.stderr.trim()}` : ''}`);
  } catch (err) {
    throw new Error(
      `Could not open ${resolved.relative} in PHPStorm. ` +
        `phpstorm: ${cliFailure}. open -a PhpStorm: ${message(err)}`,
    );
  }
}
