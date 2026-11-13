/**
 * The read pane.
 *
 * Reads rows out of SQLite -- never the pty. A long session is tens of
 * thousands of rows, so the pane holds a window anchored at the *end* of the
 * transcript and grows it backwards when the user scrolls up. New rows are
 * appended and followed only while the viewport is already at the bottom;
 * scrolling up to read is never interrupted.
 */

import { foldPastes } from './pastedText';
import { PassageRevealContext, revealPassageIn, type RevealPassage } from './passages';
import { PassageComments } from './PassageComments';
import { onHeldReleased } from './outbox';
import {
  noteShownStatus,
  startOutboxRelease,
} from './outboxRelease';
import { shownQueue } from './turn';
import { commandEchoLanded, commandLanded, echoLanded, isCompactCommand, useCommandEcho } from './commandEcho';
import { CommandEchoRow } from './CommandEchoRow';
import OverlayScrollbar from './OverlayScrollbar';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Message, TaskStatus } from '../../types';
import { getMessages, messageOrderKeys } from '../../db';
import { grownLimit, keepRowObjects, mergeTail, tailCursor } from './tail';
import {
  onCaptureUpdate,
  onQueueChange,
  queuedFor,
  type QueuedEntry,
} from '../../capture';
import { watchConnectivity } from '../../lib/connectivity';
import { usePtyLiveSince } from '../Terminal';
import { MemoMessageRow as MessageRow } from './MessageRow';
import CompactionRow from './CompactionRow';
import { ApiErrorRetryContext, apiErrorRetryOf } from './apiErrorRetry';
import { formatTurnTotals, stepDetail, stepLabel, workingState, type Working } from './working';
import { formatDuration } from '../../lib/duration';
import PromptCard from './PromptCard';
import { PreviewCard } from '../preview/PreviewCard';
import { PreviewViewerHost } from '../preview/previewViewer';
import { RemoteMenuNotice } from './RemoteMenuNotice';
import ReminderCards from '../reminders/ReminderCard';
import BackgroundStrip from './BackgroundStrip';
import { backgroundShown, useBackgroundWork } from '../BackgroundWork';
import { useGroupToolCalls } from './groupToolCalls';
import { foldToolRuns, groupRows } from './grouping';
import { MemoToolRunGroup, SidechainGroup } from './ToolRunGroup';
import { QueuedStrip } from './QueuedStrip';
import { Composer } from './Composer';
import './transcript.css';

