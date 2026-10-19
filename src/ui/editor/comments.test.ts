import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { commentsField, lineRange, linesOfSelection, setDraft, setPicking, setPlacedComments } from './comments';
import type { ReviewComment } from '../../db/comments';

const doc = 'one\ntwo\nthree\nfour\n';

function stateWith(selection: EditorSelection) {
  return EditorState.create({ doc, selection, extensions: [commentsField] });
}

describe('linesOfSelection', () => {
  it('is the cursor line when nothing is selected', () => {
    const s = stateWith(EditorSelection.single(5)); // inside "two"
    expect(linesOfSelection(s)).toEqual({ from: 4, to: 7 });
  });

  it('covers every line the selection touches', () => {
    const s = stateWith(EditorSelection.single(5, 10)); // "wo\nthr"
    expect(linesOfSelection(s)).toEqual({ from: 4, to: 13 });
  });

  it('leaves out a line the selection only reaches the very start of', () => {
    const s = stateWith(EditorSelection.single(4, 8)); // "two\n", ending at the start of "three"
    expect(linesOfSelection(s)).toEqual({ from: 4, to: 7 });
  });
});

describe('commentsField', () => {
  const c = { id: 1 } as ReviewComment;

  it('keeps comments and the draft with their code as the text changes above them', () => {
    let s = stateWith(EditorSelection.single(0));
    s = s.update({
      effects: [setPlacedComments.of([{ comment: c, from: 8, to: 13 }]), setDraft.of({ from: 14, to: 18, editing: null })],
    }).state;
    s = s.update({ changes: { from: 0, insert: 'zero\n' } }).state; // 5 characters above
    const { placed, draft } = s.field(commentsField);
    expect(placed[0]).toMatchObject({ from: 13, to: 18 });
    expect(s.doc.sliceString(placed[0]!.from, placed[0]!.to)).toBe('three');
    expect(draft).toMatchObject({ from: 19, to: 23 });
  });

  it('a cleared draft is gone', () => {
    let s = stateWith(EditorSelection.single(0)).update({ effects: setDraft.of({ from: 0, to: 3, editing: null }) }).state;
    s = s.update({ effects: setDraft.of(null) }).state;
    expect(s.field(commentsField).draft).toBeNull();
  });
});

describe('picking lines in the gutter', () => {
  it('lineRange covers whole lines, in either drag direction', () => {
    const s = stateWith(EditorSelection.single(0));
    expect(lineRange(s, 2, 3)).toEqual({ from: 4, to: 13 });
    expect(lineRange(s, 3, 2)).toEqual({ from: 4, to: 13 });
  });

  it('holds the range being dragged until it is cleared', () => {
    let s = stateWith(EditorSelection.single(0)).update({ effects: setPicking.of({ from: 4, to: 13 }) }).state;
    expect(s.field(commentsField).picking).toEqual({ from: 4, to: 13 });
    s = s.update({ effects: setPicking.of(null) }).state;
    expect(s.field(commentsField).picking).toBeNull();
  });
});
