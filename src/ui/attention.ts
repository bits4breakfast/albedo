/**
 * "This task needs you."
 *
 * With several sessions running in parallel the cockpit's core question is
 * which one is waiting on you -- and the answer is worth nothing if you are
 * looking at another window when it arrives. This module is the single place
 * that knows how to ask for a person's attention, in the two situations that
 * differ more than they look:
 *
 *   - **Albedo is not focused.** Bounce the dock icon. macOS stops the bounce
 *     itself once the app is activated, so there is nothing to clean up.
 *   - **Albedo is focused.** The dock bounce is a no-op by design -- macOS
 *     drops `requestUserAttention` for the active app -- so the cue has to be
 *     inside the window. The task's row is marked, and pulses.
 *
 * The mark is set in BOTH cases, not just the focused one. The bounce says
 * "something happened"; only the mark says *which task*, and it has to survive
 * until you come back and look.
 *
 * ## Status comes from the transcript, as always
 *
 * Nothing here observes the pty. The trigger is a derived status transition
 * (`src/capture/status.ts`), which is the same source the task list already
 * trusts. A bounce is a side effect of that transition, never of terminal
 * output -- so this adds no new knowledge of what Claude Code prints.
 */

import { getCurrentWindow, UserAttentionType } from '@tauri-apps/api/window';
import type { TaskStatus } from '../types';

/**
 * Why a task is asking for attention. The two are not equally urgent, and the
 * OS has a separate signal for each.
 */
export type AttentionKind =
  /** Waiting on a permission prompt. It will sit there until you answer. */
  | 'blocked'
  /** The turn ended. Nothing is stuck; you just have a result to read. */
  | 'finished';

/** Task ids currently asking for attention, newest-set last. */
const marked = new Map<number, AttentionKind>();
const listeners = new Set<(marks: ReadonlyMap<number, AttentionKind>) => void>();

/**
 * Whether the window has focus.
 *
 * Optimistic until `watchFocus` reports otherwise: assuming focused means the
 * first transition after launch prefers the in-window cue, which is wrong only
 * if the user launched Albedo and immediately switched away -- and is silent,
 * rather than bouncing at someone who is already looking at the window.
 */
let focused = true;

/** Test seam: `requestUserAttention` needs a real Tauri window. */
let requestOsAttention: (critical: boolean) => void = (critical) => {
  void getCurrentWindow()
    .requestUserAttention(critical ? UserAttentionType.Critical : UserAttentionType.Informational)
    .catch(() => {
      /* Attention is a nicety; never let it take the app down. */
    });
};

/** @internal for tests */
export function __setAttentionBackend(fn: ((critical: boolean) => void) | null, isFocused = true): void {
  requestOsAttention = fn ?? (() => {});
  focused = isFocused;
  marked.clear();
  listeners.clear();
}

function emit(): void {
  const snapshot: ReadonlyMap<number, AttentionKind> = new Map(marked);
  for (const fn of listeners) {
    try {
      fn(snapshot);
    } catch {
      /* one bad subscriber must not stop the others */
    }
  }
}

/** Subscribe to the set of tasks asking for attention. Returns a disposer. */
export function onAttention(fn: (marks: ReadonlyMap<number, AttentionKind>) => void): () => void {
  listeners.add(fn);
  // Guarded like `emit`: the current state is delivered on subscribe, so an
  // unguarded call here throws out of the caller's `useEffect` instead of out
  // of a notification -- same fault, but at mount, which is worse.
  try {
    fn(new Map(marked));
  } catch {
    /* as in emit: a bad subscriber is its own problem */
  }
  return () => {
    listeners.delete(fn);
  };
}

/** Current marks, for a first render before any event has arrived. */
export function attentionMarks(): ReadonlyMap<number, AttentionKind> {
  return new Map(marked);
}

/**
 * Track window focus, so the choice of cue is right.
 *
 * Returns a disposer. Safe to call outside Tauri: it resolves to a no-op
 * rather than throwing, which is what keeps the jsdom tests honest.
 */
export function watchFocus(): () => void {
  let unlisten: (() => void) | null = null;
  let disposed = false;
  void (async () => {
    try {
      const win = getCurrentWindow();
      focused = await win.isFocused();
      const off = await win.onFocusChanged(({ payload }) => {
        focused = payload;
      });
      if (disposed) off();
      else unlisten = off;
    } catch {
      focused = true;
    }
  })();
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/**
 * A task changed status. Decide whether that deserves a person's attention.
 *
 * Only transitions are interesting, never the level: a task that has been
 * blocked for ten minutes must not bounce the dock on every capture tick, so
 * the caller passes what it was as well as what it is.
 */
export function noteStatusChange(taskId: number, prior: TaskStatus, next: TaskStatus): void {
  const kind = attentionFor(prior, next);
  if (kind === null) return;
  marked.set(taskId, kind);
  // Critical bounces until the app is activated; informational bounces once.
  // "Blocked" will wait forever, so it gets the persistent one.
  if (!focused) requestOsAttention(kind === 'blocked');
  emit();
}

/**
 * The transition table, kept separate so it can be tested without a window.
 *
 * `running -> idle` is the "it finished" signal. It is deliberately NOT
 * `-> idle` from any state: `blocked -> idle` is the permission prompt you
 * just answered yourself, and bouncing the dock at someone for something they
 * did a second ago is noise. Same for the first status a task ever gets, which
 * arrives on load and describes the past, not an event.
 */
export function attentionFor(prior: TaskStatus, next: TaskStatus): AttentionKind | null {
  if (next === prior) return null;
  if (next === 'blocked') return 'blocked';
  if (next === 'idle' && prior === 'running') return 'finished';
  return null;
}

/** The user has seen it. Clears the mark; the dock bounce clears itself. */
export function clearAttention(taskId: number): void {
  if (marked.delete(taskId)) emit();
}