/** How long "that passage is not here any more" stays up. */
const REVEAL_NOTE_MS = 4_000;
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
     The tail is read session-scoped even when the window above is task-scoped:
     new rows only ever land in the session the task currently points at.

     It pages on row id, not `seq`. `seq` is `lineIndex * 100 + blockIndex`
     within ONE transcript file: it restarts at a fork, and every subagent of
     the session has a file and a numbering of its own. A seq cursor read
     against the wrong numbering either refetched held rows or, once a
     subagent's seq ran ahead of the parent's, skipped every parent row still
     to come (#104). See tail.ts.
  */
  const tailQuery = useMemo(() => {
    if (sessionId !== null) return { sessionId };
    if (taskId !== null) return { taskId };
    return null;
  }, [taskId, sessionId]);

  const inactive = taskId === null && sessionId === null;
  const liveSince = usePtyLiveSince(taskId);
  const backgroundTask = useMemo(() => (taskId === null ? null : { id: taskId, sessionId }), [taskId, sessionId]);
  const background = backgroundShown(useBackgroundWork(backgroundTask));

  // Held messages go for every task, whichever one is on screen (outboxRelease.ts).
  useEffect(() => startOutboxRelease(), []);
  // The release's prompt gate counts this task's `blocked`, as the composer does.
  useEffect(() => {
    noteShownStatus(taskId, status);
    return () => noteShownStatus(null, null);
  }, [taskId, status]);

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
        // Rows already held keep their objects, so only what is new renders.
        setMessages((prev) => keepRowObjects(prev, rows));
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
  // The cursor is the highest row id held, never a seq: seq is per file, and
  // a subagent's file runs its own numbering under the same session (tail.ts).
  const lastIdRef = useRef<number | null>(null);
  useEffect(() => {
    lastIdRef.current = tailCursor(messages);
  }, [messages]);
  /** How many rows are on screen, for growing the window from (grownLimit). */
  const heldRef = useRef(0);
  heldRef.current = messages.length;
  // Fresh rows go where a reload would put them.
  const orderKeys = useMemo(() => messageOrderKeys(query), [query]);
  const orderKeysRef = useRef(orderKeys);
  orderKeysRef.current = orderKeys;

  useEffect(() => {
    if (inactive || tailQuery === null) return;
    let live = true;
    let timer = 0;

    const fetchTail = () => {
      const after = lastIdRef.current;
      if (after === null) {
        // No rows in scope yet -- a session that has only just started writing,
        // or the first rows after a fork. Re-run the window query rather than
        // page forward from nowhere; it self-corrects on the next update.
        setReloadKey((k) => k + 1);
        return;
      }
      void getMessages({ ...tailQuery, afterId: after, limit: TAIL_LIMIT })
        .then((rows) => {
          if (!live || rows.length === 0) return;
          // With `afterId` set, `limit` keeps the OLDEST rows after it, so
          // consecutive pages abut: appending can never leave a hole.
          // Advance the cursor here so a drain pass cannot re-read this page.
          const lastRow = rows[rows.length - 1];
          if (lastRow) lastIdRef.current = lastRow.id;
          setMessages((prev) => {
            const next = mergeTail(prev, rows, orderKeysRef.current);
            if (next === null) return prev;
            if (followingRef.current) pendingScrollRef.current = 'bottom';
            return next;
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
    setLimit((l) => grownLimit(l, heldRef.current, PAGE));
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

  /*
     After every commit of the pane, not only when `messages` changes: the
     echo of a sent message and the working line are rows too, drawn from
     state of their own (#142). Sending used to scroll to the end *before*
     the echo was drawn, so the echo and the working line landed below the
     view, and a later scroll event (#136's put-back of scrollTop around
     measuring the box) read "not at the end" and stopped following.

     A reader who is following ends every commit at the end, whatever was
     added. One reading further up is never moved, and a backwards page
     restores its anchor instead. Rows that change height on their own (a
     disclosure opened) are not a commit of the pane, so this leaves them be.
  */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const mode = pendingScrollRef.current;
    if (mode === 'anchor') {
      if (!pageAppliedRef.current) return;
      // Measured from the bottom, so rows appended since the anchor was taken
      // would skew it -- but no tail row can arrive between the page landing
      // and this effect, which runs in the same commit.
      const anchor = anchorRef.current;
      if (anchor) el.scrollTop = el.scrollHeight - anchor.height + anchor.top;
      anchorRef.current = null;
      pendingScrollRef.current = null;
      pageAppliedRef.current = false;
      return;
    }
    if (mode === 'bottom') {
      el.scrollTop = el.scrollHeight;
      pendingScrollRef.current = null;
      return;
    }
    // Hidden (another tab): nothing to scroll; the ResizeObserver below
    // puts a following reader at the end when the pane comes back.
    if (!followingRef.current || el.clientHeight === 0) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 0) el.scrollTop = el.scrollHeight;
  });

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

  const [groupTools] = useGroupToolCalls();
  const items = useMemo(() => {
    const rows = groupRows(messages);
    return groupTools ? foldToolRuns(rows) : rows;
  }, [messages, groupTools]);

  // The API error the last turn stopped on (#338), on the session's own
  // thread, while the task is idle -- the task list's Stopped on an Error,
  // read the same way: its line in the transcript carries Try Again.
  const retry = useMemo(() => apiErrorRetryOf(messages, taskId, sessionId, status), [messages, taskId, sessionId, status]);

  // A Background line was clicked: bring its call's row into view. The row
  // may be older than the window holds, so the window grows a page at a time
  // until it is in, or there is nothing older; then this gives up quietly.
  const [reveal, setReveal] = useState<number | null>(null);
  /** A quoted passage to flash once its row is in view (#187). */
  const passageRef = useRef<{ messageId: number; quote: string; offset?: number } | null>(null);
  /** Said when a passage asked for is not in this conversation any more. */
  const [revealNote, setRevealNote] = useState<string | null>(null);
  useEffect(() => {
    setReveal(null);
    passageRef.current = null;
    setRevealNote(null);
  }, [selectorKey]);
  useEffect(() => {
    if (revealNote === null) return;
    const t = window.setTimeout(() => setRevealNote(null), REVEAL_NOTE_MS);
    return () => window.clearTimeout(t);
  }, [revealNote]);
  useEffect(() => {
    if (reveal === null || loading) return;
    const row = scrollRef.current?.querySelector<HTMLElement>(`[data-message-id="${reveal}"]`) ?? null;
    const step = revealStep(row !== null, messages.some((m) => m.id === reveal), hasMore);
    if (step === 'grow') {
      setLimit((l) => grownLimit(l, heldRef.current, PAGE));
      return;
    }
    const passage = passageRef.current?.messageId === reveal ? passageRef.current : null;
    passageRef.current = null;
    if (step === 'scroll') {
      const scroller = scrollRef.current;
      if (passage && row && scroller) revealPassageIn(scroller, row, passage.quote, passage.offset);
      else row?.scrollIntoView?.({ block: 'center' });
      followingRef.current = false;
      setFollowing(false);
    } else if (passage) {
      // A quote whose row is gone (a subagent's folded group, history that
      // was cleared): say so, rather than a click that does nothing.
      setRevealNote('That passage is not in this conversation’s transcript any more.');
    }
    setReveal(null);
  }, [reveal, messages, hasMore, loading]);
  const revealPassage = useCallback<RevealPassage>((target) => {
    passageRef.current = target;
    setRevealNote(null);
    setReveal(target.messageId);
  }, []);

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
  // A held message leaving the Queued band is sent, so it shows as sending.
  // A `/compact` is echoed by commandEcho.ts instead, which knows it runs on.
  useEffect(
    () =>
      onHeldReleased((id, held) => {
        if (id === taskId && !isCompactCommand(held.text)) setEcho({ text: held.text, at: Date.now() });
      }),
    [taskId],
  );
  useEffect(() => {
    if (!echo) return;
    // Clock skew between this machine's two clocks is nil, but a second of
    // slack keeps a row written in the same instant from being missed.
    if (echoLanded(echo, messages)) setEcho(null);
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
      if (echoIsQueued(echo, queuedFor(sessionId), liveSince)) setEcho(null);
    };
    check();
    return onQueueChange((sid) => {
      if (sid === sessionId) check();
    });
  }, [echo, sessionId, liveSince]);
  /*
     A command a button sent, and any `/compact` (commandEcho.ts): its own row,
     kept per task outside the pane, because the task's row and the message
     box show a running `/compact` too. It ends here as soon as the rows on
     screen have it; the store checks the database for a task not on screen.
     Only this task's rows count: right after a switch the window still holds
     the last task's.
  */
  const commandEcho = useCommandEcho(taskId);
  useEffect(() => {
    if (!commandEcho || taskId === null) return;
    const own = messages.filter((m) => m.taskId === taskId || (sessionId !== null && m.sessionId === sessionId));
    if (commandLanded(commandEcho, own)) commandEchoLanded(taskId, commandEcho.at);
  }, [messages, commandEcho, taskId, sessionId]);
  const working = status === 'running' || echo !== null;
  // A turn running or a message on its way: if the connection is gone, now
  // is when it matters (connectivity.ts probes only while watched).
  useEffect(() => (working ? watchConnectivity() : undefined), [working]);
  // A running turn is what is working, whatever was just sent.
  const sending = echo !== null && status !== 'running';
  const workingNow = useMemo(
    () => (working ? workingState(messages, { sending, echoAt: echo?.at ?? null, complete: !hasMore }) : null),
    [working, messages, sending, echo, hasMore],
  );
  const onSent = useCallback(
    (body: string) => {
      // A `/compact` typed in the box: commandEcho.ts shows it, as running.
      if (!isCompactCommand(body)) setEcho({ text: body, at: Date.now() });
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

          <PassageRevealContext.Provider value={revealPassage}>
            <ApiErrorRetryContext.Provider value={retry}>
              {items.map((item, idx) =>
                item.kind === 'tools' ? (
                  <MemoToolRunGroup key={item.key} rows={item.rows} live={idx === items.length - 1} reveal={reveal} />
                ) : item.kind === 'sidechain' ? (
                  <SidechainGroup key={item.key} rows={item.rows} results={item.results} extras={item.extras} />
                ) : item.kind === 'compaction' ? (
                  <CompactionRow key={item.key} compaction={item.compaction} />
                ) : (
                  <MessageRow key={item.key} message={item.message} result={item.result} extras={item.extras} />
                ),
              )}
            </ApiErrorRetryContext.Provider>
          </PassageRevealContext.Provider>

          {/* In the order they were sent: two can be up at once only when
              one went while the other was still on its way. */}
          {commandEcho && (!echo || commandEcho.at <= echo.at) ? <CommandEchoRow echo={commandEcho} /> : null}
          {echo ? (
            <div className="tx-row tx-row-user tx-row-echo" aria-live="polite">
              <div className="tx-gutter">You</div>
              <div className="tx-content">
                {/* A paste reads as its mention, as in the box and the Queued band. */}
                <div className="tx-echo-text">{foldPastes(echo.text)}</div>
              </div>
            </div>
          ) : null}
          {commandEcho && echo && commandEcho.at > echo.at ? <CommandEchoRow echo={commandEcho} /> : null}
          {workingNow ? <WorkingLine state={workingNow} /> : null}
          {/* Comment on a selected passage (#187): drawn in the scroller, so it scrolls with the text. */}
          <PassageComments taskId={taskId} scrollRef={scrollRef} messages={messages} />
        </div>
        {revealNote ? (
          <div className="tx-reveal-note" role="status">
            {revealNote}
          </div>
        ) : null}

        {!following ? (
          <button type="button" className="tx-jump" onClick={jumpToEnd} title="Jump to the latest message (⌘↓)">
            ↓ Latest <kbd className="tx-jump-key">⌘↓</kbd>
          </button>
        ) : null}
      </div>

      {/* Above Queued: what is queued goes next, so it sits by the composer. */}
      <BackgroundStrip items={background} onReveal={setReveal} />
      <QueuedStrip sessionId={sessionId} taskId={taskId} liveSince={liveSince} />
      {taskId !== null ? <PromptCard taskId={taskId} onAnswerInTerminal={onAnswerInTerminal} /> : null}
      {/* A mockup waiting for approval (#348): the session's call waits on it. */}
      {taskId !== null ? <PreviewCard taskId={taskId} onAnswerInTerminal={onAnswerInTerminal} /> : null}
      {/* A kept version, opened from its chip: read only, over the pane. */}
      <PreviewViewerHost taskId={taskId} />
      {/* Remote Control's menu, up in the terminal with nothing written (#343). */}
      {taskId !== null ? <RemoteMenuNotice taskId={taskId} onShowTerminal={onAnswerInTerminal} /> : null}
      {/* A reminder that came back (#156): its own card, never text in the box. */}
      {taskId !== null ? <ReminderCards taskId={taskId} status={status} /> : null}
      {taskId !== null ? (
        <Composer
          taskId={taskId}
          sessionId={sessionId}
          status={status}
          onSent={onSent}
          accessory={composerAccessory}
          onJump={revealPassage}
        />
      ) : null}
    </div>
  );
}

export default TranscriptPane;

/**
 * The next step in bringing a row into view: scroll to it once it is drawn;
 * load a page further back while it is not held and there is more; else give
 * up -- a row held but not drawn on its own (inside a subagent's group) or
 * not in the transcript at all has nowhere to scroll to.
 */
export function revealStep(drawn: boolean, held: boolean, hasMore: boolean): 'scroll' | 'grow' | 'give-up' {
  if (drawn) return 'scroll';
  return !held && hasMore ? 'grow' : 'give-up';
}

/** How long a sent message waits to appear in the transcript before its echo goes. */
const ECHO_MAX_MS = 30_000;

/** The message box's echo lands as commandEcho.ts says (`echoLanded`), shared with the buttons' echo. */
export { echoLanded };

/**
 * Whether the Queued band now shows the message just sent: one of its
 * entries (`shownQueue`) was queued no earlier than the send, with the same
 * second of slack as the user-row check. While the band would not show it
 * the echo stays, or the message would be nowhere.
 *
 * Time, not text: the queue records what Claude Code made of the input -- a
 * pasted image becomes `[Image #1]` where Albedo sent a file path -- and
 * while the echo is up only Albedo is typing into the session.
 */
export function echoIsQueued(echo: { at: number }, entries: readonly QueuedEntry[], liveSince: number | null): boolean {
  return shownQueue(entries, liveSince).some((e) => e.ts >= echo.at - 1000);
}

/**
 * "Running Bash git status · 9s", ticking, with the turn's "7m 48s · ↓ 37.6k
 * tokens" at the right (working.ts). The step's detail is the one part that
 * gives way: it truncates on one line, and the label, the step's time and the
 * totals keep their width.
 */
export function WorkingLine({ state }: { state: Working }): ReactNode {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const { step, since, turn } = state;
  const detail = stepDetail(step);
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
        <span className="tx-working-label">{stepLabel(step)}</span>
        {/* The spaces are for reading aloud and copying; between flex items
            they draw nothing. */}
        {detail ? ' ' : null}
        {detail ? (
          // A tool reads as its chip does: the name, then the target and
          // summary in the chip's mono.
          <span className="tx-working-detail" title={detail}>
            {step.kind === 'tool' ? (
              <>
                <span className="tx-working-tool">{step.name}</span>
                {detail.length > step.name.length ? (
                  <span className="tx-working-mono">{detail.slice(step.name.length)}</span>
                ) : null}
              </>
            ) : (
              detail
            )}
          </span>
        ) : null}
        {since > 0 ? ' ' : null}
        {since > 0 ? <span className="tx-working-time">· {formatDuration(now - since)}</span> : null}
        {turn ? ' ' : null}
        {turn ? <span className="tx-working-totals">{formatTurnTotals(turn, now)}</span> : null}
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
