/**
 * The read pane.
 *
 * Reads rows out of SQLite -- never the pty. A long session is tens of
 * thousands of rows, so the pane holds a window anchored at the *end* of the
 * transcript and grows it backwards when the user scrolls up. New rows are
 * appended and followed only while the viewport is already at the bottom;
 * scrolling up to read is never interrupted.
 */

import { expandPastes, placeholderFor, queuedLabel, shouldCollapse } from './pastedText';
import { onComposerInsert, onAttachRequest } from './composerBridge';
import OverlayScrollbar from './OverlayScrollbar';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { SEQ_STRIDE } from '../../capture';
import { imageSourceNote, isImagePlaceholder } from './envelopes';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent, ReactNode } from 'react';
import type { Message, TaskStatus } from '../../types';
import { getMessages } from '../../db';
import { onCaptureUpdate, onQueueChange, queuedFor, type QueuedEntry } from '../../capture';
import { canResume, hasLivePty, onPtyPresenceChange, startPty, submitPty } from '../Terminal';
import { imageFromClipboard, keepDroppedFile, savePastedImage, withInsertedPath } from '../../lib/pasteImage';
import { Disclosure } from './Diff';
import { MemoMessageRow as MessageRow } from './MessageRow';
import PromptCard from './PromptCard';
import { PermissionModeLabel } from './PermissionModeLabel';
import { isSidechain, toolUseId } from './ToolChip';
import { KEYS, readPersisted, writePersisted, type Codec } from '../persisted';
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
  /**
   * Derived task status, forwarded to the composer so it can tell a session
   * that is thinking from one that is waiting on a permission prompt. Optional:
   * without it the composer behaves exactly as it did before.
   */
  status?: TaskStatus | null;
  /**
   * Take the user to the terminal, where the waiting prompt is answered.
   * Absent: the card still shows what is being asked, without the button.
   */
  onAnswerInTerminal?: (taskId: number) => void;
  /**
   * Drawn beside Send: the model picker. The model applies to the next
   * message, so it belongs with the message, not up in the task bar.
   */
  composerAccessory?: ReactNode;
}

