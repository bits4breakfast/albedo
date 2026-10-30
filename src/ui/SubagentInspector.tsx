/**
 * One subagent's own transcript, read in place of the parent's.
 *
 * The strip says THAT an agent is running; this says what it is doing. It is
 * the same read pane as TranscriptPane -- rows out of SQLite, the same
 * MessageRow components, a window anchored at the end that follows the tail
 * while you are at the bottom -- scoped to `session_id = parent AND agent_id =
 * this agent`.
 *
 * Read-only on purpose. Claude Code gives a subagent no input of its own: the
 * only pty is the parent's, and anything typed there goes to the parent. A
 * composer here would look like it talks to the agent and would not.
 *
 * Laid over the parent's pane (see subagents.css) rather than swapped for it,
 * so "back" returns to the parent exactly as it was left.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Message } from '../types';
import type { SubagentRun } from '../db/subagents';
import { getMessages } from '../db';
import { onCaptureUpdate } from '../capture';
import StatusDot from './StatusDot';
import MessageRow from './transcript/MessageRow';
import CompactionRow from './transcript/CompactionRow';
import { groupRows } from './transcript/TranscriptPane';
import { agentLabel, agentState, agentStatusDetail, agentStatusWord, elapsedMs, formatElapsed } from './subagentView';

/** Rows in the initial window, and the size of each step backwards. */
const PAGE = 200;
/** Capture fires per batch of rows; coalesce bursts into one read. */
const TAIL_DEBOUNCE_MS = 120;
/** Rows read per tail update; a full page is drained by another read. */
const TAIL_LIMIT = 500;
/** Distance from the bottom that still counts as "following". */
const STICK_PX = 56;

export interface SubagentInspectorProps {
  /** The PARENT session: subagent rows are stored under it. */
  sessionId: string;
  run: SubagentRun;
  taskTitle: string | null;
  /** The strip's clock, so both elapsed readouts tick together. */
  now: number;
  onBack: () => void;
}

