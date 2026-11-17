/**
 * The band between the transcript and the composer (#409): In Claude Code
 * (Claude Code's queue) and Held (Albedo's outbox). To Send, under it, is the
 * composer's.
 */

import {
  draftOf,
  foldPastes,
  markPastes,
  queuedLabel,
} from './pastedText';
import { markMentions, unmarkMentions, type Mention } from './mentions';
import { markQuotes, unmarkQuotes } from './transcriptQuotes';
import {
  allNowSize,
  editHeld,
  nextRunSize,
  onEditingChange,
  removeHeld,
  sendAnyway,
  setEditing,
  takeableIntoBox,
  useHeld,
  type HeldMessage,
} from './outbox';
import {
  conditionsFor,
  heldGoes,
  heldHint,
  heldLabel,
  sendAllNow,
  sendAllNowOffered,
  sendNow,
  sendNowAllowed,
  sendNowOfferedFor,
  type ReleaseConditions,
} from './outboxRelease';
import { onTurnChange, shownQueue } from './turn';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  onQueueChange,
  queuedFor,
  queueSettlesAt,
  type QueuedEntry,
} from '../../capture';
import { onPromptChange } from '../../capture/hookEvents';
import { onTrustWaiting } from '../../capture/workspaceTrust';
import { onPreviewChange } from '../../capture/previewGate';
import { onDeletionChange } from '../../capture/githubGate';
import { onConnectivityChange, watchConnectivity } from '../../lib/connectivity';
import { REMOTE_MENU_HINT } from './RemoteMenuNotice';
import { notDeliveredNote } from './delivery';
import { onAwaitingDeliveryChange } from './deliveryGate';
import { onAwaitingStartChange } from './startGate';
import { useRemoteWait } from '../remoteWait';

/**
 * What you sent and Claude Code has not taken yet, in one band between the
 * transcript and the composer. Two kinds, in the order they will go:
 *
 *  - In Claude Code: Claude Code's queue, read from the transcript's queue records
 *    (src/capture/queue.ts). Each entry leaves the moment Claude Code takes
 *    it, as the next turn or folded into the one running -- and then appears
 *    in the transcript as your message. Shown while the session is alive,
 *    and only what this process queued (`shownQueue`). Entries Claude Code queued itself (a background task
 *    finishing, a subagent's message) are not shown.
 *  - Held: Albedo's outbox (outbox.ts), sent while offline, or while a turn was
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
  // Taken into the message box with ↑ (#399): one line says where they are,
  // and the rest keep their rows.
  const inBox = held.filter((h) => h.inBox);
  const rest = inBox.length > 0 ? held.filter((h) => !h.inBox) : held;
  const mine = shownQueue(entries, liveSince);
  // Claude Code takes nothing from its queue while Remote Control's menu is up (#343).
  const menu = useRemoteWait(taskId)?.phase === 'menu';
  // Claude Code's entries are on their way to the API: watch it.
  const waiting = mine.length > 0;
  useEffect(() => (waiting ? watchConnectivity() : undefined), [waiting]);

  if (mine.length === 0 && held.length === 0) return null;
  return (
    <div className="tx-queued" role="status" aria-label="In Claude Code and Held messages">
      {mine.length > 0 ? (
        <>
          {/* Albedo never types into the terminal, so these are changed there (#399). */}
          <div
            className="tx-queued-head"
            // While Remote Control's menu is up (#343) its hint takes the line;
            // where they are changed is still said, here.
            title={
              menu
                ? 'Claude Code sends these once Remote Control\u2019s menu is answered. Change them in the terminal (\u2191).'
                : 'Claude Code sends these when it finishes its current step'
            }
          >
            <span>
              In Claude Code · <span className="tx-queued-count">{mine.length}</span>
            </span>
            <span className="tx-queued-hint">
              {menu ? (
                REMOTE_MENU_HINT
              ) : (
                <>
                  change them in the terminal (<kbd>{'\u2191'}</kbd>)
                </>
              )}
            </span>
          </div>
          {mine.map((e, i) => (
            <div key={`${e.ts}-${i}`} className="tx-queued-item" title={foldPastes(e.text)}>
              {queuedLabel(e.text)}
            </div>
          ))}
        </>
      ) : null}
      {inBox.length > 0 ? (
        <div className="tx-queued-head">
          <span>
            Held · <span className="tx-queued-count">{inBox.length}</span>
          </span>
          <span className="tx-queued-why">being edited in the message box</span>
        </div>
      ) : null}
      {rest.length > 0 && taskId !== null ? <HeldGroup taskId={taskId} held={rest} inBox={inBox.length} /> : null}
    </div>
  );
}

