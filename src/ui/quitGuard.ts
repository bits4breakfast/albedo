/**
 * Ask before quitting while tasks are busy.
 *
 * Quitting kills every task's `claude` process. An idle one resumes on the
 * next launch with nothing lost; one mid-turn, or waiting on a permission
 * prompt, is interrupted. So Rust (src-tauri/src/lib.rs) is told how many are
 * busy, and while that is non-zero, Quit (⌘Q) and the window's close button
 * come here instead of exiting.
 */

import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ask } from '@tauri-apps/plugin-dialog';
import type { Task } from '../types';

export interface BusyCounts {
  running: number;
  waiting: number;
}

export function busyCounts(tasks: readonly Task[]): BusyCounts {
  let running = 0;
  let waiting = 0;
  for (const t of tasks) {
    if (t.status === 'running') running += 1;
    else if (t.status === 'blocked') waiting += 1;
  }
  return { running, waiting };
}

/** The dialog's text for what is busy. */
export function quitMessage({ running, waiting }: BusyCounts): string {
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} ${running === 1 ? 'task is' : 'tasks are'} still running`);
  if (waiting > 0) {
    // "2 tasks are running and 1 is waiting", but "1 task is waiting" alone.
    const noun = running > 0 ? '' : waiting === 1 ? ' task' : ' tasks';
    parts.push(`${waiting}${noun} ${waiting === 1 ? 'is' : 'are'} waiting on you`);
  }
  const what = parts.join(' and ');
  return (
    `${what.charAt(0).toUpperCase()}${what.slice(1)}. ` +
    'Quitting stops their Claude Code sessions mid-turn. Each one resumes when you reopen Albedo, ' +
    'but the work in progress is interrupted.'
  );
}

export function useQuitGuard(tasks: readonly Task[]): void {
  const counts = busyCounts(tasks);
  const busy = counts.running + counts.waiting;
  const countsRef = useRef(counts);
  countsRef.current = counts;

  // Rust decides whether to ask from this number, so it is kept current.
  useEffect(() => {
    void invoke('set_busy_tasks', { count: busy }).catch(() => {
      /* outside Tauri (tests, the browser preview): nothing to guard */
    });
  }, [busy]);

  useEffect(() => {
    let off: (() => void) | null = null;
    let gone = false;
    let asking = false;
    void listen('albedo://quit-requested', async () => {
      if (asking) return; // ⌘Q pressed twice: one dialog
      asking = true;
      try {
        const quit = await ask(quitMessage(countsRef.current), {
          title: 'Quit Albedo?',
          kind: 'warning',
          okLabel: 'Quit',
          cancelLabel: 'Cancel',
        });
        if (quit) await invoke('quit_app');
      } catch (err) {
        console.warn('[quit] could not ask; staying open', err);
      } finally {
        asking = false;
      }
    })
      .then((un) => {
        if (gone) un();
        else off = un;
      })
      .catch((err) => console.warn('[quit] confirmation unavailable', err));
    return () => {
      gone = true;
      off?.();
    };
  }, []);
}
