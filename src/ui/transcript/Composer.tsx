/**
 * The message box under the transcript: drafts, mentions, skills, pasted
 * text and images, comments to carry, and the send itself (send.ts).
 */

import {
  draftOf,
  markPastes,
  pastesIn,
  placeholderFor,
  replaceRanges,
  shouldCollapse,
  tokenRanges,
} from './pastedText';
import { PastedTexts } from './PastedTexts';
import { markMentions, unmarkMentions, type Mention } from './mentions';
import { MentionPopover, mentionOptionId } from './MentionPopover';
import { useMentions } from './useMentions';
import { SkillPopover, SkillStrip, skillOptionId } from './SkillPopover';
import { useSkillMenu } from './useSkillMenu';
import { onComposerInsert, onAttachRequest, onSendCommentsRequest, type ComposerInsert } from './composerBridge';
import { commentsOf, dropDraftText, getDraft, keepUnsent, saveDraft, useComments } from './drafts';
import { type RevealPassage } from './passages';
import { WaitingComments } from './WaitingComments';
import { composeMessage, NOTHING_CARRIED, takeCarried, takeHeldCarried, useWaitingCodeComments, type Carried } from './codeComments';
import { queuedCiOf, useQueuedCi, type QueuedCiFailure } from './ciFailure';
import { useCommentsIntro } from '../commentsIntro';
import { holdMessage } from './outbox';
import { promptOpen } from './outboxRelease';
import { isSlashCommand, mustHold, submitLocked } from './send';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ClipboardEvent, ReactNode } from 'react';
import type { TaskStatus } from '../../types';
import { useOffline } from '../../lib/connectivity';
import { canResume, hasLivePty, onPtyPresenceChange, startPty } from '../Terminal';
import { imageFromClipboard, keepDroppedFile, savePastedImage, withInsertedPath } from '../../lib/pasteImage';
import { PermissionModeLabel } from './PermissionModeLabel';
import { KEYS, readPersisted, writePersisted, type Codec } from '../persisted';
import { COMPOSER_MIN_PX, TRANSCRIPT_MIN_PX, composerHeight } from './composerHeight';

/** Text handed in from elsewhere, waiting to be sent (see composerBridge). */
type InsertWatcher = Pick<ComposerInsert, 'onSent'>;

/** Whole pixels; auto-grow (null) removes the key. */
const composerPxCodec: Codec<number | null> = {
  decode: (raw) => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= COMPOSER_MIN_PX ? n : null;
  },
  encode: (px) => (px === null ? null : String(Math.round(px))),
};

