/**
 * The Files pane's Project view: every file in the worktree as a folder tree,
 * not only the ones that changed.
 *
 * Built from `git ls-files --cached --others --exclude-standard`, the same
 * list Quick Open searches, so what the tree shows and what ⌘O finds agree:
 * tracked and untracked files, nothing git ignores. Folders exist only as the
 * paths of the files under them, so an empty folder is not shown.
 *
 * Pure, so every case is a test; ProjectTree.tsx does the I/O around it.
 */

export interface TreeDir {
  /** The folder's own name; '' for the root. */
  name: string;
  /** Worktree-relative, no trailing slash; '' for the root. */
  path: string;
  dirs: TreeDir[];
  /** Worktree-relative file paths directly in this folder. */
  files: string[];
}

export interface TreeRow {
  kind: 'dir' | 'file';
  path: string;
  name: string;
  /** 0 for an entry at the worktree root. */
  depth: number;
  /** Dirs only: expanded. */
  open: boolean;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Folders first, then files, each by name as a person sorts them. */
export function buildTree(paths: readonly string[]): TreeDir {
  const root: TreeDir = { name: '', path: '', dirs: [], files: [] };
  const dirs = new Map<string, TreeDir>([['', root]]);
  const dirFor = (path: string): TreeDir => {
    const hit = dirs.get(path);
    if (hit) return hit;
    const cut = path.lastIndexOf('/');
    const parent = dirFor(cut === -1 ? '' : path.slice(0, cut));
    const dir: TreeDir = { name: path.slice(cut + 1), path, dirs: [], files: [] };
    parent.dirs.push(dir);
    dirs.set(path, dir);
    return dir;
  };
  for (const p of paths) {
    if (p === '' || p.endsWith('/')) continue;
    const cut = p.lastIndexOf('/');
    dirFor(cut === -1 ? '' : p.slice(0, cut)).files.push(p);
  }
  for (const d of dirs.values()) {
    d.dirs.sort((a, b) => collator.compare(a.name, b.name));
    d.files.sort((a, b) => collator.compare(baseName(a), baseName(b)));
  }
  return root;
}

/** The rows on screen: the root's children, and the children of every open folder. */
export function visibleRows(root: TreeDir, expanded: ReadonlySet<string>): TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (dir: TreeDir, depth: number) => {
    for (const d of dir.dirs) {
      const open = expanded.has(d.path);
      out.push({ kind: 'dir', path: d.path, name: d.name, depth, open });
      if (open) walk(d, depth + 1);
    }
    for (const f of dir.files) out.push({ kind: 'file', path: f, name: baseName(f), depth, open: false });
  };
  walk(root, 0);
  return out;
}

/** The folders a path sits in, outermost first: `a/b/c.ts` -> `a`, `a/b`. */
export function ancestors(path: string): string[] {
  const out: string[] = [];
  let i = path.indexOf('/');
  while (i !== -1) {
    out.push(path.slice(0, i));
    i = path.indexOf('/', i + 1);
  }
  return out;
}

/** Every folder that holds a changed file, at any depth: a collapsed folder still says so. */
export function changedDirs(paths: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const p of paths) for (const a of ancestors(p)) out.add(a);
  return out;
}

/** The parent folder of a row's path, or null at the root. */
export function parentOf(path: string): string | null {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? null : path.slice(0, cut);
}
