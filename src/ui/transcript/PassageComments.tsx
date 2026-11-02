/**
 * Select text in the transcript to comment on it (#187).
 *
 *  - A selection inside one message -- yours, Claude's, a tool's output, a
 *    code block -- shows Comment and Copy by its end. A selection across two
 *    messages offers Copy only: a comment quotes one passage of one row.
 *  - Comment, or ⌘', opens a field under the passage, which stays marked
 *    while it is open. Add (⌘↩) keeps the comment with the task's draft
 *    (drafts.ts); nothing is sent. Cancel or Esc drops it.
 *  - Every passage with a comment waiting stays marked, and its row shows how
 *    many it has.
 *
 * Drawn inside the scroller, so the bar and the field scroll with the text
 * they belong to. Marks use the CSS Custom Highlight API and a data attribute
 * on the row (passages.ts): nothing is inserted into rows React owns.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import type { Message } from '../../types';
import { copyText } from '../../lib/clipboard';
import { addComment, useComments } from './drafts';
import { HIGHLIGHT, findPassage, offsetOf, rowContent, setHighlight, squeeze } from './passages';
import type { TranscriptComment } from './transcriptQuotes';

/** A selection the bar is shown for. */
interface Picked {
  /** The row it is all inside; null when it spans rows (Copy only). */
  messageId: number | null;
  /** Where the bar goes, in the scroller's content coordinates. */
  top: number;
  left: number;
}

/** The comment field, open on a passage. */
interface Field {
  messageId: number;
  quote: string;
  code: boolean;
  lang?: string;
  offset: number;
  at: number;
  range: Range;
  top: number;
  left: number;
  width: number;
}

const ROW = '[data-message-id]';
/** About the bar's width: it is drawn to the left of its anchor. */
const BAR_MIN_LEFT = 150;
const OWN = '.tx-sel-bar, .tx-cmt-field';

