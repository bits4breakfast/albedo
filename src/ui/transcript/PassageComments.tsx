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
 *    many it has. A click on a mark shows its comments under the line, to
 *    read, edit or remove (#434, PassagePopover.tsx); the marks are ranges,
 *    so the click is hit-tested against them (markHit.ts). A drag that
 *    starts on a mark still selects, and a double click still picks a word.
 *
 *  - A selection inside a diff's rows is a comment on CODE (#222): on the
 *    file's lines `a–b`, when the new-side lines it covers are found
 *    verbatim in the file as it is now (lib/anchor.ts, through the file-read
 *    context). It joins the code comments' queue. When they are not found
 *    -- the file has moved on -- or the selection is on deleted lines only,
 *    it stays a comment on the passage, and the field says why.
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
import { marksAt } from './markHit';
import { PassagePopover } from './PassagePopover';
import { HIGHLIGHT, findPassage, offsetOf, rowContent, setHighlight, squeeze } from './passages';
import type { TranscriptComment } from './transcriptQuotes';
import { selectedDiffRows } from './Diff';
import { anchorBlock, fileLines } from '../../lib/anchor';
import { useReadFile, useWorktreePath } from '../editor/openFile';
import { addComment as addCodeComment } from '../../db/comments';

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
  /** What it will be a comment on: the passage, or the file's lines (#222). */
  target: Target;
}

/**
 * A field opened on a diff's rows first checks the file ('checking'); the
 * rest are settled: code lines found in the file now, or the passage with
 * the reason it could not be code.
 */
type Target =
  | { kind: 'passage'; why: string | null }
  | { kind: 'checking' }
  | { kind: 'code'; path: string; lineStart: number; lineEnd: number; anchorText: string };

/** Where a diff selection's lines are in the file now, or why not. Pure. */
export function codeTarget(
  lines: ReadonlyArray<{ line: number; text: string }>,
  path: string | null,
  text: string | null,
): Target {
  if (lines.length === 0) return { kind: 'passage', why: 'Deleted lines are not in the file now, so this comments on the passage.' };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.line !== lines[i - 1]!.line + 1) {
      return { kind: 'passage', why: 'The selection spans two parts of the diff, so this comments on the passage.' };
    }
  }
  if (path === null || text === null) return { kind: 'passage', why: 'The file could not be read, so this comments on the passage.' };
  const block = lines.map((l) => l.text);
  const found = anchorBlock(fileLines(text), block, lines[0]!.line);
  if (!found.ok) return { kind: 'passage', why: 'These lines are not in the file as it is now, so this comments on the passage.' };
  return { kind: 'code', path, lineStart: found.offset + 1, lineEnd: found.offset + block.length, anchorText: block.join('\n') };
}

const ROW = '[data-message-id]';
/** About the bar's width: it is drawn to the left of its anchor. */
const BAR_MIN_LEFT = 150;
const OWN = '.tx-sel-bar, .tx-cmt-field, .tx-cmt-pop';
/** What a click on a mark leaves alone: it is that control's click. */
const CONTROL = 'a, button, input, textarea, select, summary, label, [role="button"], [role="link"], [contenteditable]';
/** How the mark under the pointer tells it is one (ranges take no cursor and no title). */
const MARK_TITLE = 'Your comment — click to see it';
/** The popover's widest: a few lines to read, where the field takes 640. */
const POP_MAX_WIDTH = 400;

/** A waiting comment's passage, as drawn. */
interface Mark {
  comment: TranscriptComment;
  range: Range;
}

