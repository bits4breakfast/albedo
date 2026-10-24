/**
 * How the Files pane's two lists (Changes and Project) open files from the
 * keyboard and the mouse (#86):
 *
 *   click, Space   open the row's file; the keyboard stays on the row
 *   ↑ / ↓          move to the previous / next row and open its file there
 *   Enter          open the row's file and hand the keyboard to the editor
 *
 * The editor leaves a focused row alone because the list carries
 * `data-keeps-focus` (editor/editorFocus.ts). A step replaces the editor's
 * active tab, as its own ⌥⌘↑/↓ does (OpenFileOptions.step).
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { OpenFileOptions } from './editor/openFile';
import { focusEditor } from './editor/editorFocus';

/**
 * How long a held arrow rests on a row before its file opens. A single press
 * opens at once; auto-repeat would otherwise read and highlight every file it
 * passes, and only the one it stops on is wanted.
 */
export const SETTLE_MS = 100;

/** The element before (-1) or after (1) `from` in `rows`; null at either end. */
export function adjacent<T>(rows: readonly T[], from: T, dir: 1 | -1): T | null {
  const i = rows.indexOf(from);
  return i === -1 ? null : (rows[i + dir] ?? null);
}

/** Focus a row and scroll it only as far as needed. */
export function showRow(row: HTMLElement): void {
  row.focus({ preventScroll: true });
  row.scrollIntoView?.({ block: 'nearest' });
}

export interface ListOpen {
  /** Click or Space: open the file, keep the keyboard on the row. */
  pick: (row: HTMLElement, path: string) => void;
  /** Enter: open the file and move the keyboard into the editor. */
  enter: (row: HTMLElement, path: string) => void;
  /**
   * ↑/↓ reached `row`: focus it and open its file -- at once for a press, on
   * settling for a held key. `path` is null for a row that is not a file.
   */
  step: (row: HTMLElement, path: string | null, repeat: boolean) => void;
}

export function useListOpen(open: (path: string, options?: OpenFileOptions) => void): ListOpen {
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = useCallback(() => {
    if (pending.current !== null) clearTimeout(pending.current);
    pending.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);

  return useMemo<ListOpen>(
    () => ({
      pick: (row, path) => {
        cancel();
        row.focus({ preventScroll: true });
        open(path);
      },
      enter: (row, path) => {
        cancel();
        // Off the row first, or an editor built for this file would leave it there.
        row.blur();
        open(path);
        // For a file already in the active tab, which no view build will focus.
        requestAnimationFrame(focusEditor);
      },
      step: (row, path, repeat) => {
        cancel();
        showRow(row);
        if (path === null) return;
        if (!repeat) open(path, { step: true });
        else
          pending.current = setTimeout(() => {
            pending.current = null;
            open(path, { step: true });
          }, SETTLE_MS);
      },
    }),
    [open, cancel],
  );
}
