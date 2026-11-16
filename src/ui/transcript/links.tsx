/**
 * The shared path-link primitives (`useOpenPath`, `useActivate`, `PathLink`,
 * `ExternalLink`, `LinkifiedText`). They know nothing about `Message`, so the
 * chip, the row renderers, the diff and the editor can all import them
 * without pointing the dependency graph backwards.
 */

import { useCallback, useMemo, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import type { OpenFileRequest } from '../../types';
import { parsePathRef } from '../../lib/paths';
import { openExternal } from '../../lib/openUrl';
import { splitUrls } from '../../lib/urls';
import { useOpenFile, type OpenFileOptions } from '../editor/openFile';

/** Beyond this, scanning every line of a tool result for paths is not worth it. */
const MAX_LINKIFY_LINES = 2000;
const MAX_LINKIFY_CHARS = 400_000;

/**
 * Ask the app to open a path seen in the transcript.
 *
 * The raw path goes straight through to `useOpenFile`: resolution against the
 * task's worktree happens in `resolveInWorktree`, which is a security boundary.
 * A transcript is data we render, so nothing here may join a transcript path to
 * a filesystem path or decide that one looks safe.
 *
 * Opening is best-effort. If no provider is mounted, or the editor throws, the
 * link quietly does nothing rather than taking the pane down with it.
 *
 * Call the returned function ONLY from a click or a key on the path: it tells
 * the app a person asked (`activated`), which is what lets a file outside the
 * worktree open (src/ui/editor/outsideFile.ts). Never from an effect.
 */
export function useOpenPath(): (path: string, line?: number | null, lookup?: boolean) => void {
  let open: ((req: OpenFileRequest, options?: OpenFileOptions) => void) | null = null;
  try {
    open = useOpenFile();
  } catch {
    open = null; // no provider (tests, or the editor not mounted yet)
  }
  return useCallback(
    (path: string, line: number | null = null, lookup = false) => {
      if (typeof open !== 'function') return;
      if (typeof path !== 'string' || path.trim().length === 0) return;
      try {
        // Every call comes from a click or a key on a PathLink: the one ask
        // that may open a file outside the worktree (outsideFile.ts).
        open({ path, line }, lookup ? { lookup: true, activated: true } : { activated: true });
      } catch {
        /* the editor is not allowed to break rendering */
      }
    },
    [open],
  );
}

/** Whether any of the selection's ranges reaches into `node`. */
function touches(sel: Selection, node: Node): boolean {
  for (let i = 0; i < sel.rangeCount; i++) if (sel.getRangeAt(i).intersectsNode(node)) return true;
  return false;
}

/**
 * Click handling that coexists with text selection.
 *
 * The pane re-enables `user-select: text` precisely so people can copy code out
 * of it, so a link must not steal a drag that was a selection gesture. A click
 * only activates when the pointer barely moved and nothing is selected.
 */
export function useActivate(onActivate: () => void): {
  onMouseDown: (e: ReactMouseEvent) => void;
  onClick: (e: ReactMouseEvent) => void;
} {
  const downRef = useRef<{ x: number; y: number } | null>(null);
  return {
    onMouseDown: (e: ReactMouseEvent) => {
      downRef.current = { x: e.clientX, y: e.clientY };
    },
    onClick: (e: ReactMouseEvent) => {
      const down = downRef.current;
      downRef.current = null;
      if (down && (Math.abs(e.clientX - down.x) > 3 || Math.abs(e.clientY - down.y) > 3)) return;
      // A selection that touches this link means the click ended a selection
      // gesture. A selection elsewhere does not: a line-number link is
      // `user-select: none`, so clicking it leaves an earlier selection where
      // it was, and every click on it was swallowed (#110).
      try {
        const sel = window.getSelection?.();
        if (sel && !sel.isCollapsed && sel.toString().length > 0 && touches(sel, e.currentTarget)) return;
      } catch {
        /* selection API unavailable; fall through and treat it as a click */
      }
      e.preventDefault();
      e.stopPropagation();
      onActivate();
    },
  };
}

export interface PathLinkProps {
  /** Path exactly as it appeared in the transcript. Never pre-resolved. */
  path: string;
  line?: number | null;
  className?: string;
  title?: string;
  /** Visible text; defaults to the path itself. */
  children?: ReactNode;
  /** `path` is a bare file name to look up (OpenFileOptions.lookup). */
  lookup?: boolean;
  /**
   * Keyboard-reachable. Off for the per-line affordances inside a diff, which
   * would otherwise add two tab stops per line to a 5000-line diff; the file is
   * still reachable from the diff header link.
   */
  focusable?: boolean;
}

export function PathLink({
  path,
  line = null,
  className,
  title,
  children,
  focusable = true,
  lookup = false,
}: PathLinkProps): ReactNode {
  const openPath = useOpenPath();
  const handlers = useActivate(() => openPath(path, line, lookup));
  return (
    <span
      className={`tx-link${className ? ` ${className}` : ''}`}
      role="link"
      tabIndex={focusable ? 0 : -1}
      title={title ?? (line !== null ? `${path}:${line}` : path)}
      onMouseDown={handlers.onMouseDown}
      onClick={handlers.onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openPath(path, line, lookup);
        }
      }}
    >
      {children ?? path}
    </span>
  );
}

