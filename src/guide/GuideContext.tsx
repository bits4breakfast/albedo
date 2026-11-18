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
  useContextSettings,
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

type TryState = { kind: 'running'; startedAt: number } | { kind: 'done'; context: GuideContext } | { kind: 'error'; reason: string };

export function GuideContextSheet({ projectId, projectName, task, base, onClose, onSaved }: GuideContextSheetProps): ReactNode {
  const saved = useContextSettings(projectId);
  const [draft, setDraft] = useState<ContextSettings | null>(null);
  useEffect(() => {
    if (draft === null && saved !== undefined) setDraft(saved ?? DEFAULT_CONTEXT);
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
    const names = text.split(/[\s,]+/).filter(Boolean);
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

  const needsTool = draft !== null && draft.instructions.trim() !== '' && draft.tools.length === 0;
  const canTry = draft !== null && task !== null && contextActive(draft) && trial?.kind !== 'running';

  const tryIt = () => {
    if (!draft || !task || !contextActive(draft)) return;
    const run = ++trialRun.current;
    const settings = draft;
    setTrial({ kind: 'running', startedAt: Date.now() });
    void gatherContextInput(task, base)
      .then((input) => writeContext(settings, input))
      .then(
        (context) => {
          if (trialRun.current === run) setTrial({ kind: 'done', context });
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
    const next = typed.trim() ? { ...draft, tools: [...new Set([...draft.tools, ...typed.split(/[\s,]+/).filter(Boolean)])] } : draft;
    setBusy(true);
    setSaveError(null);
    try {
      const before = saved ?? DEFAULT_CONTEXT;
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
