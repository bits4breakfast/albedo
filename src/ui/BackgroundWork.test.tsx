/**
 * @vitest-environment jsdom
 *
 * What asks for background work, when, and what the row's mark says (#122).
 * The fold's rules are capture/background.test.ts's; the query's are
 * db/background.test.ts's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

import type { Message, Task } from '../types';
import { parseLine } from '../capture/adapter';
import { asyncAgent, backgroundShell, noticeUserLine, notification, wakeup } from '../capture/backgroundFixtures';

const h = vi.hoisted(() => ({
  liveSince: new Map<number, number>(),
  presence: new Set<(id: number) => void>(),
  captures: new Set<(u: { sessionId: string }) => void>(),
  lines: new Map<string, Record<string, unknown>[]>(),
}));

vi.mock('./Terminal', async () => {
  const { useEffect, useState } = await import('react');
  return {
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
  backgroundRowsSince: vi.fn(async (sessionId: string, since: number): Promise<Message[]> => {
    lookups.push([sessionId, since]);
    let id = 0;
    return (h.lines.get(sessionId) ?? []).flatMap((line, i) =>
      parseLine(JSON.stringify(line), i).map((m) => ({ ...m, id: ++id, taskId: 1, agentId: null })),
    );
  }),
}));
vi.mock('../capture', async () => ({
  ...(await import('../capture/background')),
  onCaptureUpdate: (cb: (u: { sessionId: string }) => void) => {
    h.captures.add(cb);
    return () => void h.captures.delete(cb);
  },
}));

const { BackgroundMark, backgroundShown, backgroundSummary, useBackgroundWork } = await import('./BackgroundWork');

const task = { id: 1, sessionId: 's1' } as Task;
let SPAWNED = 0;

function spawn(id: number, at: number) {
  h.liveSince.set(id, at);
  for (const cb of [...h.presence]) cb(id);
}
function capture(sessionId: string) {
  for (const cb of [...h.captures]) cb({ sessionId });
}

beforeEach(() => {
  SPAWNED = Date.now() - 60_000;
  h.liveSince.clear();
  h.lines.clear();
  lookups.length = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('BackgroundMark', () => {
  it('shows nothing, and asks nothing, with no live pty', async () => {
    h.lines.set('s1', backgroundShell('t1', 'b1', SPAWNED + 1_000));
    const { container } = render(<BackgroundMark task={task} />);
    await act(async () => {});
    expect(container.innerHTML).toBe('');
    expect(lookups).toEqual([]);
  });

  it('counts what runs since the spawn, leaving agents to the Agents strip', async () => {
    spawn(1, SPAWNED);
    h.lines.set('s1', [...backgroundShell('t1', 'b1', SPAWNED + 1_000), ...asyncAgent('g1', 'a1', SPAWNED + 2_000)]);
    render(<BackgroundMark task={task} />);
    const mark = await screen.findByText('1 in background');
    expect(mark.getAttribute('title')).toBe('Running in the background:\nShell: Poll CI until green');
    expect(lookups).toEqual([['s1', SPAWNED]]);
  });

  it("looks again on its session's capture burst, once per burst, and goes when the work ends", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    spawn(1, SPAWNED);
    h.lines.set('s1', backgroundShell('t1', 'b1', SPAWNED + 1_000));
    render(<BackgroundMark task={task} />);
    await screen.findByText('1 in background');

    h.lines.set('s1', [
      ...backgroundShell('t1', 'b1', SPAWNED + 1_000),
      noticeUserLine(notification({ taskIds: ['b1'], toolUseId: 't1', status: 'completed' }), SPAWNED + 2_000),
    ]);
    capture('s2'); // another session's burst asks nothing
    capture('s1');
    capture('s1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(lookups).toHaveLength(2);
    expect(screen.queryByText(/in background/)).toBeNull();
  });

  it('drops a wake-up when it falls due, without asking again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    spawn(1, SPAWNED);
    // Due 2 minutes after the spawn, 1 minute from now.
    h.lines.set('s1', wakeup('w1', SPAWNED, 120));
    render(<BackgroundMark task={task} />);
    await screen.findByText('1 in background');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(screen.queryByText(/in background/)).toBeNull();
    expect(lookups).toHaveLength(1);
  });
});

describe('useBackgroundWork', () => {
  it('starts over from nothing for a new pty', async () => {
    spawn(1, SPAWNED);
    h.lines.set('s1', backgroundShell('t1', 'b1', SPAWNED + 1_000));
    let seen: readonly unknown[] = [];
    function Probe() {
      seen = useBackgroundWork(task);
      return null;
    }
    render(<Probe />);
    await act(async () => {});
    expect(seen).toHaveLength(1);
    // The claude process was replaced: its shell went with it.
    act(() => spawn(1, SPAWNED + 30_000));
    expect(seen).toEqual([]);
    await act(async () => {});
    expect(lookups.at(-1)).toEqual(['s1', SPAWNED + 30_000]);
    expect(seen).toEqual([]);
  });
});

describe('backgroundShown and backgroundSummary', () => {
  it('leaves agents out and names each kind', () => {
    const items = [
      { key: 'a', kind: 'agent', description: 'Review', startedAt: 0, until: null, rowId: 1 },
      { key: 'b', kind: 'wakeup', description: '', startedAt: 0, until: 5, rowId: 2 },
      { key: 'c', kind: 'monitor', description: 'Watch the build log', startedAt: 0, until: 5, rowId: 3 },
    ] as const;
    const shown = backgroundShown(items);
    expect(shown.map((i) => i.key)).toEqual(['b', 'c']);
    expect(backgroundSummary(shown)).toBe('Wake-up\nMonitor: Watch the build log');
  });
});
