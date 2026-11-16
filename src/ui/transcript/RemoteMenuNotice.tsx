/**
 * "Claude Code is showing Remote Control's menu in the terminal" (#343).
 *
 * `/remote-control` on a session where Remote Control is already on opens a
 * menu in the terminal and waits; nothing reaches the transcript or the hook
 * events meanwhile. remoteWait.ts judges that it is up -- the command went,
 * and four seconds on neither Remote Control came on nor the session moved
 * on -- and this says so above the message box, where the stuck session was
 * otherwise silent. It is a guess from what was not written, so it says
 * "probably", and Dismiss takes it away for a menu answered with nothing
 * written after it (Continue, Esc).
 *
 * The frame is the "waiting on you" card's (PromptCard, TrustCard): it is
 * a question only the terminal can answer, like the trust dialog's. No
 * surface or colour of its own.
 */

import type { ReactNode } from 'react';
import { dismissRemoteWait, useRemoteWait } from '../remoteWait';
import './promptCard.css';

/** The question, then what it probably means: as the trust card splits them. */
export const REMOTE_MENU_TEXT = 'Claude Code is showing Remote Control’s menu in the terminal.';
export const REMOTE_MENU_NOTE = 'Remote Control is probably already on. Answer it there.';
/** The Queued band's hint while the menu is up: nothing it holds goes before it is answered. */
export const REMOTE_MENU_HINT = 'waiting on Remote Control\u2019s menu in the terminal';

export function RemoteMenuNotice({
  taskId,
  onShowTerminal,
}: {
  taskId: number;
  /** Shows the terminal (Split from Transcript only) and focuses it: App's "answer in terminal". */
  onShowTerminal: ((taskId: number) => void) | undefined;
}): ReactNode {
  const wait = useRemoteWait(taskId);
  if (wait?.phase !== 'menu') return null;
  return (
    <div className="tx-prompt rc-menu" role="status" aria-label="Waiting on You">
      <div className="tx-prompt-head">
        <span className="tx-prompt-tag">
          <span className="status-dot" data-status="blocked" aria-hidden="true" />
          Waiting on You
        </span>
        {onShowTerminal ? (
          <button type="button" className="btn btn-primary" onClick={() => onShowTerminal(taskId)}>
            Show Terminal
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost"
          title="Hide this: the menu was answered in the terminal"
          onClick={() => dismissRemoteWait(taskId)}
        >
          Dismiss
        </button>
      </div>
      <div className="tx-prompt-q">{REMOTE_MENU_TEXT}</div>
      <div className="pc-note">{REMOTE_MENU_NOTE}</div>
    </div>
  );
}
