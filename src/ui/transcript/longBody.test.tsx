/**
 * @vitest-environment jsdom
 *
 * A row longer than the stored body keeps (BODY_MAX_CHARS) renders from its
 * whole text (#126): a long subagent report lost its closing tag to the cut
 * and printed as raw tags under "You".
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import type { Message } from '../../types';
import { BODY_MAX_CHARS, fullBodyOf, parseLine } from '../../capture/adapter';
import { MessageRow } from './MessageRow';

afterEach(cleanup);

/** What ingest stores for one line: the body cut, the line whole. */
function stored(line: object): Message {
  const [row] = parseLine(JSON.stringify(line), 3);
  if (!row) throw new Error('no row');
  return { ...row, id: 1, taskId: 1 };
}

const long = (n: number) => Array.from({ length: n }, (_, i) => `  - finding ${i}: the retry helper keeps its backoff`).join('\n');

const handBack = (report: string) =>
  'Another Claude session sent a message:\n<agent-message from="a1">\n' +
  `[Subagent hand-back] The text below is the final report. The report follows:\n${report}\n</agent-message>\n\n` +
  'That "other Claude session" is an agent working inside this same session.';

const peer = (inner: string) =>
  'Another Claude session sent a message:\n' +
  `<cross-session-message from="uds:/tmp/x.sock" from-name="Fix login" from-mode="prompting">\n${inner}\n</cross-session-message>\n\n` +
  'This came from another Claude session.';

const userLine = (content: string) => ({ type: 'user', isMeta: true, timestamp: '2026-10-29T12:00:00Z', message: { role: 'user', content } });

describe('fullBodyOf', () => {
  it('returns a stored body that was not cut as it is', () => {
    const m = stored(userLine('short'));
    expect(fullBodyOf(m)).toBe('short');
    expect(fullBodyOf({ ...m, body: null })).toBeNull();
  });

  it('reads a cut body whole from the line', () => {
    const text = handBack(long(800));
    expect(text.length).toBeGreaterThan(BODY_MAX_CHARS);
    const m = stored(userLine(text));
    expect(m.body).not.toContain('</agent-message>');
    expect(fullBodyOf(m)).toBe(text);
  });

  it('finds the right block of a line with several', () => {
    const text = 'x'.repeat(BODY_MAX_CHARS + 10);
    const rows = parseLine(
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'first' }, { type: 'text', text }] } }),
      7,
    );
    const cut = rows.find((r) => r.body?.startsWith('xxx'));
    expect(cut && fullBodyOf(cut)).toBe(text);
  });
});

describe('a row longer than the stored body', () => {
  it("keeps a long subagent hand-back out of the row, as a short one is", () => {
    const { container } = render(<MessageRow message={stored(userLine(handBack(long(800))))} />);
    expect(container.textContent).not.toContain('agent-message');
    expect(container.querySelector('.tx-row-user')).toBeNull();
  });

  it("reads a long message from another session under the sender's name", () => {
    const { container } = render(<MessageRow message={stored(userLine(peer(long(800))))} />);
    expect(container.querySelector('.tx-peer-head')?.textContent).toBe('From Fix login');
    expect(container.textContent).not.toContain('cross-session-message');
    expect(container.textContent).toContain('finding 799');
    expect(container.textContent).not.toContain('truncated by Albedo');
  });

  it('shows a long reply whole, without the storage marker', () => {
    const text = long(800);
    const m = stored({ type: 'assistant', timestamp: '2026-10-29T12:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text }] } });
    const { container } = render(<MessageRow message={m} />);
    expect(container.textContent).toContain('finding 799');
    expect(container.textContent).not.toContain('truncated by Albedo');
  });
});
