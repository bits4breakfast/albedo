/**
 * Subagents running in parallel under the selected task.
 *
 * When a session fans out, the parent transcript goes quiet: the `Task` chip
 * sits pending and nothing tells you whether three agents are working or one
 * is stuck on a permission prompt. This is the task list's question -- "which
 * one is waiting on me" -- one level down.
 *
 * Deliberately a strip, not a pane. It appears only while something is live
 * and takes no room at all otherwise: a permanently-present panel showing
 * "no subagents" would cost transcript height on every session that never
 * spawns one, which is most of them.
 *
 * Status is derived from transcript rows (`db/subagents.ts` -> `deriveStatus`),
 * never from the pty, exactly as the task list does it.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { listSubagents, liveRuns, type SubagentRun } from '../db/subagents';
import { onCaptureUpdate } from '../capture';
import StatusDot from './StatusDot';
import { relativeTime } from './TaskList';

/** Capture fires per batch of rows; coalesce bursts into one reload. */
const REFRESH_DEBOUNCE_MS = 300;
/** Re-render cadence for the "3m ago" label. Nothing is re-queried. */
const CLOCK_MS = 30_000;

export interface SubagentsProps {
  /** The parent session. Subagent rows are stored under it, keyed by agentId. */
  sessionId: string | null;
}

export default function Subagents({ sessionId }: SubagentsProps): ReactNode {
  const [runs, setRuns] = useState<SubagentRun[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(Date.now());
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (sessionId === null) {
      setRuns([]);
      return;
    }
    let cancelled = false;
    void listSubagents(sessionId)
      .then((next) => {
        if (!cancelled && alive.current) setRuns(next);
      })
      .catch(() => {
        // A half-built or failing db module degrades this to "no subagents
        // shown", never to a broken transcript pane.
        if (!cancelled && alive.current) setRuns([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, reloadKey]);

  useEffect(() => {
    if (sessionId === null) return;
    let timer = 0;
    const off = onCaptureUpdate((u) => {
      // Subagent rows are written under the PARENT's session id, so the
      // parent's own id is the right and only filter here.
      if (u.sessionId !== sessionId) return;
      if (timer !== 0) return;
      timer = window.setTimeout(() => {
        timer = 0;
        setReloadKey((k) => k + 1);
      }, REFRESH_DEBOUNCE_MS);
    });
    return () => {
      off();
      if (timer !== 0) window.clearTimeout(timer);
    };
  }, [sessionId]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(id);
  }, []);

  const live = liveRuns(runs);
  if (live.length === 0) return null;

  const blocked = live.filter((r) => r.status === 'blocked').length;

  return (
    <div className="sa-bar" role="group" aria-label="Subagents running in parallel">
      <span className="sa-lede">
        {live.length} agent{live.length === 1 ? '' : 's'}
        {blocked > 0 ? ` · ${blocked} waiting on you` : ''}
      </span>
      <ul className="sa-list">
        {live.map((run) => (
          <li className="sa-item" key={run.agentId} data-status={run.status}>
            <StatusDot status={run.status} />
            <span className="sa-label" title={run.label ?? run.agentId}>
              {run.label ?? run.agentId}
            </span>
            <span className="sa-meta">{relativeTime(run.lastTs, now)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
