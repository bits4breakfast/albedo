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
import { removedLines, type ReviewComment } from '../../db/comments';
import { holdDraftEdit } from '../../capture/draftRemovals';
import { changeLabel, indentOf, insertIndent, joinSuggestion, replacesLabel, splitSuggestion, suggestionFrom } from '../../lib/suggestion';
import { ACTION_LABEL, DESTINATIONS, SUGGEST_HINT, SUGGEST_LABEL, cardState, draftPlaceholder, draftSaveLabel } from './commentLabels';

/** A comment placed in this document. */
export interface PlacedComment {
  comment: ReviewComment;
  /** Start of its first line. */
  from: number;
  /** End of its last line. */
  to: number;
  /** #287: a draft for GitHub on lines outside the PR's diff. */
  outside?: boolean;
  /** #409: carried by a held message: its chip says Held. */
  held?: boolean;
  /**
   * #402: a comment on removed lines, which are not in this file. `from`/`to`
   * are then the line its card goes under, and the removal sat just above
   * it -- or, `below`, after it: it was at the end of the file.
   */
  removed?: { below: boolean };
}

export interface Draft {
  from: number;
  to: number;
  /** Set when editing an existing comment. */
  editing: ReviewComment | null;
  /** #402: editing a comment on removed lines: its place in words, and no line shaded. */
  label?: string;
}

/** "On removed line 4 · was above this line" (#402): a removed comment's place in the file. */
export function removedPlace(c: Pick<ReviewComment, 'lineStart' | 'lineEnd'>, below: boolean): string {
  return `On ${removedLines(c)} · was ${below ? 'below' : 'above'} this line`;
}

export interface CommentActions {
  /** Save a draft's text: a new comment over [from, to], or an edit; `github` is where it goes (#287). */
  save(draft: Draft, text: string, state: EditorState, github: 'draft' | null): void;
  /**
   * #287: on a review task, where a box starts (the choice is drawn); undefined
   * on any other task, whose box has no choice and whose comments go to Claude.
   */
  destination?(editing: ReviewComment | null): 'draft' | null | undefined;
  edit(comment: ReviewComment): void;
  resolve(comment: ReviewComment): void;
  remove(comment: ReviewComment): void;
}

export const setPlacedComments = StateEffect.define<PlacedComment[]>();
export const setDraft = StateEffect.define<Draft | null>();
/** The lines a drag down the gutter covers so far; null when not dragging. */
export const setPicking = StateEffect.define<{ from: number; to: number } | null>();

interface CommentsState {
  placed: PlacedComment[];
  draft: Draft | null;
  picking: { from: number; to: number } | null;
}

export const commentsField = StateField.define<CommentsState>({
  create: () => ({ placed: [], draft: null, picking: null }),
  update(value, tr) {
    let { placed, draft, picking } = value;
    if (tr.docChanged) {
      placed = placed.map((p) => ({ ...p, from: tr.changes.mapPos(p.from, -1), to: tr.changes.mapPos(p.to, 1) }));
      if (draft) draft = { ...draft, from: tr.changes.mapPos(draft.from, -1), to: tr.changes.mapPos(draft.to, 1) };
    }
    for (const e of tr.effects) {
      if (e.is(setPlacedComments)) placed = e.value;
      if (e.is(setDraft)) draft = e.value;
      if (e.is(setPicking)) picking = e.value;
    }
    return placed === value.placed && draft === value.draft && picking === value.picking
      ? value
      : { placed, draft, picking };
  },
});

/** Whole lines from line `a` to line `b` (1-based, either order) as offsets. */
export function lineRange(state: EditorState, a: number, b: number): { from: number; to: number } {
  return { from: state.doc.line(Math.min(a, b)).from, to: state.doc.line(Math.max(a, b)).to };
}

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
  return a === b ? `Line ${a}` : `Lines ${a}–${b}`;
}

