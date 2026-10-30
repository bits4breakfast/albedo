/**
 * @vitest-environment jsdom
 *
 * A paste sent from the message box shows folded in the transcript, as the
 * box showed it (#155). The rows here are built the way Claude Code records a
 * message typed into it as one bracketed paste: a `user` line, `origin` human,
 * `promptSource` typed, its text either bare or wrapped whole in
 * `<pasted_content id="…">` with the id repeated on the closing tag. The text
 * itself is neutral.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { Message } from '../../types';
import { BODY_MAX_CHARS, parseLine } from '../../capture/adapter';
import { isPromptRow } from './compaction';
import { MessageRow } from './MessageRow';
import { markPastes, placeholderFor } from './pastedText';
import { echoLanded } from './TranscriptPane';

afterEach(cleanup);

const TS = '2026-10-30T10:00:00.000Z';
const log = Array.from({ length: 42 }, (_, i) => `step ${i + 1}: ok`).join('\n');

/** The composer's send: a typed line and a collapsed paste. */
const sent = markPastes(`why does this step fail?\n${placeholderFor(1, log)}`, new Map([[1, log]]));
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
  return { ...m, id: 1, taskId: 1 };
}

describe('a sent paste in the transcript', () => {
  for (const [shape, content] of [
    ['wrapped by Claude Code', wrapped(sent)],
    ['as typed', sent],
  ] as const) {
    it(`folds, under "You", with the typed text beside it (${shape})`, () => {
      const { container } = render(<MessageRow message={row(content)} />);
      expect(container.querySelector('.tx-row-user .tx-gutter')?.textContent).toBe('You');
      expect(container.textContent).toContain('why does this step fail?');
      const head = screen.getByRole('button', { name: /Pasted Text · 42 Lines/ });
      expect(head.getAttribute('aria-expanded')).toBe('false');
      expect(container.textContent).not.toContain('step 42: ok');
      expect(container.textContent).not.toMatch(/pasted-text|pasted_content/);
      fireEvent.click(head);
      expect(container.textContent).toContain('step 1: ok');
      expect(container.textContent).toContain('step 42: ok');
    });
  }

  it('a message that is only a paste is still "You", folded', () => {
    const only = markPastes(placeholderFor(1, log), new Map([[1, log]]));
    const { container } = render(<MessageRow message={row(wrapped(only))} />);
    expect(container.querySelector('.tx-row-user .tx-gutter')?.textContent).toBe('You');
    expect(screen.getByRole('button', { name: /Pasted Text · 42 Lines/ })).toBeTruthy();
  });

  it('a paste longer than the stored body still folds (rendered from the whole line)', () => {
    const big = Array.from({ length: 2000 }, (_, i) => `line ${i + 1} of a long build log`).join('\n');
    const body = markPastes(`see ${placeholderFor(1, big)}`, new Map([[1, big]]));
    expect(body.length).toBeGreaterThan(BODY_MAX_CHARS);
    const { container } = render(<MessageRow message={row(wrapped(body))} />);
    expect(screen.getByRole('button', { name: /Pasted Text · 2000 Lines/ })).toBeTruthy();
    expect(container.textContent).not.toMatch(/pasted-text|truncated by Albedo/);
  });

  it('is the row that clears the "Sending" echo, and a prompt row', () => {
    const m = row(wrapped(sent));
    expect(isPromptRow(m)).toBe(true);
    expect(echoLanded({ at: Date.parse(TS) }, [m])).toBe(true);
    expect(echoLanded({ at: Date.parse(TS) + 5_000 }, [m])).toBe(false); // an older row does not
  });

  it('keeps the pasted text in the stored body, so search finds it', () => {
    expect(row(wrapped(sent)).body).toContain('step 17: ok');
  });
});
