/**
 * The read pane.
 *
 * Reads rows out of SQLite -- never the pty. A long session is tens of
 * thousands of rows, so the pane holds a window anchored at the *end* of the
 * transcript and grows it backwards when the user scrolls up. New rows are
 * appended and followed only while the viewport is already at the bottom;
 * scrolling up to read is never interrupted.
 */

import { getCurrentWebview } from '@tauri-apps/api/webview';
import { SEQ_STRIDE } from '../../capture';
import { imageSourceNote, isImagePlaceholder } from './envelopes';
import { onPromptChange, pendingPrompt, type PendingPrompt } from '../../capture/hookEvents';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent, ReactNode } from 'react';
import type { Message, TaskStatus } from '../../types';
import { getMessages } from '../../db';
import { onCaptureUpdate } from '../../capture';
import { canResume, hasLivePty, onPtyPresenceChange, startPty, submitPty } from '../Terminal';
import { imageFromClipboard, savePastedImage, withInsertedPath } from '../../lib/pasteImage';
import { Disclosure } from './Diff';
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
}

export function TranscriptPane({
  taskId,
  sessionId,
  status = null,
  onAnswerInTerminal,
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
    return <div className="tx-pane tx-pane-empty">Select a task to read its transcript</div>;
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
          <div className="tx-page-top tx-page-start">start of conversation</div>
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
      </div>

      {!following ? (
        <button type="button" className="tx-jump" onClick={jumpToEnd}>
          ↓ latest
        </button>
      ) : null}

      {taskId !== null ? <PromptCard taskId={taskId} onAnswerInTerminal={onAnswerInTerminal} /> : null}
      {taskId !== null ? <Composer taskId={taskId} status={status} onSent={jumpToEnd} /> : null}
    </div>
  );
}

export default TranscriptPane;

// ---------------------------------------------------------------------------
// Waiting prompt
// ---------------------------------------------------------------------------

/**
 * What Claude is waiting on the user for, shown where the transcript is read.
 *
 * The transcript cannot show it: Claude Code writes a turn only when it ends,
 * and this turn is waiting. It comes from the hook events (capture/
 * hookEvents.ts). Read-only for now -- answering happens in the terminal, one
 * click away -- so nothing here can type into a prompt by mistake.
 */
