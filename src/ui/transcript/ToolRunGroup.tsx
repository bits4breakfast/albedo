/**
 * The transcript's folded lines: a run of tool calls (#358) and a subagent's
 * rows, each a disclosure over the same MessageRows the pane draws.
 */

import { memo, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Message } from '../../types';
import { Disclosure } from './Diff';
import { MemoMessageRow as MessageRow } from './MessageRow';
import { summaryOf } from './ToolChip';
import { runFacts } from './toolGroups';
import type { RowItem } from './grouping';

/**
 * A run of tool calls as one line (#358): what was done, the lines added and
 * removed, how many failed, and -- while it is the newest thing and a call
 * has no result yet -- what is running. Opened, the same rows as before.
 *
 * A row asked for by a reveal (the Background band, a comment's passage)
 * opens its group, in the same render, so the pane finds the row.
 */
export function ToolRunGroup({ rows, live, reveal }: { rows: readonly RowItem[]; live: boolean; reveal: number | null }): ReactNode {
  const [open, setOpen] = useState(false);
  const holdsReveal = reveal !== null && rows.some((r) => r.message.id === reveal);
  useEffect(() => {
    if (holdsReveal) setOpen(true);
  }, [holdsReveal]);
  const shown = open || holdsReveal;

  const calls = useMemo(() => rows.filter((r) => r.message.role === 'tool_use').map((r) => r.message), [rows]);
  const results = useMemo(() => new Map(rows.map((r) => [r.message.id, r.result] as const)), [rows]);
  const facts = useMemo(() => runFacts(calls, results), [calls, results]);
  const running = live && facts.pending > 0;
  const last = calls[calls.length - 1];
  const now = running && last ? summaryOf(last) : null;

  return (
    <div className={`tx-row tx-row-toolrun ${shown ? 'tx-toolrun-open' : ''}`}>
      <div className="tx-gutter" />
      <div className="tx-content">
        <button type="button" className="tx-sidechain-head tx-toolrun-head" onClick={() => setOpen(!shown)} aria-expanded={shown}>
          <Disclosure open={shown} />
          <span className="tx-toolrun-summary">{facts.summary}</span>
          {facts.lines ? (
            <span className="tx-d-stat" aria-label={`${facts.lines.added} lines added, ${facts.lines.removed} removed`}>
              <span className="tx-d-plus">+{facts.lines.added}</span>
              <span className="tx-d-minus">−{facts.lines.removed}</span>
            </span>
          ) : null}
          {facts.failed > 0 ? <span className="tx-toolrun-failed">· {facts.failed} failed</span> : null}
          {running ? (
            <span className="tx-toolrun-live">
              · running{now ? <span className="tx-toolrun-now">{now}</span> : null}
            </span>
          ) : null}
        </button>
        {shown ? (
          <div className="tx-sidechain-body tx-toolrun-body">
            {rows.map((r) => (
              <MessageRow key={r.key} message={r.message} result={r.result} extras={r.extras} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A run whose rows are the same objects draws the same line (#362): rows are
 * immutable once captured (MessageRow's `sameRow`). groupRows builds new
 * arrays on every append, so the rows are compared one by one; without this
 * every run in the window re-read its calls on each new row.
 */
export function sameRun(
  a: { rows: readonly RowItem[]; live: boolean; reveal: number | null },
  b: { rows: readonly RowItem[]; live: boolean; reveal: number | null },
): boolean {
  if (a.live !== b.live || a.reveal !== b.reveal || a.rows.length !== b.rows.length) return false;
  return a.rows.every((r, i) => {
    const o = b.rows[i]!;
    if (r.key !== o.key || r.message !== o.message || (r.result ?? null) !== (o.result ?? null)) return false;
    const ea = r.extras ?? [];
    const eb = o.extras ?? [];
    return ea.length === eb.length && ea.every((m, k) => m === eb[k]);
  });
}

export const MemoToolRunGroup = memo(ToolRunGroup, sameRun);

export function SidechainGroup({
  rows,
  results,
  extras,
}: {
  rows: readonly Message[];
  results: Map<number, Message | null>;
  extras: Map<number, Message[]>;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const tools = rows.filter((r) => r.role === 'tool_use').length;
  return (
    <div className={`tx-row tx-row-sidechain ${open ? 'tx-sidechain-open' : ''}`}>
      <div className="tx-gutter" />
      <div className="tx-content">
        <button type="button" className="tx-sidechain-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <Disclosure open={open} /> Subagent · {rows.length} Row{rows.length === 1 ? '' : 's'}
          {tools > 0 ? ` · ${tools} Tool Call${tools === 1 ? '' : 's'}` : ''}
        </button>
        {open ? (
          <div className="tx-sidechain-body">
            {rows.map((r) => (
              <MessageRow key={r.id} message={r} result={results.get(r.id) ?? null} extras={extras.get(r.id)} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
