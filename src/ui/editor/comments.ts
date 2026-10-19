/**
 * Review comments inside CodeMirror: a gutter to start one, a card under the
 * lines each comment covers, and a draft box while one is being written.
 *
 * Positions are document offsets mapped through every edit, so a card stays
 * with its code while the buffer changes. Where a comment belongs when a file
 * is opened is decided by FileEditor from the stored text (`relocate`), not
 * here. The cards are plain DOM: CodeMirror owns this subtree, and a widget
 * that handles its own events is what it expects.
 */

import { StateEffect, StateField, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, WidgetType, gutter, type DecorationSet } from '@codemirror/view';
import type { ReviewComment } from '../../db/comments';

/** A comment placed in this document. */
export interface PlacedComment {
  comment: ReviewComment;
  /** Start of its first line. */
  from: number;
  /** End of its last line. */
  to: number;
}

export interface Draft {
  from: number;
  to: number;
  /** Set when editing an existing comment. */
  editing: ReviewComment | null;
}

export interface CommentActions {
  /** Save a draft's text: a new comment over [from, to], or an edit. */
  save(draft: Draft, text: string, state: EditorState): void;
  edit(comment: ReviewComment): void;
  resolve(comment: ReviewComment): void;
  remove(comment: ReviewComment): void;
}

export const setPlacedComments = StateEffect.define<PlacedComment[]>();
export const setDraft = StateEffect.define<Draft | null>();

interface CommentsState {
  placed: PlacedComment[];
  draft: Draft | null;
}

export const commentsField = StateField.define<CommentsState>({
  create: () => ({ placed: [], draft: null }),
  update(value, tr) {
    let { placed, draft } = value;
    if (tr.docChanged) {
      placed = placed.map((p) => ({ ...p, from: tr.changes.mapPos(p.from, -1), to: tr.changes.mapPos(p.to, 1) }));
      if (draft) draft = { ...draft, from: tr.changes.mapPos(draft.from, -1), to: tr.changes.mapPos(draft.to, 1) };
    }
    for (const e of tr.effects) {
      if (e.is(setPlacedComments)) placed = e.value;
      if (e.is(setDraft)) draft = e.value;
    }
    return placed === value.placed && draft === value.draft ? value : { placed, draft };
  },
});

/** The whole lines a selection covers, as [start of first, end of last]. */
export function linesOfSelection(state: EditorState): { from: number; to: number } {
  const sel = state.selection.main;
  const first = state.doc.lineAt(sel.from);
  // A selection ending at the very start of a line does not include that line.
  const endPos = sel.to > sel.from && state.doc.lineAt(sel.to).from === sel.to ? sel.to - 1 : sel.to;
  const last = state.doc.lineAt(Math.max(endPos, sel.from));
  return { from: first.from, to: last.to };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, onClick: () => void, cls = 'ed-cmt-btn'): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the editor's selection
  b.addEventListener('click', onClick);
  return b;
}

function rangeLabel(view: EditorView, from: number, to: number): string {
  const a = view.state.doc.lineAt(from).number;
  const b = view.state.doc.lineAt(to).number;
  return a === b ? `line ${a}` : `lines ${a}–${b}`;
}

