import { describe, expect, it } from 'vitest';
import {
  COLLAPSE_MAX_CHARS,
  draftOf,
  foldPastes,
  markPastes,
  pasteMention,
  queuedLabel,
  intactTokens,
  lineBreaks,
  lineCount,
  pastesIn,
  placeholderFor,
  replaceRanges,
  shouldCollapse,
  tokenRanges,
} from './pastedText';

describe('pasted text placeholders', () => {
  it("collapses at Claude Code's threshold: over 800 characters, or over two line breaks", () => {
    expect(shouldCollapse('one line')).toBe(false);
    expect(shouldCollapse('a\nb')).toBe(false);
    expect(shouldCollapse('a\nb\nc')).toBe(false); // two breaks: Claude Code keeps it inline too
    expect(shouldCollapse('a\nb\nc\nd')).toBe(true);
    expect(shouldCollapse('a\nb\nc\n')).toBe(true); // a trailing break counts, as in Claude Code
    expect(shouldCollapse('a\r\nb\r\nc\r\nd')).toBe(true);
    expect(shouldCollapse('x'.repeat(COLLAPSE_MAX_CHARS))).toBe(false);
    expect(shouldCollapse('x'.repeat(COLLAPSE_MAX_CHARS + 1))).toBe(true);
  });

  it('counts breaks the way Claude Code does: \\r\\n, \\r and \\n are one each', () => {
    expect(lineBreaks('a\r\nb\rc\nd')).toBe(3);
    expect(lineBreaks('flat')).toBe(0);
  });

  it('counts lines the way the placeholder reports them', () => {
    expect(lineCount('a\nb\nc\n')).toBe(3);
    expect(lineCount('a\r\nb')).toBe(2);
    expect(placeholderFor(2, 'a\nb\nc')).toBe('[Pasted text #2 +3 lines]');
    expect(placeholderFor(1, 'x'.repeat(900))).toBe('[Pasted text #1 +1 line]');
  });

  it('sends intact placeholders as their pastes, each in its marker, and leaves everything else alone', () => {
    const store = new Map([
      [1, 'line1\nline2\nline3'],
      [2, 'other'],
    ]);
    const draft = 'look: [Pasted text #1 +3 lines] and [Pasted text #9 +2 lines] and [Pasted text #2 +1 line]';
    expect(markPastes(draft, store)).toBe(
      `look: ${marked('1', 'line1\nline2\nline3')} and [Pasted text #9 +2 lines] and ${marked('2', 'other')}`,
    );
    // An edited token is no longer a placeholder.
    expect(markPastes('[Pasted text #1 +3 lin]', store)).toBe('[Pasted text #1 +3 lin]');
    expect(markPastes('plain', new Map())).toBe('plain');
  });

  it('does not send a token whose line count was edited: its paste is not sent', () => {
    const store = new Map([[1, 'a\nb\nc\nd']]);
    expect(markPastes('[Pasted text #1 +5 lines]', store)).toBe('[Pasted text #1 +5 lines]');
    expect(markPastes('[Pasted text #1 +4 lines]', store)).toBe(marked('1', 'a\nb\nc\nd'));
  });

  it('does not treat $-patterns in the pasted text specially', () => {
    expect(markPastes('[Pasted text #1 +1 line]', new Map([[1, "cost: $1 and $& and $'"]]))).toBe(
      marked('1', "cost: $1 and $& and $'"),
    );
  });

  it('sends a token moved whole, and one that appears twice', () => {
    const store = new Map([[3, 'x\ny\nz\nw']]);
    const t = placeholderFor(3, 'x\ny\nz\nw');
    expect(markPastes(`${t} then ${t}`, store)).toBe(`${marked('3', 'x\ny\nz\nw')} then ${marked('3', 'x\ny\nz\nw')}`);
  });
});

/** A paste as the composer marks it. */
function marked(id: string, text: string): string {
  return `<pasted-text id="${id}" lines="${lineCount(text)}">\n${text}\n</pasted-text id="${id}">`;
}

