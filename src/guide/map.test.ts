import { describe, expect, it } from 'vitest';
import { buildBranchDiff } from './blocks';
import { statReason } from './budget';
import { edited } from './fixtures';
import type { ImportGraph } from './imports';
import { buildChangeMap, groupColour, GROUP_COLOURS, layoutMap, NODE_W, PAD_X, PAD_Y, GAP_X, GAP_Y, NODE_H, type MapNode } from './map';
import type { GroupFile, GroupView } from './validate';

function file(path: string, added = 1, removed = 0): GroupFile {
  return { path, blocks: [], totalBlocks: 1, added, removed, stat: null, note: null, line: null, notable: false, careful: null };
}

function group(key: string, files: GroupFile[], unsorted = false): GroupView {
  return { key, index: unsorted ? null : 0, title: key, summary: '', unsorted, setAside: false, blocks: [], files };
}

const diff = buildBranchDiff([edited('src/a.ts', [3]), edited('src/b.ts', [3]), edited('src/c.ts', [3])], statReason);
const ALL = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/ui/index.ts', 'src/db/index.ts'];
const graph = (edges: Array<[string, string]>, extra: Partial<ImportGraph> = {}): ImportGraph => ({
  edges,
  scanned: new Set(ALL),
  unsupported: new Set(),
  unread: new Set(),
  skipped: null,
  ...extra,
});
const noMarks = new Map();

