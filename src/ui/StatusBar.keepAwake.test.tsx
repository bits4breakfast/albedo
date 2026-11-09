/**
 * @vitest-environment jsdom
 *
 * The status strip's note while Albedo keeps the Mac awake (#283): left of
 * the plan meters, with the count and the tooltip; absent otherwise.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('../capture', () => ({
  onCaptureUpdate: () => () => {},
  windowUsage: async () => null,
}));
vi.mock('../capture/hookEvents', () => ({
  onStatusSnapshot: () => () => {},
  planUsage: () => null,
}));

const { default: StatusBar, KEEP_AWAKE_TITLE } = await import('./StatusBar');

afterEach(cleanup);

describe('StatusBar: keeping the Mac awake', () => {
  it('says so, with the count, before the meters', () => {
    const { container } = render(<StatusBar awake={2} />);
    const note = screen.getByText('Keeping the Mac awake · 2 running');
    expect(note.getAttribute('title')).toBe(KEEP_AWAKE_TITLE);
    expect(KEEP_AWAKE_TITLE).toBe(
      'Albedo keeps the Mac from sleeping while tasks run. Closing the lid still sleeps it. Turn off in ⋯.',
    );
    const strip = container.querySelector('.statusbar')!;
    expect(strip.firstElementChild).toBe(note);
    expect(strip.querySelectorAll('.plan-meter')).toHaveLength(2);
  });

  it('shows nothing when it is not held', () => {
    render(<StatusBar awake={0} />);
    expect(screen.queryByText(/Keeping the Mac awake/)).toBeNull();
    cleanup();
    render(<StatusBar />);
    expect(screen.queryByText(/Keeping the Mac awake/)).toBeNull();
  });
});