describe('a sent paste, marked (#155)', () => {
  const log = Array.from({ length: 42 }, (_, i) => `step ${i + 1}: ok`).join('\n');

  it('takes another id when the paste already holds its tags, and leaves the text as it was', () => {
    // A pasted Albedo message: its own marker, closed with id 1.
    const inner = marked('1', 'a\nb\nc\nd');
    const store = new Map([[1, inner]]);
    const body = markPastes(`see [Pasted text #1 +${lineCount(inner)} lines]`, store);
    expect(body).toBe(`see ${marked('2', inner)}`);
    expect(draftOf(body)).toEqual({ text: `see ${placeholderFor(1, inner)}`, pastes: new Map([[1, inner]]) });
  });

  it('gives two different pastes two ids, even when one would take the other\'s', () => {
    // Paste #1 holds paste #2's natural id, so #1 moves on -- and must not land on 2.
    const a = 'holds <pasted-text id="1" and </pasted-text id="1">\nx\ny\nz';
    const b = 'q\nr\ns\nt';
    const store = new Map([
      [1, a],
      [2, b],
    ]);
    const body = markPastes(`${placeholderFor(1, a)} ${placeholderFor(2, b)}`, store);
    expect(body).toBe(`${marked('2', a)} ${marked('3', b)}`);
  });

  it('comes back as a draft with its tokens: typed text kept, each paste folded again', () => {
    const store = new Map([[4, log]]);
    const body = markPastes(`before\n${placeholderFor(4, log)}\nafter`, store);
    const back = draftOf(body);
    expect(back.text).toBe(`before\n${placeholderFor(1, log)}\nafter`);
    expect(back.pastes).toEqual(new Map([[1, log]]));
    // And goes out again as the same text.
    expect(draftOf(markPastes(back.text, back.pastes))).toEqual(back);
    expect(draftOf('no pastes here')).toEqual({ text: 'no pastes here', pastes: new Map() });
  });

  it('reads as its mention in the echo and the Queued band', () => {
    const body = markPastes(`why does this fail?\n${placeholderFor(1, log)}`, new Map([[1, log]]));
    expect(pasteMention(log)).toBe('[Pasted text · 42 lines]');
    expect(pasteMention('one')).toBe('[Pasted text · 1 line]');
    expect(foldPastes(body)).toBe('why does this fail?\n[Pasted text · 42 lines]');
    expect(queuedLabel(body)).toBe('why does this fail?\n[Pasted text · 42 lines]');
    // Inside Claude Code's wrapper the typed text still shows, the paste as its mention.
    const wrapped = `\n\n<pasted_content id="ab12">\n${body}\n</pasted_content id="ab12">\n`;
    expect(queuedLabel(wrapped)).toBe('why does this fail?\n[Pasted text · 42 lines]');
    // A wrapper with no markers in it reads as before.
    expect(queuedLabel('see <pasted_content id="1">long\ntext</pasted_content id="1"> please')).toBe('see [pasted text] please');
  });
});

describe('the pastes a draft uses', () => {
  const store = new Map([
    [1, 'a\nb\nc\nd'],
    [2, 'p\nq\nr\ns\nt'],
    [3, 'gone\nfrom\nthe\ndraft'],
  ]);
  const draft = `see ${placeholderFor(2, 'p\nq\nr\ns\nt')} and ${placeholderFor(1, 'a\nb\nc\nd')} and ${placeholderFor(2, 'p\nq\nr\ns\nt')}`;

  it('lists intact tokens in order, with where they sit', () => {
    const tokens = intactTokens(draft, store);
    expect(tokens.map((t) => t.id)).toEqual([2, 1, 2]);
    for (const t of tokens) expect(draft.slice(t.start, t.end)).toBe(placeholderFor(t.id, store.get(t.id) ?? ''));
  });

  it('keeps only pastes with an intact token, each once, in order of first appearance', () => {
    expect([...pastesIn(draft, store).keys()]).toEqual([2, 1]);
    expect(pastesIn('nothing here', store).size).toBe(0);
  });

  it('replaces one paste\'s tokens, leaving the others', () => {
    const ranges = tokenRanges(draft, store, 2);
    expect(ranges).toHaveLength(2);
    expect(replaceRanges(draft, ranges, '')).toBe(`see  and ${placeholderFor(1, 'a\nb\nc\nd')} and `);
    expect(replaceRanges(draft, tokenRanges(draft, store, 1), 'a\nb\nc\nd')).toBe(
      `see ${placeholderFor(2, 'p\nq\nr\ns\nt')} and a\nb\nc\nd and ${placeholderFor(2, 'p\nq\nr\ns\nt')}`,
    );
    expect(tokenRanges(draft, store, 3)).toEqual([]);
  });
});
