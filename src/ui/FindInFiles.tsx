/**
 * PhpStorm's Find in Files (⇧⌘F), scoped to the selected task's worktree.
 *
 * The engine and every pure decision -- argv, grouping, the cap, where the
 * match sits on the line -- are `src/git/findInFiles.ts`. This file is the
 * dialog and the keyboard, and it borrows Quick Open's: same overlay, same
 * input, same row grounds and the same keys, so the two read as one family.
 *
 * Searches run as you type, debounced. git cannot be stopped once spawned, so
 * a search the user has typed past is left to finish and its answer dropped:
 * only the newest search may write to the list.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { OpenFileRequest } from '../types';
import {
  displayLine,
  FIND_CAP,
  FIND_MIN_LENGTH,
  FindError,
  runFind,
  splitRuns,
  type FindMatch,
  type FindOptions,
  type FindResult,
} from '../git/findInFiles';
import './quickopen.css';
import './findinfiles.css';

export interface FindInFilesProps {
  open: boolean;
  /** The folder searched: the selected task's worktree, or a main checkout. */
  worktreePath: string | null;
  /**
   * Set when there is no task and the search runs in a project's main
   * checkout instead: named in the dialog so its results are never mistaken
   * for a task's branch.
   */
  scopeLabel?: string | null;
  onClose: () => void;
  onOpen: (request: OpenFileRequest) => void;
}

/** Long enough to skip the keystrokes of a word being typed, short enough to feel live. */
export const FIND_DEBOUNCE_MS = 200;

export function MatchText({ match }: { match: FindMatch }) {
  const { text, ranges } = displayLine(match);
  return (
    <>
      {splitRuns(text, ranges).map((run, i) =>
        run.hit ? (
          <mark className="qo-hit" key={i}>
            {run.text}
          </mark>
        ) : (
          run.text
        ),
      )}
    </>
  );
}