/**
 * The outbox's part of the band, headed by what its messages wait for.
 *
 * With two or more that could each be sent now, the head offers Send All Now
 * on the right (#290), after why they are held (#409); how they would go
 * when left alone is in its tooltip: they go into the running turn as one
 * message, as the turn's end would send them.
 * One open for editing is left out and stays held. If they could not go
 * after all -- a release had the task's lock -- the head says so briefly.
 */
function HeldGroup({
  taskId,
  held,
  inBox,
}: {
  taskId: number;
  /** The held messages not in the message box. */
  held: readonly HeldMessage[];
  /** How many are in the message box (#399). */
  inBox: number;
}): ReactNode {
  const conditions = useReleaseConditions(taskId);
  const [notNow, showNotNow] = useBriefNote();
  // Held messages go together, as one (#240): the hint says so when they will.
  // While Remote Control's menu is up (#343), what they wait on is that menu.
  const menu = useRemoteWait(taskId)?.phase === 'menu';
  const together = nextRunSize(taskId);
  // Behind messages being edited in the box (#399), nothing goes until those
  // are sent or put back, whatever else would let them.
  const behindBox = inBox > 0 && together === 0 && !conditions.headMaybeSent;
  const turnHint = behindBox ? 'until the message being edited is sent' : heldHint(conditions);
  // Remote Control's menu (#343) is what holds them only where the turn alone would.
  const menuHolds = menu && !behindBox && !conditions.headMaybeSent && !conditions.offline && !conditions.promptOpen && conditions.turnRunning;
  const hint = menuHolds ? REMOTE_MENU_HINT : turnHint;
  const goes = behindBox ? null : heldGoes(conditions, together);
  // ↑ in the empty message box takes them all into it (#399): said here once
  // there are two or more it would take.
  const editAll = inBox === 0 ? takeableIntoBox(taskId).length : 0;
  const allSize = allNowSize(taskId);
  const allOffered = sendAllNowOffered(conditions, allSize);
  const allowed = sendNowAllowed(conditions);
  const left = held.length - allSize;
  const allTitle = allowed
    ? `Send these ${allSize} into the running turn now, as one message: Claude takes it at its next step.` +
      (goes !== null ? ` Left alone: ${goes.charAt(0).toLowerCase()}${goes.slice(1)}.` : '') +
      (left === 1 ? ' The one you\u2019re editing stays held.' : left > 1 ? ' The ones you\u2019re editing stay held.' : '') +
      (inBox > 0 ? ' The ones being edited in the message box stay there.' : '')
    : 'Not while Claude is asking you something, or the session is not running';
  return (
    <>
      <div className="tx-queued-head" title={goes ?? undefined}>
        <span>
          {behindBox ? 'Held' : heldLabel(conditions)} · <span className="tx-queued-count">{held.length}</span>
        </span>
        {/* Why, read with the count (#409), before Send All Now as well. */}
        {hint !== null ? <span className="tx-queued-why">{hint}</span> : null}
        {allOffered ? (
          <>
            {notNow ? <span className="tx-queued-note">Couldn{'\u2019'}t send now — try again</span> : null}
            <button
              type="button"
              className="tx-btn tx-queued-act tx-queued-all"
              onClick={() =>
                void sendAllNow(taskId).then((went) => {
                  if (!went) showNotNow();
                })
              }
              // Disabled while its own write is on its way (every one it covers is
              // being written), as a row's Send Now is while its row is.
              disabled={!allowed || held.filter((h) => h.sending === true).length >= allSize}
              title={allTitle}
            >
              Send All Now
            </button>
          </>
        ) : null}
        {editAll >= 2 ? (
          <span
            className="tx-queued-key"
            title={`In the empty message box, press \u2191 to edit ${editAll === held.length ? 'these' : `${editAll} of these, up to the next one it can\u2019t take,`} there as one message; Esc puts them back`}
          >
            <kbd>{'\u2191'}</kbd> Edit All
          </span>
        ) : null}
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

/** "Couldn't send now", shown for `SEND_NOW_NOTE_MS` after `show()`. */
function useBriefNote(): [boolean, () => void] {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!shown) return;
    const t = window.setTimeout(() => setShown(false), SEND_NOW_NOTE_MS);
    return () => window.clearTimeout(t);
  }, [shown]);
  return [shown, () => setShown(true)];
}

