/**
 * The Review Guide's Map (#288): the change's files as boxes in their groups'
 * colours, with arrows for the imports between them. map.ts decides what is
 * drawn and where; this file draws it.
 *
 *   left   the key: the groups, each with its colour and file count, and
 *          what the map leaves out and why
 *   right  the boxes and arrows, on the pane's own ground, scrolling both ways
 *
 * A click on a file opens its blocks in Read; on a group in the key, that
 * group. An unchanged file has no blocks: it opens in the editor.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import type { BranchDiff } from './blocks';
import type { CommentMarks } from './commentMarks';
import { CommentCount, commentsSaid } from './CommentCount';
import { importGraph, type ImportGraph } from './imports';
import { buildChangeMap, groupColour, layoutMap, NODE_H, NODE_W, type MapNode } from './map';
import { repoFiles } from './repoFiles';
import { carefulWhy, type CarefulMark, type GroupView } from './validate';
import { useOpenFile } from '../ui/editor/openFile';
import { FlagIcon } from '../ui/icons';

/** Imports read, per worktree and change, as repoFiles keeps its list: flipping views costs nothing. */
const graphs = new Map<string, ImportGraph>();

/** The imports of the change, read once per change and worktree. */
function useImportGraph(worktreePath: string, diff: BranchDiff): ImportGraph | null {
  const key = `${worktreePath}\n${diff.hash}`;
  const [graph, setGraph] = useState<{ key: string; graph: ImportGraph } | null>(() => {
    const kept = graphs.get(key);
    return kept ? { key, graph: kept } : null;
  });
  useEffect(() => {
    let live = true;
    const kept = graphs.get(key);
    if (kept) {
      setGraph({ key, graph: kept });
      return;
    }
    void repoFiles(worktreePath, diff.hash).then((repo) => {
      const files = diff.files.map((f) => ({
        path: f.path,
        text: f.result.kind === 'diff' && f.change !== 'deleted' ? f.result.newText : null,
        deleted: f.change === 'deleted',
      }));
      const read = importGraph(files, repo);
      graphs.delete(key);
      graphs.set(key, read);
      while (graphs.size > 8) graphs.delete(graphs.keys().next().value!);
      if (live) setGraph({ key, graph: read });
    });
    return () => {
      live = false;
    };
  }, [key, worktreePath, diff]);
  return graph && graph.key === key ? graph.graph : null;
}

/** The canvas's width, for where the map wraps; a fixed guess until measured. */
function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(960);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth > 0) setWidth(el.clientWidth);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export interface GuideMapProps {
  worktreePath: string;
  diff: BranchDiff;
  /** As shown: Uncommitted Only applies. */
  groups: readonly GroupView[];
  marks: CommentMarks;
  /** The file open in Read, drawn as the current box. */
  current: string | null;
  /** Open `path` in Read, in group `groupKey`. */
  onOpen: (groupKey: string, path: string) => void;
  onOpenGroup: (groupKey: string) => void;
}

