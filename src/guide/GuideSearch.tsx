/**
 * Search in a Review Guide (#413): one bar, two scopes.
 *
 *   This File        ⌘F    the diff of the file being read: every match
 *                          highlighted in it, ↩ / ⇧↩ step, the view follows
 *   All Guide Files  ⇧⌘F   every file in the guide, listed by group in the
 *                          guide's order; ↑↓ pick a line, ↩ or a click opens
 *                          that file in its group at the line, on This File
 *
 * The switch flips between them, keeping the text. Plain text, case-
 * insensitive unless the text has a capital (`findInLine`). Esc closes the
 * bar and its highlights, never full screen: the key is marked handled here.
 *
 * GuidePane owns the state (open, scope, text, the current match) and the
 * keys that open it; this file draws the bar and the All Guide Files list.
 * The highlights are the diff's own (`Diff`'s `search`).
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { BranchDiff } from './blocks';
import type { GroupView } from './validate';
import { searchGuide, type GuideHit, type GuideHitLine } from './search';

export type SearchScope = 'file' | 'all';

export interface GuideSearchState {
  open: boolean;
  scope: SearchScope;
  query: string;
  /** This File's current match: a `DiffMatch` key, for the file it was picked in. */
  current: { path: string; key: string } | null;
}

export const CLOSED_SEARCH: GuideSearchState = { open: false, scope: 'file', query: '', current: null };

export const SCOPE_LABEL: Record<SearchScope, string> = { file: 'This File', all: 'All Guide Files' };

export interface SearchBarProps {
  scope: SearchScope;
  query: string;
  onQuery: (query: string) => void;
  onScope: (scope: SearchScope) => void;
  onClose: () => void;
  /** Bumped when ⌘F / ⇧⌘F asks for the field again: it takes focus, text selected. */
  focusTick: number;
  /** True once per request to focus: a bar that mounts later still takes it. */
  takeFocus: () => boolean;
}

/** Matches on one line, cut to show where they are on a long one. Pure. */
function clipLine(text: string, ranges: ReadonlyArray<{ start: number; end: number }>, before = 40) {
  const lead = text.length - text.trimStart().length;
  const first = ranges[0]?.start ?? lead;
  const from = first - lead > before ? first - before : lead;
  return { from, cut: from > lead };
}

function MarkedLine({ line }: { line: GuideHitLine }): ReactNode {
  const { from, cut } = clipLine(line.text, line.hits);
  const parts: ReactNode[] = [];
  let at = from;
  line.hits.forEach((h, i) => {
    if (h.end <= at) return;
    const start = Math.max(at, h.start);
    if (start > at) parts.push(line.text.slice(at, start));
    parts.push(
      <mark key={i} className="gd-search-mark">
        {line.text.slice(start, h.end)}
      </mark>,
    );
    at = h.end;
  });
  parts.push(line.text.slice(at));
  return (
    <>
      {cut ? '…' : null}
      {parts}
    </>
  );
}

/** The field, the scope switch, the count and the keys, as the mockup has them. */
export function SearchBar({
  scope,
  query,
  onQuery,
  onScope,
  onClose,
  focusTick,
  takeFocus,
  count,
  hint,
  onKeys,
  combobox,
}: SearchBarProps & {
  count: string;
  hint: string;
  /** The scope's own keys in the field (↩ / ⇧↩, or ↑↓ ↩). */
  onKeys: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
  /** All Guide Files: the field drives the list beside it. */
  combobox?: { listId: string; active: string | undefined };
}): ReactNode {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!takeFocus()) return;
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  }, [focusTick, takeFocus]);
  return (
    <div className="gd-search" role="search" aria-label="Search the guide">
      <input
        ref={input}
        className="gd-search-input"
        type="text"
        aria-label={`Search ${SCOPE_LABEL[scope]}`}
        placeholder={scope === 'file' ? 'Find in this file' : 'Find in the guide’s files'}
        value={query}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        {...(combobox
          ? {
              role: 'combobox',
              'aria-expanded': true,
              'aria-controls': combobox.listId,
              'aria-activedescendant': combobox.active,
              'aria-autocomplete': 'list' as const,
            }
          : {})}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Escape') {
            // Handled: never also the window's (full screen, #267).
            e.preventDefault();
            onClose();
            return;
          }
          onKeys(e);
        }}
      />
      <span className="seg seg-compact" role="group" aria-label="Search in">
        {(['file', 'all'] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={scope === s}
            // The field keeps focus: the switch is pressed while typing.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onScope(s)}
            title={s === 'file' ? 'Search the file you are reading (⌘F)' : 'Search every file in the guide (⇧⌘F)'}
          >
            {SCOPE_LABEL[s]}
          </button>
        ))}
      </span>
      <span className="gd-search-count" role="status" aria-live="polite">
        {count}
      </span>
      <span className="gd-search-hint">{hint}</span>
    </div>
  );
}

