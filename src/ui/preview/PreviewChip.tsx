/**
 * A `show_preview` call in the transcript (#348): one chip per version, with
 * how it ended -- "◫ Preview: Proposed row, v2 · changes requested". A click
 * opens that version, read only, over the reading pane (PreviewViewer).
 *
 * The version comes from Albedo's own copy (db/previews.ts), found by the
 * call's transcript id. Without one -- a session Albedo did not start, or a
 * task whose history was purged -- the chip names the title from the call and
 * reads how it ended from the call's result, and there is nothing to open.
 */

import { useMemo } from 'react';
import type { ReactNode } from 'react';
import type { Message, PreviewOutcome } from '../../types';
import { outcomeOfResult } from '../../capture/previewGate';
import { str, toolInput, toolResultIsError, toolResultText, toolUseId } from '../transcript/ToolChip';
import { outcomeText } from './PreviewCard';
import { openPreviewViewer } from './previewViewer';
import { usePreviewByToolUse } from './usePreviews';
import './preview.css';

export function PreviewChip({ message, result }: { message: Message; result: Message | null }): ReactNode {
  const id = toolUseId(message);
  const kept = usePreviewByToolUse(id);
  const input = toolInput(message);
  const title = kept?.title ?? str(input.title) ?? 'Untitled';

  const outcome: PreviewOutcome = useMemo(() => {
    if (kept && kept.outcome !== 'pending') return kept.outcome;
    if (result === null) return 'pending';
    return outcomeOfResult({ error: toolResultIsError(result), text: toolResultText(result) });
  }, [kept, result]);

  const label = (
    <>
      <span className="pv-chip-glyph" aria-hidden="true">
        ◫
      </span>{' '}
      Preview: <b className="pv-chip-title">{title}</b>
      {kept ? `, v${kept.version}` : ''}
      <span className="pv-chip-outcome" data-outcome={outcome}>
        {' '}
        · {outcomeText(outcome)}
      </span>
    </>
  );

  if (!kept) {
    // undefined while the lookup runs: say nothing about a copy until it answers.
    return (
      <span className="pv-chip" title={kept === null ? 'Albedo kept no copy of this preview' : undefined}>
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="pv-chip pv-chip-link"
      title={`Open v${kept.version} of ${kept.title}, read only`}
      onClick={() => openPreviewViewer(kept)}
    >
      {label}
    </button>
  );
}
