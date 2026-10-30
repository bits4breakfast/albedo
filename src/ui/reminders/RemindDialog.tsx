/**
 * "Remind Me…" (#156): set a reminder on a task, and see, change or delete
 * the ones still to come.
 *
 *   ┌ Remind Me · fix login retry ───────────────────────────────┐
 *   │ Remind me to                                               │
 *   │ [Check whether the retry fix held after the deploy.     ]  │
 *   │ When                                                       │
 *   │ [tomorrow 9:00              ] [2026-10-31 09:00 ▾]         │
 *   │ Fri Oct 31, 09:00                                          │
 *   │ [In 1 Hour] [In 3 Hours] [Tomorrow 09:00] [Monday 09:00]   │
 *   │                                                            │
 *   │ Coming up on this task                                     │
 *   │ Ping QA about the flaky test        [Edit] [Delete]        │
 *   │ today 17:30                                                │
 *   ├────────────────────────────────────────────────────────────┤
 *   │                                 [Cancel] [Set Reminder ⌘↩] │
 *   └────────────────────────────────────────────────────────────┘
 *
 * The time is typed in words (when.ts) or picked; typing wins while there
 * is any. It must be in the future. Edit loads one into the form, and Save
 * Changes moves it (text and time); Delete removes it for good.
 */

import { useEffect, useMemo, useState } from 'react';
import type { Reminder, Task } from '../../types';
import { createReminder, deleteReminder, updateReminder } from '../../reminders';
import { parseWhen, toLocalInput, tomorrowMorning, whenText } from '../../reminders/when';
import { wrapForTooltip } from '../text';
import { usePendingReminders } from './useReminders';
import '../worktree.css';
import './reminders.css';

const HOUR = 60 * 60_000;

/** The time the form names: the words if any, else the picker. Null when neither reads. */
export function chosenTime(words: string, picked: string, now: Date): number | null {
  if (words.trim() !== '') return parseWhen(words, now);
  if (picked === '') return null;
  const t = new Date(picked).getTime();
  return Number.isFinite(t) ? t : null;
}

function nextMonday(now: Date): number {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0);
  do d.setDate(d.getDate() + 1);
  while (d.getDay() !== 1);
  return d.getTime();
}

export default function RemindDialog({ task, onClose }: { task: Pick<Task, 'id' | 'title'>; onClose: () => void }) {
  const pending = usePendingReminders(task.id);
  const [text, setText] = useState('');
  const [words, setWords] = useState('');
  const [picked, setPicked] = useState('');
  const [editing, setEditing] = useState<Reminder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Re-read relative words ("in 2 h") against the clock as it moves.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const at = chosenTime(words, picked, now);
  const typed = words.trim() !== '' || picked !== '';
  const future = at !== null && at > now.getTime();
  const reading = !typed ? null : at === null ? 'Not understood. Try “in 2 h”, “tomorrow 9:00” or “fri 14:30”.' : !future ? 'That time has passed.' : whenText(at, now);
  const canSave = !busy && text.trim() !== '' && future;

  const quick = useMemo(
    () => [
      { label: 'In 1 Hour', at: now.getTime() + HOUR },
      { label: 'In 3 Hours', at: now.getTime() + 3 * HOUR },
      { label: 'Tomorrow 09:00', at: tomorrowMorning(now) },
      { label: 'Monday 09:00', at: nextMonday(now) },
    ],
    [now],
  );

  const reset = () => {
    setText('');
    setWords('');
    setPicked('');
    setEditing(null);
    setError(null);
  };

  const save = async () => {
    if (!canSave || at === null) return;
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        const ok = await updateReminder(editing.id, { text, dueAt: at });
        if (!ok) {
          setError('It has already come back, so it can no longer be changed here.');
          return;
        }
        reset();
      } else {
        await createReminder({ taskId: task.id, text, dueAt: at, createdBy: 'user' });
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (r: Reminder) => {
    setEditing(r);
    setText(r.text);
    setWords('');
    setPicked(toLocalInput(r.dueAt));
    setError(null);
  };

  return (
    <div
      className="wt-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="wt-modal" role="dialog" aria-modal="true" aria-labelledby="rm-title" onMouseDown={(e) => e.stopPropagation()}>
        <div className="wt-modal-head">
          <h2 className="wt-modal-title" id="rm-title">
            {editing ? 'Change Reminder' : 'Remind Me'}
          </h2>
          <span className="wt-modal-sub wt-modal-task" title={wrapForTooltip(task.title)}>
            {task.title}
          </span>
        </div>

        <form
          className="wt-modal-body"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.metaKey) {
              e.preventDefault();
              void save();
            }
          }}
        >
          <div className="wt-field">
            <label className="wt-label" htmlFor="rm-text">
              Remind me to
            </label>
            <textarea
              id="rm-text"
              className="wt-input wt-textarea rm-textarea"
              rows={3}
              value={text}
              autoFocus
              placeholder="Check whether the fix held after the deploy"
              onChange={(e) => setText(e.target.value)}
            />
          </div>

          <div className="wt-field">
            <label className="wt-label" htmlFor="rm-when">
              When
            </label>
            <div className="rm-when-row">
              <input
                id="rm-when"
                className="wt-input"
                value={words}
                placeholder="in 2 h, tomorrow 9:00, fri 14:30"
                onChange={(e) => setWords(e.target.value)}
              />
              <input
                className="wt-input rm-picker"
                type="datetime-local"
                aria-label="Date and time"
                value={picked}
                onChange={(e) => {
                  setPicked(e.target.value);
                  setWords('');
                }}
              />
            </div>
            {reading ? (
              <div className="rm-when-read" data-bad={!future} role="status">
                {reading}
              </div>
            ) : null}
            <div className="rm-quick">
              {quick.map((q) => (
                <button
                  key={q.label}
                  type="button"
                  className="btn"
                  onClick={() => {
                    setWords('');
                    setPicked(toLocalInput(q.at));
                  }}
                >
                  {q.label}
                </button>
              ))}
            </div>
          </div>

          {error ? <div className="rm-when-read" data-bad="true">{error}</div> : null}

          <h3 className="rm-list-head">Coming Up on This Task</h3>
          {pending.length === 0 ? (
            <div className="rm-empty">Nothing set yet.</div>
          ) : (
            <ul className="rm-list">
              {pending.map((r) => (
                <li key={r.id} className="rm-item" data-editing={editing?.id === r.id}>
                  <div className="rm-item-body">
                    <div className="rm-item-text">{r.text}</div>
                    <div className="rm-item-due">
                      {whenText(r.dueAt, now)}
                      {r.state === 'snoozed' ? ' · snoozed' : ''}
                      {r.createdBy === 'session' ? ' · set by Claude' : ''}
                    </div>
                  </div>
                  <button type="button" className="btn btn-ghost" onClick={() => startEdit(r)} disabled={busy}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busy}
                    onClick={() => {
                      if (editing?.id === r.id) reset();
                      void deleteReminder(r.id).catch((err: unknown) => setError(String(err)));
                    }}
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
        </form>

        <div className="wt-modal-foot">
          <span className="wt-foot-spacer" />
          {editing ? (
            <button type="button" className="btn btn-ghost" onClick={reset}>
              Stop Editing
            </button>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
          )}
          <button type="button" className="btn btn-primary" disabled={!canSave} onClick={() => void save()}>
            {editing ? 'Save Changes' : 'Set Reminder'} <span className="kbd" aria-hidden="true">⌘↩</span>
          </button>
        </div>
      </div>
    </div>
  );
}
