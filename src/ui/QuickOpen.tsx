/**
 * PhpStorm's Go to File / Class / Symbol and Search Everywhere, scoped to the
 * selected task's worktree.
 *
 * The index comes from git (`src/git/codeIndex.ts`) and is built lazily the
 * first time the palette opens for a worktree. A stale index is shown at once
 * while a fresh one builds behind it, so only the very first open of a
 * worktree ever says "indexing". Ranking is `quickOpenModel.ts`; this file is
 * the dialog and the keyboard.
 *
 * Opening a result goes through the app's one open-file entry point, with the
 * line, so the editor scrolls to and flashes the declaration.
 */

import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { OpenFileRequest } from '../types';
import { loadCodeIndex, peekCodeIndex, type CodeIndex } from '../git/codeIndex';
import { prepareIndex, search, type QuickOpenItem, type QuickOpenMode } from './quickOpenModel';
import './quickopen.css';

export interface QuickOpenProps {
  /** Null when closed. */
  mode: QuickOpenMode | null;
  /** The folder searched: the selected task's worktree, or a main checkout. */
  worktreePath: string | null;
  /**
   * Set when there is no task and the search runs in a project's main
   * checkout instead: named in the dialog so its results are never mistaken
   * for a task's branch.
   */
  scopeLabel?: string | null;
  /** The editor's file, worktree-relative, for "this file first". */
  currentFile: string | null;
  onMode: (mode: QuickOpenMode) => void;
  onClose: () => void;
  onOpen: (request: OpenFileRequest) => void;
}

const MODES: readonly { mode: QuickOpenMode; label: string; keys: string; placeholder: string }[] = [
  { mode: 'all', label: 'All', keys: '⇧⇧', placeholder: 'Search files and symbols' },
  { mode: 'file', label: 'Files', keys: '⇧⌘O', placeholder: 'File name, or a path with /; add :line to jump' },
  { mode: 'class', label: 'Classes', keys: '⌘O', placeholder: 'Class, interface, trait, enum or type' },
  { mode: 'symbol', label: 'Symbols', keys: '⌥⌘O', placeholder: 'Any class, function, method or constant' },
];

const KIND_LABEL: Record<QuickOpenItem['kind'], string> = {
  file: 'File',
  class: 'Class',
  interface: 'Interface',
  trait: 'Trait',
  enum: 'Enum',
  type: 'Type',
  function: 'Function',
  method: 'Method',
  const: 'Const',
};

