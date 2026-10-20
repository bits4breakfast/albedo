/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

vi.mock('../../capture', () => ({}));

const { WorkingLine } = await import('./TranscriptPane');

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('WorkingLine', () => {
  it('says Sending, then Working, and counts from the latest activity', () => {
    vi.useFakeTimers();
    const t0 = new Date('2026-10-20T12:00:00Z').getTime();
    vi.setSystemTime(t0);
    const { rerender } = render(<WorkingLine since={t0} sending />);
    expect(screen.getByRole('status').textContent).toBe('Sending · 0s');
    rerender(<WorkingLine since={t0} sending={false} />);
    act(() => {
      vi.advanceTimersByTime(75_000);
    });
    expect(screen.getByRole('status').textContent).toBe('Working · 1m 15s');
  });
});
