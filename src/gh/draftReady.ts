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
 * Only for the PR Albedo asked for (#464 review): a record is bound to the
 * first PR gh reports after Create PR was pressed -- if that PR is not a
 * draft when first seen, it is never touched -- and never carried to a later
 * PR. A record that sees no PR within {@link BIND_WINDOW_MS} expires. The PR
 * must be yours (its author is gh's signed-in user) and its head in this
 * repository, not a fork's branch of the same name. A draft Claude opened on
 * its own, or one you made by hand later, is never touched. And only while the review still holds:
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
import { guideStoreVersion, lastReadOf, useGuideReviewedVersion } from '../guide/store';
import { loadViewerLogin, markPrReady } from './gh';
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
  /** The PR this press opened: the first gh reported after `at`. Absent until seen. */
  pr?: number;
  /** Over: marked, tried, expired, or bound to a PR that was not a draft. */
  retired?: boolean;
}

/** A press that sees no PR in this long opened none: its record expires. */
export const BIND_WINDOW_MS = 60 * 60_000;

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
      out[k] = {
        at: r.at,
        escape: r.escape,
        done,
        ...(Number.isInteger(r.pr) ? { pr: r.pr as number } : {}),
        ...(r.retired === true ? { retired: true } : {}),
      };
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
 * Create PR was pressed for a task: the PR it opens, when it comes as a
 * draft, is marked ready once its checks pass. A later press starts a new
 * record (escape or not), bound to no PR yet, and keeps the PRs already done.
 */
export function notePrRequested(taskId: number, escape: boolean, now = Date.now()): void {
  const all = readAll();
  const was = all[String(taskId)];
  writeAll({ ...all, [String(taskId)]: { at: now, escape, done: was?.done ?? [] } });
}

/**
 * The record with what gh now says applied (#464 review). Pure.
 *  - Bound already: as it is -- a record never moves to another PR.
 *  - Not bound, a PR seen within the window: bound to it; retired at once
 *    when it is not a draft (Claude opened it ready, or it was another PR).
 *  - Not bound, the window over: retired.
 */
export function bindRecord(rec: DraftRecord, pr: PrStatus | null | undefined, now: number): DraftRecord {
  if (rec.retired || rec.pr !== undefined) return rec;
  if (now - rec.at > BIND_WINDOW_MS) return { ...rec, retired: true };
  if (!pr) return rec;
  if (pr.state !== 'draft') return { ...rec, pr: pr.number, retired: true, done: [...rec.done, pr.number] };
  return { ...rec, pr: pr.number };
}

function sameRecord(a: DraftRecord, b: DraftRecord): boolean {
  return a.pr === b.pr && a.retired === b.retired && a.done.length === b.done.length;
}

/** Bind or expire a task's record against its PR now, writing only a change. */
function syncRecord(taskId: number, pr: PrStatus | null | undefined, now = Date.now()): DraftRecord | null {
  const all = readAll();
  const rec = all[String(taskId)];
  if (!rec) return null;
  const next = bindRecord(rec, pr, now);
  if (!sameRecord(rec, next)) writeAll({ ...all, [String(taskId)]: next });
  return next;
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
 * Where a task's draft stands, from the (bound) record, the PR and -- for
 * `ready` -- the gate. `gate` null: not known yet (the branch has to be read).
 * `viewer` is gh's signed-in login: the PR must be theirs; undefined skips
 * that check (the badge's hint), null (not known) never marks it. Pure.
 */
export function draftStep(
  rec: DraftRecord | null,
  pr: PrStatus | null | undefined,
  gate: ReviewGate | null,
  viewer?: string | null,
): DraftStep {
  if (!rec || rec.retired || rec.pr === undefined || !pr) return null;
  if (pr.number !== rec.pr || pr.state !== 'draft') return null;
  if (rec.done.includes(pr.number)) return null;
  // A fork's branch of the same name is not this task's PR; unknown is not mine.
  if (pr.crossRepository !== false) return null;
  if (viewer !== undefined && (viewer === null || !pr.author || pr.author !== viewer)) return null;
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
export function draftHint(
  rec: DraftRecord | null,
  pr: PrStatus | null | undefined,
  gate: ReviewGate | null,
  now = Date.now(),
): string | null {
  const bound = rec ? bindRecord(rec, pr, now) : null;
  if (!bound || draftStep(bound, pr, null) === null) return null;
  if (!bound.escape && gate !== null && gate.kind !== 'checking' && !gatePasses(gate)) {
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
/** The commit the gate's read of the branch was taken at. */
let readHeadOf: (taskId: number) => string | null | undefined = (id) => lastReadOf(id)?.head;
let loadViewer: () => Promise<string | null> = loadViewerLogin;

/** Test seam: the gh write, the fresh gate and its head, gh's login; no argument restores them. */
export function setDraftReadyForTests(
  next?: Marker,
  gate?: GateReader,
  opts: { head?: (taskId: number) => string | null | undefined; viewer?: () => Promise<string | null> } = {},
): void {
  mark = next ?? markPrReady;
  readGate = gate ?? freshGate;
  readHeadOf = opts.head ?? ((id) => lastReadOf(id)?.head);
  loadViewer = opts.viewer ?? loadViewerLogin;
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
  const pr = getPrStatus(task.id);
  const rec = syncRecord(task.id, pr);
  let step = draftStep(rec, pr, null);
  if (step !== 'gate' && step !== 'ready') return;
  // The branch is read for the gate once per state of things -- the PR's
  // head, the guide and its marks, the task's last activity -- not on every
  // poll of every PR while a stale guide holds the draft back.
  const asked = `${pr?.number}:${pr?.headSha}:${guideStoreVersion()}:${task.lastActivityAt ?? ''}`;
  if (step === 'gate' && gateAsked.get(task.id) === asked) return;
  inflight.add(task.id);
  try {
    // Yours only: gh's signed-in user opened it.
    const viewer = await loadViewer();
    let readHead: string | null | undefined;
    let gate: ReviewGate | null = null;
    if (step === 'gate') {
      gateAsked.set(task.id, asked);
      gate = await readGate(task);
      readHead = readHeadOf(task.id);
    }
    // Everything again after the waits (#464 review): the PR, the record and
    // the step, as they are now. The same PR at the same head, or nothing.
    const prNow = getPrStatus(task.id);
    const recNow = syncRecord(task.id, prNow);
    if (!pr || !prNow || prNow.number !== pr.number || prNow.headSha !== pr.headSha) return;
    step = draftStep(recNow, prNow, gate, viewer);
    if (step !== 'ready' || !recNow) return;
    // Reviewed is of the branch as read here: a commit on GitHub that is not
    // in that read (pushed from elsewhere) holds it back.
    if (!recNow.escape && (!readHead || readHead !== prNow.headSha)) return;
    // Written down before gh runs: whatever happens next, never twice.
    const all = readAll();
    writeAll({ ...all, [String(task.id)]: { ...recNow, done: [...recNow.done, prNow.number], retired: true } });
    const out = await mark(prNow, task);
    logReady({ taskId: task.id, pr: prNow.number, escape: recNow.escape, ok: out.ok, ...(out.ok ? {} : { message: out.message }) });
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
        if (!rec || rec.retired || t.status === 'archived' || t.kind === 'chat') continue;
        const pr = getPrStatus(t.id);
        // Binds the record to the PR it opened, or expires it (checkDraft).
        if (rec.pr === undefined || draftStep(bindRecord(rec, pr, Date.now()), pr, null) !== null) void checkDraft(t);
      }
    };
    check();
    return subscribePrStatus(check);
  }, [reviewed]);
}