export function TranscriptPane({
  taskId,
  sessionId,
  status = null,
  onAnswerInTerminal,
  composerAccessory,
}: TranscriptPaneProps): ReactNode {
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
  /**
   * Set when the backwards page has actually been applied. Until then a
   * pending 'anchor' belongs to it alone: a tail row landing first must not
   * consume the anchor, or the page arrives with nothing to restore and the
   * window load sends the reader to the bottom.
   */
  const pageAppliedRef = useRef(false);

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
        // A backwards page restores the anchor. Anything else lands at the end
        // only for a reader who is following: someone reading further up keeps
        // their place, whatever caused the reload.
        if (pendingScrollRef.current === 'anchor') pageAppliedRef.current = true;
        else pendingScrollRef.current = followingRef.current ? 'bottom' : null;
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
    pageAppliedRef.current = false;
    setLimit((l) => l + PAGE);
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    // Hidden (another tab is showing): there is no position to read.
    if (!el || el.clientHeight === 0) return;
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
    } else if (mode === 'anchor' && pageAppliedRef.current) {
      // Measured from the bottom, so rows appended since the anchor was taken
      // would skew it -- but no tail row can arrive between the page landing
      // and this effect, which runs in the same commit.
      const anchor = anchorRef.current;
      if (anchor) el.scrollTop = el.scrollHeight - anchor.height + anchor.top;
      anchorRef.current = null;
      pendingScrollRef.current = null;
      pageAppliedRef.current = false;
    }
  }, [messages]);

  const jumpToEnd = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    followingRef.current = true;
    setFollowing(true);
  }, []);

  // Back on screen, or resized: a reader who was following stays at the end.
  // While the pane is hidden (another tab showing) new rows still arrive, but
  // scrolling a hidden element does nothing, so they piled up below the old
  // position and the pane came back short of the bottom. Its own size going
  // from nothing to something is the moment it is shown again.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // Whether the reader was following when the pane went away. Read at the
    // moment it hides, because a scroll event on the way back in can report
    // "not at the bottom" (the rows that arrived meanwhile) before this runs.
    let followingWhenHidden: boolean | null = null;
    const ro = new ResizeObserver(() => {
      if (el.clientHeight === 0) {
        followingWhenHidden ??= followingRef.current;
        return;
      }
      const follow = followingWhenHidden ?? followingRef.current;
      followingWhenHidden = null;
      if (!follow) return;
      el.scrollTop = el.scrollHeight;
      followingRef.current = true;
      setFollowing(true);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [inactive]);

  // ⌘↓: to the latest message, without having to click into the transcript
  // first. It acts only when the keyboard is not busy elsewhere: nothing
  // focused, or focus inside the transcript but not in a text field. In the
  // composer, the editor, the terminal or any other field, ⌘↓ keeps its own
  // meaning (end of text) and this stays out of the way.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.ctrlKey || e.shiftKey || e.key !== 'ArrowDown') return;
      const el = scrollRef.current;
      // Not on screen: another tab, or the pane is hidden.
      if (!el || el.offsetParent === null) return;
      if (!keyboardIsFree(document.activeElement, el)) return;
      e.preventDefault();
      jumpToEnd();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [jumpToEnd]);

  const items = useMemo(() => groupRows(messages), [messages]);

  /*
     Between Send and anything on screen there is a gap: Claude Code writes
     your message to the transcript a moment after it takes it, and its reply
     only once the reply is complete. Two cues fill it, both from Albedo's own
     state and the transcript, never from the terminal: your message shown at
     once, marked as sending, until the transcript has it (or, sent during a
     turn, until Claude Code's queue does); and a "Working" line while the
     task runs, timed from the latest activity.
  */
  const [echo, setEcho] = useState<{ text: string; at: number } | null>(null);
  useEffect(() => setEcho(null), [taskId]);
  useEffect(() => {
    if (!echo) return;
    // Clock skew between this machine's two clocks is nil, but a second of
    // slack keeps a row written in the same instant from being missed.
    if (messages.some((m) => m.role === 'user' && m.agentId === null && m.ts >= echo.at - 1000)) setEcho(null);
  }, [messages, echo]);
  useEffect(() => {
    if (!echo) return;
    const t = window.setTimeout(() => setEcho(null), ECHO_MAX_MS);
    return () => window.clearTimeout(t);
  }, [echo]);
  // Sent during a turn, it is not a user row yet but a queue entry, and the
  // Queued band shows it from then on: one place, not two. The band's
  // listener and this one run in the same queue notification, so React
  // batches both into one commit: the echo goes in the frame the band
  // arrives, never a frame with both or neither. The scroller shrinking by
  // the band's height keeps a following reader at the end (the
  // ResizeObserver above), so the transcript does not jump.
  useEffect(() => {
    if (!echo || sessionId === null) return;
    const check = () => {
      if (echoIsQueued(echo, queuedFor(sessionId), status)) setEcho(null);
    };
    check();
    return onQueueChange((sid) => {
      if (sid === sessionId) check();
    });
  }, [echo, sessionId, status]);
  const working = status === 'running' || echo !== null;
  const lastTs = messages.length > 0 ? (messages[messages.length - 1] as Message).ts : 0;
  const since = Math.max(lastTs, echo?.at ?? 0);
  const onSent = useCallback(
    (body: string) => {
      setEcho({ text: body, at: Date.now() });
      jumpToEnd();
    },
    [jumpToEnd],
  );

  if (inactive) {
    return <div className="tx-pane tx-pane-empty">Select a task to read its transcript</div>;
  }

  return (
    <div className="tx-pane">
      {/* The jump button is positioned against this wrapper, not the pane, so
          it sits at the foot of the transcript and never over the composer. */}
      <div className="tx-scroll-wrap">
        <OverlayScrollbar target={scrollRef} />
        <div className="tx-scroll" ref={scrollRef} onScroll={onScroll}>
          {hasMore ? (
            <div className="tx-page-top">
              <button type="button" className="tx-btn" onClick={loadOlder} disabled={loading}>
                {loading ? 'Loading…' : 'Load Earlier Messages'}
              </button>
            </div>
          ) : messages.length > 0 ? (
            <div className="tx-page-top tx-page-start">Start of Conversation</div>
          ) : null}

          {error ? <div className="tx-error">Could not read the transcript: {error}</div> : null}

          {messages.length === 0 && !loading && !error ? (
            <div className="tx-pane-empty">No messages in this conversation yet</div>
          ) : null}

          {items.map((item) =>
            item.kind === 'sidechain' ? (
              <SidechainGroup key={item.key} rows={item.rows} results={item.results} />
            ) : (
              <MessageRow key={item.key} message={item.message} result={item.result} extras={item.extras} />
            ),
          )}

          {echo ? (
            <div className="tx-row tx-row-user tx-row-echo" aria-live="polite">
              <div className="tx-gutter">You</div>
              <div className="tx-content">
                <div className="tx-echo-text">{echo.text}</div>
              </div>
            </div>
          ) : null}
          {/* A running turn is what is working, whatever was just sent. */}
          {working ? <WorkingLine since={since} sending={echo !== null && status !== 'running'} /> : null}
        </div>

        {!following ? (
          <button type="button" className="tx-jump" onClick={jumpToEnd} title="Jump to the latest message (⌘↓)">
            ↓ Latest <kbd className="tx-jump-key">⌘↓</kbd>
          </button>
        ) : null}
      </div>

      <QueuedStrip sessionId={sessionId} status={status} />
      {taskId !== null ? <PromptCard taskId={taskId} onAnswerInTerminal={onAnswerInTerminal} /> : null}
      {taskId !== null ? <Composer taskId={taskId} sessionId={sessionId} status={status} onSent={onSent} accessory={composerAccessory} /> : null}
    </div>
  );
}

