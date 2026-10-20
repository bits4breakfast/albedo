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
 * Unfocused, a system notification goes out as well, naming the task. The
 * bounce says "Albedo wants you"; with six sessions running, only the banner
 * says which one, and it is the one cue that reaches you in another Space or
 * on another display. It is rate-limited per task (see `shouldNotify`) and
 * can be switched off (`setNotificationsEnabled`).
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
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import type { TaskStatus } from '../types';

/**
 * Why a task is asking for attention. The two are not equally urgent, and the
 * OS has a separate signal for each.
 */
export type AttentionKind =
  /** Waiting on a permission prompt. It will sit there until you answer. */
  | 'blocked'
  /** The turn ended. Nothing is stuck; you just have a result to read. */
  | 'finished'
  /**
   * The turn ended on a question for you, or one was asked while the task's
   * agents keep working. Nothing waits on it, so it bounces once, like
   * `finished`; the banner quotes the question, which is what to read first.
   */
  | 'question'
  /**
   * The task's PR was merged. Not a session event at all -- it comes from
   * `gh` (see `mergeNotice`) -- but it asks the same question of the owner:
   * archive this, or follow it up.
   */
  | 'merged';

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

// ---------------------------------------------------------------------------
// System notifications
// ---------------------------------------------------------------------------

/**
 * The least time between two notifications of the same kind for one task.
 *
 * A task that flaps -- finishes, gets a one-line follow-up queued, finishes
 * again -- would otherwise post a banner per turn, and Notification Center
 * fills with one task's name. A minute is long enough to absorb a flap and
 * short enough that a genuinely new "waiting on you" is never held back for
 * long. Per kind, so a "finished" a moment ago never swallows a "blocked":
 * the prompt is the one that will sit there until you act.
 */
export const NOTIFY_MIN_INTERVAL_MS = 60_000;

/** A banner is a glance, not the transcript: longer questions are cut. */
const QUESTION_BODY_MAX = 160;

/** localStorage key for the off switch. Absent means on. */
export const NOTIFICATIONS_KEY = 'albedo.notifications';

/** When each (task, kind) last posted a notification. */
const lastNotified = new Map<string, number>();

/**
 * Whether a notification may go out now, and records it if so. Pure apart
 * from the map it is handed, so the rate limit is testable without a clock.
 */
export function shouldNotify(
  last: Map<string, number>,
  taskId: number,
  kind: AttentionKind,
  now: number,
): boolean {
  const key = `${taskId}:${kind}`;
  const prev = last.get(key);
  if (prev !== undefined && now - prev < NOTIFY_MIN_INTERVAL_MS) return false;
  last.set(key, now);
  return true;
}

/** What the banner says. The task's title leads: it is the whole point. */
export function notificationFor(
  kind: AttentionKind,
  title: string | null,
  taskId: number,
  /** The PR's number, for `merged`; the question itself, for `question`. */
  detail: number | string | null = null,
): {
  title: string;
  body: string;
} {
  const name = title && title.trim().length > 0 ? title.trim() : `Task ${taskId}`;
  if (kind === 'merged') {
    const pr = typeof detail === 'number' ? `PR #${detail}` : 'PR';
    return { title: name, body: `${pr} merged — archive or follow up.` };
  }
  if (kind === 'question') {
    const q = typeof detail === 'string' ? detail.trim() : '';
    return {
      title: name,
      body: q ? (q.length > QUESTION_BODY_MAX ? `${q.slice(0, QUESTION_BODY_MAX - 1)}…` : q) : 'Asks you a question.',
    };
  }
  return kind === 'blocked'
    ? { title: name, body: 'Waiting on you — Claude is asking for permission or has a question.' }
    : { title: name, body: 'Finished its turn. The result is ready to read.' };
}