/**
 * A web link. Opens in the default browser; only http(s) ever reaches here
 * (callers check, and `openExternal` refuses anything else). The visible text
 * is whatever the caller shows, so the real address is always in the tooltip.
 */
export function ExternalLink({
  url,
  className,
  children,
}: {
  url: string;
  className?: string;
  children?: ReactNode;
}): ReactNode {
  const handlers = useActivate(() => void openExternal(url));
  return (
    <span
      className={`tx-url${className ? ` ${className}` : ''}`}
      role="link"
      tabIndex={0}
      title={url}
      onMouseDown={handlers.onMouseDown}
      onClick={handlers.onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          void openExternal(url);
        }
      }}
    >
      {children ?? url}
    </span>
  );
}

/**
 * Render text, turning path references into links.
 *
 * Extraction is delegated to `parsePathRef` -- one line at a time, because that
 * is the shape of a stack trace and the parser answers per fragment. When it
 * returns null the line renders as plain text; being conservative matters more
 * than catching every path, since a false positive makes ordinary prose look
 * broken.
 *
 * Locating the parsed path inside the line with `indexOf` is presentation, not
 * parsing: we only need to know which characters to wrap. If it is not found
 * verbatim, the line stays plain.
 */
export function LinkifiedText({ text, className }: { text: string; className?: string }): ReactNode {
  const nodes = useMemo(() => linkifyLines(text), [text]);
  return <span className={className}>{nodes}</span>;
}

function linkifyLines(text: string): ReactNode[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const lines = text.split('\n');
  if (lines.length > MAX_LINKIFY_LINES || text.length > MAX_LINKIFY_CHARS) return [text];

  const out: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const suffix = i < lines.length - 1 ? '\n' : '';
    // A line with a web URL is linked as URLs; path detection would otherwise
    // read `//host/path` out of it.
    const parts = line.includes('://') ? splitUrls(line) : null;
    if (parts && parts.some((p) => typeof p !== 'string')) {
      parts.forEach((p, k) => {
        out.push(typeof p === 'string' ? p : <ExternalLink key={`${i}-u${k}`} url={p.url} />);
      });
      if (suffix) out.push(suffix);
      continue;
    }
    let ref: { path: string; line: number | null } | null = null;
    try {
      ref = parsePathRef(line);
    } catch {
      ref = null;
    }
    const at = ref && ref.path.length > 0 ? line.indexOf(ref.path) : -1;
    if (!ref || at < 0) {
      out.push(line + suffix);
      continue;
    }
    // Extend the link over a trailing :line[:col] so the whole reference is one target.
    let end = at + ref.path.length;
    const trailing = /^:\d+(?::\d+)?/.exec(line.slice(end));
    if (ref.line !== null && trailing) end += trailing[0].length;

    if (at > 0) out.push(line.slice(0, at));
    out.push(
      <PathLink key={`${i}-${at}`} path={ref.path} line={ref.line}>
        {line.slice(at, end)}
      </PathLink>,
    );
    out.push(line.slice(end) + suffix);
  }
  return out;
}