/** The height the user dragged it to, or null for auto-grow. Never throws. */
/** What a message made of these carries, so each leaves the waiting list with it. */
function carriedBy(
  comments: readonly { id: string }[],
  code: readonly { id: number }[],
  ci: QueuedCiFailure | null,
): Carried {
  return {
    transcript: comments.map((c) => c.id),
    code: code.map((c) => c.id),
    ...(ci ? { ci: ci.sha } : {}),
  };
}

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
  onJump,
}: {
  taskId: number;
  /** Called with what Claude Code was sent. */
  onSent: (body: string) => void;
  status?: TaskStatus | null;
  /** Beside Send (the model picker). */
  accessory?: ReactNode;
  /** The task's session, for the permission mode beside +. */
  sessionId?: string | null;
  /** Take the reader to a waiting comment's passage (#187). */
  onJump?: RevealPassage;
}): ReactNode {
  const [text, setText] = useState('');
  /** Comments on transcript passages, waiting to go with the next message (#187). */
  const waiting = useComments(taskId);
  /**
   * And comments on code, from the editor, the guide or a transcript diff:
   * one queue (#222). Read through refs at Send, which may run between renders.
   */
  const waitingCode = useWaitingCodeComments(taskId);
  const waitingCodeRef = useRef(waitingCode);
  waitingCodeRef.current = waitingCode;
  /** A PR's failing checks, queued like a comment (#280); read from the store at Send. */
  const waitingCi = useQueuedCi(taskId);
  const intro = useCommentsIntro();
  const introRef = useRef(intro);
  introRef.current = intro;
  /** Large text pastes kept aside; the draft holds their placeholders. */
  const pastesRef = useRef(new Map<number, string>());
  const pasteSeqRef = useRef(0);
  /** Tasks and files picked from the `@` list; the draft holds their tokens (#154). */
  const mentionsRef = useRef(new Map<string, Mention>());
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
  /**
   * With it: the box's part of that body (what comes back as the draft if it
   * fails after a switch) and the waiting comments it carries, which leave
   * the list only once it is delivered or held.
   */
  const pendingBoxRef = useRef<string | null>(null);
  const pendingCommentsRef = useRef<Carried>(NOTHING_CARRIED);
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
    // the transcript's ResizeObserver. The put-back fires a scroll event, so
    // the transcript must already be at its true end when this runs: the pane
    // pins a following reader after every commit, the echo's included (#142).
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
      mentionsRef.current = new Map();
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
        if (insert.onSent) insertWatchersRef.current.push({ onSent: insert.onSent });
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
    // The comments stay: they leave only with a message that carried them.
    if (busy || awaiting || held) dropDraftText(taskId);
    else saveDraft(taskId, text, pastesRef.current, Date.now(), mentionsRef.current);
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
      keepUnsent(left, textRef.current, pastesRef.current, Date.now(), mentionsRef.current);
    }
    const draft = getDraft(taskId);
    draftOwnerRef.current = taskId;
    setText(draft?.text ?? '');
    pastesRef.current = new Map(draft?.pastes);
    mentionsRef.current = new Map(draft?.mentions);
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
     comments it carries, and empty the box: it is no longer a draft. The
     transcript comments it carries leave the waiting list: the outbox has
     them now, in the body, and its editor shows them (#187).
  */
  const holdBody = useCallback(
    (body: string, carried: Carried = NOTHING_CARRIED) => {
      // Held: the outbox keeps the code comments' ids and marks them sent on
      // delivery (outboxRelease.ts); the transcript ones leave the list now,
      // with the message that carries them.
      holdMessage(taskId, body, Date.now(), carried.code);
      takeHeldCarried(taskId, carried);
      setText('');
      pastesRef.current = new Map();
      pasteSeqRef.current = 0;
      mentionsRef.current = new Map();
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
    (
      owner: number,
      ok: boolean,
      text: string,
      pastes: ReadonlyMap<number, string>,
      mentions: ReadonlyMap<string, Mention>,
    ): boolean => {
      if (draftOwnerRef.current === owner) return false;
      if (!ok) keepUnsent(owner, text, pastes, Date.now(), mentions);
      return true;
    },
    [],
  );

  /** Send whatever is waiting, once a session exists. */
  const flushPending = useCallback(async () => {
    const body = pendingRef.current;
    if (body === null) return;
    pendingRef.current = null; // taken: a repeat presence event finds nothing
    const box = pendingBoxRef.current ?? body;
    const carried = pendingCommentsRef.current;
    pendingBoxRef.current = null;
    pendingCommentsRef.current = NOTHING_CARRIED;
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
      holdBody(body, carried);
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
    // Delivered: the comments it carried are sent, whichever task is on screen.
    if (ok) takeCarried(owner, carried);
    // Left while it was being written: the box and its state are another
    // task's now (see `leftDuringSend`). It comes back with its pastes folded
    // and its references as tokens; its comments never left the list.
    const back = draftOf(box);
    const refs = unmarkMentions(back.text);
    if (leftDuringSend(owner, ok, refs.text, back.pastes, refs.mentions)) return;
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

  /*
     A collapsed paste's chip or inspector asked to take it out, or to put
     its text back as ordinary text (PastedTexts.tsx). Done as an edit of the
     textarea -- select the token, type over it -- so it lands on the undo
     stack like any typing and ⌘Z brings the token back. The paste itself
     stays in the store until the draft is saved without it (drafts.ts keeps
     only what the text uses), so the token ⌘Z restores still stands for it.
  */
  const editPaste = useCallback(
    (id: number, mode: 'remove' | 'insert') => {
      const el = ref.current;
      const content = pastesRef.current.get(id);
      if (!el || content === undefined || el.readOnly || inFlightRef.current) return;
      const ranges = tokenRanges(el.value, pastesRef.current, id);
      if (ranges.length === 0) return;
      const insert = mode === 'insert' ? content : '';
      el.focus();
      // From the last token back, so the earlier offsets stay true.
      let native = typeof document.execCommand === 'function';
      for (const r of [...ranges].reverse()) {
        if (!native) break;
        el.setSelectionRange(r.start, r.end);
        native = insert === '' ? document.execCommand('delete') : document.execCommand('insertText', false, insert);
      }
      if (!native) {
        // jsdom and older engines: splice the value, as a paste does. Read
        // afresh, in case an engine took some of the edits before refusing.
        const left = tokenRanges(el.value, pastesRef.current, id);
        const first = left[0]?.start ?? 0;
        setText(replaceRanges(el.value, left, insert));
        requestAnimationFrame(() => ref.current?.setSelectionRange(first + insert.length, first + insert.length));
      }
      requestAnimationFrame(grow);
    },
    [grow],
  );

  /*
     A pick from the `@` list (useMentions.ts) replaces what was typed after
     the `@` with its token. An edit of the textarea, like `editPaste`, so ⌘Z
     takes the token out again.
  */
  const replaceDraft = useCallback(
    (start: number, end: number, insert: string) => {
      const el = ref.current;
      if (!el || el.readOnly || inFlightRef.current) return;
      el.focus();
      el.setSelectionRange(start, end);
      const native = typeof document.execCommand === 'function' && document.execCommand('insertText', false, insert);
      if (!native) {
        setText(el.value.slice(0, start) + insert + el.value.slice(end));
        requestAnimationFrame(() => ref.current?.setSelectionRange(start + insert.length, start + insert.length));
      }
      requestAnimationFrame(grow);
    },
    [grow],
  );
  const mention = useMentions({
    taskId,
    inputRef: ref,
    storeRef: mentionsRef,
    frozen: busy || awaiting || held,
    replace: replaceDraft,
  });
  const mentionListId = useId();
  /* The `/` list of the session's skills, and the strip a pick leaves (#349). */
  const skill = useSkillMenu({
    taskId,
    sessionId,
    text,
    inputRef: ref,
    frozen: busy || awaiting || held,
    replace: replaceDraft,
  });
  const skillListId = useId();

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

  /*
     The waiting comments alone, asked for from the Review Guide (#254): the
     message Send with an empty box would make, and the draft is left as it
     is -- so none of send()'s box handling. Straight to the session when it
     is live and idle; otherwise into the outbox, where it waits exactly as a
     held message does (a turn running, a prompt open, offline, the session
     not up) and is shown as held in the transcript, with Send Now.
  */
  const sendComments = useCallback(async () => {
    const comments = commentsOf(taskId);
    const code = waitingCodeRef.current;
    const ci = queuedCiOf(taskId);
    if (comments.length === 0 && code.length === 0 && ci === null) return;
    const body = composeMessage(code, introRef.current, comments, '', ci);
    const carried = carriedBy(comments, code, ci);
    const owner = taskId;
    const hold = () => {
      holdMessage(owner, body, Date.now(), carried.code);
      takeHeldCarried(owner, carried);
    };
    if (inFlightRef.current || mustHold(owner) || promptOpen(owner, status) || !hasLivePty(owner)) {
      hold();
      return;
    }
    try {
      if (await submitLocked(owner, body)) {
        takeCarried(owner, carried);
        onSent(body);
      } else hold();
    } catch {
      hold();
    }
  }, [taskId, status, onSent]);

  useEffect(
    () =>
      onSendCommentsRequest((id) => {
        if (id !== taskId) return false;
        // Nothing waiting: not taken, so the caller leaves the tab alone.
        if (commentsOf(taskId).length === 0 && waitingCodeRef.current.length === 0 && queuedCiOf(taskId) === null) return false;
        void sendComments();
        return true;
      }),
    [taskId, sendComments],
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
    // Waiting comments go with the message, before the box's text (#187) --
    // unless the box is a command, which goes alone and leaves them waiting:
    // after a quote it would no longer be a command.
    const command = isSlashCommand(text);
    const comments = command ? [] : commentsOf(taskId);
    // Code comments too (#222): every waiting one goes with this message.
    const code = command ? [] : waitingCodeRef.current;
    // And a PR's failing checks, queued for Claude (#280), ahead of them all.
    const ci = command ? null : queuedCiOf(taskId);
    if (text.trim().length === 0 && comments.length === 0 && code.length === 0 && ci === null) return;
    // What Claude Code receives: the draft with its paste placeholders filled,
    // each paste in its marker so the transcript can fold it again (#155),
    // and each picked reference in its own (#154). References first: a
    // paste's text is never read for tokens.
    const box = markPastes(markMentions(text, mentionsRef.current), pastesRef.current);
    const body = composeMessage(code, introRef.current, comments, box, ci);
    const carried = carriedBy(comments, code, ci);
    /*
       It waits in the outbox (outbox.ts) rather than in Claude Code's queue
       while offline (Claude Code retries, and may drop it), behind messages
       already held or being released (they go first), and while a turn is
       running (it would go with any dialog the turn opens: turn.ts). A
       command waits the same way: the release sends only into an idle
       session (send.ts).
    */
    if (mustHold(taskId)) {
      holdBody(body, carried);
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
      pendingBoxRef.current = box;
      pendingCommentsRef.current = carried;
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
    const mentions = new Map(mentionsRef.current);
    try {
      // submitPty owns the bracketed-paste wrapper and the submitting \r (see
      // Terminal.tsx, which says callers must NOT wrap again). Wrapping here
      // too would nest the escape sequences and send the markers as text.
      const ok = await submitLocked(owner, body);
      if (ok) takeCarried(owner, carried);
      if (leftDuringSend(owner, ok, text, pastes, mentions)) return;
      if (ok) {
        succeeded(owner, body);
        inFlightRef.current = false;
        return;
      }
      if (startPty(taskId)) {
        // Coming up. Hold the body and let the presence event send it.
        pendingRef.current = body;
        pendingBoxRef.current = box;
        pendingCommentsRef.current = carried;
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
      if (leftDuringSend(owner, false, text, pastes, mentions)) return;
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
      ? waiting.length + waitingCode.length > 0
        ? 'Add a message, or send the comments as they are…'
        : waitingCi
        ? 'Add a message, or send the CI failure as it is…'
        : 'Message this conversation…'
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
      <WaitingComments taskId={taskId} frozen={busy || awaiting || held} onJump={onJump} code={waitingCode} />
      {skill.strip ? <SkillStrip skill={skill.strip} onHide={skill.hideStrip} /> : null}
      {/* claude.ai's shape: one rounded box holding the text and, under it,
          the controls -- the model and Send at the bottom right. Beside a
          tall box they floated at its foot; inside it they move with it. */}
      {/* The message box is the first stop of the Tab cycle (focusAreas.ts). */}
      <div className="tx-composer-box" data-focus-area="composer">
      <textarea
        ref={ref}
        className="tx-composer-input"
        data-focus-default=""
        /* Tab from here walks the paste chips' buttons before leaving the box. */
        data-focus-stop=""
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
          mention.sync();
          skill.sync();
        }}
        /* The `@` and `/` lists follow the caret: a click or an arrow key moves it. */
        onSelect={() => {
          mention.sync();
          skill.sync();
        }}
        onBlur={() => {
          mention.close();
          skill.close();
        }}
        aria-autocomplete="list"
        aria-controls={mention.open ? mentionListId : skill.open ? skillListId : undefined}
        aria-activedescendant={
          mention.open
            ? mentionOptionId(mentionListId, mention.active)
            : skill.open
              ? skillOptionId(skillListId, skill.active)
              : undefined
        }
        onPaste={onPaste}
        onKeyDown={(e) => {
          // The `@` list first: ↑↓, Return and Tab pick, Esc closes. It
          // prevents what it takes, so Tab never reaches the area cycle.
          if (mention.onKeyDown(e)) return;
          // Then the `/` list (#349), the same way: Return inserts, never sends.
          if (skill.onKeyDown(e)) return;
          // Match the TUI: Enter sends, Shift+Enter is a newline. `isComposing`
          // keeps an IME's Enter from submitting a half-typed word.
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <MentionPopover list={mention} listId={mentionListId} />
      <SkillPopover menu={skill} listId={skillListId} />
      <PastedTexts
        pastes={pastesIn(text, pastesRef.current)}
        frozen={busy || awaiting || held}
        onRemove={(id) => editPaste(id, 'remove')}
        onInsert={(id) => editPaste(id, 'insert')}
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
          disabled={busy || awaiting || held || (text.trim().length === 0 && waiting.length === 0 && waitingCode.length === 0 && waitingCi === null)}
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
