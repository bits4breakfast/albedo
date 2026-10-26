/**
 * The list behind ⌘B, ⌥F7 and ⌥⌘B when there is more than one place to go:
 * usages of a class, several declarations of a name, or the implementations
 * of a type.
 *
 * Find in Files' dialog without the input -- same overlay, rows and keys -- so
 * a list of usages reads as the same family as a list of text matches. Focus
 * sits on the list itself; Escape closes this and nothing else.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FindMatch, FindResult } from '../../git/findInFiles';
import { FIND_CAP } from '../../git/findInFiles';
import { MatchText } from '../FindInFiles';
import '../quickopen.css';
import '../findinfiles.css';

/**
 * `note`, when set, is a line under the title saying what the search could
 * not see -- shown with an empty answer too, where it matters most.
 */
export type SymbolResultsState =
  | { kind: 'loading'; title: string }
  | { kind: 'list'; title: string; result: FindResult; note?: string }
  | { kind: 'message'; title: string; message: string; note?: string };

export interface SymbolResultsProps {
  state: SymbolResultsState | null;
  onClose: () => void;
  onOpen: (match: FindMatch) => void;
}

export default function SymbolResults({ state, onClose, onOpen }: SymbolResultsProps) {
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const result = state?.kind === 'list' ? state.result : null;
  const flat = useMemo(() => result?.groups.flatMap((g) => g.matches) ?? [], [result]);

  useEffect(() => setActive(0), [result]);
  useEffect(() => {
    if (state) listRef.current?.focus();
  }, [state]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  if (!state) return null;

  const choose = (match: FindMatch | undefined) => {
    if (match) onOpen(match);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
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
        // Stop here: the editor closes on Escape too, and one press should
        // dismiss one thing.
        e.preventDefault();
        e.stopPropagation();
        onClose();
        break;
      case 'Tab':
        e.preventDefault();
        break;
      default:
        break;
    }
  };

  let status: string;
  if (state.kind === 'loading') status = 'Searching…';
  else if (state.kind === 'message') status = state.message;
  else {
    const files = state.result.groups.length;
    const where = `${files.toLocaleString()} ${files === 1 ? 'file' : 'files'}`;
    status = state.result.capped
      ? `First ${FIND_CAP} results, in ${where}`
      : `${state.result.count.toLocaleString()} ${state.result.count === 1 ? 'result' : 'results'} in ${where}`;
  }

  const note = state.kind === 'loading' ? undefined : state.note;
  let index = 0;
  return (
    <div className="qo-overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="qo-dialog ff-dialog" role="dialog" aria-modal="true" aria-label={state.title}>
        <div className="ff-head">
          <span className="ff-title">{state.title}</span>
        </div>
        {note && (
          <div className="qo-scope" title={note}>
            {note}
          </div>
        )}

        <div
          className="qo-list"
          id={listId}
          role="listbox"
          ref={listRef}
          tabIndex={0}
          aria-label="Results"
          aria-activedescendant={flat[active] ? `${listId}-${active}` : undefined}
          onKeyDown={onKeyDown}
        >
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
          <span className="qo-hint">↑↓ Move · ↵ Open · Esc Close</span>
        </div>
      </div>
    </div>
  );
}