/** The per-user off switch. Never throws: no storage reads as "on". */
export function notificationsEnabled(): boolean {
  try {
    return window.localStorage.getItem(NOTIFICATIONS_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setNotificationsEnabled(on: boolean): void {
  try {
    if (on) window.localStorage.removeItem(NOTIFICATIONS_KEY);
    else window.localStorage.setItem(NOTIFICATIONS_KEY, 'off');
  } catch {
    /* storage unavailable: the choice just is not remembered */
  }
}

/**
 * Permission is asked for once, on the first notification rather than at
 * launch: macOS shows its prompt with no context, and the moment a task first
 * needs you is the one moment the question explains itself. The answer is
 * cached for the session -- a refusal is not re-asked on every transition.
 */
let permission: Promise<boolean> | null = null;
function ensurePermission(): Promise<boolean> {
  permission ??= (async () => {
    try {
      if (await isPermissionGranted()) return true;
      return (await requestPermission()) === 'granted';
    } catch {
      return false;
    }
  })();
  return permission;
}

/** Test seam: `sendNotification` needs the Tauri plugin. */
let postNotification: (n: { title: string; body: string }) => void = (n) => {
  void ensurePermission()
    .then((ok) => {
      if (ok) sendNotification(n);
    })
    .catch(() => {
      /* a notification is a nicety, like the bounce */
    });
};

/** @internal for tests */
export function __setAttentionBackend(
  fn: ((critical: boolean) => void) | null,
  isFocused = true,
  notify: ((n: { title: string; body: string }) => void) | null = null,
): void {
  requestOsAttention = fn ?? (() => {});
  postNotification = notify ?? (() => {});
  focused = isFocused;
  marked.clear();
  listeners.clear();
  lastNotified.clear();
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
export function noteStatusChange(
  taskId: number,
  prior: TaskStatus,
  next: TaskStatus,
  /** For the notification banner. Absent, it says "Task <id>". */
  title: string | null = null,
  /**
   * A question the turn just ended on. It turns "finished" into "question" --
   * one bounce and one banner that says what was asked, not two.
   */
  question: string | null = null,
): void {
  let kind = attentionFor(prior, next);
  if (kind === 'finished' && question !== null) kind = 'question';
  if (kind === null) return;
  raise(taskId, kind, title, kind === 'question' ? question : null);
}

/**
 * A question appeared without the status changing: the session asked
 * something while its agents keep the task running. The caller passes only a
 * NEW question, never one that was there at launch.
 */
export function noteQuestion(taskId: number, title: string | null, question: string): void {
  // A prompt waiting on you outranks a question that can wait.
  if (marked.get(taskId) === 'blocked') return;
  raise(taskId, 'question', title, question);
}

/** The mark always; the bounce and the banner only while unfocused. */
function raise(taskId: number, kind: AttentionKind, title: string | null, detail: number | string | null): void {
  marked.set(taskId, kind);
  if (!focused) {
    // Critical bounces until the app is activated; informational bounces
    // once. "Blocked" will wait forever, so it gets the persistent one.
    requestOsAttention(kind === 'blocked');
    // Only while unfocused: a banner for the window you are looking at is
    // the same noise the dock bounce already avoids.
    if (notificationsEnabled() && shouldNotify(lastNotified, taskId, kind, Date.now())) {
      try {
        postNotification(notificationFor(kind, title, taskId, detail));
      } catch {
        /* never let a notification take the status update down */
      }
    }
  }
  emit();
}

/**
 * A task's PR was merged. The caller has already decided this is news (see
 * `mergeNoticeFor`): `notify` false is a merge that happened before this run,
 * which earns the row mark and nothing louder -- a launch must not open with a
 * banner per PR merged last week.
 *
 * Same rules as a status change otherwise: the mark always, the bounce and the
 * banner only while unfocused, and the banner through the per-(task, kind)
 * rate limit. A "blocked" mark is never replaced: a prompt that is waiting on
 * you outranks a merge that will still be merged in an hour.
 */
export function noteMerged(
  taskId: number,
  title: string | null,
  prNumber: number | null,
  notify: boolean,
): void {
  if (marked.get(taskId) === 'blocked') return;
  marked.set(taskId, 'merged');
  if (notify && !focused) {
    requestOsAttention(false);
    if (notificationsEnabled() && shouldNotify(lastNotified, taskId, 'merged', Date.now())) {
      try {
        postNotification(notificationFor('merged', title, taskId, prNumber));
      } catch {
        /* as in noteStatusChange */
      }
    }
  }
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

/**
 * What a screen reader should hear for marks that were not there before.
 *
 * The dock bounce and the row pulse are both visual, so without this a blocked
 * session is silent to anyone not looking at the list. Only NEW marks speak:
 * a mark clearing (you looked at the task) or persisting is not an event, which
 * is the same discipline `attentionFor` applies to the bounce.
 */
export function announcementFor(
  prev: ReadonlyMap<number, AttentionKind>,
  next: ReadonlyMap<number, AttentionKind>,
  titleOf: (taskId: number) => string | null,
): string {
  const parts: string[] = [];
  for (const [id, kind] of next) {
    if (prev.get(id) === kind) continue;
    const title = titleOf(id) ?? `Task ${id}`;
    parts.push(
      kind === 'blocked'
        ? `${title} needs you: waiting on a permission prompt.`
        : kind === 'merged'
          ? `${title}: pull request merged.`
          : kind === 'question'
            ? `${title} asks you a question.`
            : `${title} finished.`,
    );
  }
  return parts.join(' ');
}
