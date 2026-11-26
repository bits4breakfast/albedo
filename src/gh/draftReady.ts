/**
 * Draft first, ready when checks pass (#464).
 *
 * Create PR -- reviewed, or through "Create PR without Review…" -- asks Claude
 * to open the PR as a draft, so CI runs before anyone is asked to review.
 * When that draft's checks all pass, Albedo marks it ready for review with
 * `gh pr ready`: the owner's explicit decision, and the only GitHub write
 * Albedo makes on its own. Once per PR, ever: the attempt is written down
 * before gh runs, so a failure, a restart or a check flapping green again
 * never repeats it. A failure is logged and left for you on GitHub.
 *
 * Only for a PR Albedo asked for: a draft Claude opened on its own, or one
 * you made by hand, is never touched. And only while the review still holds:
 * a guide that went out of date after Create PR keeps the draft a draft until
 * the branch is reviewed again -- unless the PR went through the escape
 * hatch, which asked for it without review in the first place.
 *
 * A failing check leaves it a draft, and the task in Needs You, as any
 * failing PR is (taskGroups.ts). Reads the PR store as it is polled; adds no
 * `gh` calls of its own but the one write.
 */

import { useEffect, useRef } from 'react';
import { homeDir } from '@tauri-apps/api/path';
import { mkdir, writeTextFile } from '@tauri-apps/plugin-fs';
import type { Task } from '../types';
import { ALBEDO_DIR } from '../capture/hookEvents';
import { KEYS, readPersisted, writePersisted, type Codec } from '../ui/persisted';
import { freshGate, gatePasses, type GateTask, type ReviewGate } from '../guide/gate';
import { guideStoreVersion, useGuideReviewedVersion } from '../guide/store';
import { markPrReady } from './gh';
import { getPrStatus, refreshPrStatus, subscribePrStatus } from './prStore';
import type { PrStatus } from './prStatus';

/** What is remembered per task. */
export interface DraftRecord {
  /** When Create PR was pressed. */
  at: number;
  /** Through "Create PR without Review…": the review does not hold it back. */
  escape: boolean;
  /** PR numbers already marked ready, or tried: never again. */
  done: number[];
}

/** At most this many tasks are remembered, the newest kept. */
export const MAX_RECORDS = 100;

export const draftCodec: Codec<Record<string, DraftRecord>> = {
  decode: (raw) => {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const out: Record<string, DraftRecord> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v !== 'object' || v === null) continue;
      const r = v as Record<string, unknown>;
      if (typeof r.at !== 'number' || typeof r.escape !== 'boolean') continue;
      const done = Array.isArray(r.done) ? r.done.filter((n): n is number => Number.isInteger(n)) : [];
      out[k] = { at: r.at, escape: r.escape, done };
    }
    return out;
  },
  encode: (value) => (Object.keys(value).length === 0 ? null : JSON.stringify(value)),
};

function readAll(): Record<string, DraftRecord> {
  return readPersisted(KEYS.prDraftReady, draftCodec, {});
}

function writeAll(all: Record<string, DraftRecord>): void {
  const kept = Object.entries(all)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_RECORDS);
  writePersisted(KEYS.prDraftReady, draftCodec, Object.fromEntries(kept));
}

export function draftRecordOf(taskId: number): DraftRecord | null {
  return readAll()[String(taskId)] ?? null;
}

/**
 * Create PR was pressed for a task: its PR, when it comes as a draft, is
 * marked ready once its checks pass. A later press replaces what the earlier
 * one said (escape or not), and keeps the PRs already done.
 */
export function notePrRequested(taskId: number, escape: boolean, now = Date.now()): void {
  const all = readAll();
  const was = all[String(taskId)];
  writeAll({ ...all, [String(taskId)]: { at: now, escape, done: was?.done ?? [] } });
}

/** What the draft is waiting for, or what to do now. */
export type DraftStep =
  /** Nothing: not ours, not a draft, already done, or a check failed. */
  | null
  /** Checks still running (or none reported yet). */
  | 'checks'
  /** Checks pass, and the guide must be looked at before the gate is known. */
  | 'gate'
  /** Checks pass, the review holds (or was skipped): mark it ready. */
  | 'ready';

/**
 * Where a task's draft stands, from the record, the PR and -- for `ready` --
 * the gate. `gate` null: not known yet (the branch has to be read). Pure.
 */
export function draftStep(rec: DraftRecord | null, pr: PrStatus | null | undefined, gate: ReviewGate | null): DraftStep {
  if (!rec || !pr || pr.state !== 'draft') return null;
  if (rec.done.includes(pr.number)) return null;
  if (pr.checks.kind === 'failing') return null;
  if (pr.checks.kind !== 'passing') return 'checks';
  if (rec.escape) return 'ready';
  if (gate === null) return 'gate';
  return gatePasses(gate) ? 'ready' : null;
}