/** The popover, open on a marked passage (#434). */
interface Pop {
  /** Its comments' ids, oldest first. */
  ids: string[];
  top: number;
  left: number;
  width: number;
}

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
  const readFile = useReadFile();
  const relativeOf = useWorktreePath();
  const [error, setError] = useState<string | null>(null);
  const [pop, setPop] = useState<Pop | null>(null);
  const marksRef = useRef<Mark[]>([]);
  const fieldOpenRef = useRef(false);
  fieldOpenRef.current = field !== null;
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
    setPop(null);
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
    // Inside a diff's rows: a comment on the file's lines, once they are
    // found in the file as it is now (#222). Checked after the field opens.
    const rows = selectedDiffRows(document.getSelection());
    const inDiff = rows !== null && content.contains(rows.root);
    const target: Target = inDiff ? (rows.deletedOnly ? codeTarget([], null, null) : { kind: 'checking' }) : { kind: 'passage', why: null };
    if (inDiff && !rows.deletedOnly) {
      const raw = rows.root.getAttribute('data-diff-path') ?? '';
      void Promise.all([relativeOf(raw).catch(() => null), readFile(raw).catch(() => null)]).then(([path, text]) => {
        const settled = codeTarget(rows.lines, path, text);
        setField((f) => (f && f.range === range ? { ...f, target: settled } : f));
      });
    }
    setError(null);
    setField({
      target,
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
    setPop(null);
    setHighlight(HIGHLIGHT.pending, [range]);
    return true;
  }, [scrollRef, taskId, readFile, relativeOf]);

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
    if (field.target.kind === 'checking') return;
    const t = field.target;
    if (t.kind === 'code') {
      addCodeComment({ taskId, path: t.path, lineStart: t.lineStart, lineEnd: t.lineEnd, anchorText: t.anchorText, body: text.trim() }).then(
        () => {
          document.getSelection()?.removeAllRanges();
          close();
        },
        (err: unknown) => setError(`Could not save the comment, which is still here: ${String(err)}`),
      );
      return;
    }
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
    const marks: Mark[] = [];
    for (const c of comments) {
      const row = scroller.querySelector<HTMLElement>(`[data-message-id="${c.messageId}"]`);
      if (!row) continue;
      counts.set(c.messageId, (counts.get(c.messageId) ?? 0) + 1);
      const r = findPassage(rowContent(row), c.quote, c.offset);
      if (r) marks.push({ comment: c, range: r });
    }
    marksRef.current = marks;
    setHighlight(HIGHLIGHT.waiting, marks.map((m) => m.range));
    for (const row of scroller.querySelectorAll<HTMLElement>('[data-comments]')) {
      if (!counts.has(Number(row.dataset.messageId))) unmark(row);
    }
    for (const [id, n] of counts) {
      const row = scroller.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
      if (!row) continue;
      row.dataset.comments = String(n);
      row.querySelector(':scope > .tx-gutter')?.setAttribute('title', `${n} comment${n === 1 ? '' : 's'} to send`);
    }
  }, [comments, messages, scrollRef]);
  useEffect(
    () => () => {
      marksRef.current = [];
      setHighlight(HIGHLIGHT.waiting, []);
      for (const row of scrollRef.current?.querySelectorAll<HTMLElement>('[data-comments]') ?? []) unmark(row);
    },
    [scrollRef],
  );

  // --- a click on a mark shows its comments (#434) --------------------------
  /*
     On the document, in the bubble phase: a control inside the passage that
     took the click (a file link's useActivate stops it) has had it, and
     never reaches here. Only a plain click: a drag that started on a mark
     ends with text selected and is a selection; a double click picks a word
     and closes the popover the first click opened.
  */
  useEffect(() => {
    if (taskId === null) return;
    const onClick = (e: MouseEvent) => {
      const scroller = scrollRef.current;
      if (!scroller || e.button !== 0 || e.defaultPrevented) return;
      if (!(e.target instanceof Element) || !scroller.contains(e.target)) return;
      if (e.target.closest(OWN) || e.target.closest(CONTROL)) return;
      if (e.detail > 1) {
        setPop(null);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || fieldOpenRef.current) return;
      const sel = document.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().length > 0) return;
      const { hits, box } = marksAt(marksRef.current, e.clientX, e.clientY);
      if (hits.length === 0) return;
      const ids = [...hits].sort((a, b) => a.comment.addedAt - b.comment.addedAt).map((m) => m.comment.id);
      const row = e.target.closest<HTMLElement>(ROW);
      const col = (row ? rowContent(row) : scroller).getBoundingClientRect();
      const below = inContent(scroller, col.left, box ? box.bottom : e.clientY);
      setPicked(null);
      setPop({ ids, top: below.top + 6, left: below.left, width: col.width > 0 ? Math.min(col.width, POP_MAX_WIDTH) : 0 });
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [taskId, scrollRef]);

  // Over a mark: a pointer, and a tooltip saying what a click does. On the
  // scroller, which React gives neither a title nor this attribute.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || taskId === null) return;
    let frame = 0;
    let last: { x: number; y: number; target: EventTarget | null } | null = null;
    const set = (on: boolean) => {
      if (on === scroller.hasAttribute('data-on-mark')) return;
      if (on) {
        scroller.setAttribute('data-on-mark', '');
        scroller.setAttribute('title', MARK_TITLE);
      } else {
        scroller.removeAttribute('data-on-mark');
        scroller.removeAttribute('title');
      }
    };
    const look = () => {
      frame = 0;
      const at = last;
      if (!at) return;
      const t = at.target instanceof Element ? at.target : null;
      const over = t !== null && !t.closest(OWN) && !t.closest(CONTROL) && marksAt(marksRef.current, at.x, at.y).hits.length > 0;
      set(over);
    };
    const onMove = (e: MouseEvent) => {
      last = { x: e.clientX, y: e.clientY, target: e.target };
      if (marksRef.current.length === 0) {
        set(false);
        return;
      }
      if (frame === 0) frame = requestAnimationFrame(look);
    };
    const onLeave = () => {
      last = null;
      set(false);
    };
    scroller.addEventListener('mousemove', onMove);
    scroller.addEventListener('mouseleave', onLeave);
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener('mousemove', onMove);
      scroller.removeEventListener('mouseleave', onLeave);
      set(false);
    };
  }, [taskId, scrollRef]);

  const closePop = useCallback(() => setPop(null), []);
  // Only comments still To Send: one sent or removed leaves the popover, and
  // with the last one it closes.
  const popComments = pop ? pop.ids.map((id) => comments.find((c) => c.id === id)).filter((c): c is TranscriptComment => c !== undefined) : [];
  const popEmpty = pop !== null && popComments.length === 0;
  useEffect(() => {
    if (popEmpty) setPop(null);
  }, [popEmpty]);

  return (
    <>
      {pop && taskId !== null && popComments.length > 0 && !field ? (
        <PassagePopover taskId={taskId} comments={popComments} top={pop.top} left={pop.left} width={pop.width} onClose={closePop} />
      ) : null}
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
          {field.target.kind !== 'passage' || field.target.why ? (
            <div className="tx-cmt-target" role="status">
              {field.target.kind === 'checking'
                ? 'Finding these lines in the file…'
                : field.target.kind === 'code'
                  ? `On ${field.target.path.split('/').pop()}:${
                      field.target.lineStart === field.target.lineEnd
                        ? field.target.lineStart
                        : `${field.target.lineStart}–${field.target.lineEnd}`
                    }, as a code comment`
                  : field.target.why}
            </div>
          ) : null}
          <textarea
            className="tx-cmt-input"
            aria-label={field.target.kind === 'code' ? 'Comment on the selected lines' : 'Comment on the selected passage'}
            placeholder={field.target.kind === 'code' ? 'Comment on these lines…' : 'Comment on this passage…'}
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
            <button
              type="button"
              className="tx-btn tx-queued-act tx-cmt-add"
              onClick={add}
              disabled={text.trim().length === 0 || field.target.kind === 'checking'}
            >
              Add <span className="tx-cmt-key">⌘↩</span>
            </button>
          </div>
          {error ? <div className="tx-waiting-error">{error}</div> : null}
        </div>
      ) : null}
    </>
  );
}

function unmark(row: HTMLElement): void {
  delete row.dataset.comments;
  row.querySelector(':scope > .tx-gutter')?.removeAttribute('title');
}
