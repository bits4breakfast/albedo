/**
 * A reminder that came back (#156), as its own card above the message box.
 *
 *   ┌ ⏰ Reminder · due today 09:00 · set Oct 30 by you ──────────────┐
 *   │ Check whether the retry fix held after the deploy.              │
 *   │ Task was at a1b2c3d on fix/login-retry · now 3 ahead            │
 *   │                 [Snooze ▾]  [Dismiss]  [Edit…]  [Send to Claude] │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * Never text in the message box: its own container, label and colour. Send
 * goes through the send gateway (send.ts); Edit… copies the text into the
 * message box and the reminder counts as sent once a message carrying it
 * goes; Snooze brings it back later; Dismiss ends it.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { getTask } from '../../db';
import { dismissReminder, markReminderSent, snoozeReminder } from '../../reminders';
import { parseWhen, toLocalInput, tomorrowMorning, whenText, dateText } from '../../reminders/when';
import { compareHead, whereText, type HeadCompare } from '../../reminders/where';
import type { Reminder, TaskStatus } from '../../types';
import OverflowMenu from '../OverflowMenu';
import { insertIntoComposer } from '../transcript/composerBridge';
import { ReminderGlyph } from './ReminderGlyph';
import { reminderMessage, reminderPlainText, sendReminderText } from './send';
import { useReminderCards } from './useReminders';
import './reminders.css';

/** Fired this much after its time, it says "was due": it waited for a launch. */
const LATE_MS = 2 * 60_000;
const HOUR_MS = 60 * 60_000;

/** "due today 09:00 · set Oct 30 by you". */
export function reminderMeta(r: Reminder, now: Date): string {
  const late = r.firedAt !== null && r.firedAt - r.dueAt > LATE_MS;
  const due = `${late ? 'was due' : 'due'} ${whenText(r.dueAt, now)}`;
  const by = r.createdBy === 'session' ? 'by Claude' : 'by you';
  return `${due} · set ${dateText(r.createdAt, now)} ${by}`;
}

export default function ReminderCards({ taskId, status }: { taskId: number; status: TaskStatus | null }): ReactNode {
  const cards = useReminderCards(taskId);
  if (cards.length === 0) return null;
  return (
    <>
      {cards.map((r) => (
        <ReminderCard key={r.id} reminder={r} taskId={taskId} status={status} />
      ))}
    </>
  );
}

type Note = { tone: 'info' | 'error'; text: string } | null;