/**
 * The words beside a draft's badge while Albedo means to mark it ready, or
 * null. `gate` is the task's gate as the screen knows it.
 */
export function draftHint(rec: DraftRecord | null, pr: PrStatus | null | undefined, gate: ReviewGate | null): string | null {
  if (!rec || !pr || pr.state !== 'draft' || rec.done.includes(pr.number)) return null;
  if (pr.checks.kind === 'failing') return null;
  if (!rec.escape && gate !== null && gate.kind !== 'checking' && !gatePasses(gate)) {
    return 'Opens for review once the guide is reviewed again';
  }
  return 'Opens for review when checks pass';
}

// ---------------------------------------------------------------------------
// The one write
// ---------------------------------------------------------------------------

type Marker = typeof markPrReady;
let mark: Marker = markPrReady;
type GateReader = (task: GateTask) => Promise<ReviewGate>;
let readGate: GateReader = freshGate;

/** Test seam: the gh write and the fresh gate; no argument restores them. */
export function setDraftReadyForTests(next?: Marker, gate?: GateReader): void {
  mark = next ?? markPrReady;
  readGate = gate ?? freshGate;
  inflight.clear();
  gateAsked.clear();
}

const inflight = new Set<number>();
/** The state of things the gate was last read for, per task (see checkDraft). */
const gateAsked = new Map<number, string>();

let logDir: Promise<string> | null = null;

function logReady(entry: { taskId: number; pr: number; escape: boolean; ok: boolean; message?: string }): void {
  const at = new Date().toISOString();
  const line = `[albedo:pr-ready] task ${entry.taskId}: PR #${entry.pr}${entry.escape ? ' (without review)' : ''} ${entry.ok ? 'marked ready for review' : `not marked ready: ${entry.message ?? ''}`}`;
  if (entry.ok) console.info(line);
  else console.warn(line);
  void (async () => {
    try {
      logDir ??= (async () => {
        const dir = `${(await homeDir()).replace(/\/+$/, '')}/${ALBEDO_DIR}/logs`;
        await mkdir(dir, { recursive: true });
        return dir;
      })();
      const dir = await logDir;
      await writeTextFile(`${dir}/pr-ready.jsonl`, `${JSON.stringify({ at, ...entry })}\n`, { append: true });
    } catch {
      logDir = null; // the console line is the record; try the file again next time
    }
  })();
}

/**
 * Look at one task's draft and, when its time has come, mark it ready -- once.
 * Resolves when done; never throws.
 */
export async function checkDraft(task: GateTask & Pick<Task, 'title'>): Promise<void> {
  if (inflight.has(task.id)) return;
  const rec = draftRecordOf(task.id);
  const pr = getPrStatus(task.id);
  let step = draftStep(rec, pr, null);
  if (step !== 'gate' && step !== 'ready') return;
  // The branch is read for the gate once per state of things -- the PR's
  // head, the guide and its marks, the task's last activity -- not on every
  // poll of every PR while a stale guide holds the draft back.
  const asked = `${pr?.number}:${pr?.headSha}:${guideStoreVersion()}:${task.lastActivityAt ?? ''}`;
  if (step === 'gate' && gateAsked.get(task.id) === asked) return;
  inflight.add(task.id);
  try {
    if (step === 'gate') {
      gateAsked.set(task.id, asked);
      step = draftStep(rec, pr, await readGate(task));
    }
    if (step !== 'ready' || !rec || !pr) return;
    // Read again: the record may have changed while the branch was read.
    const now = draftRecordOf(task.id);
    if (!now || now.done.includes(pr.number)) return;
    // Written down before gh runs: whatever happens next, never twice.
    const all = readAll();
    writeAll({ ...all, [String(task.id)]: { ...now, done: [...now.done, pr.number] } });
    const out = await mark(pr, task);
    logReady({ taskId: task.id, pr: pr.number, escape: now.escape, ok: out.ok, ...(out.ok ? {} : { message: out.message }) });
    void refreshPrStatus(task, { force: true });
  } finally {
    inflight.delete(task.id);
  }
}

/**
 * Watch every task's PR as the store hears of it, and the Reviewed marks, and
 * mark a draft ready when its time comes. Archived tasks are skipped.
 */
export function useDraftReady(tasks: Array<GateTask & Pick<Task, 'title'>>): void {
  const ref = useRef(tasks);
  ref.current = tasks;
  // A review finished after the checks passed is the other way it comes due.
  const reviewed = useGuideReviewedVersion();
  useEffect(() => {
    const check = () => {
      // One read of the records per answer, whatever the task count.
      const all = readAll();
      for (const t of ref.current) {
        const rec = all[String(t.id)];
        if (!rec || t.status === 'archived' || t.kind === 'chat') continue;
        if (draftStep(rec, getPrStatus(t.id), null) === null) continue;
        void checkDraft(t);
      }
    };
    check();
    return subscribePrStatus(check);
  }, [reviewed]);
}
