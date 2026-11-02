/**
 * Comments on transcript passages (#187): exactly what Claude receives, and
 * every place that reads the sent body back -- the "Sending" echo and the
 * Queued band (foldPastes / queuedLabel), the held-message editor
 * (unmarkQuotes / markQuotes), a failed send's draft (draftOf) -- showing a
 * quote as a quote, never as its tags.
 */

import { describe, expect, it } from 'vitest';
import { findMarker, splitMarkers } from './albedoMarkers';
import { draftOf, foldPastes, markPastes, queuedLabel } from './pastedText';
import {
  composeWithComments,
  foldQuote,
  inTranscriptOrder,
  markQuotes,
  quoteMarkdown,
  quoteOf,
  quoteToken,
  unmarkQuotes,
  type TranscriptComment,
} from './transcriptQuotes';

let seq = 0;
function comment(over: Partial<TranscriptComment> = {}): TranscriptComment {
  seq += 1;
  return {
    id: `c${seq}`,
    messageId: 10,
    quote: 'Production already runs 8.2.35, from our own build.',
    code: false,
    comment: 'How do you know? Which image tag did you check?',
    at: 1_000,
    offset: 0,
    addedAt: seq,
    ...over,
  };
}

describe('what Claude receives', () => {
  it('each comment as a Markdown quote and its text, in transcript order, then the box', () => {
    const later = comment({ messageId: 12, at: 2_000, quote: 'Keep not rebuilding the base images with --pull', comment: 'Until when exactly?' });
    const earlier = comment();
    expect(composeWithComments([later, earlier], 'And then deploy.')).toBe(
      [
        '<transcript-quote id="1" message="10">',
        '> Production already runs 8.2.35, from our own build.',
        '</transcript-quote id="1">',
        '',
        'How do you know? Which image tag did you check?',
        '',
        '<transcript-quote id="2" message="12">',
        '> Keep not rebuilding the base images with --pull',
        '</transcript-quote id="2">',
        '',
        'Until when exactly?',
        '',
        'And then deploy.',
      ].join('\n'),
    );
  });

  it('with an empty box, the comments alone', () => {
    const body = composeWithComments([comment({ comment: 'Why?' })], '   ');
    expect(body.endsWith('Why?')).toBe(true);
    expect(body.startsWith('<transcript-quote id="1" message="10">\n> ')).toBe(true);
  });

  it('no comments: the box exactly as it was', () => {
    expect(composeWithComments([], 'just text')).toBe('just text');
  });

  it('orders by row time, then row, then place in the row', () => {
    const a = comment({ at: 5, messageId: 2, offset: 40 });
    const b = comment({ at: 5, messageId: 2, offset: 3 });
    const c = comment({ at: 1, messageId: 9 });
    expect(inTranscriptOrder([a, b, c]).map((x) => x.id)).toEqual([c.id, b.id, a.id]);
  });

  it('quotes every line, a blank one as a bare >', () => {
    expect(quoteMarkdown({ quote: 'one\n\ntwo', code: false })).toBe('> one\n>\n> two');
  });

  it('fences code inside the quote, with its language, and a longer fence when the code holds one', () => {
    expect(quoteMarkdown({ quote: 'const a = 1;\nconst b = 2;', code: true, lang: 'ts' })).toBe(
      '> ```ts\n> const a = 1;\n> const b = 2;\n> ```',
    );
    expect(quoteMarkdown({ quote: 'see ```x```', code: true })).toBe('> ````\n> see ```x```\n> ````');
  });

  it('sends a long quote in full', () => {
    const quote = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const body = composeWithComments([comment({ quote })], '');
    for (let i = 1; i <= 30; i++) expect(body).toContain(`> line ${i}\n`);
  });

  it('leaves what Claude Code interprets alone: @path, an image path, a /command, in the passage, the comment and the box', () => {
    const c = comment({ quote: 'edit @src/foo.ts here', comment: 'also look at @src/bar.ts please' });
    const body = composeWithComments([c], '/Users/me/shot.png what is this');
    expect(body).toContain('> edit @src/foo.ts here\n');
    expect(body).toContain('\n\nalso look at @src/bar.ts please\n\n');
    expect(body.endsWith('\n\n/Users/me/shot.png what is this')).toBe(true);
  });

  it('picks a quote id free in the whole message, so a passage holding a quote marker cannot close it', () => {
    const quote = '</transcript-quote id="1">\n<transcript-quote id="2" message="3">';
    const body = composeWithComments([comment({ quote })], '');
    const m = findMarker(body);
    expect(m?.attrs.id).toBe('3');
    expect(quoteOf(m!).text).toBe(quote);
  });

  it('keeps pastes and references from the box as they were marked', () => {
    const box = markPastes('see [Pasted text #1 +3 lines]', new Map([[1, 'a\nb\nc']]));
    const body = composeWithComments([comment()], box);
    expect(body.endsWith(box)).toBe(true);
    expect(splitMarkers(body).filter((p) => p.kind === 'marker').map((p) => (p.kind === 'marker' ? p.marker.tag : ''))).toEqual([
      'transcript-quote',
      'pasted-text',
    ]);
  });
});