/** The same diff as CommentViews' SuggestionDiff (#411). */
function suggestionDiff(before: readonly string[], after: readonly string[]): HTMLElement {
  const diff = el('div', 'ed-cmt-sug-diff');
  diff.setAttribute('role', 'group');
  diff.setAttribute('aria-label', `Suggested change: ${replacesLabel(before.length, after.length)}`);
  for (const [kind, lines] of [['del', before], ['add', after]] as const) {
    for (const l of lines) {
      const line = el('div', 'ed-cmt-sug-line', l);
      line.dataset.kind = kind;
      diff.append(line);
    }
  }
  return diff;
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
    return (
      a.id === b.id &&
      a.updatedAt === b.updatedAt &&
      a.sentAt === b.sentAt &&
      a.body === b.body &&
      a.github === b.github &&
      this.placed.outside === other.placed.outside &&
      this.placed.held === other.placed.held &&
      a.lineStart === b.lineStart &&
      a.lineEnd === b.lineEnd &&
      this.placed.removed?.below === other.placed.removed?.below
    );
  }
  toDOM(view: EditorView): HTMLElement {
    const c = this.placed.comment;
    // The same card as the Diff mode's CommentCardView (#222): a state chip,
    // one main action, and the rest behind ⋯.
    const state = cardState(c, Date.now(), this.placed.outside === true, this.placed.held === true);
    const card = el('div', 'ed-cmt');
    card.dataset.state = state.state;
    const removed = this.placed.removed;
    if (removed) card.dataset.side = 'old';
    const head = el('div', 'ed-cmt-head');
    head.append(
      el('span', 'ed-cmt-where', removed ? removedPlace(c, removed.below) : rangeLabel(view, this.placed.from, this.placed.to)),
    );
    const chip = el('span', 'ed-cmt-chip', state.chip);
    chip.dataset.state = state.state;
    head.append(chip);
    const run = { edit: () => this.actions.edit(c), resolve: () => this.actions.resolve(c), delete: () => this.actions.remove(c) };
    const make = (a: 'edit' | 'resolve' | 'delete', primary: boolean) =>
      button(ACTION_LABEL[a], run[a], a === 'delete' ? 'ed-cmt-btn ed-cmt-danger' : primary ? 'ed-cmt-btn ed-cmt-primary' : 'ed-cmt-btn');
    const actions = el('span', 'ed-cmt-actions');
    const more = button('⋯', () => {
      const open = more.getAttribute('aria-expanded') !== 'true';
      more.setAttribute('aria-expanded', String(open));
      for (const b of extra) b.hidden = !open;
    }, 'ed-cmt-btn ed-cmt-more');
    more.setAttribute('aria-expanded', 'false');
    more.setAttribute('aria-label', 'More actions');
    more.title = 'More actions';
    const extra = state.more.map((a) => {
      const b = make(a, false);
      b.hidden = true;
      return b;
    });
    actions.append(make(state.main, state.state === 'sent'), ...extra, more);
    head.append(actions);
    card.append(head);
    // A suggested edit (#411) as a small diff, then the text: as the Diff
    // mode's card draws it.
    const { suggestion, text } = splitSuggestion(c.body);
    if (suggestion === null) card.append(el('div', 'ed-cmt-body', c.body));
    else {
      card.append(suggestionDiff(c.anchorText.split('\n'), suggestion));
      if (text !== '') card.append(el('div', 'ed-cmt-body', text));
    }
    return card;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/** A draft box's refresh when it moves to other lines (DraftBox.updateDOM). */
const moved = new WeakMap<HTMLElement, { id: number | null; refresh: (view: EditorView) => void }>();

class DraftBox extends WidgetType {
  constructor(
    readonly draft: Draft,
    readonly actions: CommentActions,
  ) {
    super();
  }
  // Stable while typing: the textarea keeps its own value, and recreating the
  // widget on every transaction would throw the text away. A box that moved
  // (a new drag, ⌥⌘M on another selection) is not equal, and is updated in
  // place by updateDOM: same text, its lines named again.
  eq(other: DraftBox): boolean {
    return other.draft.editing?.id === this.draft.editing?.id && other.draft.from === this.draft.from && other.draft.to === this.draft.to;
  }
  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    // Only the same box, moved: a box for another comment (or a new one in
    // place of an edit) is drawn afresh, or it would carry the old one's words.
    const kept = moved.get(dom);
    if (!kept || kept.id !== (this.draft.editing?.id ?? null)) return false;
    kept.refresh(view);
    return true;
  }
  toDOM(view: EditorView): HTMLElement {
    const box = el('div', 'ed-cmt ed-cmt-draft');
    const area = el('textarea', 'ed-cmt-input');
    area.rows = 3;
    // A review task's box chooses where the comment goes (#287), as the Diff
    // mode's DestinationSwitch does; any other task's has no choice.
    const start = this.actions.destination?.(this.draft.editing);
    let github: 'draft' | null = start ?? null;
    const editing = this.draft.editing !== null;
    const primary = button(draftSaveLabel(github, editing), () => save(), 'ed-cmt-btn ed-cmt-primary');
    area.placeholder = draftPlaceholder(github);
    // A stored suggestion (#411) opens in the code box; the text in this one.
    const stored = splitSuggestion(this.draft.editing?.body ?? '');
    area.value = stored.suggestion === null ? (this.draft.editing?.body ?? '') : stored.text;
    // The commented lines as they are now: what Suggest Change starts from.
    // Read from the draft where it is at the moment asked, never kept: the
    // box moves when a new range is picked, and keeps its DOM when it does.
    const lines = (): string[] => {
      const d = view.state.field(commentsField).draft ?? this.draft;
      const doc = view.state.doc;
      return doc.sliceString(doc.lineAt(d.from).from, doc.lineAt(d.to).to).split('\n');
    };
    const code = el('textarea', 'ed-cmt-code');
    const save = () => {
      const text = area.value.trim();
      // Code left as the lines themselves suggests nothing.
      const suggestion = sug.hidden ? null : suggestionFrom(code.value, lines());
      if (text === '' && suggestion === null) return;
      const draft = view.state.field(commentsField).draft;
      if (draft) this.actions.save(draft, joinSuggestion(suggestion, text), view.state, github);
    };
    if (start !== undefined) {
      const head = el('div', 'ed-cmt-head');
      const seg = el('span', 'seg-sm');
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', 'Where this comment goes');
      const options = DESTINATIONS.map((d) => {
        const b = button(d.label, () => {
          github = d.github;
          for (const [o, x] of options) o.setAttribute('aria-pressed', String(x === github));
          primary.textContent = draftSaveLabel(github, editing);
          area.placeholder = draftPlaceholder(github);
          area.focus();
        }, '');
        b.setAttribute('aria-pressed', String(d.github === github));
        return [b, d.github] as const;
      });
      seg.append(...options.map(([b]) => b));
      head.append(el('span', 'ed-cmt-where', 'Goes to'), seg);
      box.append(head);
    }
    const cancel = () => {
      view.dispatch({ effects: setDraft.of(null) });
      view.focus();
    };

    // Suggest Change (#411), as the Diff mode's SuggestionEditor draws it:
    // a toggle, and while it is on the lines as code to edit.
    const suggestRow = el('div', 'ed-cmt-head');
    const hint = el('span', 'ed-cmt-where', SUGGEST_HINT);
    const sug = el('div', 'ed-cmt-sug');
    const sugHead = el('div', 'ed-cmt-sug-head');
    const count = el('span', '');
    sugHead.append(el('span', '', 'Suggested'), count);
    code.setAttribute('aria-label', 'Suggested code');
    code.spellcheck = false;
    code.setAttribute('autocapitalize', 'off');
    code.setAttribute('autocorrect', 'off');
    code.setAttribute('wrap', 'off');
    const fit = () => {
      count.textContent = changeLabel(lines(), code.value);
      code.rows = Math.max(1, Math.min(12, code.value.split('\n').length));
      // The widget's height changed: CodeMirror's line heights must follow.
      view.requestMeasure();
    };
    code.addEventListener('input', fit);
    code.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        save();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      } else {
        if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
          // Indent, as in the file, rather than leave the box.
          e.preventDefault();
          insertIndent(code, indentOf(lines()));
          fit();
        }
        e.stopPropagation();
      }
    });
    sug.append(sugHead, code);
    const mark = el('span', '', ' ✓');
    mark.setAttribute('aria-hidden', 'true');
    const toggle = button(SUGGEST_LABEL, () => {
      if (sug.hidden) {
        code.value = lines().join('\n');
        show(true);
        code.focus();
      } else {
        // Off drops the suggestion and keeps the text.
        show(false);
        area.focus();
      }
    }, 'ed-cmt-btn ed-cmt-suggest');
    const show = (on: boolean) => {
      sug.hidden = !on;
      hint.hidden = !on;
      toggle.setAttribute('aria-pressed', String(on));
      if (on) toggle.append(mark);
      else mark.remove();
      fit();
      view.requestMeasure();
    };
    if (stored.suggestion !== null) code.value = stored.suggestion.join('\n');
    show(stored.suggestion !== null);
    suggestRow.append(toggle, hint);
    // No Suggest Change on removed lines (#402): there is nothing in the file
    // for a suggestion to replace, and GitHub's left side takes none.
    if (this.draft.label === undefined) box.append(suggestRow, sug);

    area.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        save();
      } else if (e.key === 'Escape') {
        // Stop here: Esc also closes the editor tab.
        e.preventDefault();
        e.stopPropagation();
        cancel();
      } else {
        // Everything else is typing in the comment -- plain Enter a new line
        // -- and belongs to nothing around it.
        e.stopPropagation();
      }
    });
    const foot = el('div', 'ed-cmt-foot');
    // A removed comment's box (#402) names its place in words, which no move changes.
    const label = this.draft.label;
    const where = el('span', 'ed-cmt-where', label ?? rangeLabel(view, this.draft.from, this.draft.to));
    foot.append(where, button('Cancel', cancel), primary);
    box.append(area, foot);
    moved.set(box, { id: this.draft.editing?.id ?? null, refresh: (v) => {
      const d = v.state.field(commentsField).draft;
      if (d) where.textContent = label ?? rangeLabel(v, d.from, d.to);
      if (!sug.hidden) fit();
    } });
    setTimeout(() => area.focus(), 0);
    // An existing comment open here is not the session's to remove (#427);
    // released when the box goes (an updated box keeps the same comment).
    if (this.draft.editing) editHolds.set(box, holdDraftEdit(this.draft.editing.id));
    return box;
  }
  destroy(dom: HTMLElement): void {
    editHolds.get(dom)?.();
    editHolds.delete(dom);
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/** The edit hold each File mode box took (#427), by its element. */
const editHolds = new WeakMap<HTMLElement, () => void>();

const commentedLine = Decoration.line({ class: 'ed-cmt-line' });

/** #402: the short red mark where removed lines were, between two lines of the file. */
class RemovedMark extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const mark = el('div', 'ed-cmt-gap');
    mark.setAttribute('aria-hidden', 'true');
    return mark;
  }
}
const removedMark = new RemovedMark();

