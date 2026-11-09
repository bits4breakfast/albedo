/**
 * The Review Guide's Map (#288): the change as boxes and arrows. Pure.
 *
 * Every fact here is Albedo's own: the files and their counts from git
 * (blocks.ts), the groups from the guide as it is now (validate.ts), the
 * comments from the database, the arrows from the files' imports
 * (imports.ts). Nothing is asked of the model -- the map is outside the
 * `claude -p` run (#186) -- and nothing is guessed: an import that does not
 * resolve is no arrow.
 *
 *  - A box per changed file, in its group's colour; a file split across
 *    groups carries each of their colours.
 *  - An unchanged file appears only when two or more changed files import
 *    it, so the map stays the size of the change.
 *  - Past {@link MAX_FILE_NODES} files, one box per folder instead.
 *
 * The layout is layered, left to right, importer before imported: each set
 * of files linked by imports is laid out on its own, and the files linked to
 * nothing come after, in group order. Every box sits on one grid, so columns
 * line up across the whole map.
 */

import type { ChangeKind } from '../git/fileDiff';
import type { BranchDiff, StatReason } from './blocks';
import type { CommentMarks } from './commentMarks';
import { MAX_SCAN_FILES, type ImportGraph } from './imports';
import type { GroupView } from './validate';

/** How many group colours there are (`--group-1` .. `--group-8`); past that they repeat. */
export const GROUP_COLOURS = 8;
/** More changed files than this and the map shows folders. */
export const MAX_FILE_NODES = 60;
/** At most this many unchanged files, the most imported first. */
export const MAX_UNCHANGED_NODES = 12;

/** A group's colour slot, 1-based; null for Unsorted, which is drawn dashed in --muted. */
export function groupColour(groups: readonly GroupView[], key: string): number | null {
  const named = groups.filter((g) => !g.unsorted);
  const i = named.findIndex((g) => g.key === key);
  return i < 0 ? null : (i % GROUP_COLOURS) + 1;
}

export interface MapNode {
  /** The file's path, a folder's path with a trailing `/`, or an unchanged file's path. */
  id: string;
  kind: 'file' | 'folder' | 'unchanged';
  /** What the box says: the file's name, with its folder when two names match. */
  label: string;
  /** Keys of the groups holding it, in guide order; empty for an unchanged file. */
  groups: string[];
  /** One colour slot per group in {@link groups}. */
  colours: Array<number | null>;
  added: number;
  removed: number;
  change: ChangeKind | null;
  stat: StatReason | null;
  comments: number;
  /** A folder's changed files; 1 for a file. */
  files: number;
  /** Lines changed against the largest box, 0..1 on a log scale: the size bar. */
  size: number;
  /** For an unchanged file: how many changed files import it. */
  importers: number;
}

export interface MapEdge {
  from: string;
  to: string;
}

