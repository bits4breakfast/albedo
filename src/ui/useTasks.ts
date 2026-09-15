import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Task, TaskStatus } from '../types';
import { listTasks, updateTask, archiveTask, getMessages } from '../db';
import { startCapture, onCaptureUpdate, deriveStatus } from '../capture';
import type { CaptureHandle } from '../capture';

/** Shape of the `onCaptureUpdate` payload, per docs/INTERFACES.md. */
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

export interface UseTasksResult {
  tasks: Task[];
  loading: boolean;
  /** Fatal-ish problems worth surfacing in a banner. Null when healthy. */
  loadError: string | null;
  captureError: string | null;
  refresh: () => Promise<void>;
  /** Insert or replace a task locally (e.g. after NewTaskDialog creates one). */
  upsertTask: (task: Task) => void;
  archive: (id: number) => Promise<void>;
}

function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function useTasks(): UseTasksResult {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);

  /** Latest tasks, readable from callbacks without re-subscribing. */
  const tasksRef = useRef<Task[]>([]);
  tasksRef.current = tasks;

  const aliveRef = useRef(true);
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const applyTask = useCallback((id: number, patch: Partial<Task>) => {
    setTasks((prev) => {
      let changed = false;
      const next = prev.map((t) => {
        if (t.id !== id) return t;
        const merged = { ...t, ...patch };
        for (const key of Object.keys(patch) as (keyof Task)[]) {
          if (t[key] !== merged[key]) changed = true;
        }
        return merged;
      });
      return changed ? next : prev;
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const rows = await listTasks();
      if (!aliveRef.current) return;
      setTasks(Array.isArray(rows) ? rows : []);
      setLoadError(null);
    } catch (err) {
      if (!aliveRef.current) return;
      setLoadError(`Could not read tasks: ${message(err)}`);
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  const upsertTask = useCallback((task: Task) => {
    setTasks((prev) => {
      const i = prev.findIndex((t) => t.id === task.id);
      if (i === -1) return [task, ...prev];
      const next = prev.slice();
      next[i] = task;
      return next;
    });
  }, []);

  const archive = useCallback(
    async (id: number) => {
      applyTask(id, { status: 'archived' });
      try {
        await archiveTask(id);
      } catch (err) {
        setLoadError(`Could not archive task: ${message(err)}`);
      }
    },
    [applyTask],
  );

  /** Re-derive one session's status from persisted rows. */
  const refreshStatus = useCallback(
    async (sessionId: string, cwd: string | null) => {
      const current = tasksRef.current;
      let task = current.find((t) => t.sessionId === sessionId) ?? null;

      // A session started in a worktree we own but not yet linked to the task:
      // adopt it by cwd. This is how a task picks up its sessionId.
      if (!task && cwd) {
        const candidate = current.find(
          (t) => t.status !== 'archived' && t.sessionId === null && t.worktreePath === cwd,
        );
        if (candidate) {
          task = { ...candidate, sessionId };
          applyTask(candidate.id, { sessionId });
          void updateTask(candidate.id, { sessionId }).catch(() => {
            /* best effort; the next capture tick retries */
          });
        }
      }
      if (!task) return; // transcript for a session Albedo does not own — fine.

      let status: TaskStatus;
      try {
        const messages = await getMessages({ sessionId, limit: STATUS_WINDOW });
        status = deriveStatus(messages ?? []);
      } catch (err) {
        setCaptureError(`Status refresh failed: ${message(err)}`);
        return;
      }
      if (!aliveRef.current) return;
      setCaptureError(null);

      const lastActivityAt = Date.now();
      const prior = tasksRef.current.find((t) => t.id === task.id);
      if (!prior || prior.status === 'archived') return;

      applyTask(task.id, { status, lastActivityAt });
      if (prior.status !== status) {
        void updateTask(task.id, { status, lastActivityAt }).catch(() => {});
      }
    },
    [applyTask],
  );

  // Initial load.
  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    return () => {
      aliveRef.current = false;
    };
  }, [refresh]);

  // Capture pipeline: start the watcher, then refresh status on every burst.
  useEffect(() => {
    let handle: CaptureHandle | null = null;
    let stopped = false;
    let unsubscribe: (() => void) | null = null;
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
            void refreshStatus(u.sessionId, u.cwd ?? null);
          }, COALESCE_MS),
        );
      });
    } catch (err) {
      setCaptureError(`Capture updates unavailable: ${message(err)}`);
    }

    void (async () => {
      try {
        handle = await startCapture();
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
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      void handle?.stop().catch(() => {});
    };
  }, [refreshStatus]);

  return useMemo(
    () => ({ tasks, loading, loadError, captureError, refresh, upsertTask, archive }),
    [tasks, loading, loadError, captureError, refresh, upsertTask, archive],
  );
}

export default useTasks;