export default TranscriptPane;

/** How long a sent message waits to appear in the transcript before its echo goes. */
const ECHO_MAX_MS = 30_000;

/**
 * Whether the Queued band is on screen for a session in this status. Only
 * while a turn is live: a queue cannot be waiting in an idle session, so
 * anything left at idle is what a killed session never took.
 */
export function queueShows(status: TaskStatus | null): boolean {
  return status === 'running' || status === 'blocked';
}

/**
 * Whether the Queued band now shows the message just sent: it is showing at
 * all (`queueShows`), and it holds an entry you typed (not one Claude Code
 * queued itself), queued no earlier than the send, with the same second of
 * slack as the user-row check. A status still `idle` while the entry waits --
 * the turn just ended and the next has not started, or the status refresh
 * lags the queue -- keeps the echo: the band is hidden then, and the message
 * would be nowhere.
 *
 * Time, not text: the queue records what Claude Code made of the input -- a
 * pasted image becomes `[Image #1]` where Albedo sent a file path -- and
 * while the echo is up the composer is the only thing sending.
 */
export function echoIsQueued(
  echo: { at: number },
  entries: readonly QueuedEntry[],
  status: TaskStatus | null,
): boolean {
  return queueShows(status) && entries.some((e) => !e.injected && e.ts >= echo.at - 1000);
}

/** "Working · 14s", ticking: the session is busy and has not written yet. */
export function WorkingLine({ since, sending }: { since: number; sending: boolean }): ReactNode {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const s = Math.max(0, Math.round((now - since) / 1000));
  const elapsed = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  // A row like every other, so it starts in the text column, not the gutter.
  return (
    <div className="tx-row tx-row-working">
      <div className="tx-gutter" />
      <div className="tx-content tx-working" role="status">
        <span className="tx-working-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        {sending ? 'Sending' : 'Working'}
        {/* Read aloud as two words; between flex items it draws nothing. */}{' '}
        {since > 0 ? <span className="tx-working-time">· {elapsed}</span> : null}
      </div>
    </div>
  );
}

/**
 * Whether a key can be taken without stealing it from something focused:
 * nothing has focus (the window itself), or focus is inside `scroller` on an
 * element that is not a text field.
 */
export function keyboardIsFree(active: Element | null, scroller: Element): boolean {
  if (active === null || active === document.body || active === document.documentElement) return true;
  if (!scroller.contains(active)) return false;
  const editable =
    (active instanceof HTMLElement && active.isContentEditable) ||
    active.tagName === 'INPUT' ||
    active.tagName === 'TEXTAREA' ||
    active.tagName === 'SELECT';
  return !editable;
}

// ---------------------------------------------------------------------------
// Queued messages
// ---------------------------------------------------------------------------

/**
 * What you sent while Claude Code was busy and it has not taken yet, read
 * from the transcript's queue records (src/capture/queue.ts). Each entry
 * leaves the moment Claude Code takes it, either as the next turn or folded
 * into the one running -- and then appears in the transcript as your message.
 *
 * Only while a turn is live (`queueShows`): showing what a killed session
 * never took would claim it is still coming. Entries Claude Code queued
 * itself (a background task finishing, a subagent's message) are not shown.
 */