class CommentCard extends WidgetType {
  constructor(
    readonly placed: PlacedComment,
    readonly actions: CommentActions,
  ) {
    super();
  }
  eq(other: CommentCard): boolean {
    const a = this.placed.comment;
    const b = other.placed.comment;
    return a.id === b.id && a.updatedAt === b.updatedAt && a.sentAt === b.sentAt && a.body === b.body;
  }
  toDOM(view: EditorView): HTMLElement {
    const c = this.placed.comment;
    const card = el('div', 'ed-cmt');
    const head = el('div', 'ed-cmt-head');
    head.append(el('span', 'ed-cmt-where', rangeLabel(view, this.placed.from, this.placed.to)));
    head.append(el('span', c.sentAt ? 'ed-cmt-state ed-cmt-sent' : 'ed-cmt-state', c.sentAt ? 'sent to Claude' : 'not sent'));
    const actions = el('span', 'ed-cmt-actions');
    actions.append(
      button('Edit', () => this.actions.edit(c)),
      button('Resolve', () => this.actions.resolve(c)),
      button('Delete', () => this.actions.remove(c), 'ed-cmt-btn ed-cmt-danger'),
    );
    head.append(actions);
    card.append(head, el('div', 'ed-cmt-body', c.body));
    return card;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

class DraftBox extends WidgetType {
  constructor(
    readonly draft: Draft,
    readonly actions: CommentActions,
  ) {
    super();
  }
  // Stable while typing: the textarea keeps its own value, and recreating the
  // widget on every transaction would throw the text away.
  eq(other: DraftBox): boolean {
    return other.draft.editing?.id === this.draft.editing?.id;
  }
  toDOM(view: EditorView): HTMLElement {
    const box = el('div', 'ed-cmt ed-cmt-draft');
    const area = el('textarea', 'ed-cmt-input');
    area.rows = 3;
    area.placeholder = 'Leave a comment for Claude — any number of lines. ⌘↵ to save, Esc to cancel.';
    area.value = this.draft.editing?.body ?? '';
    const save = () => {
      const text = area.value.trim();
      if (text === '') return;
      const draft = view.state.field(commentsField).draft;
      if (draft) this.actions.save(draft, text, view.state);
    };
    const cancel = () => {
      view.dispatch({ effects: setDraft.of(null) });
      view.focus();
    };
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        save();
      } else if (e.key === 'Escape') {
        // Stop here: Esc also closes the editor tab.
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }
    });
    const foot = el('div', 'ed-cmt-foot');
    foot.append(
      el('span', 'ed-cmt-where', rangeLabel(view, this.draft.from, this.draft.to)),
      button('Cancel', cancel),
      button(this.draft.editing ? 'Save' : 'Comment', save, 'ed-cmt-btn ed-cmt-primary'),
    );
    box.append(area, foot);
    setTimeout(() => area.focus(), 0);
    return box;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

const commentedLine = Decoration.line({ class: 'ed-cmt-line' });

class Dot extends GutterMarker {
  toDOM(): Node {
    return el('span', 'ed-cmt-dot');
  }
}
const dot = new Dot();

/**
 * The extension. `actions` is read through a getter so the editor can hand
 * in fresh callbacks without reconfiguring CodeMirror.
 */
export function commentsExtension(actions: () => CommentActions | null): Extension {
  const proxy: CommentActions = {
    save: (d, t, s) => actions()?.save(d, t, s),
    edit: (c) => actions()?.edit(c),
    resolve: (c) => actions()?.resolve(c),
    remove: (c) => actions()?.remove(c),
  };

  const decorations = EditorView.decorations.compute([commentsField], (state): DecorationSet => {
    const { placed, draft } = state.field(commentsField);
    const ranges: Range<Decoration>[] = [];
    const shade = (from: number, to: number) => {
      for (let pos = from; pos <= to; ) {
        const line = state.doc.lineAt(pos);
        ranges.push(commentedLine.range(line.from));
        pos = line.to + 1;
      }
    };
    for (const p of placed) {
      if (draft?.editing?.id === p.comment.id) continue; // the draft box replaces its card
      shade(p.from, p.to);
      ranges.push(Decoration.widget({ widget: new CommentCard(p, proxy), block: true, side: 1 }).range(p.to));
    }
    if (draft) {
      shade(draft.from, draft.to);
      ranges.push(Decoration.widget({ widget: new DraftBox(draft, proxy), block: true, side: 2 }).range(draft.to));
    }
    return Decoration.set(ranges, true);
  });

  const commentGutter = gutter({
    class: 'ed-cmt-gutter',
    lineMarker(view, line) {
      const { placed } = view.state.field(commentsField);
      return placed.some((p) => p.to >= line.from && p.from <= line.to) ? dot : null;
    },
    lineMarkerChange: (update) => update.transactions.some((t) => t.effects.some((e) => e.is(setPlacedComments))),
    domEventHandlers: {
      mousedown(view, line, event) {
        if ((event as MouseEvent).button !== 0) return false;
        // On a line inside the selection, comment the selection; else the line.
        const sel = linesOfSelection(view.state);
        const range = line.from >= sel.from && line.to <= sel.to ? sel : { from: line.from, to: line.to };
        view.dispatch({ effects: setDraft.of({ ...range, editing: null }) });
        return true;
      },
    },
  });

  return [commentsField, decorations, commentGutter];
}
