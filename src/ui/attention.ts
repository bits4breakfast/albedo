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
 *     once the app is activated; a critical one is also cancelled after ten
 *     seconds (`src-tauri/src/attention.rs`), so it never bounces forever.
 *   - **Albedo is focused.** The dock bounce is a no-op by design -- macOS
 *     drops `requestUserAttention` for the active app -- so the cue has to be
 *     inside the window. The task's row is marked, and pulses.
 *
 * Unfocused, a system notification goes out as well, naming the task. The
 * bounce says "Albedo wants you"; with six sessions running, only the banner
 * says which one, and it is the one cue that reaches you in another Space or
 * on another display. It is rate-limited per task (see `shouldNotify`) and
 * can be switched off (`setNotificationsEnabled`). Clicking it opens the task
 * (`onNotificationClick`).
 *
 * Both go through `src-tauri/src/attention.rs`, not the Tauri APIs: the
 * window's `requestUserAttention` was never granted and cannot cancel a
 * bounce, and the notification plugin cannot deliver on macOS 26 (see there).
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

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import type { TaskStatus } from '../types';
import { KEYS, readPersisted, writePersisted, type Codec } from './persisted';

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
  | 'merged'
  /**
   * A reminder came back (#156): its card is on the task. Nothing is stuck,
   * so it bounces once, like `finished`; the banner quotes the reminder.
   */
  | 'reminder';

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
  // A nicety: it never takes the app down, but it says when it fails.
  void invoke('attention_bounce', { critical }).catch((err: unknown) => {
    console.warn('[attention] dock bounce failed:', err);
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
export const NOTIFICATIONS_KEY = KEYS.notifications;

/** Only 'off' is stored; on removes the key. */
const notificationsCodec: Codec<boolean> = {
  decode: (raw) => raw !== 'off',
  encode: (on) => (on ? null : 'off'),
};

/** When each (task, kind) last posted a notification. */
const lastNotified = new Map<string, number>();

/**
 * What a banner was about. The session's own kinds, and a PR's checks
 * finishing (`ui/ciNotice.ts`).
 */
export type BannerKind = AttentionKind | 'checks-pass' | 'checks-fail';

/**
 * The kind of the last banner posted for each task. A click carries only the
 * task id (`attention.rs`), so this is how a click on a "checks failed" banner
 * knows to open the checks as well as the task: when it is the newest banner
 * that task has. An older banner clicked in Notification Center after a newer
 * one opens just the task.
 */
const lastBanner = new Map<number, BannerKind>();

/** The kind of the newest banner posted for a task this run, if any. */
export function lastBannerFor(taskId: number): BannerKind | undefined {
  return lastBanner.get(taskId);
}

/** Post, and remember what the task's newest banner was about. */
function postFor(taskId: number, kind: BannerKind, n: { title: string; body: string }): void {
  lastBanner.set(taskId, kind);
  postNotification({ ...n, taskId });
}

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
  /**
   * The PR's number, for `merged`; the question itself, for `question`; the
   * session's own words, for a `blocked` it reported through Albedo's MCP server.
   */
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
  if (kind === 'reminder') {
    const text = typeof detail === 'string' ? detail.trim().replace(/\s+/g, ' ') : '';
    const cut = text.length > QUESTION_BODY_MAX ? `${text.slice(0, QUESTION_BODY_MAX - 1)}…` : text;
    return { title: name, body: cut ? `Reminder: ${cut}` : 'A reminder is back.' };
  }
  if (kind === 'question') {
    const q = typeof detail === 'string' ? detail.trim() : '';
    return {
      title: name,
      body: q ? (q.length > QUESTION_BODY_MAX ? `${q.slice(0, QUESTION_BODY_MAX - 1)}…` : q) : 'Asks you a question.',
    };
  }
  // A "blocked" with a message is the session saying so itself (#157,
  // `noteAgentBlocked`); the hooks' own "blocked" carries none.
  if (kind === 'blocked' && typeof detail === 'string' && detail.trim()) {
    const m = detail.trim();
    return { title: name, body: m.length > QUESTION_BODY_MAX ? `${m.slice(0, QUESTION_BODY_MAX - 1)}…` : m };
  }
  return kind === 'blocked'
    ? { title: name, body: 'Waiting on you — Claude is asking for permission or has a question.' }
    : { title: name, body: 'Finished its turn. The result is ready to read.' };
}

/** The per-user off switch. Never throws: no storage reads as "on". */
export function notificationsEnabled(): boolean {
  return readPersisted(NOTIFICATIONS_KEY, notificationsCodec, true);
}

/** Storage unavailable: the choice just is not remembered. */
export function setNotificationsEnabled(on: boolean): void {
  writePersisted(NOTIFICATIONS_KEY, notificationsCodec, on);
}

/**
 * Where banners go:
 *
 *   - `native`: the app's own notifications (`src-tauri/src/attention.rs`).
 *   - `plugin`: `tauri dev`, a bare binary with no app bundle for macOS to
 *     attribute a notification to. The plugin posts it as Terminal.
 *   - `off`: macOS refused. `notificationProblem` says why; for a build
 *     without a signing certificate it is "Notifications are not allowed for
 *     this application".
 */
type Route = 'native' | 'plugin' | 'off';

let problem: string | null = null;

/** Why banners are not being shown, once that is known. Null otherwise. */
export function notificationProblem(): string | null {
  return problem;
}

/**
 * Asked once, on the first notification rather than at launch: macOS shows
 * its prompt with no context, and the moment a task first needs you is the one
 * moment the question explains itself. The answer is cached for the session --
 * a refusal is not re-asked on every transition.
 */
let route: Promise<Route> | null = null;
function ensureRoute(): Promise<Route> {
  route ??= (async (): Promise<Route> => {
    try {
      const native = await invoke<string>('notify_permission');
      if (native === 'granted') return 'native';
      if (native === 'denied') {
        problem = 'Notifications are turned off for Albedo in System Settings.';
        return 'off';
      }
      // 'unsupported': not an app bundle.
      if (await isPermissionGranted()) return 'plugin';
      return (await requestPermission()) === 'granted' ? 'plugin' : 'off';
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
      console.warn('[attention] notifications unavailable:', problem);
      return 'off';
    }
  })();
  return route;
}

/** Test seam: posting needs the Tauri runtime. */
let postNotification: (n: { title: string; body: string; taskId: number }) => void = (n) => {
  void ensureRoute()
    .then(async (r) => {
      if (r === 'native') await invoke('notify_post', n);
      else if (r === 'plugin') sendNotification({ title: n.title, body: n.body });
    })
    .catch((err: unknown) => {
      // A notification is a nicety, like the bounce -- but a silent failure is
      // how this went unnoticed before, so it is at least said.
      console.warn('[attention] notification not shown:', err);
    });
};

/**
 * A banner was clicked: `fn` gets the task it was posted for. The window is
 * already brought forward by then. Returns a disposer; safe outside Tauri.
 */
export function onNotificationClick(fn: (taskId: number) => void): () => void {
  let off: (() => void) | null = null;
  let gone = false;
  void listen<number | null>('albedo://notification-clicked', ({ payload }) => {
    if (typeof payload === 'number') fn(payload);
  })
    .then((un) => {
      if (gone) un();
      else off = un;
    })
    .catch(() => {
      /* outside Tauri: no banners to click */
    });
  return () => {
    gone = true;
    off?.();
  };
}

/** @internal for tests */
export function __setAttentionBackend(
  fn: ((critical: boolean) => void) | null,
  isFocused = true,
  notify: ((n: { title: string; body: string; taskId: number }) => void) | null = null,
): void {
  requestOsAttention = fn ?? (() => {});
  postNotification = notify ?? (() => {});
  focused = isFocused;
  marked.clear();
  listeners.clear();
  lastNotified.clear();
  lastBanner.clear();
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

/**
 * The session said, through Albedo's MCP server (`notify_blocked`, #157), that
 * it cannot go on without the user. Same cue as a prompt waiting on you -- the
 * mark, and the critical bounce and a banner while unfocused -- with the
 * session's own words in the banner. It does not change the task's status:
 * that stays what the transcript and the hooks say.
 */
export function noteAgentBlocked(taskId: number, title: string | null, message: string): void {
  raise(taskId, 'blocked', title, message);
}

/** The mark always; the bounce and the banner only while unfocused. */
function raise(taskId: number, kind: AttentionKind, title: string | null, detail: number | string | null): void {
  marked.set(taskId, kind);
  if (!focused) {
    // Critical bounces for ten seconds; informational bounces once.
    // "Blocked" will wait forever, so it gets the longer one.
    requestOsAttention(kind === 'blocked');
    // Only while unfocused: a banner for the window you are looking at is
    // the same noise the dock bounce already avoids.
    if (notificationsEnabled() && shouldNotify(lastNotified, taskId, kind, Date.now())) {
      try {
        postFor(taskId, kind, notificationFor(kind, title, taskId, detail));
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
        postFor(taskId, 'merged', notificationFor('merged', title, taskId, prNumber));
      } catch {
        /* as in noteStatusChange */
      }
    }
  }
  emit();
}

/**
 * A reminder came back on this task (#156). The caller passes only one that
 * fired now. The mark always; unfocused, one bounce and a banner quoting it
 * (rate-limited per task like every other kind). A "blocked" mark is kept:
 * a prompt waiting on you outranks a reminder, whose card stays anyway.
 */
export function noteReminder(taskId: number, title: string | null, text: string): void {
  if (marked.get(taskId) === 'blocked') return;
  raise(taskId, 'reminder', title, text);
}

/**
 * A task's PR checks finished (`ui/ciNotice.ts` has decided it is news, and
 * that this kind of news is wanted). Only while unfocused, like every other
 * cue here: one informational bounce for a pass and a failure alike -- nothing
 * is stuck, there is a result -- and the banner, unless banners are off.
 * Focused, it does nothing and says so: the caller marks the row instead.
 *
 * No rate limit: the caller already announces each outcome once per head
 * commit, which is a stricter rule than a minute.
 */
export function noteChecksFinished(
  taskId: number,
  outcome: 'pass' | 'fail',
  banner: { title: string; body: string },
): boolean {
  if (focused) return false;
  requestOsAttention(false);
  if (notificationsEnabled()) {
    try {
      postFor(taskId, outcome === 'pass' ? 'checks-pass' : 'checks-fail', banner);
    } catch {
      /* as in noteStatusChange */
    }
  }
  return true;
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
            : kind === 'reminder'
              ? `${title}: a reminder is back.`
              : `${title} finished.`,
    );
  }
  return parts.join(' ');
}
