/**
 * The message box's collapsed pastes, made visible (#134).
 *
 * The box shows a paste as `[Pasted text #1 +42 lines]` (pastedText.ts). A
 * textarea holds text only, so the controls for it sit in a row under the
 * text, inside the box: one chip per paste the draft still uses, each with
 * View and Remove. View opens the inspector -- the whole paste in monospace,
 * scrollable, with Remove and Insert as Text. Escape closes it and puts focus
 * back on the View that opened it.
 *
 * The keyboard path: Tab from the text goes to the first chip's View, on
 * through the chips' buttons, then to the next area (the terminal); Shift+Tab
 * walks back to the text. The buttons are `data-focus-stop`s of the message
 * box's area (focusAreas.ts), as is the textarea.
 *
 * This component only shows and asks. Changing the draft is the composer's,
 * which edits the textarea so ⌘Z can take a removal back.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { lineCount } from './pastedText';
import '../worktree.css';

export interface PastedTextsProps {
  /** The pastes the draft uses, in order (`pastesIn`). */
  pastes: ReadonlyMap<number, string>;
  /** A send is pending: the draft is frozen, so only View is offered. */
  frozen: boolean;
  /** Take the paste and its token out of the draft. */
  onRemove: (id: number) => void;
  /** Put the paste's text where its token was, as ordinary text. */
  onInsert: (id: number) => void;
}

function linesLabel(text: string): string {
  const n = lineCount(text);
  return `${n.toLocaleString()} line${n === 1 ? '' : 's'}`;
}

export function PastedTexts({ pastes, frozen, onRemove, onInsert }: PastedTextsProps): ReactNode {
  const [viewing, setViewing] = useState<number | null>(null);
  const viewButtons = useRef(new Map<number, HTMLButtonElement>());
  const shown = viewing === null ? undefined : pastes.get(viewing);
  // The paste went while it was open (undo, an edit to its token): nothing to show.
  useEffect(() => {
    if (viewing !== null && shown === undefined) setViewing(null);
  }, [viewing, shown]);

  if (pastes.size === 0) return null;

  const close = () => {
    const id = viewing;
    setViewing(null);
    if (id !== null) requestAnimationFrame(() => viewButtons.current.get(id)?.focus());
  };

  return (
    <>
      <div className="tx-pastes" role="group" aria-label="Pasted text">
        {[...pastes].map(([id, text]) => (
          <span key={id} className="tx-paste" title={`Pasted text #${id} · ${text.length.toLocaleString()} characters`}>
            <span className="tx-paste-label">
              Pasted #{id} · {linesLabel(text)}
            </span>
            <button
              type="button"
              className="tx-paste-act"
              ref={(el) => {
                if (el) viewButtons.current.set(id, el);
                else viewButtons.current.delete(id);
              }}
              onClick={() => setViewing(id)}
              data-focus-stop=""
              aria-label={`View pasted text #${id}`}
            >
              View
            </button>
            <button
              type="button"
              className="tx-paste-act"
              onClick={() => onRemove(id)}
              disabled={frozen}
              data-focus-stop=""
              aria-label={`Remove pasted text #${id}`}
            >
              Remove
            </button>
          </span>
        ))}
      </div>
      {viewing !== null && shown !== undefined ? (
        <PasteInspector
          id={viewing}
          text={shown}
          frozen={frozen}
          onClose={close}
          onRemove={() => {
            setViewing(null);
            onRemove(viewing);
          }}
          onInsert={() => {
            setViewing(null);
            onInsert(viewing);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * One paste, whole. The text is focused when it opens, so the arrow keys and
 * Page Up/Down scroll it at once; Escape or a click outside closes it.
 * Editing in place is not offered: Insert as Text puts it in the box, where
 * it is edited like anything else.
 */
function PasteInspector({
  id,
  text,
  frozen,
  onClose,
  onRemove,
  onInsert,
}: {
  id: number;
  text: string;
  frozen: boolean;
  onClose: () => void;
  onRemove: () => void;
  onInsert: () => void;
}): ReactNode {
  const titleId = `tx-paste-title-${id}`;
  // React's autoFocus reaches form controls only; the text is a <pre>.
  const textRef = useRef<HTMLPreElement>(null);
  useEffect(() => textRef.current?.focus(), [id]);
  return (
    <div className="wt-overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="wt-modal"
        data-wide="true"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }}
      >
        <div className="wt-modal-head">
          <h2 className="wt-modal-title" id={titleId}>
            Pasted Text #{id}
          </h2>
          <span className="wt-modal-sub">
            {linesLabel(text)} · {text.length.toLocaleString()} characters
          </span>
        </div>
        <div className="wt-modal-body">
          <pre className="tx-pre tx-paste-view" tabIndex={0} aria-label={`Pasted text #${id}`} ref={textRef}>
            {text}
          </pre>
        </div>
        <div className="wt-modal-foot">
          <button type="button" className="btn" onClick={onRemove} disabled={frozen}>
            Remove
          </button>
          <span className="wt-foot-spacer" />
          <button type="button" className="btn" onClick={onInsert} disabled={frozen} title="Put the whole text in the message box in place of its token">
            Insert as Text
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