export default function SubagentInspector({
  sessionId,
  run,
  taskTitle,
  now,
  onBack,
}: SubagentInspectorProps): ReactNode {
  const agentId = run.agentId;
  const [messages, setMessages] = useState<Message[]>([]);
  const [limit, setLimit] = useState(PAGE);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [following, setFollowing] = useState(true);

  const rootRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const anchorRef = useRef<{ height: number; top: number } | null>(null);
  const pendingScrollRef = useRef<'bottom' | 'anchor' | null>('bottom');
  const lastSeqRef = useRef<number | null>(null);

  // Focus moves into the inspector, so Esc and the arrow keys act on it and a
  // screen reader announces where you are.
  useEffect(() => {
    backRef.current?.focus();
  }, []);

  // --- window load (initial, and every step backwards) ----------------------
  useEffect(() => {
    let live = true;
    setLoading(true);
    void getMessages({ sessionId, agentId, limit })
      .then((rows) => {
        if (!live) return;
        if (pendingScrollRef.current !== 'anchor') pendingScrollRef.current = 'bottom';
        setMessages(rows);
        setHasMore(rows.length >= limit);
        setError(null);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [sessionId, agentId, limit]);

  // One agent is one transcript file, so its seqs are a single consistent
  // order and the highest one is simply the cursor.
  useEffect(() => {
    let max: number | null = null;
    for (const m of messages) if (max === null || m.seq > max) max = m.seq;
    lastSeqRef.current = max;
  }, [messages]);

  // --- tail follow ----------------------------------------------------------
  useEffect(() => {
    let live = true;
    let timer = 0;

    const fetchTail = () => {
      const after = lastSeqRef.current;
      const page =
        after === null
          ? getMessages({ sessionId, agentId, limit: PAGE })
          : getMessages({ sessionId, agentId, afterSeq: after, limit: TAIL_LIMIT });
      void page
        .then((rows) => {
          if (!live || rows.length === 0) return;
          const lastRow = rows[rows.length - 1];
          if (lastRow) lastSeqRef.current = lastRow.seq;
          setMessages((prev) => {
            const seen = new Set(prev.map((m) => m.id));
            const fresh = rows.filter((r) => !seen.has(r.id));
            if (fresh.length === 0) return prev;
            if (followingRef.current) pendingScrollRef.current = 'bottom';
            return [...prev, ...fresh];
          });
          if (after !== null && rows.length >= TAIL_LIMIT && timer === 0) {
            timer = window.setTimeout(() => {
              timer = 0;
              if (live) fetchTail();
            }, 0);
          }
        })
        .catch(() => {
          /* the watcher may be mid-write; the next update retries */
        });
    };

    const off = onCaptureUpdate((u) => {
      // Parent and every sibling agent share this session id; the query is
      // what narrows it to this agent, so an update for a sibling costs one
      // empty read and nothing else.
      if (u.sessionId !== sessionId) return;
      if (timer !== 0) return;
      timer = window.setTimeout(() => {
        timer = 0;
        if (live) fetchTail();
      }, TAIL_DEBOUNCE_MS);
    });

    return () => {
      live = false;
      off();
      if (timer !== 0) window.clearTimeout(timer);
    };
  }, [sessionId, agentId]);

  // --- scrolling ------------------------------------------------------------
  const loadOlder = useCallback(() => {
    const el = scrollRef.current;
    if (el) anchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
    pendingScrollRef.current = 'anchor';
    setLimit((l) => l + PAGE);
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    if (atBottom !== followingRef.current) {
      followingRef.current = atBottom;
      setFollowing(atBottom);
    }
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const mode = pendingScrollRef.current;
    if (mode === 'bottom') {
      el.scrollTop = el.scrollHeight;
      pendingScrollRef.current = null;
    } else if (mode === 'anchor') {
      const anchor = anchorRef.current;
      if (anchor) el.scrollTop = el.scrollHeight - anchor.height + anchor.top;
      anchorRef.current = null;
      pendingScrollRef.current = null;
    }
  }, [messages]);

  const jumpToEnd = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    followingRef.current = true;
    setFollowing(true);
  }, []);

  // --- Esc goes back ---------------------------------------------------------
  /*
     A window listener, not onKeyDown on the inspector: after a click on bare
     transcript text focus is on <body>, and Esc should still work. Guarded so
     it never takes Esc from something that owns it -- an open dialog, the
     terminal (xterm reads keys from a textarea), the composer or the editor --
     and only while this inspector is actually on screen (the transcript tab
     can be hidden behind another tab with the inspector still open).
  */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const root = rootRef.current;
      if (!root || root.offsetParent === null) return;
      if (document.querySelector('[aria-modal="true"]') !== null) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && !root.contains(active)) {
        if (active.isContentEditable || active.tagName === 'TEXTAREA' || active.tagName === 'INPUT') return;
      }
      e.preventDefault();
      onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  // Every row is sidechain here, so nothing folds. Memoised as elements so the
  // once-a-second clock in the header does not re-render the whole transcript.
  const rows = useMemo(
    () =>
      groupRows(messages, { foldSidechains: false }).map((item) =>
        item.kind === 'row' ? (
          <MessageRow key={item.key} message={item.message} result={item.result} extras={item.extras} />
        ) : item.kind === 'compaction' ? (
          <CompactionRow key={item.key} compaction={item.compaction} />
        ) : null,
      ),
    [messages],
  );

  const label = agentLabel(run);
  const parent = taskTitle && taskTitle.trim().length > 0 ? taskTitle : 'Task';

  return (
    <div className="sa-inspector" ref={rootRef} role="region" aria-label={`Subagent: ${label}`}>
      <div className="sa-inspector-head">
        <button
          type="button"
          ref={backRef}
          className="sa-back"
          onClick={onBack}
          title="Back to the task transcript (Esc)"
        >
          <span aria-hidden="true">←</span> Back to {parent}
        </button>
        <div className="sa-inspector-title" title={label}>
          {label}
        </div>
        <div className="sa-inspector-meta">
          <span className="sa-status" data-status={run.status} data-state={agentState(run)} title={agentStatusDetail(run)}>
            <StatusDot status={run.status} />
            <span className="sa-status-word">{agentStatusWord(run)}</span>
          </span>
          <span className="sa-elapsed">{formatElapsed(elapsedMs(run, now))}</span>
          <span className="sa-readonly">Read-only · the agent reports back to {parent}</span>
        </div>
      </div>

      <div className="tx-pane sa-inspector-pane">
        <div className="tx-scroll" ref={scrollRef} onScroll={onScroll}>
          {hasMore ? (
            <div className="tx-page-top">
              <button type="button" className="tx-btn" onClick={loadOlder} disabled={loading}>
                {loading ? 'Loading…' : 'Load Earlier Messages'}
              </button>
            </div>
          ) : messages.length > 0 ? (
            <div className="tx-page-top tx-page-start">Start of This Agent’s Run</div>
          ) : null}

          {error ? <div className="tx-error">Could not read this agent’s transcript: {error}</div> : null}

          {messages.length === 0 && !loading && !error ? (
            <div className="tx-pane-empty">This agent has not written anything yet</div>
          ) : null}

          {rows}
        </div>

        {!following ? (
          <button type="button" className="tx-jump" onClick={jumpToEnd}>
            ↓ Latest
          </button>
        ) : null}
      </div>
    </div>
  );
}
