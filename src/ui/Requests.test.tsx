/**
 * @vitest-environment jsdom
 *
 * The Requests button and panel (#157), through what a person clicks.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueuedRequest } from './requestQueue';
import type { Project, Task } from '../types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const { default: Requests, kindLabel, panelPosition, promptPreview, requestsLabel } = await import('./Requests');
const { prefillFor } = await import('./app/useSessionRequests');

afterEach(cleanup);

const NOW = 1_793_692_800_000;
const session: QueuedRequest = {
  id: 's1',
  taskId: 3,
  at: NOW,
  tool: 'request_session',
  title: 'Fix the flaky export test',
  prompt: 'ExportTest fails one run in five.\nFind out why.',
  reason: 'Unrelated to this task.',
  project: 'acme-store',
  branch: 'fix/flaky-export',
};
const notice: QueuedRequest = { id: 'n1', taskId: 4, at: NOW, tool: 'notify_blocked', message: 'I need the VPN on.' };
const reminder: QueuedRequest = {
  id: 'r1',
  taskId: 3,
  at: NOW,
  tool: 'create_reminder',
  text: 'Check the deploy',
  due: '2026-11-03T10:00:00+01:00',
  dueMs: NOW + 3_600_000,
  summary: 's',
};

function setup(items: QueuedRequest[]) {
  const props = {
    items,
    titleOf: (id: number) => (id === 3 ? 'Login rewrite' : null),
    onApprove: vi.fn(),
    onDismiss: vi.fn(),
    onOpenTask: vi.fn(),
  };
  render(<Requests {...props} />);
  return props;
}

describe('Requests', () => {
  it('takes no room when nothing waits', () => {
    const { container } = render(
      <Requests items={[]} titleOf={() => null} onApprove={() => {}} onDismiss={() => {}} onOpenTask={() => {}} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('opens a panel listing each request with who asked and why', () => {
    setup([session, notice, reminder]);
    fireEvent.click(screen.getByRole('button', { name: '3 Requests' }));
    const panel = screen.getByRole('dialog', { name: 'Requests from sessions' });
    expect(panel.textContent).toContain('Fix the flaky export test');
    expect(panel.textContent).toContain('Unrelated to this task.');
    expect(panel.textContent).toContain('ExportTest fails one run in five.');
    expect(panel.textContent).toContain('Project: acme-store');
    expect(panel.textContent).toContain('Branch: fix/flaky-export');
    expect(panel.textContent).toContain('Login rewrite');
    expect(panel.textContent).toContain('Task 4'); // a task without a title is still named
    expect(panel.textContent).toContain('I need the VPN on.');
    expect(panel.textContent).toContain("Albedo couldn't set this reminder");
  });

  it('Approve hands the request on and closes; Deny dismisses it', () => {
    const p = setup([session]);
    fireEvent.click(screen.getByRole('button', { name: '1 Request' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(p.onDismiss).toHaveBeenCalledWith('s1');
    fireEvent.click(screen.getByRole('button', { name: 'Approve…' }));
    expect(p.onApprove).toHaveBeenCalledWith(session);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a notice opens its task, or is dismissed', () => {
    const p = setup([notice]);
    fireEvent.click(screen.getByRole('button', { name: '1 Request' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(p.onDismiss).toHaveBeenCalledWith('n1');
    fireEvent.click(screen.getByRole('button', { name: 'Open Task' }));
    expect(p.onOpenTask).toHaveBeenCalledWith(4);
  });

  it('Escape closes the panel and gives focus back to the button', () => {
    setup([notice]);
    const button = screen.getByRole('button', { name: '1 Request' });
    fireEvent.click(button);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});

describe('Requests (pure)', () => {
  it('labels, positions and previews', () => {
    expect(requestsLabel([notice])).toBe('1 Request');
    expect(requestsLabel([notice, session])).toBe('2 Requests');
    expect(kindLabel(session)).toBe('New session');
    expect(kindLabel(reminder)).toBe('Reminder');
    expect(kindLabel(notice)).toBe('Needs you');
    expect(panelPosition({ right: 1000, bottom: 40 }, 1200)).toEqual({ left: 600, top: 42 });
    expect(panelPosition({ right: 300, bottom: 40 }, 1200)).toEqual({ left: 8, top: 42 });
    expect(promptPreview('a\nb\nc\nd\ne')).toBe('a\nb\nc\nd\n…');
    expect(promptPreview('short')).toBe('short');
    expect(promptPreview('x'.repeat(400)).endsWith('…')).toBe(true);
  });
});

describe('prefillFor', () => {
  const projects = [
    { id: 1, name: 'albedo' },
    { id: 2, name: 'Acme-Store' },
  ] as Project[];
  const tasks = [{ id: 3, projectId: 1 }] as Task[];

  it('uses the project the request names, ignoring case, else the requesting task\'s', () => {
    expect(prefillFor(session as never, tasks, projects)).toEqual({
      projectId: 2,
      title: 'Fix the flaky export test',
      prompt: 'ExportTest fails one run in five.\nFind out why.',
      request: { id: 's1' },
    });
    expect(prefillFor({ ...session, project: 'nope' } as never, tasks, projects).projectId).toBe(1);
    expect(prefillFor({ ...session, project: null, taskId: 99 } as never, tasks, projects).projectId).toBeNull();
  });
});
