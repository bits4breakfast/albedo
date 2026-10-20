/**
 * PanelToggle -- shows or hides the Files column, as one icon with two
 * states: an empty right panel when off, a filled one when on.
 *
 * It sits at the far right of whichever head is rightmost -- the transcript's
 * while Files is a tab, the column's own once it is pinned -- so it stays in
 * the corner as the column comes and goes. Same 28px square as every ⋯, so
 * the trailing edge of the rows above still lines up.
 */

import type { ReactNode } from 'react';

export interface PanelToggleProps {
  on: boolean;
  /** Pinned, but the window is too narrow for the column right now. */
  waiting?: boolean;
  onToggle: () => void;
}

export default function PanelToggle({ on, waiting = false, onToggle }: PanelToggleProps): ReactNode {
  const label = on ? 'Hide Files Column' : 'Show Files Column';
  return (
    <button
      type="button"
      className="icon-btn panel-toggle"
      aria-pressed={on}
      aria-label={label}
      title={
        waiting
          ? 'Files is pinned as a column, but there is no room at this width: a tab until there is'
          : on
            ? 'Put Files back in the tab strip'
            : 'Keep Files visible as a column beside the transcript, across restarts'
      }
      onClick={onToggle}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
        {on ? (
          <path d="M10 3.5h2a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-2z" fill="currentColor" />
        ) : (
          <path d="M10 3v10" stroke="currentColor" strokeWidth="1.5" />
        )}
      </svg>
    </button>
  );
}