/** Lines shown per file before "+ N more". */
export const LINES_PER_FILE = 3;

type Row = { kind: 'line'; id: string; line: GuideHitLine } | { kind: 'more'; id: string; file: string; n: number };

function splitPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf('/');
  return i === -1 ? { name: path, dir: '' } : { name: path.slice(i + 1), dir: path.slice(0, i + 1) };
}

/** All Guide Files: the bar, then every match in the guide's files, by group. */
export function AllGuideFiles({
  groups,
  diff,
  onOpen,
  ...bar
}: SearchBarProps & {
  groups: readonly GroupView[];
  diff: BranchDiff;
  onOpen: (hit: GuideHit) => void;
}): ReactNode {
  const result = useMemo(() => searchGuide(groups, diff, bar.query), [groups, diff, bar.query]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  // The rows ↑↓ move through, in the order they are drawn.
  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const g of result.groups) {
      for (const f of g.files) {
        const fileId = `${g.key}\n${f.path}`;
        const open = expanded.has(fileId) || f.lines.length <= LINES_PER_FILE;
        const shown = open ? f.lines : f.lines.slice(0, LINES_PER_FILE);
        shown.forEach((line, i) => out.push({ kind: 'line', id: `${fileId}\n${i}`, line }));
        if (!open) out.push({ kind: 'more', id: `${fileId}\nmore`, file: fileId, n: f.lines.length - LINES_PER_FILE });
      }
    }
    return out;
  }, [result, expanded]);
  useEffect(() => setCursor(0), [bar.query]);
  const at = Math.min(cursor, Math.max(0, rows.length - 1));
  const optionId = (i: number) => `${listId}-${i}`;

  useEffect(() => {
    listRef.current?.querySelector(`[id="${optionId(at)}"]`)?.scrollIntoView?.({ block: 'nearest' });
  });

  const activate = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === 'more') setExpanded((s) => new Set(s).add(row.file));
    else onOpen(row.line.hits[0]!);
  };

  const count =
    bar.query === ''
      ? ''
      : result.total === 0
        ? 'No matches'
        : `${result.total.toLocaleString()}${result.capped ? '+' : ''} in ${result.files} ${result.files === 1 ? 'file' : 'files'}`;

  let index = 0;
  const option = (row: Row, body: ReactNode, className: string, label?: string) => {
    const i = index++;
    return (
      <div
        key={row.id}
        id={optionId(i)}
        role="option"
        aria-selected={i === at}
        aria-label={label}
        className={className}
        // The field keeps focus, so ↑↓ and ↩ go on working after a click.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setCursor(i);
          activate(row);
        }}
      >
        {body}
      </div>
    );
  };

  return (
    <div className="gd-search-all">
      <SearchBar
        {...bar}
        count={count}
        hint="↑↓ · ↩ opens"
        combobox={{ listId, active: rows.length > 0 ? optionId(at) : undefined }}
        onKeys={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setCursor(Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1))));
          } else if (e.key === 'Enter' && !e.metaKey && !e.altKey && !e.ctrlKey) {
            e.preventDefault();
            activate(rows[at]);
          }
        }}
      />
      <div className="gd-search-results" id={listId} role="listbox" aria-label="Matches in the guide’s files" ref={listRef}>
        {result.groups.map((g) => (
          <div key={g.key} role="group" aria-label={g.number ? `${g.number} ${g.title}` : g.title}>
            <div className="gd-search-group" role="presentation">
              {g.number ? `${g.number} · ` : ''}
              {g.title}
            </div>
            {g.files.map((f) => {
              const fileId = `${g.key}\n${f.path}`;
              const { name, dir } = splitPath(f.path);
              const matches = f.lines.reduce((n, l) => n + l.hits.length, 0);
              return (
                <div key={fileId} role="group" aria-label={f.path}>
                  <div className="gd-search-file" role="presentation" title={f.path}>
                    <span className="gd-search-file-name">{name}</span>
                    <span className="gd-search-file-dir">{dir}</span>
                    <span className="gd-search-file-count">{matches}</span>
                  </div>
                  {rows
                    .filter((r) => r.id.startsWith(`${fileId}\n`))
                    .map((r) =>
                      r.kind === 'line'
                        ? option(
                            r,
                            <>
                              <span className="gd-search-line">{r.line.line}</span>
                              <span className="gd-search-sign" aria-hidden="true">
                                {r.line.side === 'old' ? '−' : ''}
                              </span>
                              <span className="gd-search-text">
                                <MarkedLine line={r.line} />
                              </span>
                            </>,
                            'gd-search-hit',
                            `${r.line.side === 'old' ? 'Removed line' : 'Line'} ${r.line.line}: ${r.line.text.trim()}`,
                          )
                        : option(r, `+ ${r.n} more`, 'gd-search-more'),
                    )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