export function QueuedStrip({ sessionId, status }: { sessionId: string | null; status: TaskStatus | null }): ReactNode {
  const [entries, setEntries] = useState<readonly QueuedEntry[]>(() => (sessionId ? queuedFor(sessionId) : []));
  useEffect(() => {
    if (sessionId === null) {
      setEntries([]);
      return;
    }
    setEntries([...queuedFor(sessionId)]);
    return onQueueChange((sid) => {
      if (sid === sessionId) setEntries([...queuedFor(sessionId)]);
    });
  }, [sessionId]);

  const mine = entries.filter((e) => !e.injected);
  if (!queueShows(status) || mine.length === 0) return null;
  return (
    <div className="tx-queued" role="status" aria-label="Queued messages">
      <div className="tx-queued-head">
        Queued <span className="tx-queued-count">{mine.length}</span>
        <span className="tx-queued-hint">sent when Claude Code finishes its current step</span>
      </div>
      {mine.map((e, i) => (
        <div key={`${e.ts}-${i}`} className="tx-queued-item" title={e.text}>
          {queuedLabel(e.text)}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

/** Auto-grow ceiling. Past this the composer scrolls instead of eating the pane. */
const COMPOSER_MAX_PX = 140;

/** Smallest a dragged composer can be: one line of text. */
const COMPOSER_MIN_PX = 28;

/** Whole pixels; auto-grow (null) removes the key. */
const composerPxCodec: Codec<number | null> = {
  decode: (raw) => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= COMPOSER_MIN_PX ? n : null;
  },
  encode: (px) => (px === null ? null : String(Math.round(px))),
};

/** The height the user dragged it to, or null for auto-grow. Never throws. */
function storedComposerPx(): number | null {
  return readPersisted(KEYS.composerPx, composerPxCodec, null);
}

/** Storage unavailable: the height just is not remembered. */
function storeComposerPx(px: number | null): void {
  writePersisted(KEYS.composerPx, composerPxCodec, px);
}

/** How long to wait for a session that `startPty` said was on its way. */
const START_TIMEOUT_MS = 12_000;

/**
 * Send a message without switching panes.
 *
 * The architecture is unchanged: the pty still executes, this is only a better
 * input affordance than walking over to the terminal. The transcript stays the
 * read surface, so this is a foot -- one line tall until there is something to
 * say, and absent entirely when no task is selected.
 *
 * ## When there is no live session
 *
 * Selecting a task mounts its Terminal, so the usual reason liveness is false
 * is not "no terminal" but "the pty exited" -- the session ended, or a resume
 * was rejected. `startPty` brings one back in place, without switching panes or
 * stealing focus, so the send becomes: try, start, retry.
 *
 * Exported for its tests: the retry below is the only untestable-by-inspection
 * part of this pane, and reaching it through `<TranscriptPane>` would mean
 * mocking the db and capture layers to assert nothing about them.
 *
 * ## When the session is on a permission prompt
 *
 * `submitPty` types into the pty. If Claude Code is showing a permission
 * prompt it is asking "1 / 2 / 3", and a paragraph pasted into that is an
 * answer to the prompt, not a message -- the one case where sending does
 * something the user did not mean. A task that is merely `running` is fine:
 * Claude Code queues typed input itself, which is the normal way to follow up
 * mid-turn and is left alone.
 *
 * So `blocked` holds the message instead of sending it, and releases it when
 * the status clears. The text stays visible in the box the whole time, frozen
 * rather than hidden, so nothing fires from a place the user cannot see.
 *
 * That retry is the only new control flow here, and it is arranged to be
 * exactly-once. The pending body lives in a ref that is TAKEN synchronously
 * before the retry fires, so a presence event that arrives twice finds nothing
 * the second time; an in-flight ref (not state, which updates too late) blocks
 * a second Enter in the same tick; and the textarea is disabled while a send is
 * pending so the draft cannot drift underneath it. Every failure path leaves
 * the text exactly where the user typed it.
 */
export function Composer({
  taskId,
  onSent,
  status = null,
  accessory,
  sessionId = null,
}: {
  taskId: number;
  /** Called with what Claude Code was sent. */
  onSent: (body: string) => void;
  status?: TaskStatus | null;
  /** Beside Send (the model picker). */
  accessory?: ReactNode;
  /** The task's session, for the permission mode beside +. */
  sessionId?: string | null;
}): ReactNode {
  const [text, setText] = useState('');
  /** Large text pastes kept aside; the draft holds their placeholders. */
  const pastesRef = useRef(new Map<number, string>());
  const pasteSeqRef = useRef(0);
  const [busy, setBusy] = useState(false);
  const [awaiting, setAwaiting] = useState(false);
  /** Held because the session is on a permission prompt. See `send`. */
  const [held, setHeld] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  /** Files are being dragged over the window. */
  const [dropping, setDropping] = useState(false);

  const ref = useRef<HTMLTextAreaElement>(null);
  /** The body waiting for a session. Taken, not read, so it can only fire once. */
  const pendingRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const timerRef = useRef(0);

  /**
   * A height the user dragged the composer to. While set it is the height --
   * typing no longer auto-grows it -- and double-clicking the grip clears it.
   */
  const [userPx, setUserPx] = useState<number | null>(storedComposerPx);
  const userPxRef = useRef(userPx);
  userPxRef.current = userPx;

  const grow = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const fixed = userPxRef.current;
    if (fixed !== null) {
      el.style.maxHeight = 'none';
      el.style.height = `${fixed}px`;
      return;
    }
    el.style.maxHeight = '';
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_PX)}px`;
  }, []);

  useEffect(() => {
    grow();
  }, [userPx, grow]);

  const dragRef = useRef<{ y: number; h: number } | null>(null);
  const onGripDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { y: e.clientY, h: el.offsetHeight };
  };
  const onGripMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    // Up grows it: the composer hangs from the bottom of the pane.
    const max = Math.max(COMPOSER_MIN_PX, Math.floor(window.innerHeight * 0.6));
    setUserPx(Math.min(max, Math.max(COMPOSER_MIN_PX, d.h + (d.y - e.clientY))));
  };
  const onGripUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch {
      /* already released */
    }
    storeComposerPx(userPxRef.current);
  };

  /** Waiting to hear that text handed in from elsewhere was sent (see composerBridge). */
  const insertWatchersRef = useRef<Array<(sent: string) => boolean>>([]);
  const succeeded = useCallback(
    (body: string) => {
      setText('');
      pastesRef.current = new Map();
      pasteSeqRef.current = 0;
      setNotice(null);
      requestAnimationFrame(grow);
      // A watcher that recognises its text in what was sent is done.
      insertWatchersRef.current = insertWatchersRef.current.filter((w) => !w(body));
      onSent(body);
    },
    [grow, onSent],
  );

  // Text handed in from elsewhere (review comments) joins the draft.
  useEffect(
    () =>
      onComposerInsert((insert) => {
        if (insert.taskId !== taskId) return false;
        setText((prev) => (prev.trim() === '' ? insert.text : `${prev.replace(/\s+$/, '')}\n\n${insert.text}`));
        if (insert.onSent) insertWatchersRef.current.push(insert.onSent);
        requestAnimationFrame(() => {
          grow();
          const el = ref.current;
          if (!el) return;
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        });
        return true;
      }),
    [taskId, grow],
  );

  // Only a task switch discards a draft -- never a failed send.
  useEffect(() => {
    setText('');
    pastesRef.current = new Map();
    pasteSeqRef.current = 0;
    setNotice(null);
    setAwaiting(false);
    setHeld(false);
    pendingRef.current = null;
    insertWatchersRef.current = [];
    inFlightRef.current = false; // or a switch mid-await wedges the composer shut
    window.clearTimeout(timerRef.current);
    timerRef.current = 0;
  }, [taskId]);

  /** Send whatever is waiting, once a session exists. */
  const flushPending = useCallback(async () => {
    const body = pendingRef.current;
    if (body === null) return;
    pendingRef.current = null; // taken: a repeat presence event finds nothing
    window.clearTimeout(timerRef.current);
    timerRef.current = 0;
    try {
      if (await submitPty(taskId, body)) succeeded(body);
      else setNotice('Could not deliver your message. It is still here — press Send to retry.');
    } catch {
      setNotice('Could not send your message. It is still here — press Send to retry.');
    } finally {
      setAwaiting(false);
      setHeld(false);
      inFlightRef.current = false;
    }
  }, [taskId, succeeded]);

  // Latest-callback ref so the subscription below does not churn on every keystroke.
  const flushRef = useRef(flushPending);
  useEffect(() => {
    flushRef.current = flushPending;
  }, [flushPending]);

  /*
     Presence, not a one-off check. `hasLivePty` answers "right now" and goes
     stale the moment a session exits under an open composer -- telling someone
     their session is gone only after they have written three paragraphs is the
     bad version of that warning.
  */
  useEffect(() => {
    setLive(hasLivePty(taskId));
    return onPtyPresenceChange((id, isLive) => {
      if (id !== taskId) return;
      setLive(isLive);
      if (isLive) void flushRef.current();
    });
  }, [taskId]);

  /*
     Release on the status leaving `blocked`. `flushPending` takes the body
     rather than reading it, so a status that flickers cannot send twice.
  */
  useEffect(() => {
    if (status === 'blocked') return;
    if (!held || pendingRef.current === null) return;
    void flushRef.current();
  }, [status, held]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  /*
     Tab with nothing focused lands in the composer. Only then: if anything at
     all holds focus (the terminal, a list row, a button) Tab keeps its normal
     meaning, and an open dialog keeps it too, so focus never slips behind one.
     "Nothing focused" is `document.body` being the active element, which is
     what the page reports after a click on bare background or a closed dialog.
  */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.defaultPrevented) return;
      if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
      const active = document.activeElement;
      if (active !== null && active !== document.body && active !== document.documentElement) return;
      if (document.querySelector('[aria-modal="true"]') !== null) return;
      const el = ref.current;
      if (!el || el.disabled) return;
      e.preventDefault();
      el.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /*
     Drop files on the window and their paths land in the message box. That is
     how Claude Code itself takes a picture dragged into a terminal: it sees an
     image path in the input and attaches the file, so nothing here reads or
     uploads the file. The webview delivers drops as native paths (the DOM drop
     event never sees them), hence Tauri's event rather than onDrop.
  */
  /** Type paths into the draft the way a terminal does for a drop. Paste uses it too. */
  const insertPaths = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return;
      const insert = paths.map(shellEscapePath).join(' ');
      setText((t) => withInsertedPath(t, insert));
      requestAnimationFrame(() => {
        ref.current?.focus();
        grow();
      });
    },
    [grow],
  );

  useEffect(() => {
    let off: (() => void) | null = null;
    let gone = false;
    let webview: ReturnType<typeof getCurrentWebview>;
    try {
      webview = getCurrentWebview();
    } catch {
      return; // not inside Tauri (tests, a browser build): no drop target
    }
    void webview
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === 'enter') setDropping(true);
        else if (p.type === 'leave') setDropping(false);
        else if (p.type === 'drop') {
          setDropping(false);
          // A screenshot thumbnail's file is deleted moments after the drop.
          void Promise.all(p.paths.map((path) => keepDroppedFile(path))).then(insertPaths);
        }
      })
      .then((un) => {
        if (gone) un();
        else off = un;
      })
      .catch(() => {
        /* no webview events (tests, a browser build): drop simply does nothing */
      });
    return () => {
      gone = true;
      off?.();
    };
  }, [insertPaths]);

  /*
     ⌘V with image data -- a screenshot copied with ⌃⇧⌘4, an image copied in a
     browser -- carries bytes, not a path, so it is written to
     ~/.albedo/paste/ first and then inserted exactly as a drop is (see
     docs/ARCHITECTURE.md, "Images go in as paths").
     Anything without an image file item returns before preventDefault: a text
     paste is the browser's, untouched.
  */
  const onPaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const image = imageFromClipboard(e.clipboardData?.items);
      if (!image) {
        // A large text paste collapses to a placeholder, as in Claude Code: the
        // text is kept aside and goes back in on send (see pastedText.ts).
        const cd = e.clipboardData;
        const pasted = cd && typeof cd.getData === 'function' ? cd.getData('text/plain') : '';
        if (!shouldCollapse(pasted) || inFlightRef.current) return;
        e.preventDefault();
        const id = ++pasteSeqRef.current;
        pastesRef.current.set(id, pasted);
        const token = placeholderFor(id, pasted);
        const el = e.currentTarget;
        el.focus();
        // insertText keeps the edit on the textarea's undo stack, so Cmd+Z
        // takes the placeholder out like any other typing. jsdom and older
        // engines lack it; splicing the value is the fallback.
        const inserted = typeof document.execCommand === 'function' && document.execCommand('insertText', false, token);
        if (!inserted) {
          const start = el.selectionStart ?? el.value.length;
          const end = el.selectionEnd ?? start;
          setText((t) => t.slice(0, start) + token + t.slice(end));
        }
        requestAnimationFrame(grow);
        return;
      }
      e.preventDefault();
      // The draft is frozen while a send is pending; so is what lands in it.
      if (inFlightRef.current) return;
      savePastedImage(image)
        .then((path) => insertPaths([path]))
        .catch((err: unknown) => {
          setNotice(`Could not save the pasted image: ${err instanceof Error ? err.message : String(err)}`);
        });
    },
    [insertPaths, grow],
  );

  /**
   * Attach files from a picker -- the button, or ⌘U. They go in as paths, as
   * a drop does; the picker puts the chosen files in the fs scope.
   */
  const attachFiles = useCallback(async () => {
    if (inFlightRef.current) return;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ multiple: true, directory: false, title: 'Attach Files' });
      const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
      insertPaths(paths);
    } catch (err) {
      setNotice(`Could not open the file picker: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [insertPaths]);

  useEffect(
    () =>
      onAttachRequest((id) => {
        if (id !== taskId) return false;
        void attachFiles();
        return true;
      }),
    [taskId, attachFiles],
  );

  /** Take the held message back, so a prompt nobody answers is not a trap. */
  const cancelHold = useCallback(() => {
    pendingRef.current = null;
    inFlightRef.current = false;
    setHeld(false);
    setNotice(null);
  }, []);

  const send = useCallback(async () => {
    // A ref, because two Enters in one tick both see stale `busy` state.
    if (inFlightRef.current) return;
    if (text.trim().length === 0) return;
    // What Claude Code receives: the draft with its paste placeholders filled.
    const body = expandPastes(text, pastesRef.current);
    /*
       Checked BEFORE submitPty, because submitPty types into the prompt. No
       timeout here, unlike the pty-start hold: a permission prompt waits for a
       person and can sit for an hour, so a deadline would only invent a
       failure. `Cancel` on the notice is the way out.
    */
    if (status === 'blocked') {
      pendingRef.current = body;
      inFlightRef.current = true;
      setHeld(true);
      setNotice('Waiting — Claude is asking you something. Answer it in the terminal and your message sends itself.');
      return;
    }
    inFlightRef.current = true;
    setBusy(true);
    try {
      // submitPty owns the bracketed-paste wrapper and the submitting \r (see
      // Terminal.tsx, which says callers must NOT wrap again). Wrapping here
      // too would nest the escape sequences and send the markers as text.
      if (await submitPty(taskId, body)) {
        succeeded(body);
        inFlightRef.current = false;
        return;
      }
      if (startPty(taskId)) {
        // Coming up. Hold the body and let the presence event send it.
        pendingRef.current = body;
        setAwaiting(true);
        setNotice('Starting the session — your message sends as soon as it is ready.');
        timerRef.current = window.setTimeout(() => {
          if (pendingRef.current === null) return;
          pendingRef.current = null;
          setAwaiting(false);
          inFlightRef.current = false;
          setNotice('The session did not start. Your message is still here — press Send to try again.');
        }, START_TIMEOUT_MS);
        // `startPty` also returns true when a pty is ALREADY live -- submitPty
        // can fail on a write error alone. No presence event is coming in that
        // case, so flush now; the take-discipline keeps it single-fire either way.
        if (hasLivePty(taskId)) void flushRef.current();
        return; // otherwise inFlightRef stays set until the retry or the timeout
      }
      setNotice('This task\u2019s session isn\u2019t running, so there is nowhere to send this. Select the task in the list to start it, then press Send. Your message is still here.');
      inFlightRef.current = false;
    } catch {
      setNotice('Could not send your message. It is still here — press Send to retry.');
      inFlightRef.current = false;
    } finally {
      setBusy(false);
    }
  }, [text, taskId, succeeded]);

  /*
     Copy note: say what it means for the user's work, not what the process is
     doing. "No live session" read as "your conversation is gone" -- it is not,
     it is on disk and in the database; what stopped is a process. `canResume`
     is what lets the copy promise more than "saved": when the CLI can pick the
     session up it says so, and when it cannot (never established, or a
     `--resume` already rejected) it says a new session starts rather than
     over-promising a reopen.
  */
  const placeholder = held
    ? 'Waiting for the permission prompt to be answered…'
    : awaiting
    ? 'Starting the terminal…'
    : live
      ? 'Message this conversation…'
      : canResume(taskId)
        ? 'Terminal not running — send to pick this conversation back up.'
        : 'Terminal not running — your conversation is saved. Send to start a new session.';

  return (
    <>
    <div
      className="tx-grip"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize message box (double-click to reset)"
      title="Drag to resize the message box · double-click to reset"
      onPointerDown={onGripDown}
      onPointerMove={onGripMove}
      onPointerUp={onGripUp}
      onPointerCancel={onGripUp}
      onDoubleClick={() => {
        setUserPx(null);
        storeComposerPx(null);
      }}
    />
    <div className="tx-composer" data-drop={dropping}>
      {notice ? (
        <div className="tx-composer-notice">
          <span>{notice}</span>
          {held ? (
            <button type="button" className="tx-composer-undo" onClick={cancelHold}>
              Cancel
            </button>
          ) : null}
        </div>
      ) : null}
      {/* claude.ai's shape: one rounded box holding the text and, under it,
          the controls -- the model and Send at the bottom right. Beside a
          tall box they floated at its foot; inside it they move with it. */}
      <div className="tx-composer-box">
      <textarea
        ref={ref}
        className="tx-composer-input"
        rows={1}
        value={text}
        /*
           readOnly, not disabled: disabling a focused element blurs it, so the
           user would lose the caret mid-send and have to click back in. This
           still freezes the draft while a send is pending; `send` itself is
           guarded by inFlightRef, so the Enter key that readOnly still delivers
           cannot start a second one.
        */
        readOnly={awaiting || held}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          grow();
        }}
        onPaste={onPaste}
        onKeyDown={(e) => {
          // Match the TUI: Enter sends, Shift+Enter is a newline. `isComposing`
          // keeps an IME's Enter from submitting a half-typed word.
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="tx-composer-foot">
        <button
          type="button"
          className="tx-composer-attach"
          onClick={() => void attachFiles()}
          disabled={awaiting || held}
          title="Attach Files (⌘U). Images reach Claude as pictures"
          aria-label="Attach files"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8 3v10M3 8h10" />
          </svg>
        </button>
        <PermissionModeLabel sessionId={sessionId} />
        <div className="tx-composer-accessory">{accessory}</div>
        <button
          type="button"
          className="tx-composer-send"
          onClick={() => void send()}
          disabled={busy || awaiting || held || text.trim().length === 0}
          title="Send (Enter). Shift+Enter for a newline"
          aria-label="Send"
        >
          {awaiting || held ? (
            '…'
          ) : busy ? (
            <span className="tx-spinner" role="img" aria-label="Sending" />
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
            </svg>
          )}
        </button>
      </div>
      </div>
    </div>
    </>
  );
}

/**
 * A path as a terminal types it when a file is dropped on it: shell-special
 * characters backslash-escaped, so a screenshot's "Screenshot 2026-10-17 at
 * 00.36.49.png" stays one path. Claude Code reads image paths in this form.
 */
export function shellEscapePath(path: string): string {
  return path.replace(/([ \t'"\\()&;|<>$`!*?[\]{}#~])/g, '\\$1');
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export type Item =
  | { kind: 'row'; key: string; message: Message; result: Message | null; extras?: Message[] }
  | { kind: 'sidechain'; key: string; rows: Message[]; results: Map<number, Message | null> };

/**
 * Pair each `tool_use` with its `tool_result`, and fold runs of sidechain rows
 * into a single collapsible group. Subagent traffic is noise until you go
 * looking for it.
 *
 * `foldSidechains: false` is for the subagent inspector, which IS going looking
 * for it: every row it shows is sidechain, so folding would hide the whole run
 * behind one disclosure.
 */
export function groupRows(messages: readonly Message[], { foldSidechains = true } = {}): Item[] {
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
    if (foldSidechains && isSidechain(m)) {
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
      if (m.role === 'user') {
        // One thing you sent is one band. Claude Code writes a message with an
        // attachment as several rows -- your text and the image are blocks of
        // the same line, and the "[Image: source: ...]" note is the line after
        // -- and each used to render as its own "you" band.
        const extras: Message[] = [];
        let hasImage = isImagePlaceholder(m.body);
        let j = i + 1;
        while (j < messages.length) {
          const n = messages[j];
          if (!n || n.role !== 'user' || isSidechain(n) || consumed.has(n.id)) break;
          const sameLine = Math.floor(n.seq / SEQ_STRIDE) === Math.floor(m.seq / SEQ_STRIDE) && n.sessionId === m.sessionId;
          const note = hasImage && imageSourceNote(n.body ?? '') !== null;
          if (!sameLine && !note) break;
          extras.push(n);
          if (isImagePlaceholder(n.body)) hasImage = true;
          j++;
        }
        items.push({ kind: 'row', key: `m-${m.id}`, message: m, result: null, extras });
        i = j;
        continue;
      }
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
          <Disclosure open={open} /> Subagent · {rows.length} Row{rows.length === 1 ? '' : 's'}
          {tools > 0 ? ` · ${tools} Tool Call${tools === 1 ? '' : 's'}` : ''}
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
