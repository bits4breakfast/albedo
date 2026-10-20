import { describe, expect, it } from 'vitest';
import type { Task } from '../types';
import { busyCounts, quitMessage } from './quitGuard';

const t = (status: Task['status']) => ({ status }) as Task;

describe('busyCounts', () => {
  it('counts running and waiting tasks; idle and done are safe to quit', () => {
    expect(busyCounts([t('running'), t('blocked'), t('idle'), t('done'), t('running')])).toEqual({
      running: 2,
      waiting: 1,
    });
  });
});

describe('quitMessage', () => {
  it('names what is busy', () => {
    expect(quitMessage({ running: 1, waiting: 0 })).toMatch(/^1 task is still running\. Quitting/);
    expect(quitMessage({ running: 2, waiting: 1 })).toMatch(/^2 tasks are still running and 1 is waiting on you\./);
    expect(quitMessage({ running: 0, waiting: 3 })).toMatch(/^3 tasks are waiting on you\./);
  });
});