function elementOf(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

function rectOf(range: Range): DOMRect | null {
  if (typeof range.getClientRects === 'function') {
    const rects = range.getClientRects();
    const last = rects.length > 0 ? rects[rects.length - 1] : undefined;
    if (last) return last;
  }
  return typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null;
}

/** A point of the viewport in the scroller's content coordinates. */
function inContent(scroller: HTMLElement, x: number, y: number): { left: number; top: number } {
  const box = scroller.getBoundingClientRect();
  return { left: x - box.left + scroller.scrollLeft, top: y - box.top + scroller.scrollTop };
}

/**
 * The document's selection, when it lies inside the scroller and holds text:
 * the range, and the one row it is all inside (null when it spans rows).
 */
export function selectionIn(scroller: HTMLElement): { range: Range; row: HTMLElement | null; text: string } | null {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const start = elementOf(range.startContainer);
  const end = elementOf(range.endContainer);
  if (!start || !end || !scroller.contains(start) || !scroller.contains(end)) return null;
  if (start.closest(OWN) || end.closest(OWN)) return null;
  const text = sel.toString();
  if (squeeze(text).length === 0) return null;
  const a = start.closest<HTMLElement>(ROW);
  const b = end.closest<HTMLElement>(ROW);
  // Inside one row, and in its text: a gutter label is not a passage.
  const row = a !== null && a === b && rowContent(a).contains(start) && rowContent(a).contains(end) ? a : null;
  return { range, row, text };
}

export function PassageComments({
  taskId,
  scrollRef,
  messages,
}: {
  /** Null when browsing a session no task has: Copy only. */
  taskId: number | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  messages: readonly Message[];
}): ReactNode {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [field, setField] = useState<Field | null>(null);
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  const comments = useComments(taskId);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // --- the bar follows the selection ----------------------------------------
  const read = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const sel = selectionIn(scroller);
    if (!sel) {
      setPicked(null);
      return;
    }
    const rect = rectOf(sel.range);
    const at = rect ? inContent(scroller, rect.right, rect.bottom) : { left: 0, top: 0 };
    // The bar ends where the selection does, and never runs off the left edge.
    setPicked({ messageId: sel.row ? Number(sel.row.dataset.messageId) : null, top: at.top + 6, left: Math.max(at.left, BAR_MIN_LEFT) });
    setCopied(false);
  }, [scrollRef]);

  useEffect(() => {
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(read);
    };
    document.addEventListener('selectionchange', later);
    const scroller = scrollRef.current;
    scroller?.addEventListener('mouseup', read);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', later);
      scroller?.removeEventListener('mouseup', read);
    };
  }, [read, scrollRef]);

  // --- the field ------------------------------------------------------------
  const close = useCallback(() => {
    setField(null);
    setText('');
    setHighlight(HIGHLIGHT.pending, []);
  }, []);

  // Another task: whatever was open was about that task's transcript.
  useEffect(() => {
    close();
    setPicked(null);
  }, [taskId, close]);
  useEffect(() => () => setHighlight(HIGHLIGHT.pending, []), []);

  const openField = useCallback((): boolean => {
    const scroller = scrollRef.current;
    if (!scroller || taskId === null) return false;
    const sel = selectionIn(scroller);
    if (!sel || !sel.row) return false;
    const content = rowContent(sel.row);
    const messageId = Number(sel.row.dataset.messageId);
    const range = sel.range.cloneRange();
    const common = elementOf(range.commonAncestorContainer);
    const pre = common?.closest('pre') ?? null;
    const code = pre !== null && content.contains(pre);
    const lang = code ? (pre?.closest('.tx-md-pre')?.querySelector('.tx-md-pre-lang')?.textContent?.trim() ?? '') : '';
    const rect = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null;
    const col = content.getBoundingClientRect();
    const below = inContent(scroller, col.left, rect ? rect.bottom : col.bottom);
    setField({
      messageId,
      // The passage as selected; only the blank edges a drag picks up go.
      quote: sel.text.replace(/^\s*\n/, '').replace(/\s+$/, ''),
      code,
      ...(lang ? { lang } : {}),
      offset: offsetOf(content, range),
      at: messagesRef.current.find((m) => m.id === messageId)?.ts ?? 0,
      range,
      top: below.top + 6,
      left: below.left,
      width: col.width > 0 ? Math.min(col.width, 640) : 0,
    });
    setText('');
    setPicked(null);
    setHighlight(HIGHLIGHT.pending, [range]);
    return true;
  }, [scrollRef, taskId]);

  // ⌘': the bar's Comment, from the keyboard. Command only, matched on the
  // physical key too (`code`), so a layout that puts ' elsewhere still has it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code !== 'Quote' && e.key !== "'") return;
      if (openField()) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openField]);

  const add = () => {
    if (!field || taskId === null || text.trim().length === 0) return;
    const now = Date.now();
    const c: TranscriptComment = {
      id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      messageId: field.messageId,
      quote: field.quote,
      code: field.code,
      ...(field.lang ? { lang: field.lang } : {}),
      comment: text.trim(),
      at: field.at,
      offset: field.offset,
      addedAt: now,
    };
    addComment(taskId, c, now);
    document.getSelection()?.removeAllRanges();
    close();
  };

  // --- marks: every passage with a comment waiting --------------------------
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const counts = new Map<number, number>();
    const ranges: Range[] = [];
    for (const c of comments) {
      const row = scroller.querySelector<HTMLElement>(`[data-message-id="${c.messageId}"]`);
      if (!row) continue;
      counts.set(c.messageId, (counts.get(c.messageId) ?? 0) + 1);
      const r = findPassage(rowContent(row), c.quote, c.offset);
      if (r) ranges.push(r);
    }
    setHighlight(HIGHLIGHT.waiting, ranges);
    for (const row of scroller.querySelectorAll<HTMLElement>('[data-comments]')) {
      if (!counts.has(Number(row.dataset.messageId))) unmark(row);
    }
    for (const [id, n] of counts) {
      const row = scroller.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
      if (!row) continue;
      row.dataset.comments = String(n);
      row.querySelector(':scope > .tx-gutter')?.setAttribute('title', `${n} comment${n === 1 ? '' : 's'} waiting to be sent`);
    }
  }, [comments, messages, scrollRef]);
  useEffect(
    () => () => {
      setHighlight(HIGHLIGHT.waiting, []);
      for (const row of scrollRef.current?.querySelectorAll<HTMLElement>('[data-comments]') ?? []) unmark(row);
    },
    [scrollRef],
  );

  return (
    <>
      {picked && !field ? (
        <div
          className="tx-sel-bar"
          role="toolbar"
          aria-label="Selected text"
          style={{ top: picked.top, left: picked.left }}
          // Pressing a button must not clear the selection it acts on.
          onMouseDown={(e) => e.preventDefault()}
        >
          {picked.messageId !== null && taskId !== null ? (
            <button type="button" className="tx-sel-btn" onClick={() => void openField()} title="Comment on this passage (⌘')">
              Comment
            </button>
          ) : null}
          <button
            type="button"
            className="tx-sel-btn"
            title={picked.messageId === null ? 'Copy (a comment quotes a passage of one message)' : 'Copy'}
            onClick={() => {
              const t = document.getSelection()?.toString() ?? '';
              void copyText(t).then((ok) => setCopied(ok));
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      ) : null}
      {field ? (
        <div
          className="tx-cmt-field"
          data-focus-keeps-tab=""
          style={{ top: field.top, left: field.left, ...(field.width > 0 ? { width: field.width } : {}) }}
        >
          <textarea
            className="tx-cmt-input"
            aria-label="Comment on the selected passage"
            placeholder="Comment on this passage…"
            rows={3}
            value={text}
            autoFocus
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                add();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                close();
              }
            }}
          />
          <div className="tx-cmt-foot">
            <button type="button" className="tx-btn tx-queued-act" onClick={close}>
              Cancel
            </button>
            <button type="button" className="tx-btn tx-queued-act tx-cmt-add" onClick={add} disabled={text.trim().length === 0}>
              Add <span className="tx-cmt-key">⌘↩</span>
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function unmark(row: HTMLElement): void {
  delete row.dataset.comments;
  row.querySelector(':scope > .tx-gutter')?.removeAttribute('title');
}
