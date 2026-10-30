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
import { onComposerInsert, onAttachRequest, type ComposerInsert } from './composerBridge';
import { dropDraft, getDraft, keepUnsent, saveDraft } from './drafts';
import { editHeld, holdMessage, onHeldReleased, removeHeld, sendAnyway, setEditing, useHeld, type HeldMessage } from './outbox';
import {
  conditionsFor,
  heldHint,
  heldLabel,
  noteShownStatus,
  promptOpen,
  sendNow,
  sendNowAllowed,
  sendNowOfferedFor,
  startOutboxRelease,
  type ReleaseConditions,
} from './outboxRelease';
import { isSlashCommand, mustHold, submitLocked } from './send';
import { onTurnChange, shownQueue } from './turn';
import OverlayScrollbar from './OverlayScrollbar';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { SEQ_STRIDE } from '../../capture';
import { imageSourceNote, isImagePlaceholder } from './envelopes';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent, ReactNode } from 'react';
import type { Message, TaskStatus } from '../../types';
import { getMessages, messageOrderKeys } from '../../db';
import { mergeTail, tailCursor } from './tail';
import { isLocalCommandLine, onCaptureUpdate, onQueueChange, queuedFor, queueSettlesAt, type QueuedEntry } from '../../capture';
import { onPromptChange } from '../../capture/hookEvents';
import { onTrustWaiting } from '../../capture/workspaceTrust';
import { onConnectivityChange, useOffline, watchConnectivity } from '../../lib/connectivity';
import { canResume, hasLivePty, onPtyPresenceChange, startPty, usePtyLiveSince } from '../Terminal';
import { imageFromClipboard, keepDroppedFile, savePastedImage, withInsertedPath } from '../../lib/pasteImage';
import { Disclosure } from './Diff';
import { MemoMessageRow as MessageRow } from './MessageRow';
import CompactionRow from './CompactionRow';
import { compactionAt, isPromptRow, type Compaction } from './compaction';
import { formatTurnTotals, stepDetail, stepLabel, workingState, type Working } from './working';
import { formatDuration } from '../../lib/duration';
import PromptCard from './PromptCard';
import BackgroundStrip from './BackgroundStrip';
import { backgroundShown, useBackgroundWork } from '../BackgroundWork';
import { PermissionModeLabel } from './PermissionModeLabel';
import { isSidechain, toolUseId } from './ToolChip';
import { KEYS, readPersisted, writePersisted, type Codec } from '../persisted';
import { COMPOSER_MIN_PX, TRANSCRIPT_MIN_PX, composerHeight } from './composerHeight';
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
  // The cursor is the highest row id held, never a seq: seq is per file, and
  // a subagent's file runs its own numbering under the same session (tail.ts).
  const lastIdRef = useRef<number | null>(null);
  useEffect(() => {
    lastIdRef.current = tailCursor(messages);
  }, [messages]);
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

  // A Background line was clicked: bring its call's row into view. The row
  // may be older than the window holds, so the window grows a page at a time
  // until it is in, or there is nothing older; then this gives up quietly.
  const [reveal, setReveal] = useState<number | null>(null);
  useEffect(() => setReveal(null), [selectorKey]);
  useEffect(() => {
    if (reveal === null || loading) return;
    const row = scrollRef.current?.querySelector<HTMLElement>(`[data-message-id="${reveal}"]`) ?? null;
    const step = revealStep(row !== null, messages.some((m) => m.id === reveal), hasMore);
    if (step === 'grow') {
      setLimit((l) => l + PAGE);
      return;
    }
    if (step === 'scroll') {
      row?.scrollIntoView?.({ block: 'center' });
      followingRef.current = false;
      setFollowing(false);
    }
    setReveal(null);
  }, [reveal, messages, hasMore, loading]);

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
  useEffect(
    () =>
      onHeldReleased((id, held) => {
        if (id === taskId) setEcho({ text: held.text, at: Date.now() });
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
            ) : item.kind === 'compaction' ? (
              <CompactionRow key={item.key} compaction={item.compaction} />
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
          {workingNow ? <WorkingLine state={workingNow} /> : null}
        </div>

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
      {taskId !== null ? <Composer taskId={taskId} sessionId={sessionId} status={status} onSent={onSent} accessory={composerAccessory} /> : null}
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

/**
 * Whether the transcript now has the message just sent: a row of the main
 * session written no earlier than the send, with a second of slack for a row
 * stamped in the same instant.
 *
 * A prompt arrives as a `user` row. A slash command Claude Code runs itself
 * (`/rc`, `/rename`) writes none, only `system` lines for the command and its
 * output; without them the echo of `/rc` sat below later rows as "Sending"
 * until it timed out (#113). `isPromptRow` stays "a user row someone sent".
 */
export function echoLanded(echo: { at: number }, messages: readonly Message[]): boolean {
  return messages.some(
    (m) =>
      m.agentId === null &&
      m.ts >= echo.at - 1000 &&
      (isPromptRow(m) || (m.role === 'system' && isLocalCommandLine(m.rawJson))),
  );
}

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

// ---------------------------------------------------------------------------
// Queued messages
// ---------------------------------------------------------------------------

/**
 * What you sent and Claude Code has not taken yet, in one band between the
 * transcript and the composer. Two kinds, in the order they will go:
 *
 *  - Claude Code's queue, read from the transcript's queue records
 *    (src/capture/queue.ts). Each entry leaves the moment Claude Code takes
 *    it, as the next turn or folded into the one running -- and then appears
 *    in the transcript as your message. Shown while the session is alive,
 *    and only what this process queued (`shownQueue`). Entries Claude Code queued itself (a background task
 *    finishing, a subagent's message) are not shown.
 *  - Albedo's outbox (outbox.ts): sent while offline, or while a turn was
 *    running (turn.ts), still here, so they can be edited or removed until
 *    they go.
 */
export function QueuedStrip({
  sessionId,
  taskId,
  liveSince,
}: {
  sessionId: string | null;
  taskId: number | null;
  /** When the session's pty was spawned; null with none (see `shownQueue`). */
  liveSince: number | null;
}): ReactNode {
  const [entries, setEntries] = useState<readonly QueuedEntry[]>(() => (sessionId ? queuedFor(sessionId) : []));
  useEffect(() => {
    if (sessionId === null) {
      setEntries([]);
      return;
    }
    let timer = 0;
    const read = () => {
      setEntries([...queuedFor(sessionId)]);
      // An idle session writes nothing that would clear an entry it dropped
      // at a turn end, so the band re-reads when that entry stops counting.
      window.clearTimeout(timer);
      const at = queueSettlesAt(sessionId);
      if (at !== null) timer = window.setTimeout(read, Math.max(0, at - Date.now()) + 1);
    };
    read();
    const off = onQueueChange((sid) => {
      if (sid === sessionId) read();
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, [sessionId]);

  const held = useHeld(taskId);
  const mine = shownQueue(entries, liveSince);
  // Claude Code's entries are on their way to the API: watch it.
  const waiting = mine.length > 0;
  useEffect(() => (waiting ? watchConnectivity() : undefined), [waiting]);

  if (mine.length === 0 && held.length === 0) return null;
  return (
    <div className="tx-queued" role="status" aria-label="Queued messages">
      {mine.length > 0 ? (
        <>
          <div className="tx-queued-head">
            Queued <span className="tx-queued-count">{mine.length}</span>
            <span className="tx-queued-hint">sent when Claude Code finishes its current step</span>
          </div>
          {mine.map((e, i) => (
            <div key={`${e.ts}-${i}`} className="tx-queued-item" title={e.text}>
              {queuedLabel(e.text)}
            </div>
          ))}
        </>
      ) : null}
      {held.length > 0 && taskId !== null ? <HeldGroup taskId={taskId} held={held} /> : null}
    </div>
  );
}

/** The outbox's part of the band, headed by what its messages wait for. */
function HeldGroup({ taskId, held }: { taskId: number; held: readonly HeldMessage[] }): ReactNode {
  const conditions = useReleaseConditions(taskId);
  const hint = heldHint(conditions);
  return (
    <>
      <div className="tx-queued-head">
        {heldLabel(conditions)} <span className="tx-queued-count">{held.length}</span>
        {hint !== null ? <span className="tx-queued-hint">{hint}</span> : null}
      </div>
      {held.map((h) => (
        <HeldRow
          key={h.id}
          taskId={taskId}
          held={h}
          sendNow={sendNowOfferedFor(conditions, h.text) ? sendNowAllowed(conditions) : null}
        />
      ))}
    </>
  );
}

/**
 * What the task's held messages wait for. Re-read on the connection, a
 * prompt, the trust dialog or the turn changing, and on any render: the
 * outbox and the pty already re-render the band.
 */
function useReleaseConditions(taskId: number): ReleaseConditions {
  const [, bump] = useState(0);
  useEffect(() => {
    const mine = (id: number) => {
      if (id === taskId) bump((n) => n + 1);
    };
    const offs = [
      onConnectivityChange(() => bump((n) => n + 1)),
      onPromptChange(mine),
      onTrustWaiting(mine),
      onTurnChange(mine),
    ];
    return () => offs.forEach((off) => off());
  }, [taskId]);
  return conditionsFor(taskId);
}

/**
 * One held message: Edit opens it in place, Remove takes it out. While it is
 * open no release passes it, so what goes is what you saved. Enter saves,
 * Shift+Enter is a newline, Escape puts it back as it was; saving it empty
 * removes it. One being written right now cannot be changed.
 *
 * One that was being sent when the app stopped may already be with Claude
 * Code, so it says so and offers Send beside Edit and Remove: nothing sends
 * it again, or drops it, without the person.
 *
 * One held only for the running turn offers Send Now: into the turn, as a
 * mid-turn message went before (`sendNow`); never a command. `sendNow` is
 * null when not offered, else whether it can be used now. If it could not go
 * after all -- a release had the task's lock -- the row says so briefly.
 */
function HeldRow({
  taskId,
  held,
  sendNow: sendNowEnabled,
}: {
  taskId: number;
  held: HeldMessage;
  sendNow: boolean | null;
}): ReactNode {
  const [draft, setDraft] = useState<string | null>(null);
  const [notNow, setNotNow] = useState(false);
  useEffect(() => {
    if (!notNow) return;
    const t = window.setTimeout(() => setNotNow(false), SEND_NOW_NOTE_MS);
    return () => window.clearTimeout(t);
  }, [notNow]);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Left open (a task switch): what was typed is kept, not thrown away.
  useEffect(
    () => () => {
      if (draftRef.current !== null) editHeld(taskId, held.id, draftRef.current);
      setEditing(taskId, held.id, false);
    },
    [taskId, held.id],
  );

  const open = () => {
    setEditing(taskId, held.id, true);
    setDraft(held.text);
  };
  const close = (save: boolean) => {
    if (save && draft !== null && draft !== held.text) editHeld(taskId, held.id, draft);
    setDraft(null);
    setEditing(taskId, held.id, false);
  };

  if (draft !== null) {
    return (
      <div className="tx-queued-row">
        <textarea
          className="tx-queued-edit"
          aria-label="Edit held message"
          value={draft}
          rows={Math.min(6, Math.max(1, draft.split('\n').length))}
          spellCheck={false}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              close(true);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              close(false);
            }
          }}
        />
        <button type="button" className="tx-btn tx-queued-act" onClick={() => close(true)}>
          Save
        </button>
        <button type="button" className="tx-btn tx-queued-act" onClick={() => close(false)}>
          Cancel
        </button>
      </div>
    );
  }
  const sending = held.sending === true;
  return (
    <div className="tx-queued-row">
      <div className="tx-queued-item" title={held.text}>
        {queuedLabel(held.text)}
      </div>
      {held.maybeSent ? (
        <>
          <span className="tx-queued-note">May already have been sent</span>
          <button type="button" className="tx-btn tx-queued-act" onClick={() => sendAnyway(taskId, held.id)}>
            Send
          </button>
        </>
      ) : null}
      {notNow ? <span className="tx-queued-note">Couldn{'\u2019'}t send now — try again</span> : null}
      {sendNowEnabled !== null && !held.maybeSent ? (
        <button
          type="button"
          className="tx-btn tx-queued-act"
          onClick={() =>
            void sendNow(taskId, held.id).then((went) => {
              if (!went) setNotNow(true);
            })
          }
          disabled={sending || !sendNowEnabled}
          title={
            sendNowEnabled
              ? 'Send it into the running turn now: Claude takes it at its next step'
              : 'Not while Claude is asking you something, or the session is not running'
          }
        >
          Send Now
        </button>
      ) : null}
      <button type="button" className="tx-btn tx-queued-act" onClick={open} disabled={sending}>
        Edit
      </button>
      <button type="button" className="tx-btn tx-queued-act" onClick={() => removeHeld(taskId, held.id)} disabled={sending}>
        Remove
      </button>
    </div>
  );
}

/** How long a held row says Send Now could not go. */
const SEND_NOW_NOTE_MS = 3_000;

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

/** Text handed in from elsewhere, waiting to be sent (see composerBridge). */
type InsertWatcher = Pick<ComposerInsert, 'onSent' | 'comments'>;

/**
 * The review comments a held body carries, and the watchers left once they
 * are handed to it: a watcher whose comments are all in the body is done.
 */
export function commentsHeldIn(body: string, watchers: readonly InsertWatcher[]): { ids: number[]; left: InsertWatcher[] } {
  const ids: number[] = [];
  const left: InsertWatcher[] = [];
  for (const w of watchers) {
    const found = (w.comments ?? []).filter((c) => body.includes(c.marker));
    ids.push(...found.map((c) => c.id));
    if (found.length === 0) left.push(w);
  }
  return { ids, left };
}

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
 * something the user did not mean. A running turn does not get this hold: a
 * message sent during one waits in the outbox instead (send.ts, turn.ts), and
 * goes when the turn ends.
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
  const offline = useOffline();
  /** Files are being dragged over the window. */
  const [dropping, setDropping] = useState(false);

  const ref = useRef<HTMLTextAreaElement>(null);
  /** The body waiting for a session. Taken, not read, so it can only fire once. */
  const pendingRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const timerRef = useRef(0);
  /**
   * The task the box's text belongs to. On the render that switches task,
   * `text` is still the old task's, so it must not be saved under the new id.
   */
  const draftOwnerRef = useRef<number | null>(null);

  /**
   * A height the user dragged the composer to. While set it is the resting
   * height -- content grows it up to 150% of that, then it scrolls (#135) --
   * and double-clicking the grip clears it.
   */
  const [userPx, setUserPx] = useState<number | null>(storedComposerPx);
  const userPxRef = useRef(userPx);
  userPxRef.current = userPx;
  /** The box's text, for the task switch below, which must not depend on it. */
  const textRef = useRef(text);
  textRef.current = text;

  const grow = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const resting = userPxRef.current;
    // The box and the transcript share the pane: the room the box may take is
    // its own height plus the transcript's, less a strip of transcript that
    // always stays. Hidden or unmeasurable (another tab, tests): no cap.
    const pane = el.closest('.tx-pane');
    const wrap = pane?.querySelector<HTMLElement>('.tx-scroll-wrap');
    const available =
      pane && wrap && pane.clientHeight > 0 ? el.offsetHeight + wrap.offsetHeight - TRANSCRIPT_MIN_PX : Infinity;
    // Measuring collapses the box for a moment, and the browser clamps the
    // transcript's scrollTop to the taller view. Put it back, so a reader
    // above the end keeps their place; one following the end is kept there by
    // the transcript's ResizeObserver.
    const scroll = pane?.querySelector<HTMLElement>('.tx-scroll');
    const top = scroll?.scrollTop;
    // A dragged box may grow past the CSS max-height; auto-grow stays under it.
    el.style.maxHeight = resting === null ? '' : 'none';
    el.style.height = 'auto';
    el.style.height = `${composerHeight({ content: el.scrollHeight, resting, available })}px`;
    if (scroll && top !== undefined && scroll.scrollTop !== top) scroll.scrollTop = top;
  }, []);

  // A smaller window leaves less room: take the cap again.
  useEffect(() => {
    window.addEventListener('resize', grow);
    return () => window.removeEventListener('resize', grow);
  }, [grow]);

  useEffect(() => {
    grow();
  }, [userPx, grow]);
  /** Read by the task switch, which must run on a switch and nothing else. */
  const growRef = useRef(grow);
  growRef.current = grow;

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
  const insertWatchersRef = useRef<InsertWatcher[]>([]);
  const succeeded = useCallback(
    (sentFor: number, body: string) => {
      // Sent after the box moved to another task: that task's draft is in it now.
      if (draftOwnerRef.current !== sentFor) return;
      setText('');
      pastesRef.current = new Map();
      pasteSeqRef.current = 0;
      setNotice(null);
      requestAnimationFrame(grow);
      // A watcher that recognises its text in what was sent is done.
      insertWatchersRef.current = insertWatchersRef.current.filter((w) => !w.onSent?.(body));
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
        if (insert.onSent || insert.comments) insertWatchersRef.current.push({ onSent: insert.onSent, comments: insert.comments });
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

  /*
     Keep the draft (drafts.ts). Declared before the switch below, so on a
     switch it still sees the old owner and saves nothing. A send that is
     under way -- busy, waiting for a session, or held at a prompt -- is not
     a draft: it leaves the store, so a restore can never send it twice. A
     send that fails or is cancelled unfreezes the box and is kept again.
  */
  useEffect(() => {
    if (draftOwnerRef.current !== taskId) return;
    if (busy || awaiting || held) dropDraft(taskId);
    else saveDraft(taskId, text, pastesRef.current);
  }, [taskId, text, busy, awaiting, held]);

  /*
     A task switch puts that task's own draft in the box. A send the old task
     still had held or waiting is cancelled -- taken, so it can no longer fire
     -- and only then kept as that task's draft: what was typed is never lost,
     and never both pending and a draft. One already being written is not
     cancellable, and is left to land.
  */
  useEffect(() => {
    const left = draftOwnerRef.current;
    if (left !== null && left !== taskId && pendingRef.current !== null) {
      pendingRef.current = null;
      keepUnsent(left, textRef.current, pastesRef.current);
    }
    const draft = getDraft(taskId);
    draftOwnerRef.current = taskId;
    setText(draft?.text ?? '');
    pastesRef.current = new Map(draft?.pastes);
    pasteSeqRef.current = draft ? Math.max(0, ...draft.pastes.map(([id]) => id)) : 0;
    if (draft) {
      requestAnimationFrame(() => {
        growRef.current();
        const el = ref.current;
        el?.setSelectionRange(el.value.length, el.value.length);
      });
    }
    setNotice(draft?.notSent ? 'Not sent \u2014 press Send when you\u2019re ready.' : null);
    setBusy(false); // a send still being written belongs to the task left
    setAwaiting(false);
    setHeld(false);
    insertWatchersRef.current = [];
    inFlightRef.current = false; // or a switch mid-await wedges the composer shut
    window.clearTimeout(timerRef.current);
    timerRef.current = 0;
  }, [taskId]);

  /**
     Put the body in the outbox (outbox.ts), with the ids of the review
     comments it carries, and empty the box: it is no longer a draft.
  */
  const holdBody = useCallback(
    (body: string) => {
      const { ids, left } = commentsHeldIn(body, insertWatchersRef.current);
      holdMessage(taskId, body, Date.now(), ids);
      insertWatchersRef.current = left;
      setText('');
      pastesRef.current = new Map();
      pasteSeqRef.current = 0;
      setNotice(null);
      requestAnimationFrame(grow);
    },
    [taskId, grow],
  );

  /**
     True when the person switched to another task while `owner`'s send was
     being written. Then nothing about the box may change -- it holds the
     other task's restored draft -- and a send that failed comes back as
     `owner`'s draft, marked not sent, as a send cancelled by a switch does.
  */
  const leftDuringSend = useCallback(
    (owner: number, ok: boolean, text: string, pastes: ReadonlyMap<number, string>): boolean => {
      if (draftOwnerRef.current === owner) return false;
      if (!ok) keepUnsent(owner, text, pastes);
      return true;
    },
    [],
  );

  /** Send whatever is waiting, once a session exists. */
  const flushPending = useCallback(async () => {
    const body = pendingRef.current;
    if (body === null) return;
    pendingRef.current = null; // taken: a repeat presence event finds nothing
    window.clearTimeout(timerRef.current);
    timerRef.current = 0;
    const owner = taskId;
    let ok = false;
    let threw = false;
    if (mustHold(owner)) {
      // Gone offline, something held, or a turn under way since it waited
      // (after an answer, the turn goes on): it joins the outbox. The band
      // shows it from now, so it is not sent as far as the box is concerned
      // -- no echo, no `onSent` -- or it would be on screen twice.
      holdBody(body);
      setAwaiting(false);
      setHeld(false);
      inFlightRef.current = false;
      return;
    }
    try {
      ok = await submitLocked(owner, body);
    } catch {
      threw = true;
    }
    // Left while it was being written: the box and its state are another
    // task's now (see `leftDuringSend`).
    if (leftDuringSend(owner, ok, body, new Map())) return;
    if (ok) succeeded(owner, body);
    else if (threw) setNotice('Could not send your message. It is still here — press Send to retry.');
    else setNotice('Could not deliver your message. It is still here — press Send to retry.');
    setAwaiting(false);
    setHeld(false);
    inFlightRef.current = false;
  }, [taskId, succeeded, holdBody, leftDuringSend]);

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
    if (promptOpen(taskId, status)) return;
    if (!held || pendingRef.current === null) return;
    void flushRef.current();
  }, [taskId, status, held]);

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
       It waits in the outbox (outbox.ts) rather than in Claude Code's queue
       while offline (Claude Code retries, and may drop it), behind messages
       already held or being released (they go first), and while a turn is
       running (it would go with any dialog the turn opens: turn.ts). A
       command waits the same way: the release sends only into an idle
       session (send.ts).
    */
    if (mustHold(taskId)) {
      holdBody(body);
      return;
    }
    /*
       Checked BEFORE submitPty, because submitPty types into the prompt. No
       timeout here, unlike the pty-start hold: a permission prompt waits for a
       person and can sit for an hour, so a deadline would only invent a
       failure. `Cancel` on the notice is the way out.
    */
    // The release's gate (outboxRelease.ts): a hook prompt, the trust dialog, or `blocked`.
    if (promptOpen(taskId, status)) {
      // After the answer the turn goes on, and a command would land in it:
      // it waits in the outbox for an idle session instead.
      if (isSlashCommand(body)) {
        holdBody(body);
        return;
      }
      pendingRef.current = body;
      inFlightRef.current = true;
      setHeld(true);
      setNotice('Waiting — Claude is asking you something. Answer it in the terminal and your message sends itself.');
      return;
    }
    inFlightRef.current = true;
    setBusy(true);
    const owner = taskId;
    // What the box held, for `leftDuringSend`: by then the box is another task's.
    const pastes = new Map(pastesRef.current);
    try {
      // submitPty owns the bracketed-paste wrapper and the submitting \r (see
      // Terminal.tsx, which says callers must NOT wrap again). Wrapping here
      // too would nest the escape sequences and send the markers as text.
      const ok = await submitLocked(owner, body);
      if (leftDuringSend(owner, ok, text, pastes)) return;
      if (ok) {
        succeeded(owner, body);
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
      if (leftDuringSend(owner, false, text, pastes)) return;
      setNotice('Could not send your message. It is still here — press Send to retry.');
      inFlightRef.current = false;
    } finally {
      // The switch already cleared it; the other task may have a send of its own.
      if (draftOwnerRef.current === owner) setBusy(false);
    }
  }, [text, taskId, status, succeeded, holdBody, leftDuringSend]);

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
      {offline ? (
        <div className="tx-composer-notice" role="status">
          You{'\u2019'}re offline. Messages wait here and go when the connection is back.
        </div>
      ) : null}
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
  | { kind: 'sidechain'; key: string; rows: Message[]; results: Map<number, Message | null> }
  | { kind: 'compaction'; key: string; compaction: Compaction };

/**
 * Pair each `tool_use` with its `tool_result`, and fold runs of sidechain rows
 * into a single collapsible group. Subagent traffic is noise until you go
 * looking for it. A compaction's boundary, summary and notice become one
 * divider (compaction.ts), so the summary is never a "you" band.
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
      const compacted = compactionAt(messages, i);
      if (compacted) {
        const first = compacted.compaction.boundary ?? m;
        items.push({ kind: 'compaction', key: `c-${first.id}`, compaction: compacted.compaction });
        i = compacted.next;
        continue;
      }
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
