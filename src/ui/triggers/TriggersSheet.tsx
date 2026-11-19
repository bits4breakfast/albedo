/**
 * Triggers in Projects… (#448): beside CI Details, what each event on a
 * task's PR puts in front of you -- Off, Draft or Suggest, and Draft's
 * message. Its own file under `~/.albedo/triggers/` (settings.ts), saved by
 * its own sheet, not with the project form: personal, on this Mac, never in
 * the repo.
 *
 *   Triggers · <project>
 *   Yours only, kept on this Mac. ...
 *   Your PR is merged                          [Off | Draft]
 *     <template>
 *     The message Albedo drafts. ... Added for you: ...
 *   ...
 *   Your PR is approved and checks are green   [Off | Draft | Suggest]
 *     Suggests Squash and Merge…, the same dialog as the task bar's. ...
 *                                                   [Cancel] [Save]
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  DEFAULT_TRIGGERS,
  TRIGGER_EVENTS,
  TRIGGER_TEMPLATE_MAX_CHARS,
  anyTriggerOn,
  loadTriggerSettings,
  saveTriggerSettings,
  useTriggerLoad,
  type TriggerEvent,
  type TriggerMode,
  type TriggerSettings,
} from '../../triggers/settings';
import '../worktree.css';
import './triggers.css';

const MODE_LABEL: Record<TriggerMode, string> = { off: 'Off', draft: 'Draft', suggest: 'Suggest' };

/** Neutral sample text: a placeholder, never a default. */
const PLACEHOLDER: Record<TriggerEvent, string> = {
  merged: '/after-merge — watch the deploy for two hours and tell me about new errors.',
  ciFailed: 'Fix the failing checks. Explain the cause before changing anything.',
  review: 'Address these review threads. Propose the changes; don’t push.',
  approved: 'Rebase onto the base branch and run the tests once more.',
};

/** What Draft adds to the template, per event. */
const ADDED: Record<TriggerEvent, string> = {
  merged: 'PR number, title, merge commit.',
  ciFailed: 'the failure, as CI Details sets it up for this project.',
  review: 'the review threads with something new from someone else.',
  approved: 'who approved, the checks, no conflicts.',
};

function summaryOf(s: TriggerSettings): string {
  if (!anyTriggerOn(s)) return 'Off';
  return TRIGGER_EVENTS.filter((e) => s[e.id].mode !== 'off')
    .map((e) => `${SHORT[e.id]}: ${MODE_LABEL[s[e.id].mode]}`)
    .join(' · ');
}

const SHORT: Record<TriggerEvent, string> = {
  merged: 'Merged',
  ciFailed: 'CI failed',
  review: 'Review',
  approved: 'Approved',
};

export interface TriggersSheetProps {
  projectId: number;
  projectName: string;
  onClose: () => void;
}

