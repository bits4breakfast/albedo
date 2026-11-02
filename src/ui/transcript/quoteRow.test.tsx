/**
 * @vitest-environment jsdom
 *
 * A message carrying comments on transcript passages (#187), as the
 * transcript draws it: each quote a compact block above its comment, a long
 * one folded to its first line and "+N lines", never its tags -- whether
 * Claude Code recorded the message bare or wrapped whole in
 * `<pasted_content id="…">` (the shape it gives a message from the box,
 * measured 2.1.314). A click on a quote asks the pane to show the passage.
 * Rows are built the way Claude Code records a typed message, through the
 * adapter.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { Message } from '../../types';
import { parseLine } from '../../capture/adapter';
import { isAllEnvelopes, parseUserBody } from './envelopes';
import { MessageRow } from './MessageRow';
import { PassageRevealContext } from './passages';
import { composeWithComments, type TranscriptComment } from './transcriptQuotes';

afterEach(cleanup);

const TS = '2026-10-30T10:00:00.000Z';

const long = Array.from({ length: 13 }, (_, i) => `build step ${i + 1}`).join('\n');
const comments: TranscriptComment[] = [
  { id: 'a', messageId: 41, quote: 'Production already runs 8.2.35.', code: false, comment: 'How do you know?', at: 1, offset: 0, addedAt: 1 },
  { id: 'b', messageId: 43, quote: long, code: true, lang: 'sh', comment: 'Why thirteen steps?', at: 2, offset: 0, addedAt: 2 },
];
const sent = composeWithComments(comments, 'Then deploy.');
const wrapped = (body: string) => `\n\n<pasted_content id="5e1a">\n${body}\n</pasted_content id="5e1a">\n`;

function row(content: string): Message {
  const line = {
    type: 'user',
    uuid: 'u1',
    parentUuid: null,
    sessionId: 's1',
    timestamp: TS,
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    origin: { kind: 'human' },
    promptSource: 'typed',
    turnOrigin: 'human',
    message: { role: 'user', content },
  };
  const [m] = parseLine(JSON.stringify(line), 5);
  if (!m) throw new Error('no row');
  return { ...m, id: 50, taskId: 1 };
}

describe('a sent message with quoted passages', () => {
  for (const [shape, content] of [
    ['as typed', sent],
    ['wrapped by Claude Code', wrapped(sent)],
  ] as const) {
    it(`parses into quote, comment, quote, then the last comment and the box text as one text (${shape})`, () => {
      const blocks = parseUserBody(content);
      expect(blocks.map((b) => b.kind)).toEqual(['quote', 'text', 'quote', 'text']);
      expect(blocks[3]).toEqual({ kind: 'text', text: 'Why thirteen steps?\n\nThen deploy.' });
      expect(blocks[0]).toEqual({ kind: 'quote', messageId: 41, text: 'Production already runs 8.2.35.', code: false, lang: null });
      expect(blocks[2]).toEqual({ kind: 'quote', messageId: 43, text: long, code: true, lang: 'sh' });
      expect(isAllEnvelopes(blocks)).toBe(false);
    });

    it(`draws under "You": the quotes compact above their comments, no tags (${shape})`, () => {
      const { container } = render(<MessageRow message={row(content)} />);
      expect(container.querySelector('.tx-row-user .tx-gutter')?.textContent).toBe('You');
      expect(container.querySelector('.tx-row-user')?.getAttribute('data-message-id')).toBe('50');
      expect(container.textContent).not.toMatch(/transcript-quote|pasted_content|^>/);
      const quotes = container.querySelectorAll('.tx-quote');
      expect(quotes).toHaveLength(2);
      expect(quotes[0]?.textContent).toBe('Production already runs 8.2.35.');
      // A long one: first line and "+12 lines", the rest a click away.
      expect(quotes[1]?.textContent).toBe('build step 1+12 lines');
      expect(container.textContent).toContain('How do you know?');
      expect(container.textContent).toContain('Why thirteen steps?');
      expect(container.textContent).toContain('Then deploy.');
      fireEvent.click(screen.getByRole('button', { name: '+12 lines' }));
      expect(quotes[1]?.textContent).toContain('build step 13');
    });
  }

  it('without the pane, a quote is text, not a button that does nothing', () => {
    render(<MessageRow message={row(sent)} />);
    expect(screen.queryByRole('button', { name: /Production already runs/ })).toBeNull();
  });

  it('in the pane, a click on a quote asks for its passage in its source row', () => {
    const reveal = vi.fn();
    render(
      <PassageRevealContext.Provider value={reveal}>
        <MessageRow message={row(wrapped(sent))} />
      </PassageRevealContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Production already runs 8.2.35.' }));
    expect(reveal).toHaveBeenCalledWith({ messageId: 41, quote: 'Production already runs 8.2.35.' });
  });
});
