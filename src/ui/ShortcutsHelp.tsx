/**
 * The keymap, rendered from `SHORTCUTS`.
 *
 * Reads the exported table rather than carrying a list of its own, so a binding
 * added to the keymap appears here without anyone remembering to.
 */

import { useEffect } from 'react';
import { SHORTCUTS } from './shortcuts';
import './worktree.css';

export interface ShortcutsHelpProps {
  open: boolean;
  onClose: () => void;
}

export default function ShortcutsHelp({ open, onClose }: ShortcutsHelpProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="wt-overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="wt-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="wt-modal-head">
          <h2 className="wt-modal-title" id="shortcuts-title">
            Keyboard Shortcuts
          </h2>
        </div>
        <div className="wt-modal-body">
          <dl className="shortcuts-list">
            {SHORTCUTS.map((s) => (
              <div className="shortcuts-row" key={s.combo}>
                <dt>
                  <kbd>{s.keys}</kbd>
                </dt>
                <dd>{s.description}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="wt-modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
