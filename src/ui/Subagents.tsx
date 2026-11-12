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
 * ## Rows, not chips
 *
 * It was one line of chips, each label cut at a fixed width. That was easy to
 * miss and said almost nothing: "Review the backend…" is not what an agent is
 * doing. Each agent is now its own row -- status mark and word, two lines,
 * elapsed time -- like a list in a macOS sidebar, and past COLLAPSE_AFTER
 * agents the strip folds to one summary line so it can never take over the
 * transcript.
 *
 * The two lines are the terminal's (#377): the agent's name -- the short
 * description its `Agent` call gave it, with its type beside it -- and what it
 * is doing now, its newest tool call. Each is cut with an ellipsis, never
 * wrapped, so every row is exactly two lines. The first two lines of its
 * prompt, which this showed before, were mostly setup ("Fix GitHub issue …
 * Your worktree: …"); the prompt stays one hover away.
 *
 * ## The inspector
 *
 * Clicking a row opens that agent's own transcript over the parent's, in the
 * same tab. It is laid OVER the transcript pane rather than replacing it in
 * the tree, so going back lands exactly where you were reading -- scroll
 * position, loaded history and a half-written message in the composer all
 * survive. See SubagentInspector.tsx.
 *
 * Status is derived from transcript rows (`db/subagents.ts` -> `deriveStatus`),
 * never from the pty, exactly as the task list does it -- and settled by the
 * parent's notification that the agent stopped. One that stopped with its own
 * background work still running reads "In Background" (#139): listed after
 * the live rows while the strip is open, never opening it, never counted as
 * running, and timed by its last run, not counting up.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { listSubagents, type SubagentRun } from '../db/subagents';
import { onCaptureUpdate } from '../capture';
import StatusDot from './StatusDot';
import SubagentInspector from './SubagentInspector';
import {
  agentActivity,
  agentLabel,
  agentTokens,
  agentState,
  agentStatusDetail,
  agentStatusWord,
  elapsedMs,
  formatElapsed,
  nextExpiry,
  agentTitle,
  shouldCollapse,
  spokenElapsed,
  STARTING,
  stripRuns,
  stripSummary,
} from './subagentView';
import './subagents.css';

/** Capture fires per batch of rows; coalesce bursts into one reload. */
const REFRESH_DEBOUNCE_MS = 300;
/**
 * Re-render cadence for the elapsed clocks. Nothing is re-queried. Only runs
 * while there is a clock on screen.
 */
const CLOCK_MS = 1_000;

export interface SubagentsProps {
  /** The parent session. Subagent rows are stored under it, keyed by agentId. */
  sessionId: string | null;
  /** The parent task's title, for the inspector's way back. */
  taskTitle?: string | null;
}

export default function Subagents({ sessionId, taskTitle = null }: SubagentsProps): ReactNode {
  const [runs, setRuns] = useState<SubagentRun[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [expanded, setExpanded] = useState(false);
  /** The agent being inspected. A snapshot, so it survives the run going quiet. */
  const [inspecting, setInspecting] = useState<SubagentRun | null>(null);
  const alive = useRef(true);
  const stripRef = useRef<HTMLDivElement>(null);

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
    void listSubagents(sessionId, { detail: true })
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

  const { live, waiting } = stripRuns(runs);
  const ticking = live.length > 0 || inspecting !== null;

  // A status read from a recency window goes stale with no new row: an agent
  // whose last line was a tool result reads Running until the window closes,
  // and nothing else re-asks (#139). Re-read when the earliest one closes.
  const expiry = nextExpiry(runs);
  useEffect(() => {
    if (expiry === null) return;
    const id = window.setTimeout(() => setReloadKey((k) => k + 1), Math.max(0, expiry - Date.now()) + 50);
    return () => window.clearTimeout(id);
  }, [expiry]);

  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(id);
  }, [ticking]);

  // The parent session changed under us (fork, resume): the agent belongs to
  // the old one, so there is nothing left to inspect.
  useEffect(() => {
    setInspecting(null);
  }, [sessionId]);

  const back = useCallback(() => {
    const agentId = inspecting?.agentId ?? null;
    setInspecting(null);
    // Return focus to the row that opened it, if it is still there, so the
    // keyboard picks up where it left off.
    window.requestAnimationFrame(() => {
      if (agentId === null) return;
      const row = stripRef.current?.querySelector<HTMLButtonElement>(
        `button[data-agent-id="${CSS.escape(agentId)}"]`,
      );
      row?.focus();
    });
  }, [inspecting]);

  // The inspector reads the freshest copy of its run, falling back to the
  // snapshot once the run drops out of the list.
  const inspected = inspecting ? (runs.find((r) => r.agentId === inspecting.agentId) ?? inspecting) : null;

  const collapsible = shouldCollapse(live.length);
  const showAll = !collapsible || expanded;
  // Collapsed, a blocked agent still gets its row: it is the one that will sit
  // there until somebody acts, which is the whole point of the strip. Agents
  // waiting on their own background work come after the live ones.
  const shown = showAll ? [...live, ...waiting] : live.filter((r) => r.status === 'blocked');

  const strip =
    live.length === 0 ? null : (
      <div className="sa-bar" ref={stripRef} role="group" aria-label="Subagents running in parallel">
        <div className="sa-head">
          <span className="sa-lede">{stripSummary(live, waiting.length)}</span>
          {collapsible ? (
            <button
              type="button"
              className="sa-toggle"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? 'Show Less' : 'Show All'}
            </button>
          ) : null}
        </div>
        {shown.length > 0 ? (
          <ul className="sa-list">
            {shown.map((run) => {
              const title = agentTitle(run);
              const activity = agentActivity(run);
              const ms = elapsedMs(run, now);
              const state = agentState(run);
              const atWork = state === 'running' || state === 'blocked';
              const named = [title, run.kind, activity].filter((s) => s !== null && s !== '').join(', ');
              const tokens = agentTokens(run);
              return (
                <li key={run.agentId}>
                  <button
                    type="button"
                    className="sa-row"
                    data-status={run.status}
                    data-state={state}
                    data-agent-id={run.agentId}
                    aria-current={inspecting?.agentId === run.agentId ? 'true' : undefined}
                    aria-label={`${named}. ${
                      atWork
                        ? `${agentStatusWord(run)} for ${spokenElapsed(ms)}`
                        : `${agentStatusDetail(run)}. Its last run took ${spokenElapsed(ms)}`
                    }${tokens === null ? '' : `, ${tokens}`}. Open its transcript.`}
                    // The whole prompt, for when the name is not enough.
                    title={run.prompt ?? agentLabel(run)}
                    onClick={() => setInspecting(run)}
                  >
                    <span className="sa-status" title={agentStatusDetail(run)}>
                      <StatusDot status={run.status} />
                      <span className="sa-status-word">{agentStatusWord(run)}</span>
                    </span>
                    <span className="sa-main">
                      <span className="sa-title">
                        <span className="sa-name">{title}</span>
                        {run.kind !== null ? <span className="sa-kind">{run.kind}</span> : null}
                      </span>
                      <span className="sa-now" data-starting={activity === STARTING ? 'true' : undefined}>
                        {activity}
                      </span>
                    </span>
                    <span className="sa-elapsed sa-meter">
                      <span className="sa-clock">{formatElapsed(ms)}</span>
                      {tokens !== null ? (
                        <>
                          <span className="sa-meter-sep"> · </span>
                          <span className="sa-tokens">{tokens}</span>
                        </>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    );

  return (
    <>
      {strip}
      {inspected !== null && sessionId !== null ? (
        <SubagentInspector
          key={inspected.agentId}
          sessionId={sessionId}
          run={inspected}
          taskTitle={taskTitle}
          now={now}
          onBack={back}
        />
      ) : null}
    </>
  );
}
