/**
 * The Review Guide's Context step on screen (#444): its section at the top of
 * a guide, the banner when it failed, and the per-project sheet where the
 * user writes what it should also look up and which of their MCP tools it may
 * use. What it runs and what it keeps are context.ts, writer.ts and
 * validate.ts; this file only shows them.
 *
 * Everything the step wrote is shown as text: names and summary in text
 * nodes, a source's link opened only through openExternal (http(s) only).
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { openExternal } from '../lib/openUrl';
import { hostOf } from '../lib/urls';
import {
  CONTEXT_FRAME,
  CONTEXT_GIVEN,
  CONTEXT_INSTRUCTIONS_MAX_CHARS,
  CONTEXT_MAX_TOOLS,
  CONTEXT_MODELS,
  CONTEXT_TIMEOUTS,
  DEFAULT_CONTEXT,
  contextActive,
  contextKey,
  gatherContextInput,
  saveContextSettings,
  settingsOf,
  useContextLoad,
  validToolName,
  type ContextModel,
  type ContextSettings,
  type ContextTask,
} from './context';
import { GuideError, writeContext } from './writer';
import { contextFailureReason } from './store';
import type { GuideContext, GuideSource } from './validate';
import '../ui/worktree.css';
import './guide.css';

export const CONTEXT_MENU_LABEL = 'Review Guide Context…';

// ---------------------------------------------------------------------------
// In the guide
// ---------------------------------------------------------------------------

function Sources({ sources }: { sources: readonly GuideSource[] }): ReactNode {
  if (sources.length === 0) return null;
  return (
    <div className="gd-context-sources">
      {sources.map((s) =>
        s.url ? (
          <button
            key={s.name}
            type="button"
            className="gd-context-source gd-context-source-link"
            title={s.url}
            onClick={() => void openExternal(s.url!)}
          >
            {s.name}
            {/* Where the link goes, beside what it is called (#444 review). */}
            <span className="gd-context-source-host">{` · ${hostOf(s.url) ?? ''}`}</span>
          </button>
        ) : (
          <span key={s.name} className="gd-context-source">
            {s.name}
          </span>
        ),
      )}
    </div>
  );
}

/** The Context section at the top of a guide (#444). */
export function ContextSection({
  context,
  onEdit,
}: {
  context: Pick<GuideContext, 'summary' | 'sources'>;
  onEdit?: () => void;
}): ReactNode {
  return (
    <section className="gd-context" aria-label="Context">
      <div className="gd-context-head">
        <h3 className="gd-context-title">Context</h3>
        <span className="gd-context-by">
          from your instructions
          {onEdit ? (
            <>
              {' · '}
              <button type="button" className="gd-link" onClick={onEdit}>
                Edit…
              </button>
            </>
          ) : null}
        </span>
      </div>
      <p className="gd-context-text">{context.summary}</p>
      <Sources sources={context.sources} />
    </section>
  );
}

/** The Context step failed or timed out (#444): said once, above the guide, with Try Again. */
export function ContextFailureBanner({ reason, onRetry, busy }: { reason: string; onRetry: () => void; busy: boolean }): ReactNode {
  return (
    <div className="gd-banner gd-context-failed" role="status">
      <span>Context wasn’t added: {reason}. The guide below is written without it.</span>
      <button type="button" className="gd-btn" onClick={onRetry} disabled={busy}>
        Try Again
      </button>
    </div>
  );
}

/** Seconds since `from`, ticking once a second while shown. */
export function useElapsed(from: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (from === null) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [from]);
  return from === null ? 0 : Math.max(0, Math.floor((now - from) / 1000));
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

export interface GuideContextSheetProps {
  projectId: number;
  projectName: string;
  /** The task the guide is open on: what "Try on the selected task" reads. */
  task: ContextTask | null;
  /** What that task is measured against, for its commit subjects. */
  base: string;
  onClose: () => void;
  /** Saved; `changed` when the instructions, tools or model differ from before. */
  onSaved?: (changed: boolean) => void;
}

