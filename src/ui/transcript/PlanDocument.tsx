/**
 * A plan, shown as a document inside the "waiting on you" card (#272), with
 * comments collected on it before anything is sent.
 *
 *  - The document is the plan file a question names (planDoc.ts), or the plan
 *    Claude Code's own plan mode hands over (hookEvents.ts, PLAN_MODE),
 *    rendered with the transcript's markdown, scrolling inside a fixed height.
 *  - Select a passage: Comment by the selection, or ⌥⌘M. A box opens under
 *    the passage; Add Comment (⌘↩) keeps the comment on the card
 *    (planComments.ts). Nothing is sent: the card's "Send N Comments" does
 *    that, on a click.
 *  - A passage with a comment is marked and numbered in the margin; the tray
 *    under the document lists every comment, with Edit and ✕.
 *
 * Marks use the CSS Custom Highlight API and the pins sit in the document's
 * margin, so nothing is inserted into the markdown React draws (passages.ts
 * finds a passage again by its text).
 *
 * ⌥⌘M is the editor's and the diff's comment key too. Each acts only on a
 * selection inside its own text, read from `code` (Option makes `key` µ):
 * CodeMirror takes it only while it has focus, the diff only for a selection
 * in its rows, and nothing app-wide binds it (shortcuts.ts).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Markdown } from './MessageRow';
import { findPassage, offsetOf, setHighlight, squeeze } from './passages';
import {
  addPlanComment,
  editPlanComment,
  inDocumentOrder,
  removePlanComment,
  usePlanComments,
  type PlanComment,
} from './planComments';

/** The CSS highlight names (promptCard.css draws them). */
export const PLAN_HIGHLIGHT = {
  /** Passages with a comment on the card. */
  marked: 'albedo-plan-comment',
  /** The passage being commented on, while its box is open. */
  pending: 'albedo-plan-comment-pending',
} as const;

/** The longest quote the tray shows before cutting it. */
const QUOTE_SHOWN = 90;

interface Field {
  quote: string;
  offset: number;
  range: Range;
  top: number;
}

interface Pin {
  top: number;
  numbers: number[];
}

/** The selection, when all of it is inside `root` and holds text. */
function selectionIn(root: HTMLElement): { range: Range; text: string } | null {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const text = sel.toString();
  return squeeze(text).length === 0 ? null : { range, text };
}

function lastRect(range: Range): DOMRect | null {
  if (typeof range.getClientRects === 'function') {
    const rects = range.getClientRects();
    const last = rects.length > 0 ? rects[rects.length - 1] : undefined;
    if (last) return last;
  }
  return typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null;
}

function firstRect(range: Range): DOMRect | null {
  if (typeof range.getClientRects === 'function') {
    const first = range.getClientRects()[0];
    if (first) return first;
  }
  return null;
}

