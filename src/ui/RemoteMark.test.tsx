/**
 * @vitest-environment jsdom
 *
 * Remote Control's mark and ⋯ item (#114). The rule "a row written at or
 * after this pty was spawned" is the query's (db/remoteControl.test.ts); here
 * is what asks it, when, and what the mark and the item do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { Task } from '../types';

const URL = 'https://claude.ai/code/session_example';

const h = vi.hoisted(() => ({
  liveSince: new Map<number, number>(),
  presence: new Set<(id: number, live: boolean) => void>(),
  captures: new Set<(u: { sessionId: string }) => void>(),
  found: new Map<string, string | null>(),
  holding: false,
}));

vi.mock('./Terminal', async () => {
  const { useEffect, useState } = await import('react');
  return {
    hasLivePty: (id: number) => h.liveSince.has(id),
    ptyLiveSince: (id: number) => h.liveSince.get(id) ?? null,
    usePtyLiveSince: (id: number | null) => {
      const [since, setSince] = useState(id === null ? null : (h.liveSince.get(id) ?? null));
      useEffect(() => {
        const cb = (taskId: number) => {
          if (taskId === id) setSince(h.liveSince.get(taskId) ?? null);
        };
        h.presence.add(cb);
        return () => void h.presence.delete(cb);
      }, [id]);
      return since;
    },
  };
});
const lookups = vi.hoisted(() => [] as [string, number][]);
vi.mock('../db', () => ({
  remoteControlUrlSince: vi.fn(async (sessionId: string, since: number) => {
    lookups.push([sessionId, since]);
    return h.found.get(sessionId) ?? null;
  }),
}));
vi.mock('../capture', () => ({
  onCaptureUpdate: (cb: (u: { sessionId: string }) => void) => {
    h.captures.add(cb);
    return () => void h.captures.delete(cb);
  },
}));
const opened = vi.hoisted(() => [] as string[]);
vi.mock('../lib/openUrl', () => ({ openExternal: vi.fn(async (url: string) => void opened.push(url)) }));
const sent = vi.hoisted(() => [] as [number, string][]);
const composed = vi.hoisted(() => [] as string[]);
vi.mock('./transcript/send', () => ({
  mustHold: () => h.holding,
  sendToSession: vi.fn(async (id: number, text: string) => {
    sent.push([id, text]);
    return h.holding ? 'held' : 'sent';
  }),
}));
vi.mock('./transcript/composerBridge', () => ({
  insertIntoComposer: vi.fn(({ text }: { text: string }) => {
    composed.push(text);
    return true;
  }),
}));

const { default: RemoteMark, REMOTE_CONTROL_COMMAND, REMOTE_CONTROL_KEYS, REMOTE_TITLE, remoteControlItem } = await import(
  './RemoteMark'
);
const { default: RemoteControlDialog, REMOTE_CONFIRM_TITLE } = await import('./RemoteControlDialog');

const task = { id: 1, sessionId: 's1', status: 'idle' } as Task;

function spawn(id: number, at: number) {
  h.liveSince.set(id, at);
  for (const cb of [...h.presence]) cb(id, true);
}
function exit(id: number) {
  h.liveSince.delete(id);
  for (const cb of [...h.presence]) cb(id, false);
}
function capture(sessionId: string) {
  for (const cb of [...h.captures]) cb({ sessionId });
}

beforeEach(() => {
  h.liveSince.clear();
  h.found.clear();
  h.holding = false;
  lookups.length = 0;
  opened.length = 0;
  sent.length = 0;
  composed.length = 0;
});
afterEach(cleanup);

describe('RemoteMark', () => {
  it('shows nothing, and asks nothing, with no live pty', async () => {
    h.found.set('s1', URL);
    const { container } = render(<RemoteMark task={task} variant="row" />);
    await act(async () => {});
    expect(container.innerHTML).toBe('');
    expect(lookups).toEqual([]);
  });

  it('asks for a row since the spawn, and shows the mark when there is one', async () => {
    spawn(1, 5_000);
    h.found.set('s1', URL);
    render(<RemoteMark task={task} variant="row" />);
    const mark = await screen.findByRole('button', { name: REMOTE_TITLE });
    expect(mark.textContent).toBe('Remote');
    expect(mark.getAttribute('title')).toBe('Available through Remote Control. Open on claude.ai');
    expect(lookups).toEqual([['s1', 5_000]]);
  });

  it('opens the session on claude.ai, without selecting the row under it', async () => {
    spawn(1, 5_000);
    h.found.set('s1', URL);
    const onRow = vi.fn();
    render(
      <div onClick={onRow}>
        <RemoteMark task={task} variant="row" />
      </div>,
    );
    fireEvent.click(await screen.findByRole('button', { name: REMOTE_TITLE }));
    expect(opened).toEqual([URL]);
    expect(onRow).not.toHaveBeenCalled();
  });

  it('appears when the row is ingested, on the capture update for its session', async () => {
    vi.useFakeTimers();
    try {
      spawn(1, 5_000);
      render(<RemoteMark task={task} variant="bar" />);
      await act(async () => {});
      expect(screen.queryByRole('button')).toBeNull();

      h.found.set('s1', URL);
      capture('s2'); // another session's burst asks nothing
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(lookups).toHaveLength(1);

      capture('s1');
      capture('s1'); // a burst is one lookup
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(lookups).toHaveLength(2);
      expect(screen.getByRole('button', { name: REMOTE_TITLE }).className).toContain('remote-mark-bar');
    } finally {
      vi.useRealTimers();
    }
  });

  it('goes when the pty exits, and a new pty starts from off', async () => {
    spawn(1, 5_000);
    h.found.set('s1', URL);
    render(<RemoteMark task={task} variant="row" />);
    await screen.findByRole('button', { name: REMOTE_TITLE });

    act(() => exit(1));
    expect(screen.queryByRole('button')).toBeNull();

    h.found.set('s1', null); // the old row is before the new spawn
    act(() => spawn(1, 9_000));
    await act(async () => {});
    expect(lookups.at(-1)).toEqual(['s1', 9_000]);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('refuses a link that is not http(s)', async () => {
    spawn(1, 5_000);
    h.found.set('s1', 'javascript:alert(1)');
    const { container } = render(<RemoteMark task={task} variant="row" />);
    await waitFor(() => expect(lookups).toHaveLength(1));
    await act(async () => {});
    expect(container.innerHTML).toBe('');
  });
});

describe('remoteControlItem', () => {
  it('is offered only on a live session where Remote Control is off', () => {
    expect(remoteControlItem(task, false, null)).toBeNull();
    expect(remoteControlItem(task, true, URL)).toBeNull();
    const item = remoteControlItem(task, true, null);
    expect(item?.label).toBe('Make Available Remotely');
    // The ⋯ menu shows the shortcut that asks for the same thing.
    expect(item?.aside).toBe(REMOTE_CONTROL_KEYS);
    expect(REMOTE_CONTROL_KEYS).toBe('⇧⌘R');
  });

  it('sends /remote-control through the send gateway', async () => {
    expect(REMOTE_CONTROL_COMMAND).toBe('/remote-control');
    h.liveSince.set(1, 5_000);
    remoteControlItem(task, true, null)?.onSelect();
    await waitFor(() => expect(sent).toEqual([[1, '/remote-control']]));
  });

  it('is held, not typed, while a turn runs', async () => {
    h.liveSince.set(1, 5_000);
    h.holding = true;
    remoteControlItem({ ...task, status: 'running' }, true, null)?.onSelect();
    await waitFor(() => expect(sent).toEqual([[1, '/remote-control']]));
    expect(composed).toEqual([]);
  });

  it('is never typed into a waiting prompt: it goes to the message box', async () => {
    h.liveSince.set(1, 5_000);
    remoteControlItem({ ...task, status: 'blocked' }, true, null)?.onSelect();
    await waitFor(() => expect(composed).toEqual(['/remote-control']));
    expect(sent).toEqual([]);
  });
});

describe('RemoteControlDialog (⇧⌘R)', () => {
  const titled = { ...task, title: 'Fix the login page' };

  function open(t: Task = titled, onClose = vi.fn()) {
    const item = remoteControlItem(t, true, null)!;
    render(<RemoteControlDialog task={t} onConfirm={item.onSelect} onClose={onClose} />);
    return onClose;
  }

  it('asks, says what it sends and where it can be continued, on the task named', () => {
    open();
    const dialog = screen.getByRole('dialog', { name: REMOTE_CONFIRM_TITLE });
    expect(dialog.textContent).toContain('/remote-control');
    expect(dialog.textContent).toContain('phone');
    expect(dialog.textContent).toContain('claude.ai');
    expect(dialog.textContent).toContain('Fix the login page');
    // Return confirms: the keyboard starts on the confirm button.
    expect(document.activeElement?.textContent).toBe('Make Available Remotely');
  });

  it('confirming sends /remote-control as the ⋯ item does, then closes', async () => {
    h.liveSince.set(1, 5_000);
    const onClose = open();
    fireEvent.click(screen.getByRole('button', { name: 'Make Available Remotely' }));
    await waitFor(() => expect(sent).toEqual([[1, '/remote-control']]));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('confirming during a running turn holds it, and says so', async () => {
    h.liveSince.set(1, 5_000);
    h.holding = true;
    open({ ...titled, status: 'running' });
    expect(screen.getByRole('dialog').textContent).toContain('sent when it ends');
    fireEvent.click(screen.getByRole('button', { name: 'Make Available Remotely' }));
    await waitFor(() => expect(sent).toEqual([[1, '/remote-control']]));
    expect(composed).toEqual([]);
  });

  it('on a waiting prompt it goes to the message box, and says so', async () => {
    h.liveSince.set(1, 5_000);
    open({ ...titled, status: 'blocked' });
    expect(screen.getByRole('dialog').textContent).toContain('message box');
    fireEvent.click(screen.getByRole('button', { name: 'Make Available Remotely' }));
    await waitFor(() => expect(composed).toEqual(['/remote-control']));
    expect(sent).toEqual([]);
  });

  it('Cancel, Escape and a click outside send nothing', async () => {
    h.liveSince.set(1, 5_000);
    const onClose = open();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.mouseDown(screen.getByRole('presentation'));
    expect(onClose).toHaveBeenCalledTimes(3);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual([]);
    expect(composed).toEqual([]);
  });

  it('Escape is its own: a window listener behind it does not also hear it', () => {
    const behind = vi.fn();
    window.addEventListener('keydown', behind);
    try {
      open();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(behind).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', behind);
    }
  });

  it('gives the keyboard back to where ⇧⌘R was pressed when it goes', () => {
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    try {
      field.focus();
      const item = remoteControlItem(titled, true, null)!;
      const { unmount } = render(<RemoteControlDialog task={titled} onConfirm={item.onSelect} onClose={() => {}} />);
      expect(document.activeElement).not.toBe(field);
      unmount();
      expect(document.activeElement).toBe(field);
    } finally {
      field.remove();
    }
  });
});