type TryState =
  | { kind: 'running'; startedAt: number }
  | { kind: 'done'; context: GuideContext; allowed: string[] | null }
  | { kind: 'error'; reason: string };

/** `mcp__support` rather than `mcp__support__search`: a whole server. */
export function isServerName(name: string): boolean {
  return !name.slice('mcp__'.length).includes('__');
}

/** What allowing a whole server means, in the sheet's words; `count` once a Try has listed it. */
export function serverWarning(name: string, count: number | null): string {
  const all = count === null ? 'all the tools of this server' : `all ${count} ${count === 1 ? 'tool' : 'tools'} of this server`;
  return `${name} allows ${all}, including any that can write; list single tools to be safe.`;
}

function namesIn(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}

export function GuideContextSheet({ projectId, projectName, task, base, onClose, onSaved }: GuideContextSheetProps): ReactNode {
  const saved = useContextLoad(projectId);
  const [draft, setDraft] = useState<ContextSettings | null>(null);
  useEffect(() => {
    // A file that cannot be read starts from the defaults, with the error
    // shown above them: never an empty sheet that looks like nothing saved.
    if (draft === null && saved !== undefined) setDraft(settingsOf(saved) ?? DEFAULT_CONTEXT);
  }, [draft, saved]);
  const [typed, setTyped] = useState('');
  const [toolError, setToolError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [trial, setTrial] = useState<TryState | null>(null);
  const trialRun = useRef(0);
  const elapsed = useElapsed(trial?.kind === 'running' ? trial.startedAt : null);

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
  // A Try still running when the sheet goes is forgotten, never shown elsewhere.
  useEffect(() => () => void (trialRun.current += 1), []);

  const addTyped = (text: string): boolean => {
    if (!draft) return false;
    const names = namesIn(text);
    if (names.length === 0) return true;
    const bad = names.filter((n) => !validToolName(n));
    if (bad.length > 0) {
      setToolError(
        `${bad.join(', ')} ${bad.length === 1 ? 'isn’t an MCP tool or server name' : 'aren’t MCP tool or server names'}. They start with mcp__.`,
      );
      return false;
    }
    const tools = [...new Set([...draft.tools, ...names])];
    if (tools.length > CONTEXT_MAX_TOOLS) {
      setToolError(`At most ${CONTEXT_MAX_TOOLS} tools.`);
      return false;
    }
    setDraft({ ...draft, tools });
    setToolError(null);
    return true;
  };

  // A name still in the box counts, as if Enter had been pressed (#444 review).
  const typedValid = namesIn(typed).filter(validToolName);
  const effective = draft ? { ...draft, tools: [...new Set([...draft.tools, ...typedValid])] } : null;
  const needsTool = effective !== null && effective.instructions.trim() !== '' && effective.tools.length === 0;
  const canTry = effective !== null && task !== null && contextActive(effective) && trial?.kind !== 'running';
  const lastAllowed = trial?.kind === 'done' ? trial.allowed : null;
  const servers = (effective?.tools ?? []).filter(isServerName);

  const tryIt = () => {
    if (!effective || !task || !contextActive(effective)) return;
    const run = ++trialRun.current;
    const settings = effective;
    setTrial({ kind: 'running', startedAt: Date.now() });
    void gatherContextInput(task, base)
      .then((input) => writeContext(settings, input))
      .then(
        ({ context, allowed }) => {
          if (trialRun.current === run) setTrial({ kind: 'done', context, allowed });
        },
        (err: unknown) => {
          const e = err instanceof GuideError ? err : new GuideError('failed', err instanceof Error ? err.message : String(err));
          if (trialRun.current === run) setTrial({ kind: 'error', reason: contextFailureReason(e, settings.timeoutMs) });
        },
      );
  };

  const save = async () => {
    if (!draft || needsTool) return;
    // Whatever is still typed in the tool box counts, as if Enter was pressed.
    if (typed.trim() && !addTyped(typed)) return;
    const next = typed.trim() ? { ...draft, tools: [...new Set([...draft.tools, ...namesIn(typed)])] } : draft;
    setBusy(true);
    setSaveError(null);
    try {
      const before = settingsOf(saved) ?? DEFAULT_CONTEXT;
      await saveContextSettings(projectId, next);
      onSaved?.(contextKey(before) !== contextKey(next));
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
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
      <div className="wt-modal" role="dialog" aria-modal="true" aria-labelledby="gc-title" onMouseDown={(e) => e.stopPropagation()}>
        <div className="wt-modal-head">
          <h2 className="wt-modal-title" id="gc-title">
            Review Guide Context · {projectName}
          </h2>
        </div>
        <div className="wt-modal-body">
          <p className="gc-lead">
            Before writing a guide for this project, Albedo runs one extra step with your instructions and the tools you allow. Its answer
            goes at the top of the guide and into the notes.
          </p>
          {draft === null ? (
            <div className="wt-hint">Reading the settings…</div>
          ) : (
            <>
              {saved?.kind === 'unreadable' ? (
                <div className="wt-error" role="alert">
                  <div className="wt-error-head">The saved settings couldn’t be read. Saving replaces them.</div>
                  <pre className="wt-error-body">{saved.message}</pre>
                </div>
              ) : null}
              <div className="wt-field">
                <label className="wt-label" htmlFor="gc-instructions">
                  Also look up
                </label>
                <textarea
                  id="gc-instructions"
                  className="wt-input wt-textarea"
                  rows={5}
                  value={draft.instructions}
                  maxLength={CONTEXT_INSTRUCTIONS_MAX_CHARS}
                  disabled={busy}
                  autoFocus
                  placeholder="Find the ticket this branch is for (its key is usually in the branch name or the PR title) in my tracker. Read its description and comments, and the support conversations linked to it."
                  onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
                />
                <div className="wt-hint">Written by you, in your words. Leave empty to keep the guide as it is today.</div>
              </div>

              <div className="wt-field">
                <label className="wt-label" htmlFor="gc-tool-input">
                  Tools it may use
                </label>
                <div className="gc-tools">
                  {draft.tools.map((t) => (
                    <span key={t} className="wt-chip gc-tool">
                      {t}
                      <button
                        type="button"
                        className="gc-tool-remove"
                        aria-label={`Remove ${t}`}
                        title={`Remove ${t}`}
                        disabled={busy}
                        onClick={() => setDraft({ ...draft, tools: draft.tools.filter((x) => x !== t) })}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <input
                    id="gc-tool-input"
                    className="gc-tool-input"
                    value={typed}
                    disabled={busy}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="+ tool name or server…"
                    aria-invalid={toolError !== null}
                    aria-describedby="gc-tools-hint"
                    onChange={(e) => {
                      setTyped(e.target.value);
                      setToolError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ',') {
                        e.preventDefault();
                        if (addTyped(typed)) setTyped('');
                      } else if (e.key === 'Backspace' && typed === '' && draft.tools.length > 0) {
                        setDraft({ ...draft, tools: draft.tools.slice(0, -1) });
                      }
                    }}
                  />
                </div>
                {toolError ? (
                  <div className="wt-hint gc-error" role="alert">
                    {toolError}
                  </div>
                ) : null}
                <div className="wt-hint" id="gc-tools-hint">
                  Only these, read-only ones. A server name (<span className="wt-mono">mcp__support</span>) allows all of its tools. No
                  file, shell or web tools, ever.
                </div>
                {servers.map((name) => (
                  <div key={name} className="wt-hint gc-warn">
                    {serverWarning(name, lastAllowed === null ? null : lastAllowed.filter((t) => t.startsWith(`${name}__`)).length)}
                  </div>
                ))}
                {needsTool ? <div className="wt-hint gc-error">Add a tool it may use, or leave the instructions empty.</div> : null}
              </div>

              <div className="wt-field gc-row">
                <label className="gc-inline">
                  Model
                  <select
                    className="wt-select gc-select"
                    value={draft.model}
                    disabled={busy}
                    onChange={(e) => setDraft({ ...draft, model: e.target.value as ContextModel })}
                  >
                    {CONTEXT_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="gc-inline">
                  Time limit
                  <select
                    className="wt-select gc-select"
                    value={draft.timeoutMs}
                    disabled={busy}
                    onChange={(e) => setDraft({ ...draft, timeoutMs: Number(e.target.value) })}
                  >
                    {CONTEXT_TIMEOUTS.map((t) => (
                      <option key={t.ms} value={t.ms}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <details className="gc-fixed">
                <summary>What it is given, and the fixed part of the prompt</summary>
                <div className="gc-fixed-body">
                  {`Given: ${CONTEXT_GIVEN}\n\nFixed: "${CONTEXT_FRAME}"\n\nYour instructions are added after this, as written.`}
                </div>
              </details>

              {trial ? (
                <div className="gc-trial" role="status" aria-live="polite">
                  {trial.kind === 'running' ? (
                    <span className="gc-trial-running">
                      <span className="gd-spinner" aria-hidden="true" />
                      Reading context · your instructions · {elapsed}s
                    </span>
                  ) : trial.kind === 'done' ? (
                    <ContextSection context={trial.context} />
                  ) : (
                    <div className="gc-error">Context wasn’t added: {trial.reason}.</div>
                  )}
                </div>
              ) : null}

              {saveError ? (
                <div className="wt-error">
                  <div className="wt-error-head">Couldn’t save the settings</div>
                  <pre className="wt-error-body">{saveError}</pre>
                </div>
              ) : null}
            </>
          )}
        </div>
        <div className="wt-modal-foot">
          <button
            type="button"
            className="gd-link"
            disabled={!canTry}
            onClick={tryIt}
            title={
              task === null
                ? 'Open a task’s guide to try this on it'
                : 'Run only the Context step on the selected task, with what is typed here, and show its answer'
            }
          >
            Try on the selected task
          </button>
          <span className="wt-foot-spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || draft === null || needsTool} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// In Projects…
// ---------------------------------------------------------------------------

/**
 * The Context step's place among a project's settings (#444 review), beside
 * the Review Guide's defaults: what it is set to, and Edit… for the sheet.
 * The sheet saves on its own (its own file), not with the project form.
 */
export function GuideContextField({ projectId, projectName, busy }: { projectId: number | null; projectName: string; busy: boolean }): ReactNode {
  const load = useContextLoad(projectId);
  const [open, setOpen] = useState(false);
  const settings = settingsOf(load);
  const state =
    projectId === null
      ? 'Save the project first, then set what its guides also look up.'
      : load === undefined
        ? 'Reading…'
        : load.kind === 'unreadable'
          ? 'Its settings couldn’t be read.'
          : contextActive(settings)
            ? `On · ${settings.tools.length} ${settings.tools.length === 1 ? 'tool' : 'tools'} · Claude ${
                CONTEXT_MODELS.find((m) => m.id === settings.model)?.label ?? settings.model
              } · ${CONTEXT_TIMEOUTS.find((t) => t.ms === settings.timeoutMs)?.label ?? ''}`
            : 'Off';
  return (
    <div className="wt-field">
      <span className="wt-label" id="wt-proj-guide-context">
        Review Guide: Context <span className="wt-label-optional">Looked up in your own tools first</span>
      </span>
      <div className="wt-confirm-actions wt-guide-actions">
        <span className="wt-modal-sub" aria-labelledby="wt-proj-guide-context">
          {state}
        </span>
        <button
          type="button"
          className="btn"
          disabled={busy || projectId === null}
          aria-label="Edit Review Guide Context"
          onClick={() => setOpen(true)}
        >
          Edit…
        </button>
      </div>
      <div className="wt-hint">
        Your instructions and the MCP tools they may use, for one extra step before each guide of this project. Saved on its own,
        not with this form.
      </div>
      {open && projectId !== null ? (
        <GuideContextSheet projectId={projectId} projectName={projectName} task={null} base="" onClose={() => setOpen(false)} />
      ) : null}
    </div>
  );
}