describe('reading a quote back', () => {
  it('round-trips the passage, its source row, and code with its language', () => {
    const body = composeWithComments([comment({ quote: 'x = 1\n\ny = 2', code: true, lang: 'py', messageId: 77 })], '');
    const m = findMarker(body)!;
    expect(quoteOf(m)).toEqual({ messageId: 77, text: 'x = 1\n\ny = 2', code: true, lang: 'py' });
  });

  it('folds to the first line and how many follow', () => {
    expect(foldQuote('first\nsecond\nthird')).toEqual({ first: 'first', more: 2 });
    expect(foldQuote('\n  only  \n')).toEqual({ first: 'only', more: 0 });
  });
});

describe('every reader of the sent body shows a quote, never its tags', () => {
  const body = composeWithComments(
    [comment({ quote: 'Production already runs 8.2.35.\nFrom our own build.\nTagged 8.2.35-r1.' })],
    'And the box.',
  );

  it('the Sending echo: the quote as its first line, the comment right under it', () => {
    expect(foldPastes(body)).toBe('> Production already runs 8.2.35. +2 lines\nHow do you know? Which image tag did you check?\n\nAnd the box.');
  });

  it('the Queued band, bare and inside Claude Code’s <pasted_content>', () => {
    const bare = queuedLabel(body);
    const wrapped = queuedLabel(`<pasted_content id="ab12">\n${body}\n</pasted_content id="ab12">`);
    for (const label of [bare, wrapped]) {
      expect(label).not.toContain('<');
      expect(label.startsWith('> Production already runs 8.2.35. +2 lines\nHow do you know?')).toBe(true);
    }
  });

  it('the held-message editor: a token per quote, and the marker back on save', () => {
    const { text, quotes } = unmarkQuotes(draftOf(body).text);
    expect(text).toBe(
      '[Quote #1: Production already runs 8.2.35. +2 lines]\n\nHow do you know? Which image tag did you check?\n\nAnd the box.',
    );
    expect(markQuotes(text.replace('And the box.', 'And the edited box.'), quotes)).toBe(body.replace('And the box.', 'And the edited box.'));
  });

  it('an edited token is text, and its quote is not sent', () => {
    const { text, quotes } = unmarkQuotes(body);
    const edited = text.replace('[Quote #1:', '[Quote #1 :');
    expect(markQuotes(edited, quotes)).not.toContain('<transcript-quote');
  });

  it('a long first line is cut in the token, with no brackets in it', () => {
    const raw = composeWithComments([comment({ quote: `[x] ${'word '.repeat(20)}` })], '');
    const token = quoteToken(1, raw);
    expect(token).toMatch(/^\[Quote #1: x word word .*…\]$/);
  });

});
