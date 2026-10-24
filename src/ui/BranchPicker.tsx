/**
 * A branch field that searches: the New Task dialog's Base Branch and Branch
 * to Check Out. A repository can have 700+ refs; a native select cannot be
 * searched, and WebKit's datalist filters poorly.
 *
 * The field shows the chosen branch. Focus, a click or typing opens a list
 * under it: in `branchPickerModel.ts`'s order with nothing typed, ranked by the
 * fuzzy matcher once something is. ↑/↓ move, Enter picks, Esc puts back the
 * value the list opened on. Tab and blur keep what was typed only when it
 * names a listed branch.
 *
 * While the list is open, Enter and Esc are the list's: Enter never reaches
 * the dialog's submit, and the first Esc never closes the dialog.
 *
 * `freeText` (Branch to Check Out): every keystroke is the value, as before,
 * so a ref that is not listed yet can still be typed. Otherwise only a listed
 * branch can become the value.
 *
 * The WAI-ARIA combobox pattern, list autocomplete without automatic
 * selection: no row is highlighted until an arrow key moves to one.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BRANCH_LIMIT, filterBranches } from './branchPickerModel';
import { Highlighted } from './Highlighted';

export interface BranchPickerProps {
  id: string;
  value: string;
  /** Every branch offered, in the no-query order (`orderBranches`). */
  branches: readonly string[];
  /** A word shown beside a branch, saying why it sits where it does. */
  notes?: ReadonlyMap<string, string>;
  freeText?: boolean;
  disabled?: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
  /** Enter while the list is closed. */
  onEnter?: () => void;
}

/** Room between the field and the list, and the least kept from the window edge. */
const GAP = 4;
const EDGE = 12;
/** About eleven rows; the list scrolls past that. */
const MAX_HEIGHT = 320;
/** Below this much room under the field, open upwards if there is more above. */
const MIN_BELOW = 160;

interface Place {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

export function BranchPicker({
  id,
  value,
  branches,
  notes,
  freeText = false,
  disabled = false,
  placeholder,
  onChange,
  onEnter,
}: BranchPickerProps) {
  const [open, setOpen] = useState(false);
  /** What was typed since the list opened; null while nothing was. */
  const [draft, setDraft] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const [place, setPlace] = useState<Place | null>(null);
  /** The value the list opened on, for Esc. */
  const before = useRef(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const { rows, total } = useMemo(() => filterBranches(branches, draft ?? ''), [branches, draft]);
  const text = freeText ? value : (draft ?? value);
  const shown = open && !disabled;

  const close = useCallback(() => {
    setOpen(false);
    setDraft(null);
    setActive(-1);
  }, []);

  const show = () => {
    if (open || disabled) return;
    before.current = value;
    setDraft(null);
    // Start on the chosen branch, so the list opens where the user is.
    const at = branches.indexOf(value);
    setActive(at < BRANCH_LIMIT ? at : -1);
    setOpen(true);
  };

  const pick = (name: string) => {
    onChange(name);
    close();
  };

  // Branches being read again (after a fetch) disable the field: drop the list.
  useEffect(() => {
    if (disabled) close();
  }, [disabled, close]);

  // Fixed, so the dialog body's scrolling cannot clip it. The dialog's overlay
  // (inset 0) is its containing block, so window coordinates hold.
  useLayoutEffect(() => {
    if (!shown) return;
    const measure = (e?: Event) => {
      if (e && e.target === listRef.current) return;
      const r = inputRef.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom - GAP - EDGE;
      const above = r.top - GAP - EDGE;
      const up = below < MIN_BELOW && above > below;
      setPlace({
        left: r.left,
        width: r.width,
        ...(up ? { bottom: window.innerHeight - r.top + GAP } : { top: r.bottom + GAP }),
        maxHeight: Math.max(0, Math.min(MAX_HEIGHT, up ? above : below)),
      });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [shown]);

  // Keep the active row in view while arrowing.
  useEffect(() => {
    if (!shown) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [active, shown]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const last = rows.length - 1;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) show();
        else setActive((a) => (a >= last ? 0 : a + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) show();
        else setActive((a) => (a <= 0 ? Math.max(last, 0) : a - 1));
        break;
      case 'Enter': {
        if (!open) {
          onEnter?.();
          break;
        }
        // The list's Enter: never the dialog's submit, ⌘↩ included.
        e.preventDefault();
        e.stopPropagation();
        const row = rows[active];
        if (row) pick(row.name);
        else if (branches.includes(text)) pick(text);
        else if (freeText) close();
        // Nothing highlighted and nothing named: show what Enter would take.
        else if (rows.length > 0) setActive(0);
        break;
      }
      case 'Escape':
        if (!open) break;
        // One Esc, one thing: the list closes, the dialog stays.
        e.preventDefault();
        e.stopPropagation();
        if (freeText && value !== before.current) onChange(before.current);
        close();
        break;
      default:
        break;
    }
  };

  let status = '';
  if (rows.length === 0) {
    status =
      branches.length === 0
        ? 'No branches.'
        : freeText
          ? `No listed branch matches; Enter keeps “${text}”.`
          : `No branch matches “${draft ?? ''}”.`;
  } else if (total > rows.length) {
    status = `${(total - rows.length).toLocaleString()} more match; type to narrow.`;
  }

  return (
    <>
      <input
        ref={inputRef}
        id={id}
        className="wt-input wt-branch-input"
        type="text"
        role="combobox"
        aria-expanded={shown}
        aria-controls={shown ? listId : undefined}
        aria-activedescendant={shown && rows[active] ? `${listId}-${active}` : undefined}
        aria-autocomplete="list"
        value={text}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        disabled={disabled}
        onFocus={show}
        onClick={show}
        onChange={(e) => {
          const typed = freeText ? e.target.value.trim() : e.target.value;
          if (!open) {
            before.current = value;
            setOpen(true);
          }
          setDraft(typed);
          setActive(-1);
          if (freeText) onChange(typed);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (!open) return;
          // Only a listed branch is kept; anything else puts the value back.
          if (!freeText && draft !== null && branches.includes(draft)) onChange(draft);
          close();
        }}
      />
      {shown && (
        <div
          className="wt-branch-pop"
          style={place ?? undefined}
          // Keep focus in the field: a click on a row must not blur it first.
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="wt-branch-list" id={listId} role="listbox" aria-label="Branches" ref={listRef}>
            {rows.map((r, i) => (
              <div
                key={r.name}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                data-index={i}
                className="wt-branch-row"
                // Move, not enter: a list scrolling under a resting pointer
                // must not drag the highlight with it.
                onMouseMove={() => i !== active && setActive(i)}
                onClick={() => pick(r.name)}
              >
                <span className="wt-branch-name">
                  <Highlighted text={r.name} hits={r.hits} className="wt-branch-hit" />
                </span>
                {notes?.get(r.name) && <span className="wt-branch-note">{notes.get(r.name)}</span>}
              </div>
            ))}
          </div>
          {status && (
            <div className="wt-branch-foot" role="status">
              {status}
            </div>
          )}
        </div>
      )}
    </>
  );
}