describe('buildChangeMap (#288)', () => {
  it('a box per changed file in its group’s colour; a file in two groups carries both', () => {
    const groups = [group('g1', [file('src/a.ts', 4, 1), file('src/b.ts')]), group('g2', [file('src/a.ts', 2)]), group('u', [file('src/c.ts')], true)];
    const map = buildChangeMap(groups, diff, graph([]), noMarks);
    const a = map.nodes.find((n) => n.id === 'src/a.ts')!;
    expect(a).toMatchObject({ kind: 'file', label: 'a.ts', groups: ['g1', 'g2'], colours: [1, 2], added: 6, removed: 1 });
    expect(map.nodes.find((n) => n.id === 'src/c.ts')!.colours).toEqual([null]);
    expect(map.notes).toEqual(['None of these files imports another.']);
  });

  it('colours repeat after the last token, and Unsorted has none', () => {
    const groups = Array.from({ length: GROUP_COLOURS + 1 }, (_, i) => group(`g${i}`, []));
    expect(groupColour(groups, 'g0')).toBe(1);
    expect(groupColour(groups, `g${GROUP_COLOURS}`)).toBe(1);
    expect(groupColour([...groups, group('u', [], true)], 'u')).toBeNull();
  });

  it('draws an unchanged file only when two or more changed files import it', () => {
    const groups = [group('g1', [file('src/a.ts'), file('src/b.ts'), file('src/c.ts')])];
    const map = buildChangeMap(
      groups,
      diff,
      graph([
        ['src/a.ts', 'src/b.ts'],
        ['src/a.ts', 'src/shared.ts'],
        ['src/b.ts', 'src/shared.ts'],
        ['src/c.ts', 'src/once.ts'],
      ]),
      noMarks,
    );
    expect(map.nodes.map((n) => n.id)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/shared.ts']);
    expect(map.nodes[3]).toMatchObject({ kind: 'unchanged', importers: 2 });
    expect(map.edges).toEqual([
      { from: 'src/a.ts', to: 'src/b.ts' },
      { from: 'src/a.ts', to: 'src/shared.ts' },
      { from: 'src/b.ts', to: 'src/shared.ts' },
    ]);
  });

  it('counts open comments per file across its groups', () => {
    const groups = [group('g1', [file('src/a.ts')]), group('g2', [file('src/a.ts')])];
    const marks = new Map([
      ['g1', new Map([['src/a.ts', 1]])],
      ['g2', new Map([['src/a.ts', 2]])],
    ]);
    expect(buildChangeMap(groups, diff, graph([]), marks).nodes[0]!.comments).toBe(3);
  });

  it('says why there are no arrows', () => {
    const groups = [group('g1', [file('src/a.ts'), file('src/b.ts')])];
    const none = new Set<string>();
    expect(buildChangeMap(groups, diff, graph([], { scanned: none, unsupported: new Set(['src/a.ts', 'src/b.ts']) }), noMarks).notes[0]).toMatch(
      /^No arrows: imports are read from TypeScript/,
    );
    expect(buildChangeMap(groups, diff, graph([], { skipped: 'too-many', scanned: none }), noMarks).notes[0]).toMatch(/^No arrows: imports are read for up to/);
    expect(
      buildChangeMap(groups, diff, graph([['src/a.ts', 'src/b.ts']], { scanned: new Set(['src/a.ts']), unsupported: new Set(['src/b.ts', 'elsewhere.md']) }), noMarks).notes,
    ).toEqual(['Imports are read from TypeScript, JavaScript, PHP and Rust files; 1 file in other languages has no arrows.']);
  });

  it('a file it reads the language of but could not read is not called another language (#288 review)', () => {
    const groups = [group('g1', [file('src/a.ts'), file('src/b.ts')])];
    const g = graph([], { scanned: new Set(), unsupported: new Set(['src/b.ts']), unread: new Set(['src/a.ts']) });
    expect(buildChangeMap(groups, diff, g, noMarks).notes[0]).toBe(
      'No arrows: the one file here in a language the map reads is deleted, binary or too large to read.',
    );
  });

  it('counts only the files shown: one hidden by Uncommitted Only is not in the note', () => {
    const groups = [group('g1', [file('src/a.ts'), file('src/b.ts')])];
    const g = graph([['src/a.ts', 'src/b.ts']], { unsupported: new Set(['src/c.ts']) });
    expect(buildChangeMap(groups, diff, g, noMarks).notes).toEqual([]);
  });

  it('a changed file the filter hides is never drawn as unchanged (#288 review)', () => {
    // a.ts and b.ts are uncommitted and import c.ts, which is changed but committed.
    const groups = [group('g1', [file('src/a.ts'), file('src/b.ts')])];
    const map = buildChangeMap(
      groups,
      diff,
      graph([
        ['src/a.ts', 'src/c.ts'],
        ['src/b.ts', 'src/c.ts'],
      ]),
      noMarks,
    );
    expect(map.nodes.map((n) => n.id)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(map.edges).toEqual([]);
  });

  it('names a file by its folder too when two would read the same', () => {
    const groups = [group('g1', [file('src/ui/index.ts'), file('src/db/index.ts'), file('src/a.ts')])];
    expect(buildChangeMap(groups, diff, graph([]), noMarks).nodes.map((n) => n.label)).toEqual(['ui/index.ts', 'db/index.ts', 'a.ts']);
  });

  it('past the cap, one box per folder, with the imports between folders', () => {
    const files = ['src/a/1.ts', 'src/a/2.ts', 'src/b/1.ts', 'src/b/2.ts', 'lib/x.ts'].map((p) => file(p, 2));
    const map = buildChangeMap(
      [group('g1', files.slice(0, 3)), group('g2', files.slice(3))],
      diff,
      graph([
        ['src/a/1.ts', 'src/a/2.ts'],
        ['src/a/1.ts', 'src/b/1.ts'],
        ['src/b/2.ts', 'src/b/1.ts'],
      ]),
      noMarks,
      3,
    );
    expect(map.folded).toBe(true);
    expect(map.nodes.map((n) => [n.id, n.files, n.colours])).toEqual([
      ['src/a/', 2, [1]],
      ['src/b/', 2, [1, 2]],
      ['lib/', 1, [2]],
    ]);
    expect(map.edges).toEqual([{ from: 'src/a/', to: 'src/b/' }]);
    expect(map.notes[0]).toMatch(/^5 files is more than the map draws one by one \(3\)/);
  });
});

function node(id: string): MapNode {
  return { id, kind: 'file', label: id, groups: [], colours: [], added: 1, removed: 0, change: 'modified', stat: null, comments: 0, files: 1, size: 1, importers: 0 };
}

describe('layoutMap (#288)', () => {
  const pitch = NODE_W + GAP_X;

  it('lays a chain left to right, importer before imported, every box on the grid', () => {
    const l = layoutMap([node('a'), node('b'), node('c')], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }], 2000);
    expect(['a', 'b', 'c'].map((id) => l.at.get(id)!.x)).toEqual([PAD_X, PAD_X + pitch, PAD_X + 2 * pitch]);
    expect(new Set(['a', 'b', 'c'].map((id) => l.at.get(id)!.y)).size).toBe(1);
    expect(l.routes).toHaveLength(2);
    expect(l.routes[0]!.d.startsWith(`M${PAD_X + NODE_W},`)).toBe(true);
  });

  it('survives a cycle, and draws its closing arrow backwards', () => {
    const l = layoutMap([node('a'), node('b')], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }], 2000);
    expect(l.at.get('a')!.x).toBeLessThan(l.at.get('b')!.x);
    expect(l.routes).toHaveLength(2);
  });

  it('puts unlinked files after the linked ones, in a grid that wraps at the width', () => {
    const nodes = ['a', 'b', 'x1', 'x2', 'x3'].map(node);
    const l = layoutMap(nodes, [{ from: 'a', to: 'b' }], PAD_X * 2 + pitch * 2);
    const linkedBottom = l.at.get('a')!.y;
    expect(l.at.get('x1')!.y).toBeGreaterThan(linkedBottom);
    expect(l.at.get('x1')!.x).toBe(PAD_X);
    expect(l.at.get('x2')!.x).toBe(PAD_X + pitch);
    expect(l.at.get('x3')!.x).toBe(PAD_X);
    expect(l.at.get('x3')!.y).toBeGreaterThan(l.at.get('x1')!.y);
    for (const p of l.at.values()) expect((p.x - PAD_X) % pitch).toBe(0);
  });
});