export interface ChangeMap {
  nodes: MapNode[];
  edges: MapEdge[];
  /** What the map leaves out and why, one sentence each. */
  notes: string[];
  folded: boolean;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Names, with the last folder added where two would read the same. */
function labels(paths: readonly string[], name: (p: string) => string): Map<string, string> {
  const count = new Map<string, number>();
  for (const p of paths) count.set(name(p), (count.get(name(p)) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const p of paths) {
    const n = name(p);
    const dir = baseName(dirOf(p.replace(/\/$/, '')));
    out.set(p, (count.get(n) ?? 0) > 1 && dir ? `${dir}/${n}` : n);
  }
  return out;
}

function withSizes(nodes: MapNode[]): MapNode[] {
  const max = Math.max(1, ...nodes.map((n) => n.added + n.removed));
  return nodes.map((n) => ({ ...n, size: n.kind === 'unchanged' ? 0 : Math.log1p(n.added + n.removed) / Math.log1p(max) }));
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The map of `groups` (as shown: Uncommitted Only applies) over `diff`, with
 * the arrows of `graph` -- null while it is read.
 */
export function buildChangeMap(
  groups: readonly GroupView[],
  diff: BranchDiff,
  graph: ImportGraph | null,
  marks: CommentMarks,
  maxFileNodes: number = MAX_FILE_NODES,
): ChangeMap {
  const byPath = new Map<string, MapNode>();
  for (const g of groups) {
    const colour = groupColour(groups, g.key);
    for (const f of g.files) {
      const comments = marks.get(g.key)?.get(f.path) ?? 0;
      const had = byPath.get(f.path);
      if (had) {
        had.groups.push(g.key);
        had.colours.push(colour);
        had.added += f.added;
        had.removed += f.removed;
        had.comments += comments;
        continue;
      }
      const file = diff.files.find((x) => x.path === f.path);
      byPath.set(f.path, {
        id: f.path,
        kind: 'file',
        label: '',
        groups: [g.key],
        colours: [colour],
        added: f.added,
        removed: f.removed,
        change: file?.change ?? null,
        stat: f.stat,
        comments,
        files: 1,
        size: 0,
        importers: 0,
      });
    }
  }
  const files = [...byPath.values()];
  const notes: string[] = [];

  if (files.length > maxFileNodes) {
    return { ...foldToFolders(files, graph, maxFileNodes, groups), folded: true };
  }

  // Arrows between changed files, and to unchanged files two or more import.
  const edges: MapEdge[] = [];
  const outside = new Map<string, Set<string>>();
  for (const [from, to] of graph?.edges ?? []) {
    if (!byPath.has(from)) continue;
    if (byPath.has(to)) edges.push({ from, to });
    else {
      const set = outside.get(to) ?? new Set<string>();
      set.add(from);
      outside.set(to, set);
    }
  }
  const shared = [...outside.entries()]
    .filter(([, by]) => by.size >= 2)
    .sort((a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : 1));
  const unchanged: MapNode[] = shared.slice(0, MAX_UNCHANGED_NODES).map(([path, by]) => {
    for (const from of by) edges.push({ from, to: path });
    return {
      id: path,
      kind: 'unchanged',
      label: '',
      groups: [],
      colours: [],
      added: 0,
      removed: 0,
      change: 'unchanged',
      stat: null,
      comments: 0,
      files: 1,
      size: 0,
      importers: by.size,
    };
  });
  if (shared.length > MAX_UNCHANGED_NODES) {
    notes.push(`${shared.length - MAX_UNCHANGED_NODES} more unchanged files imported by two or more are left out.`);
  }

  const all = [...files, ...unchanged];
  const names = labels(
    all.map((n) => n.id),
    baseName,
  );
  for (const n of all) n.label = names.get(n.id) ?? n.id;

  if (graph !== null) notes.unshift(...arrowNotes(graph, edges.length, files.length));
  return { nodes: withSizes(all), edges, notes, folded: false };
}

/** Why there are no arrows, or fewer than one might expect. */
function arrowNotes(graph: ImportGraph, edgeCount: number, fileCount: number): string[] {
  if (graph.skipped === 'too-many') {
    return [`No arrows: imports are read for up to ${MAX_SCAN_FILES} changed files, and this change has more.`];
  }
  if (graph.scanned === 0) {
    return ['No arrows: imports are read from TypeScript, JavaScript, PHP and Rust files, and none of these changed files is one.'];
  }
  const out: string[] = [];
  if (edgeCount === 0) out.push(fileCount === 1 ? 'One file, nothing to link.' : 'None of these files imports another.');
  if (graph.unsupported > 0) {
    out.push(`Imports are read from TypeScript, JavaScript, PHP and Rust files; ${plural(graph.unsupported, 'file')} in other languages ${graph.unsupported === 1 ? 'has' : 'have'} no arrows.`);
  }
  return out;
}

/** One box per folder, shortened until there are few enough. */
function foldToFolders(
  files: readonly MapNode[],
  graph: ImportGraph | null,
  max: number,
  groups: readonly GroupView[],
): Omit<ChangeMap, 'folded'> {
  const order = new Map(groups.map((g, i) => [g.key, i] as const));
  let depth = Math.max(...files.map((f) => f.id.split('/').length - 1), 0);
  const folderOf = (path: string, d: number) => {
    const segs = path.split('/').slice(0, -1).slice(0, d);
    return segs.length === 0 ? './' : `${segs.join('/')}/`;
  };
  const count = (d: number) => new Set(files.map((f) => folderOf(f.id, d))).size;
  while (depth > 0 && count(depth) > max) depth--;

  const folders = new Map<string, MapNode>();
  for (const f of files) {
    const id = folderOf(f.id, depth);
    const n = folders.get(id) ?? {
      id,
      kind: 'folder' as const,
      label: '',
      groups: [],
      colours: [],
      added: 0,
      removed: 0,
      change: null,
      stat: null,
      comments: 0,
      files: 0,
      size: 0,
      importers: 0,
    };
    f.groups.forEach((g, i) => {
      if (!n.groups.includes(g)) {
        n.groups.push(g);
        n.colours.push(f.colours[i] ?? null);
      }
    });
    n.added += f.added;
    n.removed += f.removed;
    n.comments += f.comments;
    n.files += 1;
    folders.set(id, n);
  }
  for (const n of folders.values()) {
    const pairs = n.groups.map((g, i) => [g, n.colours[i] ?? null] as const).sort((a, b) => (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0));
    n.groups = pairs.map((p) => p[0]);
    n.colours = pairs.map((p) => p[1]);
  }
  const nodes = [...folders.values()];
  const names = labels(
    nodes.map((n) => n.id),
    (p) => (p === './' ? './' : `${baseName(p.slice(0, -1))}/`),
  );
  for (const n of nodes) n.label = names.get(n.id) ?? n.id;

  const edges: MapEdge[] = [];
  const seen = new Set<string>();
  const changed = new Set(files.map((f) => f.id));
  for (const [from, to] of graph?.edges ?? []) {
    if (!changed.has(from) || !changed.has(to)) continue;
    const a = folderOf(from, depth);
    const b = folderOf(to, depth);
    if (a === b || seen.has(`${a}\n${b}`)) continue;
    seen.add(`${a}\n${b}`);
    edges.push({ from: a, to: b });
  }
  const notes = [`${plural(files.length, 'file')} is more than the map draws one by one (${max}): one box per folder.`];
  if (graph !== null && graph.skipped === null) notes.push('Arrows are imports between folders; unchanged files are left out.');
  else if (graph !== null) notes.push(...arrowNotes(graph, 0, files.length));
  return { nodes: withSizes(nodes), edges, notes };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export const NODE_W = 184;
export const NODE_H = 52;
/** Room between columns for the arrows. */
export const GAP_X = 48;
export const GAP_Y = 14;
export const PAD = 16;
/** Between one set of linked files and the next, below it. */
export const SHELF_GAP = 28;

export interface Placed {
  x: number;
  y: number;
}

export interface Route {
  from: string;
  to: string;
  /** The SVG path of the line, ending where the arrowhead starts. */
  d: string;
  /** The arrowhead, an SVG polygon's points. */
  head: string;
}

export interface MapLayout {
  at: ReadonlyMap<string, Placed>;
  routes: Route[];
  width: number;
  height: number;
}

interface Block {
  /** id -> column and row inside the block. */
  cells: Map<string, { col: number; row: number }>;
  cols: number;
  rows: number;
}

/** Layers by longest path, importer left of imported; cycles broken where met. */
function layerComponent(ids: readonly string[], edges: readonly MapEdge[]): Block {
  const inComp = new Set(ids);
  const out = new Map<string, string[]>();
  for (const id of ids) out.set(id, []);
  for (const e of edges) if (inComp.has(e.from) && inComp.has(e.to)) out.get(e.from)!.push(e.to);

  // Break cycles: drop edges that close one, found by a depth-first walk.
  const state = new Map<string, 1 | 2>();
  const dag = new Map<string, string[]>();
  for (const id of ids) dag.set(id, []);
  const walk = (id: string) => {
    state.set(id, 1);
    for (const to of out.get(id) ?? []) {
      const s = state.get(to);
      if (s === 1) continue; // back edge
      dag.get(id)!.push(to);
      if (s === undefined) walk(to);
    }
    state.set(id, 2);
  };
  for (const id of ids) if (!state.has(id)) walk(id);

  // Longest path from the sources.
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const tos of dag.values()) for (const t of tos) indeg.set(t, (indeg.get(t) ?? 0) + 1);
  const layer = new Map<string, number>(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => indeg.get(id) === 0);
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const t of dag.get(id) ?? []) {
      layer.set(t, Math.max(layer.get(t) ?? 0, (layer.get(id) ?? 0) + 1));
      indeg.set(t, (indeg.get(t) ?? 0) - 1);
      if (indeg.get(t) === 0) queue.push(t);
    }
  }

  const cols = Math.max(...ids.map((id) => layer.get(id) ?? 0)) + 1;
  const layers: string[][] = Array.from({ length: cols }, () => []);
  for (const id of ids) layers[layer.get(id) ?? 0]!.push(id);

  // Fewer crossings: order each layer by its neighbours' mean position, a few sweeps.
  const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [from, tos] of dag) for (const t of tos) preds.get(t)!.push(from);
  const pos = new Map<string, number>();
  const index = () => layers.forEach((l) => l.forEach((id, i) => pos.set(id, i)));
  index();
  const mean = (ns: readonly string[], fallback: number) =>
    ns.length === 0 ? fallback : ns.reduce((s, n) => s + (pos.get(n) ?? 0), 0) / ns.length;
  for (let sweep = 0; sweep < 4; sweep++) {
    const down = sweep % 2 === 0;
    const range = down ? layers.slice(1) : layers.slice(0, -1).reverse();
    for (const l of range) {
      const key = new Map(l.map((id) => [id, mean(down ? preds.get(id)! : dag.get(id)!, pos.get(id) ?? 0)] as const));
      l.sort((a, b) => key.get(a)! - key.get(b)! || pos.get(a)! - pos.get(b)!);
      index();
    }
  }