export function TriggersSheet({ projectId, projectName, onClose }: TriggersSheetProps): ReactNode {
  const saved = useTriggerLoad(projectId);
  const [draft, setDraft] = useState<TriggerSettings | null>(null);
  useEffect(() => {
    // An unreadable file starts from Off, with the error shown above; one
    // that could not even be checked starts nothing until a read succeeds,
    // so a save can never overwrite a file the sheet did not see.
    if (draft === null && saved !== undefined && saved.kind !== 'unchecked') {
      setDraft(saved.kind === 'saved' ? saved.settings : DEFAULT_TRIGGERS);
    }
  }, [draft, saved]);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    // Capture, as the other dialogs do: nothing behind hears this Escape.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const set = (event: TriggerEvent, patch: Partial<TriggerSettings[TriggerEvent]>) => {
    if (!draft) return;
    setDraft({ ...draft, [event]: { ...draft[event], ...patch } });
  };

  const save = async () => {
    if (!draft || busy) return;
    setBusy(true);
    setSaveError(null);
    try {
      await saveTriggerSettings(projectId, draft);
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="wt-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="wt-modal" role="dialog" aria-modal="true" aria-labelledby="tg-title" onMouseDown={(e) => e.stopPropagation()}>
        <div className="wt-modal-head">
          <h2 className="wt-modal-title" id="tg-title">
            Triggers · {projectName}
          </h2>
        </div>
        <div className="wt-modal-body">
          <p className="tg-lead">
            Yours only, kept on this Mac. When an event happens on a task’s PR, the task gets a Waiting on You card. Nothing is sent or
            merged until you press its button.
          </p>
          {draft === null && saved?.kind === 'unchecked' ? (
            <div className="wt-error" role="alert">
              <div className="wt-error-head">Couldn’t check the saved settings: {saved.message}</div>
              <div className="wt-error-actions">
                <button type="button" className="btn" onClick={() => void loadTriggerSettings(projectId)}>
                  Try Again
                </button>
              </div>
            </div>
          ) : draft === null ? (
            <div className="wt-hint">Reading the settings…</div>
          ) : (
            <>
              {saved?.kind === 'unreadable' ? (
                <div className="wt-error" role="alert">
                  <div className="wt-error-head">The saved settings couldn’t be read, so every trigger is Off. Saving replaces them.</div>
                  <pre className="wt-error-body">{saved.message}</pre>
                </div>
              ) : null}
              {TRIGGER_EVENTS.map((e) => {
                const rule = draft[e.id];
                const labelId = `tg-ev-${e.id}`;
                return (
                  <div key={e.id} className="tg-row" data-event={e.id}>
                    <span className="tg-ev" id={labelId}>
                      {e.label}
                    </span>
                    <span className="seg seg-compact" role="group" aria-labelledby={labelId}>
                      {e.modes.map((m) => (
                        <button
                          key={m}
                          type="button"
                          aria-pressed={rule.mode === m}
                          disabled={busy}
                          onClick={() => set(e.id, { mode: m })}
                        >
                          {MODE_LABEL[m]}
                        </button>
                      ))}
                    </span>
                    {rule.mode === 'draft' ? (
                      <>
                        <textarea
                          className="wt-input wt-textarea tg-template"
                          aria-label={`${e.label}: the message Albedo drafts`}
                          rows={3}
                          value={rule.template}
                          maxLength={TRIGGER_TEMPLATE_MAX_CHARS}
                          disabled={busy}
                          placeholder={PLACEHOLDER[e.id]}
                          onChange={(ev) => set(e.id, { template: ev.target.value })}
                        />
                        <span className="wt-hint tg-hint">
                          The message Albedo drafts, for you to read, edit and send. It can start with a personal skill such as{' '}
                          <span className="wt-mono">/after-merge</span>. Added for you: {ADDED[e.id]}
                        </span>
                      </>
                    ) : rule.mode === 'suggest' ? (
                      <span className="wt-hint tg-hint">
                        Suggests <b>Squash and Merge…</b>, the same dialog as the task bar’s. Never merges on its own.
                      </span>
                    ) : null}
                  </div>
                );
              })}
              {saveError ? (
                <div className="wt-error">
                  <div className="wt-error-head">Couldn’t save the triggers</div>
                  <pre className="wt-error-body">{saveError}</pre>
                </div>
              ) : null}
            </>
          )}
        </div>
        <div className="wt-modal-foot">
          <span className="wt-foot-spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || draft === null} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Triggers' place among a project's settings, beside CI Details: what they
 * are set to, and Edit… for the sheet. The sheet saves on its own (its own
 * file), not with the project form.
 */
export function TriggersField({ projectId, projectName, busy }: { projectId: number | null; projectName: string; busy: boolean }): ReactNode {
  const load = useTriggerLoad(projectId);
  const [open, setOpen] = useState(false);
  const state =
    projectId === null
      ? 'Save the project first, then set its triggers.'
      : load === undefined
        ? 'Reading…'
        : load.kind === 'unreadable'
          ? 'Its settings couldn’t be read.'
          : load.kind === 'unchecked'
            ? 'Couldn’t check its settings.'
            : summaryOf(load.kind === 'saved' ? load.settings : DEFAULT_TRIGGERS);
  return (
    <div className="wt-field">
      <span className="wt-label" id="wt-proj-triggers">
        Triggers <span className="wt-label-optional">A next step when something happens to a task’s PR</span>
      </span>
      <div className="wt-confirm-actions wt-guide-actions">
        <span className="wt-modal-sub" aria-labelledby="wt-proj-triggers">
          {state}
        </span>
        <button
          type="button"
          className="btn"
          disabled={busy || projectId === null}
          aria-label="Edit Triggers"
          onClick={() => setOpen(true)}
        >
          Edit…
        </button>
      </div>
      <div className="wt-hint">
        Yours only, kept on this Mac. A fired trigger is a Waiting on You card on the task: a message drafted for you to send, or Squash
        and Merge… to click. Saved on its own, not with this form.
      </div>
      {open && projectId !== null ? <TriggersSheet projectId={projectId} projectName={projectName} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
