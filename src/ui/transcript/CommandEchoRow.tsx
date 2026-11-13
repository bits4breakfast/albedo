/**
 * The echo of a command a button sent (#384): "You /model sonnet · from the
 * model picker · sending…", drawn like the message box's own echo until the
 * transcript has the command (commandEcho.ts).
 *
 * `/compact` runs until it has compacted, so under it a line counts up:
 * "Compacting context… 21s", with no limit of 30 s. Past its limit with
 * nothing in the transcript the row stays and says so, in the warning colour,
 * and where to look: Albedo never reads the terminal, so it cannot say more.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { formatDuration } from '../../lib/duration';
import type { CommandEcho } from './commandEcho';

/** What a row that had no reply says. */
export const NO_REPLY_TEXT = 'no reply from the session · see the terminal';

/** The words after the command: which button, then where it stands. */
export function commandEchoMeta(echo: Pick<CommandEcho, 'from' | 'compact' | 'noReply'>): string {
  const parts: string[] = [];
  if (echo.from !== null) parts.push(`from ${echo.from}`);
  if (echo.noReply) parts.push(NO_REPLY_TEXT);
  // A running /compact says so on its own line, with its clock.
  else if (!echo.compact) parts.push('sending…');
  return parts.join(' · ');
}

export function CommandEchoRow({ echo }: { echo: CommandEcho }): ReactNode {
  const running = echo.compact && !echo.noReply;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);
  const meta = commandEchoMeta(echo);
  return (
    <div className="tx-row tx-row-user tx-row-echo tx-row-command-echo" aria-live="polite">
      <div className="tx-gutter">You</div>
      <div className="tx-content">
        <span className="tx-echo-command">{echo.text}</span>
        {meta ? ' ' : null}
        {meta ? (
          <span className="tx-echo-meta" data-no-reply={echo.noReply || undefined}>
            {meta}
          </span>
        ) : null}
        {running ? (
          <div className="tx-working tx-echo-running" role="status">
            {/* The pane's one "something is happening" motion, as on the working line. */}
            <span className="tx-working-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span className="tx-working-label">Compacting context…</span>{' '}
            <span className="tx-working-time">{formatDuration(now - echo.at)}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