/**
 * A gutter cell's content on every line: the place to press, named by its
 * tooltip, since the gutter is the one way in with no label. A dot when the
 * line already has a comment.
 */
class Slot extends GutterMarker {
  constructor(readonly commented: boolean) {
    super();
  }
  eq(other: Slot): boolean {
    return other.commented === this.commented;
  }
  toDOM(): Node {
    const slot = el('span', 'ed-cmt-slot');
    slot.title = 'Add a Comment (⌥⌘M)';
    if (this.commented) slot.append(el('span', 'ed-cmt-dot'));
    return slot;
  }
}
const dot = new Slot(true);
const empty = new Slot(false);

/**
 * The extension. `actions` is read through a getter so the editor can hand
 * in fresh callbacks without reconfiguring CodeMirror.
 */
export function commentsExtension(actions: () => CommentActions | null): Extension {
  const proxy: CommentActions = {
    save: (d, t, s, g) => actions()?.save(d, t, s, g),
    destination: (c) => actions()?.destination?.(c),
    edit: (c) => actions()?.edit(c),
    resolve: (c) => actions()?.resolve(c),
    remove: (c) => actions()?.remove(c),
  };

  const decorations = EditorView.decorations.compute([commentsField], (state): DecorationSet => {
    const { placed, draft, picking } = state.field(commentsField);
    const ranges: Range<Decoration>[] = [];
    const shade = (from: number, to: number) => {
      for (let pos = from; pos <= to; ) {
        const line = state.doc.lineAt(pos);
        ranges.push(commentedLine.range(line.from));
        pos = line.to + 1;
      }
    };
    // One mark per gap (#402), however many comments it has.
    const gaps = new Set<number>();
    for (const p of placed) {
      if (p.removed) {
        // Not this line's: a mark where the removed lines were, above it
        // (or, at the end of the file, below it), and no edge.
        const at = p.removed.below ? p.to : p.from;
        if (!gaps.has(at)) {
          gaps.add(at);
          ranges.push(Decoration.widget({ widget: removedMark, block: true, side: p.removed.below ? 1 : -1 }).range(at));
        }
      }
      if (draft?.editing?.id === p.comment.id) continue; // the draft box replaces its card
      if (!p.removed) shade(p.from, p.to);
      ranges.push(Decoration.widget({ widget: new CommentCard(p, proxy), block: true, side: p.removed?.below ? 2 : 1 }).range(p.to));
    }
    if (picking) shade(picking.from, picking.to);
    if (draft) {
      if (draft.label === undefined) shade(draft.from, draft.to);
      ranges.push(Decoration.widget({ widget: new DraftBox(draft, proxy), block: true, side: 2 }).range(draft.to));
    }
    return Decoration.set(ranges, true);
  });

  const commentGutter = gutter({
    class: 'ed-cmt-gutter',
    // A marker on every line, not only the commented ones: CodeMirror draws a
    // gutter cell only where there is a marker, so a file with no comments
    // showed its + on the cursor's line alone, and a blank strip elsewhere.
    lineMarker(view, line) {
      const { placed } = view.state.field(commentsField);
      // A comment on removed lines (#402) is not on this line: no dot.
      return placed.some((p) => !p.removed && p.to >= line.from && p.from <= line.to) ? dot : empty;
    },
    lineMarkerChange: (update) => update.transactions.some((t) => t.effects.some((e) => e.is(setPlacedComments))),
    domEventHandlers: {
      // Press for one line, drag down (or up) the gutter for several, the way
      // a review tool picks a range. A press inside a multi-line selection,
      // released without dragging, comments the selection.
      mousedown(view, line, event) {
        const e = event as MouseEvent;
        if (e.button !== 0 || !actions()) return false;
        const sel = linesOfSelection(view.state);
        const inSelection = line.from >= sel.from && line.to <= sel.to && sel.to - sel.from > line.to - line.from;
        const start = view.state.doc.lineAt(line.from).number;
        let end = start;
        view.dispatch({ effects: setPicking.of(lineRange(view.state, start, end)) });
        const move = (ev: MouseEvent) => {
          const block = view.lineBlockAtHeight(ev.clientY - view.documentTop);
          const n = view.state.doc.lineAt(block.from).number;
          if (n === end) return;
          end = n;
          view.dispatch({ effects: setPicking.of(lineRange(view.state, start, end)) });
        };
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          const range = end === start && inSelection ? sel : lineRange(view.state, start, end);
          view.dispatch({ effects: [setPicking.of(null), setDraft.of({ ...range, editing: null })] });
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        return true;
      },
    },
  });

  return [commentsField, decorations, commentGutter];
}
