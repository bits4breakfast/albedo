import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, Task, TaskStatus } from '../types';
import { listTasks, updateTask, archiveTask, getMessages, onTasksChanged, compactHistory } from '../db';
import { listProjects, onProjectsChanged } from '../db/projects';
import { startCapture, onCaptureUpdate, onCaptureProgress, deriveStatus, contextUsageForSessions } from '../capture';
import { keepUserStatus, pendingQuestion, RUNNING_WINDOW_MS, statusExpiresAt, turnEndedAt } from '../capture/status';
import { listSubagents, liveRuns } from '../db/subagents';
import { hasHooks, onPromptChange, onStatusSnapshot, pendingPrompt } from '../capture/hookEvents';
import { isTrustWaiting, onTrustWaiting } from '../capture/workspaceTrust';
import { noteQuestion, noteStatusChange } from './attention';
import { dropDraft, keepDraftsFor } from './transcript/drafts';
import { keepOutboxFor } from './transcript/outbox';
import { noteTaskSessions } from './transcript/turn';
import type { CaptureHandle, ContextUsage } from '../capture';

/** Shape of the `onCaptureUpdate` payload. */
interface CaptureUpdate {
  sessionId: string;
  cwd: string | null;
  lastSeq: number;
}

/**
 * Task state for the shell.
 *
 * Architectural rule this hook exists to enforce: status comes from
 * `deriveStatus(messages)` over rows the capture pipeline persisted. It never
 * comes from pty output. The pty is execution only; the transcript is truth.
 *
 * Every call into a sibling module is wrapped — a half-built or failing
 * capture/db module degrades the app to "no live status", never to a blank
 * window.
 */

/** How long we sit on a burst of capture events before hitting the db. */
const COALESCE_MS = 250;
/** Recent-window of rows handed to deriveStatus. */
const STATUS_WINDOW = 400;
/** Coalesces bursts of task-row writes into one reload. */
const TASKS_CHANGED_DEBOUNCE_MS = 120;
/** One batched context query per burst, never one per row. */
const CONTEXT_DEBOUNCE_MS = 400;
/**
 * Slack after a status window lapses before it is re-derived, so the check
 * lands on the far side of the edge even if the timer fires a little early.
 */
const EXPIRY_SLACK_MS = 50;

/**
 * What a task's status alone does not say, kept beside it rather than on the
 * Task row (src/types.ts is a shared contract): how many of its subagents are
 * still working, whether its last turn ended on a question for the user, and
 * when the session last handed control back (Ready to Review's "finished").
 */
export interface TaskSignals {
  agents: number;
  question: boolean;
  /** `turnEndedAt` over the task's rows; null when no turn has ended. */
  finishedAt: number | null;
}

/**
 * While the session has handed control back but its agents still work, they
 * write to their own files and the parent writes nothing, so nothing re-asks
 * when one dies quietly. Re-check this often until they are done.
 */
const AGENT_RECHECK_MS = RUNNING_WINDOW_MS / 3;

export interface UseTasksResult {
  tasks: Task[];
  /** Keyed by task id; absent means no agents and no question. */
  signals: Map<number, TaskSignals>;
  loading: boolean;
  /** Fatal-ish problems worth surfacing in a banner. Null when healthy. */
  loadError: string | null;
  captureError: string | null;
  /**
   * Projects, name-ascending as the db returns them. The task list groups by
   * these, INCLUDING empty ones -- a project with no tasks still has to appear,
   * or creating one looks like nothing happened.
   */
  projects: Project[];
  /**
   * Context-window usage keyed by sessionId, fetched for every visible task in
   * a single batched query. Absent entries simply render no meter.
   */
  contextBySession: Map<string, ContextUsage>;
  refresh: () => Promise<void>;
  /** Insert or replace a task locally (e.g. after NewTaskDialog creates one). */
  upsertTask: (task: Task) => void;
  archive: (id: number) => Promise<void>;
  /** Mark as Done, or with false, Mark as Not Done. A task at rest only. */
  setDone: (id: number, done: boolean) => Promise<void>;
  /** The task was on screen at `at` (epoch ms); see `Task.seenAt`. */
  markSeen: (id: number, at: number) => void;
}