  const rows = Math.max(...layers.map((l) => l.length));
  const cells = new Map<string, { col: number; row: number }>();
  layers.forEach((l, col) => {
    // Centred on the block's rows, on whole rows so every box stays on the grid.
    const offset = Math.floor((rows - l.length) / 2);
    l.forEach((id, i) => cells.set(id, { col, row: offset + i }));
  });
  return { cells, cols, rows };
}

/** Place `nodes` (already in reading order) within `maxWidth`, and route `edges`. */
export function layoutMap(nodes: readonly MapNode[], edges: readonly MapEdge[], maxWidth: number): MapLayout {
  const pitchX = NODE_W + GAP_X;
  const pitchY = NODE_H + GAP_Y;
  const maxCols = Math.max(1, Math.floor((maxWidth - 2 * PAD + GAP_X) / pitchX));
  const ids = nodes.map((n) => n.id);
  const known = new Set(ids);
  const links = edges.filter((e) => known.has(e.from) && known.has(e.to) && e.from !== e.to);

  // Linked sets, by union-find.
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id: string): string => {
    let r = id;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(id, r);
    return r;
  };
  for (const e of links) parent.set(find(e.from), find(e.to));
  const comps = new Map<string, string[]>();
  for (const id of ids) {
    const r = find(id);
    const list = comps.get(r) ?? [];
    list.push(id);
    comps.set(r, list);
  }
  const linked = [...comps.values()].filter((c) => c.length > 1).sort((a, b) => b.length - a.length);
  const alone = [...comps.values()].filter((c) => c.length === 1).map((c) => c[0]!);

  const at = new Map<string, Placed>();
  let y = PAD;
  let width = 0;
  // Linked sets side by side while they fit, then on the next shelf.
  let col = 0;
  let shelfRows = 0;
  for (const comp of linked) {
    const block = layerComponent(comp, links);
    if (col > 0 && col + block.cols > maxCols) {
      y += shelfRows * pitchY - GAP_Y + SHELF_GAP;
      col = 0;
      shelfRows = 0;
    }
    for (const [id, c] of block.cells) at.set(id, { x: PAD + (col + c.col) * pitchX, y: y + c.row * pitchY });
    col += block.cols;
    shelfRows = Math.max(shelfRows, block.rows);
  }
  if (shelfRows > 0) y += shelfRows * pitchY - GAP_Y + (alone.length > 0 ? SHELF_GAP : 0);
  // The rest in a grid, in reading order: one group's colour runs together.
  alone.forEach((id, i) => {
    at.set(id, { x: PAD + (i % maxCols) * pitchX, y: y + Math.floor(i / maxCols) * pitchY });
  });
  if (alone.length > 0) y += Math.ceil(alone.length / maxCols) * pitchY - GAP_Y;
  for (const p of at.values()) width = Math.max(width, p.x + NODE_W + PAD);

  const routes = links.map((e) => route(e, at.get(e.from)!, at.get(e.to)!));
  return { at, routes, width: Math.max(width, 2 * PAD), height: nodes.length === 0 ? 2 * PAD : y + PAD };
}

const HEAD_L = 7;
const HEAD_W = 4;

function route(e: MapEdge, a: Placed, b: Placed): Route {
  const ay = a.y + NODE_H / 2;
  const by = b.y + NODE_H / 2;
  const fwd = b.x > a.x;
  // Forward: out of the importer's right edge into the imported's left.
  // Backward (a cycle, or a set laid out the other way): left edge to right edge.
  const x1 = fwd ? a.x + NODE_W : a.x;
  const tip = fwd ? b.x : b.x + NODE_W;
  const dir = fwd ? 1 : -1;
  const x2 = tip - dir * HEAD_L;
  const bend = Math.max(24, Math.abs(x2 - x1) / 2) * dir;
  const d = `M${x1},${ay} C${x1 + bend},${ay} ${x2 - bend},${by} ${x2},${by}`;
  const head = `${tip},${by} ${x2},${by - HEAD_W} ${x2},${by + HEAD_W}`;
  return { from: e.from, to: e.to, d, head };
}