export default function GuideMap({ worktreePath, diff, groups, marks, current, onOpen, onOpenGroup }: GuideMapProps): ReactNode {
  const graph = useImportGraph(worktreePath, diff);
  const map = useMemo(() => buildChangeMap(groups, diff, graph, marks), [groups, diff, graph, marks]);
  const [canvasRef, width] = useWidth();
  const layout = useMemo(() => layoutMap(map.nodes, map.edges, width), [map, width]);
  const [hot, setHot] = useState<string | null>(null);
  const openFile = useOpenFile();
  const isHot = (r: { from: string; to: string }) => hot !== null && (r.from === hot || r.to === hot);
  const nodeOf = useMemo(() => new Map(map.nodes.map((n) => [n.id, n] as const)), [map]);

  const titleOf = new Map(groups.map((g) => [g.key, g.title] as const));
  const linksOf = (id: string) => ({
    out: map.edges.filter((e) => e.from === id).map((e) => e.to),
    in: map.edges.filter((e) => e.to === id).map((e) => e.from),
  });
  const fileCount = map.nodes.reduce((n, x) => n + (x.kind === 'unchanged' ? 0 : x.files), 0);
  const groupFiles = (g: GroupView) => g.files.length;

  const open = (n: MapNode) => {
    if (n.kind === 'unchanged') {
      openFile({ path: n.id });
      return;
    }
    const key = n.groups[0];
    if (!key) return;
    if (n.kind === 'file') {
      onOpen(key, n.id);
      return;
    }
    // A folder: its first file in its first group.
    const g = groups.find((x) => x.key === key);
    const first = g?.files.find((f) => (n.id === './' ? !f.path.includes('/') : f.path.startsWith(n.id)));
    if (first) onOpen(key, first.path);
    else onOpenGroup(key);
  };

  const describe = (n: MapNode): string => {
    const parts: string[] = [n.kind === 'folder' ? `${n.id}, ${plural(n.files, 'file')}` : n.id];
    if (n.kind === 'unchanged') parts.push(`unchanged, imported by ${plural(n.importers, 'changed file')}`);
    else {
      parts.push(n.groups.map((k) => titleOf.get(k) ?? k).join(' and '));
      if (n.change === 'added') parts.push('new');
      if (n.change === 'deleted') parts.push('deleted');
      parts.push(`${n.added} added, ${n.removed} removed`);
    }
    const l = linksOf(n.id);
    const name = (id: string) => map.nodes.find((x) => x.id === id)?.label ?? id;
    if (l.out.length > 0) parts.push(`imports ${l.out.map(name).join(', ')}`);
    if (l.in.length > 0) parts.push(`imported by ${l.in.map(name).join(', ')}`);
    if (n.careful) parts.push(`review carefully: ${n.careful}`);
    return parts.join('; ') + commentsSaid(n.comments, '; ');
  };

  // The careful files (#295), once each, in group order: listed in the key with why.
  const careful: Array<{ key: string; path: string; mark: CarefulMark }> = [];
  for (const g of groups) {
    for (const f of g.files) {
      if (f.careful && !careful.some((c) => c.path === f.path)) {
        careful.push({ key: g.key, path: f.path, mark: f.careful });
      }
    }
  }

  return (
    <div className="gd-body gd-map-body">
      <section className="gd-left" aria-label="Map key">
        <h2 className="gd-title">Map</h2>
        <div className="gd-count-row">
          <span className="gd-count">
            {plural(fileCount, 'file')} · {plural(groups.length, 'group')}
            {graph ? ` · ${plural(map.edges.length, 'import')}` : ''}
          </span>
        </div>
        <p className="gd-map-lede">Each box is a changed file in its group’s colour; arrows point to what it imports.</p>
        <ul className="gd-files" aria-label="Groups">
          {groups.map((g) => {
            const colour = groupColour(groups, g.key);
            return (
              <li key={g.key}>
                <button
                  type="button"
                  className="gd-file gd-map-group"
                  onClick={() => onOpenGroup(g.key)}
                  title={`Read ${g.title}`}
                >
                  <span className="gd-map-swatch" data-colour={colour ?? 'none'} aria-hidden="true" />
                  <span className="gd-file-base">{g.title}</span>
                  <span className="gd-counts">{plural(groupFiles(g), 'file')}</span>
                </button>
              </li>
            );
          })}
        </ul>
        {careful.length > 0 ? (
          <>
            <h3 className="gd-map-subhead">
              <FlagIcon className="gd-careful-icon" />
              Review carefully
            </h3>
            <ul className="gd-files" aria-label="Files to review carefully">
              {careful.map((c) => {
                const at = c.path.lastIndexOf('/');
                return (
                  <li key={c.path}>
                    <button
                      type="button"
                      className="gd-file gd-map-careful"
                      onClick={() => onOpen(c.key, c.path)}
                      title={`${c.path}: review carefully, ${carefulWhy(c.mark)}`}
                    >
                      {/* 12px: the swatch column's width, so the names line up with the groups'. */}
                      <FlagIcon size={12} className="gd-careful-icon" />
                      <span className="gd-file-base">{c.path.slice(at + 1)}</span>
                      <span className="gd-file-dir">{c.path.slice(0, at + 1)}</span>
                      <span className="gd-file-careful">
                        <span>
                          {c.mark.reason ?? (
                            <>
                              Matches <span className="gd-pattern">{c.mark.pattern}</span>
                            </>
                          )}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
        {map.notes.length > 0 ? (
          <div className="gd-map-notes" role="note">
            {map.notes.map((n) => (
              <p key={n}>{n}</p>
            ))}
          </div>
        ) : null}
      </section>

      <section className="gd-map" aria-label="Map" ref={canvasRef}>
        {graph === null ? (
          <div className="gd-message">Reading the imports…</div>
        ) : (
          <div className="gd-map-canvas" style={{ width: layout.width, height: layout.height }}>
            <svg className="gd-map-edges" width={layout.width} height={layout.height} aria-hidden="true">
              {/* The highlighted arrows last, so they are drawn over the rest. */}
              {[...layout.routes.filter((r) => !isHot(r)), ...layout.routes.filter(isHot)].map((r) => (
                <g key={`${r.from}\n${r.to}`} className="gd-map-edge" data-hot={isHot(r) || undefined}>
                  <path d={r.d} />
                  <polygon points={r.head} />
                </g>
              ))}
            </svg>
            {/* In reading order, so Tab follows the map as it is drawn. */}
            {layout.order.map((id) => {
              const n = nodeOf.get(id);
              const p = layout.at.get(id);
              if (!n || !p) return null;
              return (
                <button
                  key={n.id}
                  type="button"
                  className="gd-map-node"
                  data-kind={n.kind}
                  aria-current={n.kind === 'file' && n.id === current ? 'true' : undefined}
                  style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
                  onClick={() => open(n)}
                  onMouseEnter={() => setHot(n.id)}
                  onMouseLeave={() => setHot((h) => (h === n.id ? null : h))}
                  onFocus={() => setHot(n.id)}
                  onBlur={() => setHot((h) => (h === n.id ? null : h))}
                  aria-label={describe(n)}
                  title={n.careful ? `${n.id}\nReview carefully: ${n.careful}` : n.id}
                >
                  {n.kind === 'unchanged' ? null : (
                    <span className="gd-map-stripe" aria-hidden="true">
                      {n.colours.map((c, i) => (
                        <span key={i} data-colour={c ?? 'none'} />
                      ))}
                    </span>
                  )}
                  <span className="gd-map-name">
                    {n.careful ? <FlagIcon className="gd-careful-icon" /> : null}
                    {n.label}
                  </span>
                  <span className="gd-map-facts">
                    <NodeFacts n={n} />
                    <CommentCount n={n.comments} />
                  </span>
                  {n.kind === 'unchanged' ? null : (
                    <span className="gd-map-size" aria-hidden="true" style={{ width: `calc((100% - 24px) * ${Math.max(0.04, n.size).toFixed(3)})` }} />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function NodeFacts({ n }: { n: MapNode }): ReactNode {
  if (n.kind === 'unchanged') return <span className="gd-map-tag">unchanged · {plural(n.importers, 'importer')}</span>;
  const tag =
    n.kind === 'folder' ? plural(n.files, 'file') : n.change === 'added' ? 'new' : n.change === 'deleted' ? 'deleted' : null;
  const counts =
    n.stat === 'binary' || n.stat === 'too-large' ? (
      <span className="gd-counts">{n.stat === 'binary' ? 'Binary' : 'Too large'}</span>
    ) : (
      <span className="gd-counts">
        {n.added > 0 ? <span className="gd-add">+{n.added}</span> : null}
        {n.removed > 0 ? <span className="gd-del">−{n.removed}</span> : null}
      </span>
    );
  return (
    <>
      {tag ? <span className="gd-map-tag">{tag}</span> : null}
      {counts}
    </>
  );
}