function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Same keys, same values. Task and ContextUsage are both flat records. */
export function shallowEqual<T extends object>(a: T, b: T): boolean {
  if (a === b) return true;
  const keys = Object.keys(a) as (keyof T)[];
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

/**
 * The reloaded list, reusing every previous object whose row did not change --
 * and the previous ARRAY when none did.
 *
 * Every transcript append touches a task row, and each touch reloads the list.
 * Handing React all-new objects for that made the selected task and every
 * Terminal's `task` prop change identity on every line Claude wrote, so the
 * whole shell re-rendered for a recency bump on one row.
 */
export function reconcileTasks(prev: Task[], rows: Task[]): Task[] {
  const byId = new Map(prev.map((t) => [t.id, t]));
  let same = prev.length === rows.length;
  const next = rows.map((row, i) => {
    const old = byId.get(row.id);
    const kept = old !== undefined && shallowEqual(old, row) ? old : row;
    if (kept !== prev[i]) same = false;
    return kept;
  });
  return same ? prev : next;
}

/**
 * `prev` with `ids` re-read from `result`, sessions no longer live dropped,
 * and `prev` itself back when nothing moved. An id that was asked for and is
 * absent from `result` has no reading any more, so its meter goes too.
 */
export function mergeContext(
  prev: Map<string, ContextUsage>,
  ids: string[],
  result: Map<string, ContextUsage>,
  live: Set<string>,
): Map<string, ContextUsage> {
  const next = new Map(prev);
  let changed = false;
  for (const id of prev.keys()) {
    if (!live.has(id)) {
      next.delete(id);
      changed = true;
    }
  }
  for (const id of ids) {
    if (!live.has(id)) continue;
    const fresh = result.get(id);
    const old = next.get(id);
    if (fresh === undefined) {
      if (old !== undefined) {
        next.delete(id);
        changed = true;
      }
    } else if (old === undefined || !shallowEqual(old, fresh)) {
      next.set(id, fresh);
      changed = true;
    }
  }
  return changed ? next : prev;
}

function liveSessionIds(tasks: Task[]): string[] {
  const ids = new Set<string>();
  for (const t of tasks) if (t.status !== 'archived' && t.sessionId) ids.add(t.sessionId);
  return [...ids];
}

/**
 * A task write this hook has made in memory and not yet seen come back from
 * the database. See `refresh` for why it is laid over every reload.
 */
interface PendingWrite {
  patch: Partial<Task>;
  /** Write-clock value when the write landed; null while in flight or failed. */
  settledAt: number | null;
  /** The write failed; the next status refresh for the task retries it. */
  failed: boolean;
}

export function useTasks(): UseTasksResult {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [contextBySession, setContextBySession] = useState<Map<string, ContextUsage>>(
    () => new Map(),
  );
  const [projects, setProjects] = useState<Project[]>([]);
  const [signals, setSignals] = useState<Map<number, TaskSignals>>(() => new Map());

  /**
   * Latest tasks, readable from callbacks without re-subscribing. Written
   * SYNCHRONOUSLY by `commit`, not copied from state on render: two status
   * refreshes landing in one tick must see each other's result, or both read
   * the same old status and both announce the transition.
   */
  const tasksRef = useRef<Task[]>([]);

  const aliveRef = useRef(true);
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** One timer per task, for the instant its derived status goes stale. */
  const expiryRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  /** Per-task derivation counter: an older derivation never lands on a newer. */
  const statusGenRef = useRef(new Map<number, number>());
  const pendingRef = useRef(new Map<number, PendingWrite>());
  /** The pending question per task as last derived; see refreshStatus. */
  const questionSeenRef = useRef(new Map<number, string | null>());
  /** Monotonic clock over write completions, compared against reload starts. */
  const writeClockRef = useRef(0);

  const commit = useCallback((update: (prev: Task[]) => Task[]) => {
    const prev = tasksRef.current;
    const next = update(prev);
    if (next === prev) return;
    tasksRef.current = next;
    // The outbox's turn follows each task's session (transcript/turn.ts).
    noteTaskSessions(next);
    setTasks(next);
  }, []);

  const applyTask = useCallback(
    (id: number, patch: Partial<Task>) => {
      commit((prev) => {
        let changed = false;
        const next = prev.map((t) => {
          if (t.id !== id) return t;
          const merged = { ...t, ...patch };
          if (shallowEqual(t, merged)) return t;
          changed = true;
          return merged;
        });
        return changed ? next : prev;
      });
    },
    [commit],
  );

  /**
   * Persist a change already applied in memory, keeping it laid over reloads
   * until the database is known to hold it. Resolves to the error, or null.
   *
   * Failure is never silent. With `rollback`, the in-memory change is undone
   * so the next capture update redoes it from scratch; without, it is kept --
   * it is what the transcript says -- and marked for the next status refresh
   * to write again.
   */
  const persist = useCallback(
    (
      id: number,
      patch: Partial<Task>,
      opts: { write?: () => Promise<void>; rollback?: () => void } = {},
    ): Promise<unknown> => {
      const pending = pendingRef.current;
      const entry: PendingWrite = {
        patch: { ...pending.get(id)?.patch, ...patch },
        settledAt: null,
        failed: false,
      };
      pending.set(id, entry);
      // The merged patch, not just this one: a superseded write that failed
      // must not leave its fields shown in memory and never written.
      const write = opts.write ?? (() => updateTask(id, entry.patch));
      return write().then(
        () => {
          if (pending.get(id) === entry) entry.settledAt = ++writeClockRef.current;
          return null;
        },
        (err: unknown) => {
          console.error(`[tasks] could not persist task ${id}`, patch, err);
          if (pending.get(id) === entry) {
            if (opts.rollback) pending.delete(id);
            else entry.failed = true;
          }
          opts.rollback?.();
          return err ?? new Error('write failed');
        },
      );
    },
    [],
  );

  /**
   * Reload from the database.
   *
   * The read can be older than memory: it may have started before a status
   * write this hook already fired landed, and the pool does not order a read
   * behind a write. Landing as-is put the old status back, and the next
   * derivation then "saw" the same transition again -- a second dock bounce.
   * So every write still unconfirmed when the read began is laid over it.
   */
  const refresh = useCallback(async () => {
    try {
      const startedAt = writeClockRef.current;
      const rows = await listTasks();
      if (!aliveRef.current) return;
      const pending = pendingRef.current;
      const merged = (Array.isArray(rows) ? rows : []).map((row) => {
        const edit = pending.get(row.id);
        if (!edit) return row;
        if (edit.settledAt !== null && edit.settledAt <= startedAt) {
          pending.delete(row.id); // this read began after the write landed
          return row;
        }
        const patch = { ...edit.patch };
        // An archive done elsewhere outranks a status derived here.
        if (row.status === 'archived') delete patch.status;
        return { ...row, ...patch };
      });
      commit((prev) => reconcileTasks(prev, merged));
      // The read holds every live task: an archived or deleted one's draft
      // and held messages go.
      const live = merged.filter((t) => t.status !== 'archived').map((t) => t.id);
      keepDraftsFor(live);
      keepOutboxFor(live);
      setLoadError(null);
    } catch (err) {
      if (!aliveRef.current) return;
      setLoadError(`Could not read tasks: ${message(err)}`);
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [commit]);

  const refreshProjects = useCallback(async () => {
    try {
      const rows = await listProjects();
      if (!aliveRef.current) return;
      setProjects(Array.isArray(rows) ? rows : []);
    } catch {
      /* The list still renders; it just cannot group by project. */
    }
  }, []);

  const upsertTask = useCallback(
    (task: Task) => {
      commit((prev) => {
        const i = prev.findIndex((t) => t.id === task.id);
        if (i === -1) return [task, ...prev];
        if (shallowEqual(prev[i] as Task, task)) return prev;
        const next = prev.slice();
        next[i] = task;
        return next;
      });
    },
    [commit],
  );

  const archive = useCallback(
    async (id: number) => {
      applyTask(id, { status: 'archived' });
      dropDraft(id);
      // On failure the overlay is dropped, not the status reverted: archiveTask
      // flips the row before purging, so a failure may or may not have
      // archived, and a reload shows whichever is true.
      const err = await persist(
        id,
        { status: 'archived' },
        { write: () => archiveTask(id), rollback: () => void refresh() },
      );
      if (err !== null && aliveRef.current) setLoadError(`Could not archive task: ${message(err)}`);
    },
    [applyTask, persist, refresh],
  );

  const setDone = useCallback(
    async (id: number, done: boolean) => {
      const task = tasksRef.current.find((t) => t.id === id);
      const from = done ? 'idle' : 'done';
      // Only between turns: anything else would be replaced by the next
      // derivation (keepUserStatus) the moment it landed.
      if (!task || task.status !== from) return;
      const status = done ? 'done' : 'idle';
      applyTask(id, { status });
      const err = await persist(id, { status });
      if (err !== null && aliveRef.current) setLoadError(`Could not update task: ${message(err)}`);
    },
    [applyTask, persist],
  );

  const markSeen = useCallback(
    (id: number, at: number) => {
      applyTask(id, { seenAt: at });
      void persist(id, { seenAt: at });
    },
    [applyTask, persist],
  );

  const clearExpiry = useCallback((taskId: number) => {
    const t = expiryRef.current.get(taskId);
    if (t !== undefined) clearTimeout(t);
    expiryRef.current.delete(taskId);
  }, []);

  /** Re-derive one session's status from persisted rows. */
  const refreshStatus = useCallback(
    async (sessionId: string) => {
      // By session id only. A task is on its session before `claude` starts
      // (capture/sessionLink.ts); this used to adopt sessions by folder too,
      // which in a shared folder put whichever session wrote first onto the
      // task.
      const task = tasksRef.current.find((t) => t.sessionId === sessionId) ?? null;
      if (!task) return; // transcript for a session Albedo does not own — fine.
      const taskId = task.id;
      const gen = (statusGenRef.current.get(taskId) ?? 0) + 1;
      statusGenRef.current.set(taskId, gen);

      let status: TaskStatus;
      let expiresAt: number | null;
      let newestTs = 0;
      let agents = 0;
      let asked: string | null = null;
      let finishedAt: number | null = null;
      try {
        // Parent rows only: a subagent's tool call that is still running has no
        // result yet, and would read as this task waiting on a permission prompt.
        const messages = (await getMessages({ sessionId, limit: STATUS_WINDOW, parentOnly: true })) ?? [];
        const now = Date.now();
        const opts = { unansweredToolUseBlocks: !hasHooks(taskId) };
        status = deriveStatus(messages, now, opts);
        expiresAt = statusExpiresAt(messages, now, opts);
        for (const m of messages) if (m.ts > newestTs) newestTs = m.ts;
        finishedAt = turnEndedAt(messages);
        // The transcript cannot show a prompt that is still waiting (the turn
        // is written only when it ends); the hooks can. See hookEvents.ts.
        if (pendingPrompt(taskId) !== null || isTrustWaiting(taskId)) status = 'blocked';
        asked = status !== 'blocked' ? pendingQuestion(messages) : null;
        // Background agents report back to the session when they finish, and
        // it carries on by itself: a turn handed back while they work is not
        // idle. Same liveness as the "Agents Running" strip.
        if (status !== 'blocked') {
          agents = liveRuns(await listSubagents(sessionId).catch(() => [])).length;
          if (agents > 0 && status === 'idle') {
            status = 'running';
            const recheck = Date.now() + AGENT_RECHECK_MS;
            expiresAt = expiresAt === null ? recheck : Math.min(expiresAt, recheck);
          }
        }
      } catch (err) {
        if (aliveRef.current) setCaptureError(`Status refresh failed: ${message(err)}`);
        return;
      }
      if (!aliveRef.current) return;
      if (statusGenRef.current.get(taskId) !== gen) return; // a newer one ran
      setCaptureError(null);

      clearExpiry(taskId);
      const prior = tasksRef.current.find((t) => t.id === taskId);
      if (!prior || prior.status === 'archived') return;
      // A task marked done stays done while its session stays at rest.
      status = keepUserStatus(prior.status, status);

      const question = asked !== null;
      // The question as last seen, per task. Absent until the first derivation,
      // which describes the past (a question left open at launch is not news).
      const seen = questionSeenRef.current;
      const newQuestion = seen.has(taskId) && seen.get(taskId) === null && asked !== null;
      seen.set(taskId, asked);

      setSignals((prev) => {
        const old = prev.get(taskId);
        const none = agents === 0 && !question && finishedAt === null;
        const same = none
          ? old === undefined
          : old?.agents === agents && old.question === question && old.finishedAt === finishedAt;
        if (same) return prev;
        const next = new Map(prev);
        if (none) next.delete(taskId);
        else next.set(taskId, { agents, question, finishedAt });
        return next;
      });

      // The status windows are measured against the clock, and once a session
      // dies mid-turn no new row ever comes to re-ask. So re-ask at the
      // instant the answer would change on its own.
      if (expiresAt !== null) {
        const delay = Math.max(0, expiresAt - Date.now()) + EXPIRY_SLACK_MS;
        expiryRef.current.set(
          taskId,
          setTimeout(() => {
            expiryRef.current.delete(taskId);
            const live = tasksRef.current.find((t) => t.id === taskId);
            if (live?.sessionId) void refreshStatus(live.sessionId);
          }, delay),
        );
      }

      // Activity is the newest ROW, as touchTaskActivity records it -- never
      // "now": a re-derivation at launch or at a window edge is not activity.
      const lastActivityAt =
        newestTs > (prior.lastActivityAt ?? 0) ? newestTs : prior.lastActivityAt;
      applyTask(taskId, { status, lastActivityAt });
      if (prior.status !== status) {
        // A transition, not a level: this is the one place that knows a task
        // just *became* blocked rather than having been blocked all along.
        noteStatusChange(taskId, prior.status, status, prior.title, newQuestion ? asked : null);
      } else if (newQuestion && asked !== null) {
        noteQuestion(taskId, prior.title, asked);
      }
      const retry = pendingRef.current.get(taskId)?.failed === true;
      if (prior.status !== status || retry) void persist(taskId, { status, lastActivityAt });
    },
    [applyTask, persist, clearExpiry],
  );

  /**
   * Context for the given sessions only, merged into what is held. Asking for
   * every live session on every append ran a json_extract scan per session
   * for a change that touched one of them.
   */
  const refreshContext = useCallback(async (requested: string[]) => {
    const live = new Set(liveSessionIds(tasksRef.current));
    const ids = [...new Set(requested)].filter((id) => live.has(id));
    let result = new Map<string, ContextUsage>();
    if (ids.length > 0) {
      try {
        const r = await contextUsageForSessions(ids);
        if (!aliveRef.current) return;
        if (r instanceof Map) result = r;
      } catch {
        /* Keep the last good reading rather than blanking the meters. */
        return;
      }
    }
    setContextBySession((prev) => mergeContext(prev, ids, result, live));
  }, []);

  /** Identity of the live session set — refetch when a task joins or leaves. */
  const sessionKey = liveSessionIds(tasks).sort().join(',');

  const contextRef = useRef(contextBySession);
  contextRef.current = contextBySession;

  useEffect(() => {
    // Only sessions with no reading yet; the rest are kept current by capture
    // updates, and leavers are pruned by the merge.
    const ids = sessionKey === '' ? [] : sessionKey.split(',');
    void refreshContext(ids.filter((id) => !contextRef.current.has(id)));
  }, [sessionKey, refreshContext]);

  // Initial load, then a fresh look at every task's status: the database holds
  // whatever was derived last time, and a session that died mid-turn left
  // `running` behind with nothing to ever clear it.
  useEffect(() => {
    aliveRef.current = true;
    const expiry = expiryRef.current;
    void refresh().then(() => {
      if (!aliveRef.current) return;
      for (const t of tasksRef.current) {
        if (t.status !== 'archived' && t.sessionId) void refreshStatus(t.sessionId);
      }
    });
    void refreshProjects();
    return () => {
      aliveRef.current = false;
      for (const t of expiry.values()) clearTimeout(t);
      expiry.clear();
    };
  }, [refresh, refreshProjects, refreshStatus]);

  // Projects mutate from the dialog, and from the launch backfill.
  useEffect(() => {
    let off: (() => void) | null = null;
    try {
      off = onProjectsChanged(() => void refreshProjects());
    } catch {
      /* no notifications: the dialog's onChanged still refreshes */
    }
    return () => off?.();
  }, [refreshProjects]);

  // Task rows mutated behind the shell's back -- the worktree module creating
  // or removing one, the capture watcher adopting a sessionId. Without this the
  // list silently goes stale.
  useEffect(() => {
    let off: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      off = onTasksChanged(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void refresh(), TASKS_CHANGED_DEBOUNCE_MS);
      });
    } catch {
      /* db build without notifications: we still see our own writes */
    }
    return () => {
      if (timer) clearTimeout(timer);
      off?.();
    };
  }, [refresh]);

  // Capture pipeline: start the watcher, then refresh status on every burst.
  useEffect(() => {
    let handle: CaptureHandle | null = null;
    let stopped = false;
    let unsubscribe: (() => void) | null = null;
    let contextTimer: ReturnType<typeof setTimeout> | null = null;
    const contextDirty = new Set<string>();
    const timers = timersRef.current;

    try {
      unsubscribe = onCaptureUpdate((u: CaptureUpdate) => {
        if (!u || typeof u.sessionId !== 'string') return;
        const existing = timers.get(u.sessionId);
        if (existing) clearTimeout(existing);
        timers.set(
          u.sessionId,
          setTimeout(() => {
            timers.delete(u.sessionId);
            void refreshStatus(u.sessionId);
          }, COALESCE_MS),
        );

        // Context is event-driven too — no polling. One batch per burst,
        // covering only the sessions the burst touched.
        contextDirty.add(u.sessionId);
        if (contextTimer) clearTimeout(contextTimer);
        contextTimer = setTimeout(() => {
          contextTimer = null;
          const ids = [...contextDirty];
          contextDirty.clear();
          void refreshContext(ids);
        }, CONTEXT_DEBOUNCE_MS);
      });
    } catch (err) {
      setCaptureError(`Capture updates unavailable: ${message(err)}`);
    }

    // The watcher reports a dead or inert fs watch here, and nothing else did:
    // liveUpdatesError was set and never read.
    const unsubscribeProgress = onCaptureProgress((p) => {
      if (stopped) return;
      if (p.phase === 'degraded' || p.phase === 'polling') setCaptureError(p.error ?? null);
    });

    void (async () => {
      try {
        // Before capture starts, so a VACUUM never contends with ingest.
        // Housekeeping only: a failure must not keep capture from starting.
        await compactHistory().catch((err) => console.error('[db] compactHistory failed', err));
        handle = await startCapture();
        if (!stopped && handle?.liveUpdatesError) setCaptureError(handle.liveUpdatesError);
        if (stopped) {
          void handle?.stop().catch(() => {});
          handle = null;
        }
      } catch (err) {
        if (!stopped) setCaptureError(`Transcript capture is not running: ${message(err)}`);
      }
    })();

    return () => {
      stopped = true;
      unsubscribe?.();
      unsubscribeProgress();
      if (contextTimer) clearTimeout(contextTimer);
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      void handle?.stop().catch(() => {});
    };
  }, [refreshStatus, refreshContext]);

  // The status line reports a session's real window size: re-read its context.
  useEffect(() => {
    return onStatusSnapshot((_taskId, snap) => {
      if (snap.sessionId) void refreshContext([snap.sessionId]);
    });
  }, [refreshContext]);

  // A prompt appearing or being answered is a status change on its own: the
  // transcript has nothing to say about either until the turn ends.
  useEffect(() => {
    return onPromptChange((taskId, prompt) => {
      const task = tasksRef.current.find((t) => t.id === taskId);
      if (!task || task.status === 'archived') return;
      if (prompt !== null) {
        if (task.status === 'blocked') return;
        applyTask(taskId, { status: 'blocked' });
        noteStatusChange(taskId, task.status, 'blocked', task.title);
        void persist(taskId, { status: 'blocked' });
      } else if (task.sessionId) {
        void refreshStatus(task.sessionId);
      }
    });
  }, [applyTask, persist, refreshStatus]);

  // Claude Code's trust dialog, the same way: no hook and no transcript line
  // says it is up (capture/workspaceTrust.ts).
  useEffect(() => {
    return onTrustWaiting((taskId, waiting) => {
      const task = tasksRef.current.find((t) => t.id === taskId);
      if (!task || task.status === 'archived') return;
      if (waiting) {
        if (task.status === 'blocked') return;
        applyTask(taskId, { status: 'blocked' });
        noteStatusChange(taskId, task.status, 'blocked', task.title);
        void persist(taskId, { status: 'blocked' });
      } else if (task.sessionId) {
        void refreshStatus(task.sessionId);
      }
    });
  }, [applyTask, persist, refreshStatus]);

  return useMemo(
    () => ({
      tasks,
      signals,
      loading,
      loadError,
      captureError,
      projects,
      contextBySession,
      refresh,
      upsertTask,
      archive,
      setDone,
      markSeen,
    }),
    [
      tasks,
      signals,
      loading,
      loadError,
      captureError,
      projects,
      contextBySession,
      refresh,
      upsertTask,
      archive,
      setDone,
      markSeen,
    ],
  );
}

export default useTasks;
