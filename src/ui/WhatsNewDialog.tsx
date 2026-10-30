/**
 * What's New (#147): the changes merged since the build last run here.
 *
 * The same modal shell as the other dialogs (`wt-modal`, worktree.css). One
 * line per change: the PR's title, and its number as a link to the PR. Done,
 * Escape and a click outside all dismiss -- and dismissing is what records
 * the build as seen (app/useWhatsNew.ts), so there is no second button.
 */

import { useEffect, useState } from 'react';
import { openExternal } from '../lib/openUrl';
import { prUrl, whatsNewSubtitle, type WhatsNewList } from './whatsNew';
import './worktree.css';
import './whatsNew.css';

export interface WhatsNewDialogProps {
  list: WhatsNewList;
  onClose: () => void;
}

export const WHATS_NEW_TITLE = "What's New";

export default function WhatsNewDialog({ list, onClose }: WhatsNewDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    // Capture, as the other dialogs: the editor closes its file on Escape
    // from a window listener of its own.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Give the keyboard back to wherever it was when the dialog appeared.
  const [from] = useState(() => document.activeElement);
  useEffect(() => {
    return () => {
      if (from instanceof HTMLElement && from.isConnected) from.focus();
    };
  }, [from]);

  return (
    <div
      className="wt-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="wt-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wn-title"
        aria-describedby="wn-sub"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="wt-modal-head wn-head">
          <h2 className="wt-modal-title" id="wn-title">
            {WHATS_NEW_TITLE}
          </h2>
          <span className="wt-modal-sub" id="wn-sub">
            {whatsNewSubtitle(list)}
          </span>
        </div>

        <div className="wt-modal-body wn-body">
          <ul className="wn-list">
            {list.changes.map((c) => {
              const url = prUrl(list.repo, c.pr);
              return (
                <li className="wn-item" key={c.sha}>
                  <span className="wn-subject">{c.subject}</span>
                  {c.pr !== null &&
                    (url ? (
                      <button
                        type="button"
                        className="wn-pr"
                        title={`Open #${c.pr} on GitHub`}
                        onClick={() => void openExternal(url)}
                      >
                        #{c.pr}
                      </button>
                    ) : (
                      <span className="wn-pr-plain">#{c.pr}</span>
                    ))}
                </li>
              );
            })}
          </ul>
          {list.dirty && <div className="wn-dirty">Plus uncommitted changes</div>}
        </div>

        <div className="wt-modal-foot">
          <span className="wt-foot-spacer" />
          <button type="button" className="btn btn-primary" onClick={onClose} autoFocus>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
