/**
 * @vitest-environment jsdom
 *
 * The notice above the message box while Claude Code is taken to be showing
 * Remote Control's menu in the terminal (#343): when it shows, what Show
 * Terminal does, and Dismiss.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../Terminal', () => ({
  submitPty: vi.fn(async () => true),
  startPty: vi.fn(() => false),
  hasLivePty: vi.fn(() => true),
  ptyLiveSince: vi.fn(() => 1),
  canResume: vi.fn(() => false),
  onPtyPresenceChange: () => () => {},
}));
vi.mock('../../capture', () => ({ onCaptureUpdate: () => () => {} }));

const { RemoteMenuNotice, REMOTE_MENU_NOTE, REMOTE_MENU_TEXT } = await import('./RemoteMenuNotice');
const { __resetRemoteWaits, __setRemoteWait, remoteWaitFor } = await import('../remoteWait');

afterEach(() => {
  cleanup();
  __resetRemoteWaits();
});

describe('RemoteMenuNotice', () => {
  it('shows only once the task is taken to be on the menu', () => {
    const { container } = render(<RemoteMenuNotice taskId={1} onShowTerminal={() => {}} />);
    expect(container.innerHTML).toBe('');
    act(() => __setRemoteWait(1, { phase: 'asked' }));
    expect(container.innerHTML).toBe('');
    act(() => __setRemoteWait(1, { phase: 'sent', at: 1_000 }));
    expect(container.innerHTML).toBe('');
    act(() => __setRemoteWait(1, { phase: 'menu', at: 1_000 }));
    const notice = screen.getByRole('status', { name: 'Waiting on You' });
    expect(notice.textContent).toContain(REMOTE_MENU_TEXT);
    expect(notice.textContent).toContain(REMOTE_MENU_NOTE);
    expect(REMOTE_MENU_TEXT + ' ' + REMOTE_MENU_NOTE).toBe(
      'Claude Code is showing Remote Control’s menu in the terminal. Remote Control is probably already on. Answer it there.',
    );
  });

  it('goes as soon as the wait ends', () => {
    const { container } = render(<RemoteMenuNotice taskId={1} onShowTerminal={() => {}} />);
    act(() => __setRemoteWait(1, { phase: 'menu', at: 1_000 }));
    act(() => __setRemoteWait(1, null));
    expect(container.innerHTML).toBe('');
  });

  it("is per task: another task's menu shows nothing here", () => {
    const { container } = render(<RemoteMenuNotice taskId={1} onShowTerminal={() => {}} />);
    act(() => __setRemoteWait(2, { phase: 'menu', at: 1_000 }));
    expect(container.innerHTML).toBe('');
  });

  it('Show Terminal asks for the terminal of this task', () => {
    const show = vi.fn();
    render(<RemoteMenuNotice taskId={7} onShowTerminal={show} />);
    act(() => __setRemoteWait(7, { phase: 'menu', at: 1_000 }));
    fireEvent.click(screen.getByRole('button', { name: 'Show Terminal' }));
    expect(show).toHaveBeenCalledWith(7);
    // It shows the terminal; the notice stays until the session moves on.
    expect(remoteWaitFor(7)?.phase).toBe('menu');
  });

  it('Dismiss ends the wait', () => {
    const { container } = render(<RemoteMenuNotice taskId={1} onShowTerminal={() => {}} />);
    act(() => __setRemoteWait(1, { phase: 'menu', at: 1_000 }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(remoteWaitFor(1)).toBeNull();
    expect(container.innerHTML).toBe('');
  });
});