/**
 * What the task's held messages wait for. Re-read on the connection, a
 * prompt, the trust dialog or the turn changing, a held message opened or
 * closed for editing (what goes next changes with it), and on any render:
 * the outbox and the pty already re-render the band.
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
      onPreviewChange(mine),
      onDeletionChange(mine),
      onTurnChange(mine),
      onEditingChange(mine),
      onAwaitingDeliveryChange(mine),
      onAwaitingStartChange(mine),
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
  const [notNow, showNotNow] = useBriefNote();
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // A paste is edited as the box shows it, a token standing for its text,
  // and goes back in its marker on save (pastedText.ts).
  const pastesRef = useRef<ReadonlyMap<number, string>>(new Map());
  // References too: `@[Title]` in the field, its marker on save (mentions.ts).
  const mentionsRef = useRef<ReadonlyMap<string, Mention>>(new Map());
  // And a quoted passage (#187): `[Quote #1: …]` in the field, its marker on save.
  const quotesRef = useRef<ReadonlyMap<number, string>>(new Map());
  const openedRef = useRef('');
  const bodyOf = (draft: string) =>
    markPastes(markQuotes(markMentions(draft, mentionsRef.current), quotesRef.current), pastesRef.current);
  const bodyOfRef = useRef(bodyOf);
  bodyOfRef.current = bodyOf;
  // Left open (a task switch): what was typed is kept, not thrown away.
  useEffect(
    () => () => {
      if (draftRef.current !== null) editHeld(taskId, held.id, bodyOfRef.current(draftRef.current));
      setEditing(taskId, held.id, false);
    },
    [taskId, held.id],
  );

  const open = () => {
    setEditing(taskId, held.id, true);
    const d = draftOf(held.text);
    const q = unmarkQuotes(d.text);
    const u = unmarkMentions(q.text);
    pastesRef.current = d.pastes;
    quotesRef.current = q.quotes;
    mentionsRef.current = u.mentions;
    openedRef.current = u.text;
    setDraft(u.text);
  };
  const close = (save: boolean) => {
    if (save && draft !== null && draft !== openedRef.current) editHeld(taskId, held.id, bodyOf(draft));
    setDraft(null);
    setEditing(taskId, held.id, false);
  };

  if (draft !== null) {
    return (
      /* A field and its Save / Cancel: Tab walks between them. */
      <div className="tx-queued-row" data-focus-keeps-tab="">
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
      <div className="tx-queued-item" title={foldPastes(held.text)}>
        {queuedLabel(held.text)}
      </div>
      {held.maybeSent ? (
        <>
          {/* Not delivered (#433): what Claude Code did with it is in the terminal. */}
          <span className="tx-queued-note">{held.notDelivered ? notDeliveredNote(held) : 'May already have been sent'}</span>
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
              if (!went) showNotNow();
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

/** How long a held row, or the head's Send All Now, says it could not go. */
const SEND_NOW_NOTE_MS = 3_000;
