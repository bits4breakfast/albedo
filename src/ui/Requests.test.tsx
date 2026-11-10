/**
 * @vitest-environment jsdom
 *
 * The Requests button and panel (#157), through what a person clicks. A
 * request for a new session is not here (#332): it is a row in the task
 * list's Proposed group (ProposedGroup.test.tsx).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueuedRequest } from './requestQueue';
import type { Project, Task } from '../types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const { default: Requests, kindLabel, panelPosition, requestsLabel } = await import('./Requests');
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
    onDismiss: vi.fn(),
    onOpenTask: vi.fn(),
  };
  render(<Requests {...props} />);
  return props;
}

describe('Requests', () => {
  it('takes no room when nothing waits', () => {
    const { container } = render(
      <Requests items={[]} titleOf={() => null} onDismiss={() => {}} onOpenTask={() => {}} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('takes no room when only requests for a new session wait: those are in the task list', () => {
    const { container } = render(
      <Requests items={[session]} titleOf={() => null} onDismiss={() => {}} onOpenTask={() => {}} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('opens a panel listing each other request with who asked, never a request for a new session', () => {
    setup([session, notice, reminder]);
    // Counts what it lists: the session request is left out.
    expect(screen.queryByRole('dialog')).toBeNull(); // nothing opens on its own
    fireEvent.click(screen.getByRole('button', { name: '2 Requests' }));
    const panel = screen.getByRole('dialog', { name: 'Requests from sessions' });
    expect(panel.textContent).not.toContain('Fix the flaky export test');
    expect(panel.textContent).not.toContain('New session');
    expect(screen.queryByRole('button', { name: 'Approve…' })).toBeNull();
    expect(panel.textContent).toContain('Login rewrite');
    expect(panel.textContent).toContain('Task 4'); // a task without a title is still named
    expect(panel.textContent).toContain('I need the VPN on.');
    expect(panel.textContent).toContain("Albedo couldn't set this reminder");
  });

  it('a reminder that could not be set is dismissed', () => {
    const p = setup([reminder]);
    fireEvent.click(screen.getByRole('button', { name: '1 Request' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(p.onDismiss).toHaveBeenCalledWith('r1');
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
    expect(requestsLabel([notice, reminder])).toBe('2 Requests');
    expect(kindLabel(reminder)).toBe('Reminder');
    expect(kindLabel(notice)).toBe('Needs you');
    expect(panelPosition({ right: 1000, bottom: 40 }, 1200)).toEqual({ left: 600, top: 42 });
    expect(panelPosition({ right: 300, bottom: 40 }, 1200)).toEqual({ left: 8, top: 42 });
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