export function ReminderCard({
  reminder: r,
  taskId,
  status,
}: {
  reminder: Reminder;
  /** The task showing the card: where Send and Edit… go. */
  taskId: number;
  status: TaskStatus | null;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [note, setNote] = useState<Note>(null);
  const [custom, setCustom] = useState(false);
  const [cmp, setCmp] = useState<HeadCompare | null>(null);

  // Where the task's HEAD is now, against what was recorded.
  useEffect(() => {
    let alive = true;
    if (r.headSha === null) return;
    void getTask(taskId)
      .then((t) => (t ? compareHead(t.worktreePath, r.headSha) : null))
      .then((c) => {
        if (alive) setCmp(c);
      })
      .catch(() => {
        /* the line then says only where it was */
      });
    return () => {
      alive = false;
    };
  }, [taskId, r.headSha]);

  const once = async (fn: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      console.warn('[reminders] card action failed:', err);
      setNote({ tone: 'error', text: 'That did not work. Try again.' });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const send = () =>
    once(async () => {
      const text = await reminderMessage(r, taskId);
      const out = await sendReminderText({ id: taskId, status: status ?? 'idle' }, text);
      if (out === 'failed') {
        setNote({ tone: 'error', text: 'Could not send it. The session may not be running; try again.' });
        return;
      }
      await markReminderSent(r.id);
    });

  const edit = () =>
    once(async () => {
      const text = await reminderPlainText(r, taskId);
      const key = r.text.trim().split('\n', 1)[0] ?? '';
      const took = insertIntoComposer({
        taskId,
        text,
        // Sent from the box: the reminder is done once a message carrying it goes.
        onSent: (sent) => {
          if (!sent.includes(key)) return false;
          void markReminderSent(r.id).catch((err: unknown) => console.warn('[reminders] mark sent failed:', err));
          return true;
        },
      });
      setNote(
        took
          ? { tone: 'info', text: 'In the message box. It counts as sent when that message goes.' }
          : { tone: 'error', text: 'The message box is not open for this task.' },
      );
    });

  const snooze = (at: number) => once(() => snoozeReminder(r.id, at));
  const now = new Date();
  const where = whereText(r, cmp);

  return (
    <section className="rm-card" aria-label="Reminder" data-focus-keeps-tab="">
      <div className="rm-head">
        <span className="rm-tag">
          <ReminderGlyph />
          Reminder
        </span>
        <span className="rm-meta">· {reminderMeta(r, now)}</span>
      </div>
      <div className="rm-text">{r.text}</div>
      {taskId !== r.taskId ? (
        <div className="rm-where">Set on an earlier task. Sending includes a brief of where it left off.</div>
      ) : null}
      {where ? <div className="rm-where">{where}</div> : null}
      {custom ? <CustomSnooze onSnooze={(at) => void snooze(at)} onCancel={() => setCustom(false)} disabled={busy} /> : null}
      {note ? (
        <div className="rm-note" data-tone={note.tone} role="status">
          {note.text}
        </div>
      ) : null}
      <div className="rm-actions">
        <OverflowMenu
          label="Snooze"
          title="Bring it back later"
          trigger={{ className: 'btn', content: <>Snooze ▾</> }}
          items={[
            { id: 'hour', label: 'In 1 Hour', onSelect: () => void snooze(Date.now() + HOUR_MS) },
            { id: 'tomorrow', label: 'Tomorrow at 09:00', onSelect: () => void snooze(tomorrowMorning(new Date())) },
            { id: 'custom', label: 'Custom…', onSelect: () => setCustom(true) },
          ]}
        />
        <button type="button" className="btn btn-ghost" onClick={() => void once(() => dismissReminder(r.id))} disabled={busy}>
          Dismiss
        </button>
        <span className="rm-spacer" />
        <button type="button" className="btn" onClick={() => void edit()} disabled={busy} title="Copy it into the message box to change it first">
          Edit…
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void send()}
          disabled={busy}
          title={
            status === 'running'
              ? 'A turn is running: it waits and is sent when the turn ends'
              : status === 'blocked'
                ? 'Claude is waiting on you: it is sent once that is answered'
                : 'Send it to Claude now'
          }
        >
          Send to Claude
        </button>
      </div>
    </section>
  );
}

/** "Custom…": a time in words or from the picker. */
function CustomSnooze({
  onSnooze,
  onCancel,
  disabled,
}: {
  onSnooze: (at: number) => void;
  onCancel: () => void;
  disabled: boolean;
}): ReactNode {
  const [words, setWords] = useState('');
  const [picked, setPicked] = useState(() => toLocalInput(Date.now() + HOUR_MS));
  const now = new Date();
  const fromWords = words.trim() === '' ? null : parseWhen(words, now);
  const fromPicker = picked ? new Date(picked).getTime() : NaN;
  const at = words.trim() !== '' ? fromWords : Number.isFinite(fromPicker) ? fromPicker : null;
  const ok = at !== null && at > now.getTime();
  return (
    <div className="rm-custom">
      <input
        className="wt-input rm-custom-words"
        aria-label="Snooze until"
        placeholder="in 3 h, tomorrow 14:00, fri 9:00"
        value={words}
        autoFocus
        onChange={(e) => setWords(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && ok) onSnooze(at);
          if (e.key === 'Escape') {
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <input
        className="wt-input rm-custom-picker"
        type="datetime-local"
        aria-label="Snooze until (date and time)"
        value={picked}
        onChange={(e) => {
          setPicked(e.target.value);
          setWords('');
        }}
      />
      <span className="rm-custom-when">{ok ? whenText(at, now) : words.trim() === '' ? '' : 'Not understood'}</span>
      <button type="button" className="btn btn-ghost" onClick={onCancel}>
        Cancel
      </button>
      <button type="button" className="btn" disabled={!ok || disabled} onClick={() => ok && onSnooze(at)}>
        Snooze
      </button>
    </div>
  );
}