/** A viewport y as a y in `scroller`'s content. */
function contentY(scroller: HTMLElement, y: number): number {
  return y - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

export function PlanDocument({
  name,
  folder,
  onOpen,
  text,
  note,
  commentKey,
  locked,
}: {
  /** The file name, or what the document is when there is no file. */
  name: string;
  /** The folder it is in, shown dimmed; null when there is no file. */
  folder: string | null;
  /** Open it full size in the editor; null when there is no file. */
  onOpen: (() => void) | null;
  text: string;
  /** Said under the text: that it was cut, for one. */
  note: string | null;
  /** Where its comments are kept; null when it cannot be commented on (no hook waiting). */
  commentKey: string | null;
  /** An answer is on its way: nothing changes now. */
  locked: boolean;
}): ReactNode {
  const bodyRef = useRef<HTMLDivElement>(null);
  const mdRef = useRef<HTMLDivElement>(null);
  const comments = usePlanComments(commentKey);
  const ordered = useMemo(() => inDocumentOrder(comments), [comments]);
  const canComment = commentKey !== null && !locked;

  const [bar, setBar] = useState<{ top: number; left: number } | null>(null);
  const [field, setField] = useState<Field | null>(null);
  const [draft, setDraft] = useState('');
  const [pins, setPins] = useState<Pin[]>([]);
  const [layout, setLayout] = useState(0);

  // --- the Comment button follows a selection in the document ----------------
  useEffect(() => {
    if (!canComment) {
      setBar(null);
      return;
    }
    let frame = 0;
    const read = () => {
      const body = bodyRef.current;
      const md = mdRef.current;
      const sel = md ? selectionIn(md) : null;
      if (!body || !sel) {
        setBar(null);
        return;
      }
      // By the selection's end; at the top when the engine has no geometry.
      const rect = lastRect(sel.range);
      const box = body.getBoundingClientRect();
      setBar(
        rect
          ? { top: contentY(body, rect.bottom) + 4, left: Math.max(rect.right - box.left + body.scrollLeft, 120) }
          : { top: body.scrollTop, left: 120 },
      );
    };
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(read);
    };
    document.addEventListener('selectionchange', later);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', later);
    };
  }, [canComment]);

  // --- the comment box ---------------------------------------------------------
  const close = useCallback(() => {
    setField(null);
    setDraft('');
    setHighlight(PLAN_HIGHLIGHT.pending, []);
  }, []);

  const openField = useCallback((): boolean => {
    const body = bodyRef.current;
    const md = mdRef.current;
    if (!canComment || !body || !md) return false;
    const sel = selectionIn(md);
    if (!sel) return false;
    const range = sel.range.cloneRange();
    const rect = lastRect(range);
    setField({
      // The passage as selected; only the blank edges a drag picks up go.
      quote: sel.text.replace(/^\s*\n/, '').replace(/\s+$/, ''),
      offset: offsetOf(md, range),
      range,
      top: rect ? contentY(body, rect.bottom) + 6 : body.scrollTop,
    });
    setDraft('');
    setBar(null);
    setHighlight(PLAN_HIGHLIGHT.pending, [range]);
    return true;
  }, [canComment]);

  // The whole box in view, its buttons too: the document scrolls inside a
  // fixed height, and the box may open at its foot.
  const boxRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (field) boxRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [field]);

  // ⌥⌘M, for a selection in this document only.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyM' || !e.metaKey || !e.altKey || e.shiftKey || e.ctrlKey) return;
      if (openField()) e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openField]);

  // Locked (an answer is going) or no longer commentable: nothing stays open.
  useEffect(() => {
    if (!canComment) close();
  }, [canComment, close]);

  const add = () => {
    if (!field || commentKey === null || draft.trim().length === 0) return;
    addPlanComment(commentKey, { quote: field.quote, offset: field.offset, comment: draft.trim() });
    document.getSelection()?.removeAllRanges();
    close();
  };

  // --- marks and pins --------------------------------------------------------
  useEffect(() => {
    const md = mdRef.current;
    if (!md || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setLayout((n) => n + 1));
    ro.observe(md);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    const md = mdRef.current;
    if (!body || !md) return;
    const ranges: Range[] = [];
    const byLine = new Map<number, Pin>();
    ordered.forEach((c, i) => {
      const r = findPassage(md, c.quote, c.offset);
      if (!r) return;
      ranges.push(r);
      const rect = firstRect(r);
      if (!rect) return;
      // The pin sits on the passage's first line, centred on it.
      const top = Math.round(contentY(body, rect.top + rect.height / 2));
      const same = [...byLine.keys()].find((t) => Math.abs(t - top) < 6);
      if (same !== undefined) byLine.get(same)!.numbers.push(i + 1);
      else byLine.set(top, { top, numbers: [i + 1] });
    });
    setHighlight(PLAN_HIGHLIGHT.marked, ranges);
    setPins([...byLine.values()]);
  }, [ordered, text, layout]);

  useEffect(
    () => () => {
      setHighlight(PLAN_HIGHLIGHT.marked, []);
      setHighlight(PLAN_HIGHLIGHT.pending, []);
    },
    [],
  );

  /** Bring a comment's passage into view in the document. */
  const reveal = (c: PlanComment) => {
    const body = bodyRef.current;
    const md = mdRef.current;
    const r = md ? findPassage(md, c.quote, c.offset) : null;
    const rect = r ? firstRect(r) : null;
    if (!body || !rect) return;
    body.scrollTop = contentY(body, rect.top) - 24;
  };

  return (
    <>
      <div className="pc-doc">
        <div className="pc-doc-head">
          <span className="pc-doc-name">{name}</span>
          <span className="pc-doc-folder" title={folder ?? undefined}>
            {folder}
          </span>
          {onOpen ? (
            <button type="button" className="pc-doc-open" onClick={onOpen} title="Open it in the editor, read-only">
              Open
            </button>
          ) : null}
        </div>
        <div className={canComment ? 'pc-doc-body pc-doc-body-commenting' : 'pc-doc-body'} ref={bodyRef}>
          <div className="pc-doc-md" ref={mdRef}>
            <Markdown text={text} />
          </div>
          {note ? <div className="pc-doc-note">{note}</div> : null}
          {pins.map((p) => (
            <span
              key={`${p.top}-${p.numbers.join('-')}`}
              className="pc-pin pc-doc-pin"
              style={{ top: p.top }}
              aria-hidden="true"
            >
              {p.numbers.join('·')}
            </span>
          ))}
          {bar && !field ? (
            <div
              className="pc-sel-bar"
              role="toolbar"
              aria-label="Selected text"
              style={{ top: bar.top, left: bar.left }}
              // Pressing the button must not clear the selection it acts on.
              onMouseDown={(e) => e.preventDefault()}
            >
              <button type="button" className="pc-sel-btn" onClick={() => void openField()} title="Comment on this passage (⌥⌘M)">
                Comment <span className="pc-key">⌥⌘M</span>
              </button>
            </div>
          ) : null}
          {field ? (
            <div className="pc-cbox" ref={boxRef} style={{ top: field.top }} data-focus-keeps-tab="">
              <div className="pc-cbox-quote">{field.quote}</div>
              <textarea
                className="pc-cbox-input"
                aria-label="Comment on the selected passage"
                placeholder="Comment on this passage…"
                rows={2}
                value={draft}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
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
              <div className="pc-cbox-foot">
                <button type="button" className="btn" onClick={close}>
                  Cancel
                </button>
                <button type="button" className="btn btn-primary" onClick={add} disabled={draft.trim().length === 0}>
                  Add Comment
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
      {ordered.length > 0 && commentKey !== null ? (
        <CommentTray commentKey={commentKey} comments={ordered} locked={locked} onReveal={reveal} />
      ) : null}
    </>
  );
}

function CommentTray({
  commentKey,
  comments,
  locked,
  onReveal,
}: {
  commentKey: string;
  comments: readonly PlanComment[];
  locked: boolean;
  onReveal: (c: PlanComment) => void;
}): ReactNode {
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const n = comments.length;
  return (
    <div className="pc-tray" role="group" aria-label="Comments on the plan">
      <div className="pc-tray-head">
        Comments · {n}, not sent yet
      </div>
      <ol className="pc-tray-list">
        {comments.map((c, i) => {
          const quote = c.quote.replace(/\s+/g, ' ').trim();
          const shown = quote.length > QUOTE_SHOWN ? `${quote.slice(0, QUOTE_SHOWN - 1)}…` : quote;
          const isEditing = editing?.id === c.id;
          return (
            <li key={c.id} className="pc-tray-item">
              <span className="pc-pin" aria-hidden="true">
                {i + 1}
              </span>
              <div className="pc-tray-text">
                {isEditing ? (
                  <div className="pc-tray-edit">
                    <textarea
                      className="pc-cbox-input"
                      aria-label={`Edit comment ${i + 1}`}
                      rows={2}
                      value={editing.text}
                      autoFocus
                      onChange={(e) => setEditing({ id: c.id, text: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          if (editing.text.trim().length > 0) {
                            editPlanComment(commentKey, c.id, editing.text);
                            setEditing(null);
                          }
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          e.stopPropagation();
                          setEditing(null);
                        }
                      }}
                    />
                    <div className="pc-cbox-foot">
                      <button type="button" className="btn" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={editing.text.trim().length === 0}
                        onClick={() => {
                          editPlanComment(commentKey, c.id, editing.text);
                          setEditing(null);
                        }}
                      >
                        Save
                      </button>
                    </div>
                  </div>
                ) : (
                  <span className="pc-tray-comment">{c.comment}</span>
                )}{' '}
                <button type="button" className="pc-tray-quote" onClick={() => onReveal(c)} title="Show this passage in the plan">
                  — “{shown}”
                </button>
              </div>
              {isEditing ? null : (
                <span className="pc-tray-acts">
                  <button
                    type="button"
                    className="pc-tray-act"
                    disabled={locked}
                    onClick={() => setEditing({ id: c.id, text: c.comment })}
                    aria-label={`Edit comment ${i + 1}`}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="pc-tray-act"
                    disabled={locked}
                    onClick={() => removePlanComment(commentKey, c.id)}
                    aria-label={`Remove comment ${i + 1}`}
                    title="Remove this comment"
                  >
                    ✕
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
