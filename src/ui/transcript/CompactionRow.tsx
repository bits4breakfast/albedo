/**
 * Where Claude Code compacted the session: one divider across the pane, the
 * summary it continues from folded under it (closed by default, markdown when
 * opened), and a notice it wrote about the compaction as a quiet line. See
 * compaction.ts for how the rows are found and paired.
 */

import { memo, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Disclosure } from '../Disclosure';
import { Markdown } from './MessageRow';
import { compactionLabel, noticeParts, type Compaction } from './compaction';
import { splitCompactSummary, systemRowText } from './envelopes';

function CompactionRow({ compaction }: { compaction: Compaction }): ReactNode {
  const [open, setOpen] = useState(false);
  const label = compactionLabel(compaction.meta);
  const summary = useMemo(
    () => (compaction.summaryText === null ? null : splitCompactSummary(compaction.summaryText)),
    [compaction.summaryText],
  );
  const notice = compaction.notice ? noticeParts(systemRowText(compaction.notice.body)) : null;
  const hasSummary = summary !== null && summary.text.trim().length > 0;

  return (
    <div className="tx-row tx-row-compacted">
      <div className="tx-gutter" />
      <div className="tx-content">
        {/* No separator role: it would hide the button inside from assistive tech. */}
        <div className="tx-cleared">
          {hasSummary ? (
            <button
              type="button"
              className="tx-compacted-head"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              title={open ? 'Hide the summary Claude continues from' : 'Show the summary Claude continues from'}
            >
              <Disclosure open={open} /> {label}
            </button>
          ) : (
            <span>{label}</span>
          )}
        </div>
        {notice && notice.line.length > 0 ? (
          <div className="tx-compacted-note" title={notice.title}>
            {notice.line}
          </div>
        ) : null}
        {open && summary ? (
          <div className="tx-compacted-body">
            {summary.tools.length > 0 ? (
              <div className="tx-compacted-tools">Tools used before: {summary.tools.join(', ')}</div>
            ) : null}
            <Markdown text={summary.text} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The rows never change once captured, so the same compaction renders the same. */
export default memo(
  CompactionRow,
  (a, b) =>
    a.compaction.boundary === b.compaction.boundary &&
    a.compaction.summary === b.compaction.summary &&
    a.compaction.notice === b.compaction.notice,
);
