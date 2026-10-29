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

/**
 * Default is a no-op with a warning rather than a throw: a renderer mounted
 * outside the provider (a test, a storybook) should still render its links,
 * it just cannot open them.
 */
function unprovided(req: OpenFileRequest): void {
  console.warn('openFile: no FileOpenContext provider above this component', req.path);
}

/** How an open request treats the editor's tabs and the reading pane. */
export interface OpenFileOptions {
  /**
   * Opened by ↑/↓ walking a Files list: it replaces the active tab, the way
   * the editor's own ⌥⌘↑/↓ step does, so walking twenty files does not leave
   * twenty tabs (a tab with unsaved edits is kept: a new one opens instead),
   * and a Files tab on screen stays there so the next arrow still reaches it.
   */
  step?: boolean;
  /**
   * The path is a bare file name from the transcript (`Foo.php`), not a path:
   * find the file by name first. One match opens it; none or several open Go
   * to File with the name typed. Only a link that knows it holds a bare name
   * sets this -- a root-level `README.md` from the Files tree is a path.
   */
  lookup?: boolean;
}

export type OpenFile = (req: OpenFileRequest, options?: OpenFileOptions) => void;

export const FileOpenContext = createContext<OpenFile>(unprovided);
FileOpenContext.displayName = 'FileOpenContext';

/** Ask the shell to open a file. Honours `line` when the source had one. */
export function useOpenFile(): OpenFile {
  return useContext(FileOpenContext);
}

/**
 * Read a file's CURRENT text, for renderers that need more of it than the
 * transcript carries -- the diff view expanding context around a hunk.
 *
 * Same division of labour as `FileOpenContext`, and for the same reason: the
 * caller passes the raw path it saw in the transcript and the PROVIDER
 * resolves it through `resolveInWorktree`. A transcript is data we render, so
 * no renderer may join a transcript path to a filesystem path or decide that
 * one looks safe. Keeping the resolution on this side means the diff component
 * never learns what a worktree is.
 *
 * Resolves to null for anything unavailable -- no task, no provider, outside
 * the worktree, unreadable. Callers treat null as "no context to offer",
 * never as an error worth a dialog.
 */
export const FileTextContext = createContext<(path: string) => Promise<string | null>>(
  async () => null,
);
FileTextContext.displayName = 'FileTextContext';

/** Read a file's current text, or null when it cannot be read. */
export function useReadFile(): (path: string) => Promise<string | null> {
  return useContext(FileTextContext);
}

// ---------------------------------------------------------------------------
// The escape hatch, removed
// ---------------------------------------------------------------------------
//
// `openInPhpStorm` lived here and is gone: the spec's "one-key open in
// PHPStorm" hardcoded one editor, by name, in both the CLI it shelled out to
// and the macOS-only `open -a` fallback. That is the author's setup, not a
// property of the app, and a VS Code or Zed user could not use it at all.
//
// Deliberately NOT replaced with a configurable version in the same change.
// See #16 -- an external-editor command template belongs with the rest of
// the configuration work (#13), and shipping a second hardcoded editor while
// waiting for that would be the same mistake with a different name.
//
// Its `phpstorm` entry in src-tauri/capabilities/default.json is gone too: a
// capability for a program nothing runs is a permission with no purpose. The
// template above will add its own when it lands.