/** Every point a route passes through, sampled along its straight runs. */
function crossesABox(d: string, boxes: ReadonlyArray<{ x: number; y: number }>): boolean {
  const pts = [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]!;
    const [x1, y1] = pts[i]!;
    for (let t = 0; t <= 1; t += 0.05) {
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      if (boxes.some((b) => x > b.x + 1 && x < b.x + NODE_W - 1 && y > b.y + 1 && y < b.y + NODE_H - 1)) return true;
    }
  }
  return false;
}

describe('layoutMap routing and wrapping (#288 review)', () => {
  const pitch = NODE_W + GAP_X;

  it('an arrow that skips a column runs along the gaps, never behind the box between', () => {
    // a -> b -> c, and a -> c skipping b: c is two columns on, b in the way.
    const l = layoutMap(['a', 'b', 'c'].map(node), [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'c' }], 4000);
    expect(l.at.get('c')!.x).toBe(l.at.get('a')!.x + 2 * pitch);
    const boxes = [...l.at.values()];
    for (const r of l.routes) expect(crossesABox(r.d, boxes), `${r.from} -> ${r.to}`).toBe(false);
    const skip = l.routes.find((r) => r.from === 'a' && r.to === 'c')!;
    // Through the gutter beside the row, not along the boxes' middle.
    expect(skip.d).not.toMatch(/C/);
  });

  it('a chain longer than the width wraps onto further bands, and every arrow still clears every box', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const edges = ids.slice(1).map((id, i) => ({ from: ids[i]!, to: id }));
    edges.push({ from: 'a', to: 'e' }, { from: 'g', to: 'b' });
    const width = PAD_X * 2 + pitch * 3 - GAP_X;
    const l = layoutMap(ids.map(node), edges, width);
    expect(l.width).toBeLessThanOrEqual(width);
    expect(new Set(ids.map((id) => l.at.get(id)!.y)).size).toBe(3);
    expect(l.at.get('d')!.x).toBe(PAD_X);
    const boxes = [...l.at.values()];
    for (const r of l.routes) expect(crossesABox(r.d, boxes), `${r.from} -> ${r.to}`).toBe(false);
  });

  it('gives the boxes in reading order: set by set, column by column, then the rest row by row', () => {
    const l = layoutMap(['a', 'b', 'c', 'x', 'y'].map(node), [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }], 4000);
    expect(l.order).toEqual(['a', 'b', 'c', 'x', 'y']);
    expect(l.at.get('b')!.x).toBe(l.at.get('c')!.x);
    expect(l.at.get('x')!.y).toBeGreaterThan(l.at.get('c')!.y + NODE_H + GAP_Y);
    expect(PAD_Y).toBe(16);
  });
});
