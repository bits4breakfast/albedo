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
import type { BackgroundItem } from '../capture/background';
import { asyncAgent, backgroundShell, cronTimer, noticeUserLine, notification, wakeup } from '../capture/backgroundFixtures';
import { clockText } from '../reminders/when';

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

const { BackgroundMark, backgroundShown, backgroundSummary, runTimeText, scheduleText, soonestWake, useBackgroundWork, wakeText } = await import(
  './BackgroundWork'
);

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
    await screen.findByText(`wakes ${runTimeText(SPAWNED + 120_000, Date.now())}`);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(screen.queryByText(/wakes|in background/)).toBeNull();
    expect(lookups).toHaveLength(1);
  });

  it('says when a timer next checks, with a clock, and moves on when it has run, without asking again (#443)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    spawn(1, SPAWNED);
    // Every minute; first run 2 minutes from now, then each minute after.
    const first = Math.floor(Date.now() / 60_000) * 60_000 + 2 * 60_000;
    h.lines.set('s1', [
      ...cronTimer('c1', 'job1', SPAWNED + 1_000, { cron: '* * * * *', nextFireAt: first }),
      ...backgroundShell('t1', 'b1', SPAWNED + 2_000),
    ]);
    render(<BackgroundMark task={task} />);
    const mark = await screen.findByText(`next check ${runTimeText(first, Date.now())}`);
    expect(mark.getAttribute('data-wake')).toBe('true');
    expect(mark.querySelector('svg')).not.toBeNull();
    expect(mark.getAttribute('title')).toBe(
      `Running in the background:\nTimer (every minute · next ${runTimeText(first, Date.now())}): Check the error rate since the deploy\nShell: Poll CI until green`,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(first - Date.now() + 1_000);
    });
    expect(screen.getByText(`next check ${runTimeText(first + 60_000, Date.now())}`)).toBeTruthy();
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

/** Local noon: the times below fall on the same local day, in any zone. */
const NOON = new Date(2026, 10, 18, 12, 0).getTime();
const MIN = 60_000;
const item = (o: Partial<BackgroundItem> & Pick<BackgroundItem, 'key' | 'kind'>): BackgroundItem => ({
  description: '',
  startedAt: 0,
  until: null,
  rowId: 1,
  schedule: null,
  nextRunAt: null,
  ...o,
});
const recurring = (cron: string, nextRunAt: number) => item({ key: 'c', kind: 'timer', schedule: { cron, once: false, firstRunAt: null }, nextRunAt });

describe('backgroundShown and backgroundSummary', () => {
  it('leaves agents out and names each kind, with when it wakes the task', () => {
    const items = [
      item({ key: 'a', kind: 'agent', description: 'Review' }),
      item({ key: 'b', kind: 'wakeup', until: NOON + 6 * MIN, nextRunAt: NOON + 6 * MIN }),
      item({ key: 'c', kind: 'monitor', description: 'Watch the build log', until: 5 }),
      { ...recurring('13,43 * * * *', NOON + 21 * MIN), key: 'd', description: 'Check the error rate' },
    ];
    const shown = backgroundShown(items);
    expect(shown.map((i) => i.key)).toEqual(['b', 'c', 'd']);
    expect(backgroundSummary(shown, NOON)).toBe(
      `Wake-up (${clockText(NOON + 6 * MIN)})\nMonitor: Watch the build log\nTimer (every 30 min · next ${clockText(NOON + 21 * MIN)}): Check the error rate`,
    );
  });
});

describe('what the row and band say about when the task wakes (#443)', () => {
  it('runTimeText: the time today, the weekday within the week, the date past it', () => {
    expect(runTimeText(new Date(2026, 10, 18, 14, 13).getTime(), NOON)).toBe('14:13');
    // Wed 18 Nov 2026 -> Mon 23 Nov.
    expect(runTimeText(new Date(2026, 10, 23, 9, 0).getTime(), NOON)).toBe('Mon 09:00');
    expect(runTimeText(new Date(2026, 10, 19, 0, 5).getTime(), NOON)).toBe('Thu 00:05');
    expect(runTimeText(new Date(2026, 11, 1, 9, 0).getTime(), NOON)).toBe('Dec 1 09:00');
    expect(runTimeText(new Date(2027, 9, 28, 14, 30).getTime(), NOON)).toBe('Oct 28 2027 14:30');
  });

  it('wakeText: next check, check at, wakes -- and nothing for other work', () => {
    const at = new Date(2026, 10, 18, 14, 13).getTime();
    expect(wakeText(recurring('13,43 * * * *', at), NOON)).toBe('next check 14:13');
    expect(wakeText(item({ key: 'o', kind: 'timer', schedule: { cron: null, once: true, firstRunAt: at }, nextRunAt: at }), NOON)).toBe('check at 14:13');
    expect(wakeText(item({ key: 'w', kind: 'wakeup', nextRunAt: at }), NOON)).toBe('wakes 14:13');
    expect(wakeText(recurring('0 9 * * 1-5', new Date(2026, 10, 23, 9, 0).getTime()), NOON)).toBe('next check Mon 09:00');
    expect(wakeText(item({ key: 's', kind: 'shell' }), NOON)).toBeNull();
    expect(wakeText(item({ key: 't', kind: 'timer', schedule: { cron: 'x', once: false, firstRunAt: null } }), NOON)).toBeNull();
  });

  it('scheduleText: every N when even, the next time alone when not, once, a wake-up\'s time', () => {
    const at = new Date(2026, 10, 18, 14, 13).getTime();
    expect(scheduleText(recurring('13,43 * * * *', at), NOON)).toBe('every 30 min · next 14:13');
    expect(scheduleText(recurring('*/15 * * * *', at), NOON)).toBe('every 15 min · next 14:13');
    expect(scheduleText(recurring('0 */2 * * *', at), NOON)).toBe('every 2 h · next 14:13');
    expect(scheduleText(recurring('0 9,13,17 * * 1-5', at), NOON)).toBe('next 14:13');
    expect(scheduleText(recurring('not a cron', at), NOON)).toBe('next 14:13');
    expect(scheduleText(recurring('0 9 * * 1-5', new Date(2026, 10, 23, 9, 0).getTime()), NOON)).toBe('next Mon 09:00');
    expect(scheduleText(item({ key: 'o', kind: 'timer', schedule: { cron: '0 15 * * *', once: true, firstRunAt: at }, nextRunAt: at }), NOON)).toBe(
      'once · 14:13',
    );
    expect(scheduleText(item({ key: 'w', kind: 'wakeup', nextRunAt: at }), NOON)).toBe('14:13');
    expect(scheduleText(item({ key: 'm', kind: 'monitor', until: at }), NOON)).toBeNull();
  });

  it('soonestWake: the soonest timer or wake-up wins; shells and monitors never do', () => {
    const later = recurring('13,43 * * * *', NOON + 21 * MIN);
    const sooner = item({ key: 'w', kind: 'wakeup', nextRunAt: NOON + 6 * MIN });
    expect(soonestWake([later, sooner, item({ key: 's', kind: 'shell' })])).toBe(sooner);
    expect(soonestWake([item({ key: 's', kind: 'shell' }), item({ key: 'm', kind: 'monitor', until: NOON + MIN })])).toBeNull();
  });
});
