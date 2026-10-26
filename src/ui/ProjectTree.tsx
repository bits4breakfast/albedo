/**
 * The Files pane's Project view: browse the whole worktree, changed or not,
 * without knowing a file's name (Quick Open needs one).
 *
 * The tree is projectTreeModel.ts; this file lists the files, remembers which
 * folders are open, and draws the rows. A changed file carries the same status
 * letter as in the Changes view, and a folder holding one carries a dot, so a
 * collapsed tree still says where the work is.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { git } from '../git/worktree';
import { parseLsFilesZ } from '../git/codeIndex';
import { Disclosure } from './Disclosure';
import { FileIcon, FolderGlyph } from './fileIcons';
import type { OpenFileOptions } from './editor/openFile';
import { useListOpen } from './filesListOpen';
import { ancestors, buildTree, changedDirs, parentOf, visibleRows, type TreeRow } from './projectTreeModel';

/**
 * Open folders per task. Module-level, so switching tasks or views and coming
 * back finds the tree as it was left.
 */
const openByTask = new Map<number, Set<string>>();

function openFor(taskId: number): Set<string> {
  let s = openByTask.get(taskId);
  if (!s) {
    s = new Set();
    openByTask.set(taskId, s);
  }
  return s;
}

async function listFiles(root: string): Promise<string[]> {
  const r = await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root);
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'git ls-files failed');
  return parseLsFilesZ(r.stdout);
}

export interface ProjectTreeProps {
  taskId: number;
  worktreePath: string;
  /** Status letter per changed path, as the Changes view shows it. */
  status: ReadonlyMap<string, string>;
  /** The letter's colour, the Changes view's own rule (passed in: that file imports this one). */
  toneOf: (code: string) => string;
  /** The file in the editor's active tab: revealed and marked. */
  activePath: string | null;
  /** Bumped by the pane whenever it reloads; the listing follows. */
  reloadKey: number;
  onOpen: (path: string, options?: OpenFileOptions) => void;
}

export default function ProjectTree({ taskId, worktreePath, status, toneOf, activePath, reloadKey, onOpen }: ProjectTreeProps): ReactNode {
  const [files, setFiles] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A copy of the module set, so a toggle re-renders.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(openFor(taskId)));
  const listRef = useRef<HTMLDivElement>(null);
  const list = useListOpen(onOpen);

  useEffect(() => {
    setFiles(null);
    setOpen(new Set(openFor(taskId)));
  }, [taskId]);

  useEffect(() => {
    let live = true;
    listFiles(worktreePath)
      .then((f) => {
        if (!live) return;
        setFiles(f);
        setError(null);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [worktreePath, reloadKey]);

  const update = (next: Set<string>) => {
    openByTask.set(taskId, next);
    setOpen(next);
  };
  const toggle = (path: string, to?: boolean) => {
    const next = new Set(open);
    if (to ?? !next.has(path)) next.add(path);
    else next.delete(path);
    update(next);
  };

  // Reveal the open file: its folders open, its row in view.
  useEffect(() => {
    if (activePath === null) return;
    const missing = ancestors(activePath).filter((a) => !open.has(a));
    if (missing.length > 0) update(new Set([...open, ...missing]));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the file changes
  }, [activePath, taskId]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.tf-tree-row[aria-current="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [activePath, files, open]);

  const tree = useMemo(() => (files === null ? null : buildTree(files)), [files]);
  const rows = useMemo(() => (tree === null ? [] : visibleRows(tree, open)), [tree, open]);
  const dirty = useMemo(() => changedDirs(status.keys()), [status]);

  const focusRow = (path: string) =>
    listRef.current?.querySelector<HTMLElement>(`.tf-tree-row[data-path="${CSS.escape(path)}"]`)?.focus();

  // Up / down walk the visible rows, opening each file they land on (see
  // filesListOpen.ts); Right opens a folder, Left closes it or goes to its
  // parent; Enter or Space toggles a folder.
  const onKey = (e: KeyboardEvent<HTMLDivElement>, row: TreeRow, i: number) => {
    const go = (path: string | undefined) => {
      if (path === undefined) return;
      e.preventDefault();
      focusRow(path);
    };
    const step = (j: number) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      const to = rows[j];
      const el = listRef.current?.querySelectorAll<HTMLElement>('.tf-tree-row')[j];
      if (to !== undefined && el !== undefined) list.step(el, to.kind === 'file' ? to.path : null, e.repeat);
    };
    switch (e.key) {
      case 'ArrowDown':
        step(i + 1);
        break;
      case 'ArrowUp':
        step(i - 1);
        break;
      case 'ArrowRight':
        if (row.kind === 'dir') {
          e.preventDefault();
          if (!row.open) toggle(row.path, true);
          else go(rows[i + 1]?.depth === row.depth + 1 ? rows[i + 1]?.path : undefined);
        }
        break;
      case 'ArrowLeft':
        if (row.kind === 'dir' && row.open) {
          e.preventDefault();
          toggle(row.path, false);
        } else go(parentOf(row.path) ?? undefined);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (row.kind === 'dir') toggle(row.path);
        else if (e.key === 'Enter') list.enter(e.currentTarget, row.path);
        else list.pick(e.currentTarget, row.path);
        break;
    }
  };

  if (error !== null) {
    return (
      <div className="tf-error">
        <span className="tf-error-label">Could not list the worktree’s files</span>
        <pre className="tf-error-detail">{error}</pre>
      </div>
    );
  }
  if (files === null) return <div className="tf-empty">Listing files…</div>;
  if (rows.length === 0) return <div className="tf-empty">No files in this worktree.</div>;

  return (
    <div className="tf-tree" role="tree" ref={listRef}>
      {rows.map((row, i) => {
        const code = row.kind === 'file' ? (status.get(row.path) ?? null) : null;
        return (
          <div
            key={row.path}
            role="treeitem"
            tabIndex={0}
            className="tf-tree-row"
            data-kind={row.kind}
            data-path={row.path}
            data-keeps-focus=""
            aria-expanded={row.kind === 'dir' ? row.open : undefined}
            aria-current={row.path === activePath ? 'true' : undefined}
            style={{ paddingLeft: `calc(8px + ${row.depth} * 1.1em)` }}
            title={row.path}
            onClick={(e) => (row.kind === 'dir' ? toggle(row.path) : list.pick(e.currentTarget, row.path))}
            onKeyDown={(e) => onKey(e, row, i)}
          >
            <span className="tf-tree-caret">
              {row.kind === 'dir' ? <Disclosure open={row.open} inline /> : null}
            </span>
            {row.kind === 'file' ? (
              <FileIcon path={row.path} className="tf-icon" />
            ) : (
              <FolderGlyph open={row.open} className="tf-icon" />
            )}
            <span className="tf-tree-name">{row.name}</span>
            {row.kind === 'dir' ? (
              dirty.has(row.path) ? (
                <span className="tf-tree-dot" title="Holds changed files" />
              ) : null
            ) : code !== null ? (
              <span className="tf-status" data-tone={toneOf(code)}>
                {code.replace(/ /g, '·')}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