export default function FindInFiles({ open: openProp, worktreePath, scopeLabel = null, onClose, onOpen }: FindInFilesProps) {
  const open = openProp && worktreePath !== null;
  const [query, setQuery] = useState('');
  const [opts, setOpts] = useState<FindOptions>({ regex: false, matchCase: false });
  const [result, setResult] = useState<FindResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<Element | null>(null);
  /** Bumped by every search started; an answer for an older number is dropped. */
  const seq = useRef(0);
  const listId = useId();

  // A different worktree's hits mean nothing here.
  useEffect(() => {
    setResult(null);
    setError(null);
  }, [worktreePath]);

  // --- the search: debounced, newest wins ------------------------------------
  const trimmed = query.trim();
  const searchable = trimmed.length >= FIND_MIN_LENGTH;
  useEffect(() => {
    if (!open || worktreePath === null) return;
    const mine = ++seq.current;
    if (!searchable) {
      setResult(null);
      setError(null);
      setRunning(false);
      return;
    }
    setRunning(true);
    const timer = setTimeout(() => {
      // The raw query, not the trimmed one: a leading space can be the point.
      runFind(worktreePath, query, opts)
        .then((r) => {
          if (seq.current !== mine) return;
          setResult(r);
          setError(null);
          setActive(0);
        })
        .catch((err: unknown) => {
          if (seq.current !== mine) return;
          setResult(null);
          setError(err instanceof FindError ? `Invalid pattern: ${err.message}` : `Search failed: ${String(err)}`);
        })
        .finally(() => {
          if (seq.current === mine) setRunning(false);
        });
    }, FIND_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, worktreePath, query, opts, searchable]);

  // Closing abandons whatever is in flight.
  useEffect(() => {
    if (!open) seq.current++;
  }, [open]);

  // --- focus: take it on open, give it back on close -------------------------
  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement;
    // The last query is kept and selected, as in Quick Open: retype to replace
    // it, or arrow straight into the last results.
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => {
      const back = returnFocus.current;
      if (back instanceof HTMLElement && back.isConnected && document.activeElement === document.body) back.focus();
    };
  }, [open]);

  /** Every match in display order; the keyboard walks this, skipping headers. */
  const flat = useMemo(() => result?.groups.flatMap((g) => g.matches) ?? [], [result]);

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const choose = useCallback(
    (match: FindMatch | undefined) => {
      if (!match) return;
      onClose();
      onOpen({ path: match.path, line: match.line });
    },
    [onClose, onOpen],
  );

  if (!open) return null;

  const toggle = (key: keyof FindOptions) => setOpts((o) => ({ ...o, [key]: !o[key] }));

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // PhpStorm's ⌥C / ⌥X. Read from `code`: Option rewrites `key` (ç, ≈).
    if (e.altKey && !e.metaKey && !e.ctrlKey && (e.code === 'KeyC' || e.code === 'KeyX')) {
      e.preventDefault();
      toggle(e.code === 'KeyC' ? 'matchCase' : 'regex');
      return;
    }
    const last = flat.length - 1;
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
        choose(flat[active]);
        break;
      case 'Escape':
        // Stop here: the editor also closes on Escape, and one press should
        // dismiss one thing.
        e.preventDefault();
        e.stopPropagation();
        onClose();
        break;
      case 'Tab':
        // Keep focus inside the modal. The toggles have their own keys.
        e.preventDefault();
        break;
      default:
        break;
    }
  };

  let status: string;
  if (!searchable) status = `Type at least ${FIND_MIN_LENGTH} characters · tracked and untracked files`;
  else if (error) status = error;
  else if (!result) status = 'Searching…';
  else if (result.count === 0) status = `Nothing matches “${trimmed}”`;
  else {
    const files = result.groups.length;
    const where = `${files.toLocaleString()} ${files === 1 ? 'file' : 'files'}`;
    status = result.capped
      ? `First ${FIND_CAP} matches, in ${where} · narrow the search to see the rest`
      : `${result.count.toLocaleString()} ${result.count === 1 ? 'match' : 'matches'} in ${where}`;
  }
  if (result && running) status += ' · searching';

  let index = 0;
  return (
    <div className="qo-overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="qo-dialog ff-dialog" role="dialog" aria-modal="true" aria-label="Find in Files">
        <div className="ff-head">
          <span className="ff-title">Find in Files</span>
          <kbd className="qo-mode-keys">⇧⌘F</kbd>
        </div>

        {scopeLabel && <div className="qo-scope">Searching {scopeLabel}</div>}

        <div className="ff-bar">
          <input
            ref={inputRef}
            className="qo-input ff-input"
            type="text"
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls={listId}
            aria-activedescendant={flat[active] ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            aria-invalid={error !== null}
            placeholder={opts.regex ? 'Regular expression' : 'Text to find'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
          />
          <button
            type="button"
            className="ff-toggle"
            aria-pressed={opts.matchCase}
            title="Match case (⌥C)"
            tabIndex={-1}
            // Keep focus in the input; a click must not steal it.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggle('matchCase')}
          >
            Aa
          </button>
          <button
            type="button"
            className="ff-toggle"
            aria-pressed={opts.regex}
            title="Regex (⌥X)"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggle('regex')}
          >
            .*
          </button>
        </div>

        <div className="qo-list" id={listId} role="listbox" ref={listRef} aria-label="Matches">
          {result?.groups.map((group) => (
            <div key={group.path} role="group" aria-label={group.path}>
              <div className="ff-file" role="presentation">
                <span className="ff-path">
                  <bdi>{group.path}</bdi>
                </span>
                <span className="ff-count">{group.matches.length}</span>
              </div>
              {group.matches.map((match) => {
                const i = index++;
                return (
                  <div
                    key={`${match.path}:${match.line}`}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === active}
                    data-index={i}
                    className="qo-row ff-row"
                    onMouseMove={() => i !== active && setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(match)}
                  >
                    <span className="ff-line">{match.line}</span>
                    <span className="ff-text">
                      <MatchText match={match} />
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div className="qo-foot">
          <span className="qo-status" role="status" aria-live="polite">
            {status}
          </span>
          <span className="qo-hint">↑↓ Move · ↵ Open · ⌥C Case · ⌥X Regex · Esc Close</span>
        </div>
      </div>
    </div>
  );
}
