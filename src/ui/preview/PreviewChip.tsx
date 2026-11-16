/**
 * A `show_preview` call in the transcript (#348): one row per version, drawn
 * as every other tool row is (#356) -- icon, "Preview", the title, the
 * version, the question asked (or, from v2 on, what changed), and how it
 * ended on the right. A click opens that version, read only, over the reading
 * pane (PreviewViewer); nothing expands, so there is no caret.
 *
 * The version comes from Albedo's own copy (db/previews.ts), found by the
 * call's transcript id. Without one -- a session Albedo did not start, or a
 * task whose history was purged -- the row names the title from the call and
 * reads how it ended from the call's result, and there is nothing to open.
 */

import { useMemo } from 'react';
import type { ReactNode } from 'react';
import type { Message, PreviewOutcome } from '../../types';
import { outcomeOfResult } from '../../capture/previewGate';
import { str, toolInput, toolResultIsError, toolResultText, toolUseId } from '../transcript/ToolChip';
import { outcomeText } from './PreviewCard';
import { commentCount } from './previewComments';
import { openPreviewViewer } from './previewViewer';
import { usePreviewByToolUse } from './usePreviews';
import './preview.css';

/** A window: what the row is, drawn, so it can never fall back to a box. */
export function PreviewIcon(): ReactNode {
  return (
    <svg className="pv-row-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M1.5 5.5h13" />
    </svg>
  );
}

/** "Approved", "Changes requested · 2 comments", "Waiting on you", "Cancelled". */
export function rowState(outcome: PreviewOutcome, answer: string | null): string {
  const text = outcomeText(outcome);
  const said = text.charAt(0).toUpperCase() + text.slice(1);
  if (outcome !== 'changes' || answer === null) return said;
  const n = commentCount(answer);
  return n > 0 ? `${said} · ${n} comment${n === 1 ? '' : 's'}` : said;
}

export function PreviewChip({ message, result }: { message: Message; result: Message | null }): ReactNode {
  const id = toolUseId(message);
  const kept = usePreviewByToolUse(id);
  const input = toolInput(message);
  const title = kept?.title ?? str(input.title) ?? 'Untitled';
  const question = kept ? kept.question : str(input.question);
  const note = kept ? kept.note : str(input.note);
  const summary = note ?? question;

  const outcome: PreviewOutcome = useMemo(() => {
    if (kept && kept.outcome !== 'pending') return kept.outcome;
    if (result === null) return 'pending';
    return outcomeOfResult({ error: toolResultIsError(result), text: toolResultText(result) });
  }, [kept, result]);
  const answer = kept?.answer ?? (result !== null && outcome === 'changes' ? toolResultText(result) : null);

  const parts = (
    <>
      <PreviewIcon />
      <span className="tx-chip-name">Preview</span>
      <span className="pv-row-title" title={title}>
        {title}
      </span>
      {kept ? <span className="pv-row-ver">v{kept.version}</span> : null}
      {summary ? (
        <span className="tx-chip-summary pv-row-summary" title={summary}>
          {summary}
        </span>
      ) : kept === null ? (
        <span className="tx-chip-summary pv-row-summary">No copy kept</span>
      ) : null}
      {kept ? (
        <span className="pv-row-open" aria-hidden="true">
          Open ↗
        </span>
      ) : null}
      <span className="tx-chip-state pv-row-state" data-outcome={outcome}>
        {rowState(outcome, answer)}
      </span>
    </>
  );

  // undefined while the lookup runs: say nothing about a copy until it answers.
  if (!kept) {
    return (
      <div className="tx-chip pv-row-chip">
        <div className="tx-chip-head pv-row" title={kept === null ? 'Albedo kept no copy of this preview' : undefined}>
          {parts}
        </div>
      </div>
    );
  }
  return (
    <div className="tx-chip pv-row-chip">
      <button
        type="button"
        className="tx-chip-head pv-row pv-row-link"
        aria-label={`Preview: ${kept.title}, v${kept.version}, ${rowState(outcome, answer)}. Open read only`}
        onClick={() => openPreviewViewer(kept)}
      >
        {parts}
      </button>
    </div>
  );
}
