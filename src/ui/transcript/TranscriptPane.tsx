/**
 * The read pane.
 *
 * Reads rows out of SQLite -- never the pty. A long session is tens of
 * thousands of rows, so the pane holds a window anchored at the *end* of the
 * transcript and grows it backwards when the user scrolls up. New rows are
 * appended and followed only while the viewport is already at the bottom;
 * scrolling up to read is never interrupted.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Message } from '../../types';
import { getMessages } from '../../db';
import { onCaptureUpdate } from '../../capture';
import MessageRow from './MessageRow';
import { isSidechain, toolUseId } from './ToolChip';
import './transcript.css';

/** Rows in the initial window, and the size of each step backwards. */
const PAGE = 200;
/** Capture fires per batch of rows; coalesce bursts into one read. */
const TAIL_DEBOUNCE_MS = 120;
/** Rows read per tail update; a full page is drained by another read. */
const TAIL_LIMIT = 500;
/** Distance from the bottom that still counts as "following". */
const STICK_PX = 56;
/** Distance from the top that triggers loading the previous page. */
const LOAD_PX = 160;

export interface TranscriptPaneProps {
  taskId: number | null;
  sessionId: string | null;
}

export function TranscriptPane({ taskId, sessionId }: TranscriptPaneProps): ReactNode {
  const [messages, setMessages] = useState<Message[]>([]);
  const [limit, setLimit] = useState(PAGE);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [following, setFollowing] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  /** Scroll anchor captured before a backwards page is applied. */
  const anchorRef = useRef<{ height: number; top: number } | null>(null);
  const pendingScrollRef = useRef<'bottom' | 'anchor' | null>('bottom');

  const selectorKey = `${taskId ?? ''}|${sessionId ?? ''}`;

  // Reset everything when the pane is pointed at a different session.
  useEffect(() => {
    setMessages([]);
    setLimit(PAGE);
    setReloadKey(0);
    setHasMore(false);
    setError(null);
    followingRef.current = true;
    setFollowing(true);
    pendingScrollRef.current = 'bottom';
  }, [selectorKey]);

  /*
     Window query. `taskId` alone is not merely sufficient, it is strictly more
     correct: a task that continued one session and later forked has rows under
     two session ids, and only the task-scoped query returns the whole story of
     that task, ordered by ts. Conjoining both silently truncates the history at
     the fork -- and, for a resumed pre-Albedo session whose rows predate the
     task, returned nothing at all.

     `sessionId` keeps its place for the taskId === null case: browsing a
     session no task has adopted.
  */
  const query = useMemo(() => {
    const q: { taskId?: number; sessionId?: string } = {};
    if (taskId !== null) q.taskId = taskId;
    else if (sessionId !== null) q.sessionId = sessionId;
    return q;
  }, [taskId, sessionId]);

  /*
     The tail is read session-scoped even when the window above is task-scoped,
     and that is not an inconsistency.

     `seq` is `lineIndex * 100 + blockIndex` within ONE transcript file, so it
     restarts at a fork. `afterSeq` therefore only means anything inside a
     single session -- which is precisely what `messageOrderKeys` encodes when
     it switches to seq-ordering only for a sessionId-without-taskId query. Ask
     for the tail task-scoped after a fork and `seq > lastSeq` reads as a filter
     against the OLD session's numbering: the page fills with already-held rows
     from before the fork and the new ones never arrive.

     Nothing is lost by scoping it: new rows only ever land in the session the
     task currently points at.
  */
  const tailQuery = useMemo(() => {
    if (sessionId !== null) return { sessionId };
    if (taskId !== null) return { taskId };
    return null;
  }, [taskId, sessionId]);

  const inactive = taskId === null && sessionId === null;

  // --- window load (initial, and every step backwards) ----------------------
  useEffect(() => {
    if (inactive) return;
    let live = true;
    setLoading(true);
    void getMessages({ ...query, limit })
      .then((rows) => {
        if (!live) return;
        // A backwards page restores the anchor; anything else lands at the end.
        if (pendingScrollRef.current !== 'anchor') pendingScrollRef.current = 'bottom';
        setMessages(rows);
        // `limit` keeps the most recent rows, so a full page means there is more
        // history behind it.
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
  }, [query, limit, inactive, reloadKey]);

  // --- tail follow ----------------------------------------------------------
  // Driven by the capture watcher rather than a timer: rows land, we read the
  // new tail. Held in a ref so a new row does not re-subscribe.
  // Highest seq *within the tail's scope* -- not simply the last row, which
  // after a fork belongs to the new session while older rows carry higher seqs.
  const lastSeqRef = useRef<number | null>(null);
  useEffect(() => {
    let max: number | null = null;
    for (const m of messages) {
      if (sessionId !== null && m.sessionId !== sessionId) continue;
      if (max === null || m.seq > max) max = m.seq;
    }
    lastSeqRef.current = max;
  }, [messages, sessionId]);

  useEffect(() => {
    if (inactive || tailQuery === null) return;
    let live = true;
    let timer = 0;

    const fetchTail = () => {
      const after = lastSeqRef.current;
      if (after === null) {
        // No rows in scope yet -- a session that has only just started writing,
        // or the first rows after a fork. Re-run the window query rather than
        // page forward from nowhere; it self-corrects on the next update.
        setReloadKey((k) => k + 1);
        return;
      }
      void getMessages({ ...tailQuery, afterSeq: after, limit: TAIL_LIMIT })
        .then((rows) => {
          if (!live || rows.length === 0) return;
          // With `afterSeq` set, `limit` keeps the OLDEST rows after it, so
          // consecutive pages abut: appending can never leave a hole.
          // Advance the cursor here so a drain pass cannot re-read this page.
          const lastRow = rows[rows.length - 1];
          if (lastRow) lastSeqRef.current = lastRow.seq;
          setMessages((prev) => {
            const seen = new Set(prev.map((m) => m.id));
            const fresh = rows.filter((r) => !seen.has(r.id));
            if (fresh.length === 0) return prev;
            if (followingRef.current) pendingScrollRef.current = 'bottom';
            return [...prev, ...fresh];
          });
          // A full page means capture wrote more than one page since the last
          // update; keep draining rather than sitting on it until the next one.
          if (rows.length >= TAIL_LIMIT && timer === 0) {
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
      if (sessionId !== null && u.sessionId !== sessionId) return;
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
  }, [tailQuery, inactive, sessionId]);

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
    if (el.scrollTop < LOAD_PX && hasMore && !loading) loadOlder();
  }, [hasMore, loading, loadOlder]);

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

  const items = useMemo(() => groupRows(messages), [messages]);

  if (inactive) {
    return <div className="tx-pane tx-pane-empty">No session selected</div>;
  }

  return (
    <div className="tx-pane">
      <div className="tx-scroll" ref={scrollRef} onScroll={onScroll}>
        {hasMore ? (
          <div className="tx-page-top">
            <button type="button" className="tx-btn" onClick={loadOlder} disabled={loading}>
              {loading ? 'loading…' : 'Load earlier messages'}
            </button>
          </div>
        ) : messages.length > 0 ? (
          <div className="tx-page-top tx-page-start">start of session</div>
        ) : null}

        {error ? <div className="tx-error">Could not read the transcript: {error}</div> : null}

        {messages.length === 0 && !loading && !error ? (
          <div className="tx-pane-empty">Nothing recorded for this session yet</div>
        ) : null}

        {items.map((item) =>
          item.kind === 'sidechain' ? (
            <SidechainGroup key={item.key} rows={item.rows} results={item.results} />
          ) : (
            <MessageRow key={item.key} message={item.message} result={item.result} />
          ),
        )}
      </div>

      {!following ? (
        <button type="button" className="tx-jump" onClick={jumpToEnd}>
          ↓ latest
        </button>
      ) : null}
    </div>
  );
}

export default TranscriptPane;

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

type Item =
  | { kind: 'row'; key: string; message: Message; result: Message | null }
  | { kind: 'sidechain'; key: string; rows: Message[]; results: Map<number, Message | null> };

/**
 * Pair each `tool_use` with its `tool_result`, and fold runs of sidechain rows
 * into a single collapsible group. Subagent traffic is noise until you go
 * looking for it.
 */
function groupRows(messages: readonly Message[]): Item[] {
  const resultByCallId = new Map<string, Message>();
  for (const m of messages) {
    if (m.role !== 'tool_result') continue;
    const id = toolUseId(m);
    if (id) resultByCallId.set(id, m);
  }

  const consumed = new Set<number>();
  for (const m of messages) {
    if (m.role !== 'tool_use') continue;
    const id = toolUseId(m);
    if (!id) continue;
    const result = resultByCallId.get(id);
    if (result) consumed.add(result.id);
  }

  const resultFor = (m: Message): Message | null => {
    if (m.role !== 'tool_use') return null;
    const id = toolUseId(m);
    return id ? (resultByCallId.get(id) ?? null) : null;
  };

  const items: Item[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (!m) break;
    if (isSidechain(m)) {
      const rows: Message[] = [];
      const results = new Map<number, Message | null>();
      while (i < messages.length) {
        const s = messages[i];
        if (!s || !isSidechain(s)) break;
        if (!consumed.has(s.id)) {
          rows.push(s);
          results.set(s.id, resultFor(s));
        }
        i++;
      }
      if (rows.length > 0) items.push({ kind: 'sidechain', key: `sc-${rows[0]?.id ?? i}`, rows, results });
      continue;
    }
    if (!consumed.has(m.id)) {
      items.push({ kind: 'row', key: `m-${m.id}`, message: m, result: resultFor(m) });
    }
    i++;
  }
  return items;
}

function SidechainGroup({
  rows,
  results,
}: {
  rows: readonly Message[];
  results: Map<number, Message | null>;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const tools = rows.filter((r) => r.role === 'tool_use').length;
  return (
    <div className={`tx-row tx-row-sidechain ${open ? 'tx-sidechain-open' : ''}`}>
      <div className="tx-gutter" />
      <div className="tx-content">
        <button type="button" className="tx-sidechain-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? '▾' : '▸'} subagent · {rows.length} row{rows.length === 1 ? '' : 's'}
          {tools > 0 ? ` · ${tools} tool call${tools === 1 ? '' : 's'}` : ''}
        </button>
        {open ? (
          <div className="tx-sidechain-body">
            {rows.map((r) => (
              <MessageRow key={r.id} message={r} result={results.get(r.id) ?? null} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