/** Split `text` into runs, marking the characters at `hits`. */
function Highlighted({ text, hits }: { text: string; hits: number[] }) {
  if (hits.length === 0) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let at = 0;
  let i = 0;
  while (i < hits.length) {
    const start = hits[i]!;
    let end = start + 1;
    while (i + 1 < hits.length && hits[i + 1] === end) {
      i++;
      end++;
    }
    i++;
    if (start > at) out.push(text.slice(at, start));
    out.push(
      <mark className="qo-hit" key={start}>
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

export default function QuickOpen({ mode, worktreePath, scopeLabel = null, currentFile, onMode, onClose, onOpen }: QuickOpenProps) {
  const open = mode !== null && worktreePath !== null;
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [index, setIndex] = useState<CodeIndex | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<Element | null>(null);
  const listId = useId();

  // --- index: show what we have, refresh behind it --------------------------
  useEffect(() => {
    if (!open || worktreePath === null) return;
    let cancelled = false;
    setIndex(peekCodeIndex(worktreePath));
    setError(null);
    setLoading(true);
    loadCodeIndex(worktreePath)
      .then((fresh) => {
        if (!cancelled) setIndex(fresh);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, worktreePath]);

  // --- focus: take it on open, give it back on close -------------------------
  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement;
    // The last query is kept and selected, PhpStorm-style: retype to replace
    // it, or press Enter to repeat the last jump.
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => {
      const back = returnFocus.current;
      // Only if nothing else claimed focus meanwhile -- opening a result
      // focuses the editor, and that must win.
      if (back instanceof HTMLElement && back.isConnected && document.activeElement === document.body) back.focus();
    };
  }, [open]);

  // A new mode or query starts at the top.
  const deferredQuery = useDeferredValue(query);
  useEffect(() => setActive(0), [deferredQuery, mode]);

  const prepared = useMemo(() => (index ? prepareIndex(index) : null), [index]);
  const result = useMemo(
    () => (prepared && mode ? search(prepared, mode, deferredQuery, currentFile) : { items: [], total: 0 }),
    [prepared, mode, deferredQuery, currentFile],
  );
  const items = result.items;

  // Keep the active row in view while arrowing.
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const choose = useCallback(
    (item: QuickOpenItem | undefined) => {
      if (!item) return;
      onClose();
      onOpen({ path: item.file, line: item.line });
    },
    [onClose, onOpen],
  );

  if (!open || mode === null) return null;

  const meta = MODES.find((m) => m.mode === mode)!;

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const last = items.length - 1;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((a) => (a >= last ? 0 : a + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((a) => (a <= 0 ? Math.max(last, 0) : a - 1));
        break;
      case 'PageDown':
        e.preventDefault();
        setActive((a) => Math.min(a + 10, Math.max(last, 0)));
        break;
      case 'PageUp':
        e.preventDefault();
        setActive((a) => Math.max(a - 10, 0));
        break;
      case 'Enter':
        e.preventDefault();
        choose(items[active]);
        break;
      case 'Escape':
        // Stop here: the editor also closes on Escape, and one press should
        // dismiss one thing.
        e.preventDefault();
        e.stopPropagation();
        onClose();
        break;
      case 'Tab': {
        // Tab walks the modes, as in PhpStorm's Search Everywhere. It also
        // keeps focus inside the dialog, which is the other thing Tab must do
        // in a modal.
        e.preventDefault();
        const at = MODES.findIndex((m) => m.mode === mode);
        const next = MODES[(at + (e.shiftKey ? MODES.length - 1 : 1)) % MODES.length]!;
        onMode(next.mode);
        break;
      }
      default:
        break;
    }
  };

  const trimmed = deferredQuery.trim();
  let status: string;
  if (error && !index) status = `Could not index this worktree: ${error}`;
  else if (!index) status = 'Indexing…';
  else if (trimmed === '' && items.length === 0)
    status =
      mode === 'file'
        ? `Type to search ${index.files.length.toLocaleString()} files`
        : `Type to search ${index.symbols.length.toLocaleString()} symbols`;
  else if (items.length === 0) status = `Nothing matches “${trimmed}”`;
  else if (result.total > items.length) status = `${items.length} of ${result.total.toLocaleString()}`;
  else status = `${items.length}`;
  if (index && loading) status += ' · refreshing';

  return (
    <div className="qo-overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="qo-dialog" role="dialog" aria-modal="true" aria-label={`Go to: ${meta.label}`}>
        <div className="qo-modes" role="tablist" aria-label="Search scope">
          {MODES.map((m) => (
            <button
              key={m.mode}
              type="button"
              role="tab"
              className="qo-mode"
              aria-selected={m.mode === mode}
              tabIndex={-1}
              // Keep focus in the input; a click must not steal it.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onMode(m.mode)}
            >
              {m.label}
              <kbd className="qo-mode-keys">{m.keys}</kbd>
            </button>
          ))}
        </div>

        {scopeLabel && <div className="qo-scope">Searching {scopeLabel}</div>}

        <input
          ref={inputRef}
          className="qo-input"
          type="text"
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls={listId}
          aria-activedescendant={items[active] ? `${listId}-${active}` : undefined}
          aria-autocomplete="list"
          placeholder={meta.placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
        />

        <div className="qo-list" id={listId} role="listbox" ref={listRef} aria-label="Results">
          {items.map((item, i) => (
            <div
              key={item.key}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              data-index={i}
              className="qo-row"
              // Move, not enter: a list scrolling under a resting pointer must
              // not drag the selection with it.
              onMouseMove={() => i !== active && setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(item)}
            >
              <span className="qo-kind">{KIND_LABEL[item.kind]}</span>
              <span className="qo-name">
                <Highlighted text={item.name} hits={item.nameHits} />
              </span>
              <span className="qo-where">
                <bdi>
                  {item.current ? (
                    'This File'
                  ) : (
                    <Highlighted text={item.path} hits={item.pathHits} />
                  )}
                  {item.line !== null && <span className="qo-line">:{item.line}</span>}
                </bdi>
              </span>
            </div>
          ))}
        </div>

        <div className="qo-foot">
          <span className="qo-status" role="status" aria-live="polite">
            {status}
          </span>
          <span className="qo-hint">↑↓ Move · ↵ Open · ⇥ Scope · Esc Close</span>
        </div>
      </div>
    </div>
  );
}
