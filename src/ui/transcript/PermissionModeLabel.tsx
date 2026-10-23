/**
 * The session's permission mode, beside the composer's +: whether Claude will
 * ask, plan or act before you send. Read only -- changing it from here would
 * mean sending ⇧⇥ blind, not knowing the mode it starts from.
 *
 * The mode is the one recorded with the last prompt sent (see
 * src/capture/permissionMode.ts), so it can trail a ⇧⇥ by one message, and
 * the tooltip says so. Unknown -- a session that has sent nothing yet -- shows
 * nothing rather than a guess.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { loadPermissionMode, onPermissionModeChange, permissionModeFor, type PermissionMode } from '../../capture';

/**
 * `quiet` is the composer's neutral text tier. Plan and bypass stand apart:
 * plan because Claude will not act, bypass because nothing will be asked.
 */
export type PermissionModeTone = 'quiet' | 'plan' | 'bypass';

export interface PermissionModeView {
  text: string;
  /** What the mode means, for the tooltip. */
  meaning: string;
  tone: PermissionModeTone;
}

const VIEWS: Readonly<Record<PermissionMode, PermissionModeView>> = {
  default: { text: 'Ask', meaning: 'Claude asks before it edits files or runs commands.', tone: 'quiet' },
  auto: { text: 'Auto', meaning: 'Claude runs most actions without asking; a safety check stops risky ones.', tone: 'quiet' },
  plan: { text: 'Plan', meaning: 'Claude explores and proposes a plan, and changes nothing until you approve it.', tone: 'plan' },
  acceptEdits: { text: 'Accept Edits', meaning: 'File edits are applied without asking; commands still ask.', tone: 'quiet' },
  bypassPermissions: { text: 'Bypass', meaning: 'Nothing is asked: every action runs.', tone: 'bypass' },
  dontAsk: { text: "Don't Ask", meaning: 'Nothing is asked: anything not already allowed is refused.', tone: 'quiet' },
};

/** The label for a mode, or null when the mode is unknown. */
export function permissionModeView(mode: PermissionMode | null): PermissionModeView | null {
  return mode === null ? null : VIEWS[mode];
}

/** The tooltip: what the mode means, how to change it, and how fresh it is. */
export function permissionModeTitle(view: PermissionModeView): string {
  return `${view.text}: ${view.meaning}\nSwitch with ⇧⇥ in the terminal. Read from the last message sent, so a switch shows here with the next one.`;
}

export function PermissionModeLabel({ sessionId }: { sessionId: string | null }): ReactNode {
  const [mode, setMode] = useState<PermissionMode | null>(() => (sessionId ? permissionModeFor(sessionId) : null));

  useEffect(() => {
    if (sessionId === null) {
      setMode(null);
      return;
    }
    setMode(permissionModeFor(sessionId));
    const off = onPermissionModeChange((sid) => {
      if (sid === sessionId) setMode(permissionModeFor(sessionId));
    });
    void loadPermissionMode(sessionId);
    return off;
  }, [sessionId]);

  const view = permissionModeView(mode);
  if (view === null) return null;
  return (
    <span className="tx-permission-mode" data-tone={view.tone} title={permissionModeTitle(view)}>
      {view.text}
    </span>
  );
}