function PromptCard({
  taskId,
  onAnswerInTerminal,
}: {
  taskId: number;
  onAnswerInTerminal: ((taskId: number) => void) | undefined;
}): ReactNode {
  const [prompt, setPrompt] = useState<PendingPrompt | null>(() => pendingPrompt(taskId));
  useEffect(() => {
    setPrompt(pendingPrompt(taskId));
    return onPromptChange((id, next) => {
      if (id === taskId) setPrompt(next);
    });
  }, [taskId]);

  if (prompt === null) return null;
  return (
    <div className="tx-prompt" role="status" aria-label="Waiting on you">
      <div className="tx-prompt-head">
        <span className="tx-prompt-tag">waiting on you</span>
        {onAnswerInTerminal ? (
          <button type="button" className="btn btn-ghost" onClick={() => onAnswerInTerminal(taskId)}>
            Answer in terminal
          </button>
        ) : null}
      </div>
      {prompt.kind === 'question' ? (
        prompt.questions.length === 0 ? (
          <div className="tx-prompt-q">Claude is asking a question.</div>
        ) : (
          prompt.questions.map((q, i) => (
            <div className="tx-prompt-block" key={i}>
              {q.header ? <div className="tx-prompt-sub">{q.header}</div> : null}
              <div className="tx-prompt-q">{q.question}</div>
              <ol className="tx-prompt-opts">
                {q.options.map((o, j) => (
                  <li key={j}>
                    <span className="tx-prompt-opt">{o.label}</span>
                    {o.description ? <span className="tx-prompt-desc"> — {o.description}</span> : null}
                  </li>
                ))}
              </ol>
            </div>
          ))
        )
      ) : prompt.kind === 'permission' ? (
        <div className="tx-prompt-q">
          Needs permission: <span className="tx-prompt-cmd">{prompt.summary}</span>
        </div>
      ) : (
        <div className="tx-prompt-q">{prompt.message}</div>
      )}
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
const COMPOSER_PX_KEY = 'albedo.composerPx';

/** The height the user dragged it to, or null for auto-grow. Never throws. */
function storedComposerPx(): number | null {
  try {
    const n = Number(window.localStorage.getItem(COMPOSER_PX_KEY));
    return Number.isFinite(n) && n >= COMPOSER_MIN_PX ? n : null;
  } catch {
    return null;
  }
}

function storeComposerPx(px: number | null): void {
  try {
    if (px === null) window.localStorage.removeItem(COMPOSER_PX_KEY);
    else window.localStorage.setItem(COMPOSER_PX_KEY, String(Math.round(px)));
  } catch {
    /* storage unavailable: the height just is not remembered */
  }
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
}: {
  taskId: number;
  onSent: () => void;
  status?: TaskStatus | null;
}): ReactNode {
  const [text, setText] = useState('');
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

  const succeeded = useCallback(() => {
    setText('');
    setNotice(null);
    requestAnimationFrame(grow);
    onSent();
  }, [grow, onSent]);

  // Only a task switch discards a draft -- never a failed send.
  useEffect(() => {
    setText('');
    setNotice(null);
    setAwaiting(false);
    setHeld(false);
    pendingRef.current = null;
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
      if (await submitPty(taskId, body)) succeeded();
      else setNotice('Could not deliver your message. It is still here — press send to retry.');
    } catch {
      setNotice('Could not send your message. It is still here — press send to retry.');
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
          insertPaths(p.paths);
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
     ~/.albedo/paste/ first and then inserted exactly as a drop is (TODO §8).
     Anything without an image file item returns before preventDefault: a text
     paste is the browser's, untouched.
  */
  const onPaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const image = imageFromClipboard(e.clipboardData?.items);
      if (!image) return;
      e.preventDefault();
      // The draft is frozen while a send is pending; so is what lands in it.
      if (inFlightRef.current) return;
      savePastedImage(image)
        .then((path) => insertPaths([path]))
        .catch((err: unknown) => {
          setNotice(`Could not save the pasted image: ${err instanceof Error ? err.message : String(err)}`);
        });
    },
    [insertPaths],
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
    /*
       Checked BEFORE submitPty, because submitPty types into the prompt. No
       timeout here, unlike the pty-start hold: a permission prompt waits for a
       person and can sit for an hour, so a deadline would only invent a
       failure. `Cancel` on the notice is the way out.
    */
    if (status === 'blocked') {
      pendingRef.current = text;
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
      if (await submitPty(taskId, text)) {
        succeeded();
        inFlightRef.current = false;
        return;
      }
      if (startPty(taskId)) {
        // Coming up. Hold the body and let the presence event send it.
        pendingRef.current = text;
        setAwaiting(true);
        setNotice('Starting the session — your message sends as soon as it is ready.');
        timerRef.current = window.setTimeout(() => {
          if (pendingRef.current === null) return;
          pendingRef.current = null;
          setAwaiting(false);
          inFlightRef.current = false;
          setNotice('The session did not start. Your message is still here — press send to try again.');
        }, START_TIMEOUT_MS);
        // `startPty` also returns true when a pty is ALREADY live -- submitPty
        // can fail on a write error alone. No presence event is coming in that
        // case, so flush now; the take-discipline keeps it single-fire either way.
        if (hasLivePty(taskId)) void flushRef.current();
        return; // otherwise inFlightRef stays set until the retry or the timeout
      }
      setNotice('This task\u2019s session isn\u2019t running, so there is nowhere to send this. Select the task in the list to start it, then press send. Your message is still here.');
      inFlightRef.current = false;
    } catch {
      setNotice('Could not send your message. It is still here — press send to retry.');
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
              cancel
            </button>
          ) : null}
        </div>
      ) : null}
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
      <button
        type="button"
        className="tx-composer-send"
        onClick={() => void send()}
        disabled={busy || awaiting || held || text.trim().length === 0}
        title="Enter to send, Shift+Enter for a newline"
      >
        {awaiting || held ? '…' : 'send'}
      </button>
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

type Item =
  | { kind: 'row'; key: string; message: Message; result: Message | null; extras?: Message[] }
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
          <Disclosure open={open} /> subagent · {rows.length} row{rows.length === 1 ? '' : 's'}
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
