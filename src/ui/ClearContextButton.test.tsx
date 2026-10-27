import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ContextUsage } from '../capture';
import type { Task } from '../types';

vi.mock('./Terminal', () => ({
  hasLivePty: () => true,
  ptyLiveSince: () => null,
  onPtyPresenceChange: () => () => {},
  submitPty: async () => true,
}));

import { CLEAR_OFFER_AT, commandBlocker, ContextClear, contextWarning } from './ClearContextButton';
import { CONTEXT_HIGH, CONTEXT_WARN } from './StatusDot';

const task = { id: 1, status: 'idle', sessionId: 's' } as Task;
const usage = (fraction: number, over: Partial<ContextUsage> = {}): ContextUsage => ({
  used: Math.round(fraction * 1_000_000),
  limit: 1_000_000,
  fraction,
  limitBasis: 'known',
  model: 'claude-opus-5-5',
  at: 1_700_000_000_000,
  ...over,
});

describe('ContextClear', () => {
  it('stays out of the way while the session has room', () => {
    expect(renderToStaticMarkup(<ContextClear task={task} usage={usage(0.6)} />)).toBe('');
    expect(renderToStaticMarkup(<ContextClear task={task} usage={null} />)).toBe('');
  });

  it('offers Compact Now and Clear beside the message once the window is filling up', () => {
    const html = renderToStaticMarkup(<ContextClear task={task} usage={usage(CLEAR_OFFER_AT + 0.02)} />);
    expect(html).toContain('Context 72%');
    expect(html).toContain('>Compact Now<');
    expect(html).toContain('>Clear<');
  });

  it('marks an inferred reading as a token count, not a percentage', () => {
    const html = renderToStaticMarkup(
      <ContextClear task={task} usage={usage(0.9, { limitBasis: 'inferred', used: 900_000 })} />,
    );
    expect(html).toContain('Context ~900k');
  });

  it('is not offered while messages are waiting to send: a command would be held', async () => {
    const { holdMessage, __resetOutbox } = await import('./transcript/outbox');
    holdMessage(1, 'waiting for the connection');
    const html = renderToStaticMarkup(<ContextClear task={task} usage={usage(CLEAR_OFFER_AT + 0.02)} />);
    expect(html).toContain('Not available while messages are waiting to send');
    expect(html).toMatch(/<button[^>]*disabled=""/);
    __resetOutbox();
  });
});

describe('the warning before an automatic compaction', () => {
  it('starts at the meter\'s warn level and grows stronger at its high level', () => {
    expect(CLEAR_OFFER_AT).toBe(CONTEXT_WARN);
    expect(contextWarning(usage(CONTEXT_WARN - 0.01))).toBeNull();
    expect(contextWarning(usage(CONTEXT_WARN))).toEqual({ level: 'warn', text: 'Context 70%' });
    expect(contextWarning(usage(CONTEXT_HIGH + 0.03))).toEqual({ level: 'high', text: 'Context 93% · compacts soon' });
    expect(contextWarning(null)).toBeNull();
  });

  it('draws the high level as such, and says Claude Code compacts on its own', () => {
    const html = renderToStaticMarkup(<ContextClear task={task} usage={usage(0.93)} />);
    expect(html).toContain('data-level="high"');
    expect(html).toContain('Context 93% · compacts soon');
    expect(html).toContain('compacts the session on its own');
  });
});

describe('commandBlocker', () => {
  it('lets a command go only to a live, idle session with nothing waiting', () => {
    expect(commandBlocker(true, 'idle', false)).toBeNull();
    expect(commandBlocker(true, 'done', false)).toBeNull();
    expect(commandBlocker(false, 'idle', false)).toBe('No session is running for this task.');
    expect(commandBlocker(true, 'running', false)).toBe('Available once the session is idle.');
    expect(commandBlocker(true, 'blocked', false)).toBe('Available once the session is idle.');
    expect(commandBlocker(true, 'idle', true)).toBe('Not available while messages are waiting to send');
  });
});
