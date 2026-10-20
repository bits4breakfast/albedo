import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ContextUsage } from '../capture';
import type { Task } from '../types';

vi.mock('./Terminal', () => ({
  hasLivePty: () => true,
  onPtyPresenceChange: () => () => {},
  submitPty: async () => true,
}));

import { CLEAR_OFFER_AT, ContextClear } from './ClearContextButton';

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

  it('offers Clear beside the message once the window is nearly full', () => {
    const html = renderToStaticMarkup(<ContextClear task={task} usage={usage(CLEAR_OFFER_AT + 0.02)} />);
    expect(html).toContain('Context 87%');
    expect(html).toContain('>Clear<');
  });

  it('marks an inferred reading as a token count, not a percentage', () => {
    const html = renderToStaticMarkup(
      <ContextClear task={task} usage={usage(0.9, { limitBasis: 'inferred', used: 900_000 })} />,
    );
    expect(html).toContain('Context ~900k');
  });
});
