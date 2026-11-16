/**
 * @vitest-environment jsdom
 *
 * A waiting comment on removed lines (#402), above the message box: named
 * as removed lines of the base, beside one on the file as it is now, which
 * reads as before.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WaitingComments } from './WaitingComments';
import { __resetQueuedCi } from './ciFailure';
import type { ReviewComment } from '../../db/comments';

beforeEach(() => {
  const data = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
  __resetQueuedCi();
});
afterEach(cleanup);

const base: ReviewComment = {
  id: 1, taskId: 7, path: 'src/lib/queue.ts', lineStart: 12, lineEnd: 13, anchorText: 'if (full) {\n  return;', body: 'Why drop it?',
  createdAt: 0, updatedAt: 0, sentAt: null, resolvedAt: null, github: null, replyTo: null,
};

it('names removed lines as removed, and a comment on the file now as before', () => {
  render(<WaitingComments taskId={7} frozen={false} code={[{ ...base, side: 'old' }, { ...base, id: 2, body: 'And here?' }]} />);
  fireEvent.click(screen.getByRole('button', { name: /2 Comments/ }));
  const places = [...document.querySelectorAll('.tx-waiting-where')];
  expect(places.map((p) => p.textContent)).toEqual(['queue.ts removed 12–13', 'queue.ts:12–13']);
  expect(places[0]!.getAttribute('title')).toBe('src/lib/queue.ts: removed 12–13 (in the base)\n\nif (full) {\n  return;');
  expect(places[1]!.getAttribute('title')).toBe('src/lib/queue.ts:12–13\n\nif (full) {\n  return;');
});
