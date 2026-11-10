/**
 * A review task's side of GitHub (#287, steps 3 and 4), for the views: which
 * PR it is, the lines of the PR's diff a comment may go on, its drafts for
 * GitHub kept current, and what Submit Review needs from disk and git.
 *
 * The rules live elsewhere: what goes out and how is reviewSubmit.ts, the
 * threads are reviewThreads.ts, the storage is db/comments.ts.
 */

import { useEffect, useState } from 'react';
import type { Task } from '../types';
import { listGithubDrafts, markDraftsPosted, moveComment, onCommentsChanged, relocate, type ReviewComment } from '../db/comments';
import { parsePrUrl, type PrRef } from '../git/reviewCheckout';
import { git, gitOk, taskBase } from '../git/worktree';
import { gh } from '../gh/gh';
import { getPrStatus } from '../gh/prStore';
import { detectStackBase } from '../git/stackBase';
import { measuredBase } from './mergeTarget';
import { parseDiffRanges, type DiffRanges, type GithubDraft, type SubmitIo } from '../gh/reviewSubmit';

export type ReviewTask = Pick<Task, 'id' | 'reviewUrl' | 'worktreePath' | 'baseBranch' | 'kind' | 'branch'>;

/** The PR a review task is for; null for any other task. */
export function reviewPr(task: Pick<Task, 'reviewUrl'> | null | undefined): PrRef | null {
  return task?.reviewUrl ? parsePrUrl(task.reviewUrl) : null;
}

// ---------------------------------------------------------------------------
// The PR's diff, as GitHub takes comments on it
// ---------------------------------------------------------------------------

/**
 * What a review task is measured against (#237): `measuredBase`'s order --
 * the PR's base when gh has one, then a stack parent, then the stored base
 * -- as the Guide and the Files pane measure it, so a card and the Guide
 * never disagree about what is in the diff.
 */
export async function reviewBase(task: ReviewTask): Promise<string> {
  const pr = getPrStatus(task.id) ?? null;
  const stack = task.branch ? await detectStackBase(task.worktreePath, task.branch, task.baseBranch).catch(() => null) : null;
  return measuredBase({ kind: task.kind, branch: task.branch, baseBranch: task.baseBranch }, pr, stack);
}

/**
 * The new-side ranges of `git diff -U3 -M <merge-base> HEAD`: the PR as
 * GitHub diffs it (three lines of context, renames found), against
 * {@link reviewBase}. Null when the base cannot be found -- then nothing is
 * judged outside the diff, and GitHub has the last word.
 */
export async function prDiffRanges(task: ReviewTask): Promise<DiffRanges | null> {
  const base = await taskBase(task.worktreePath, await reviewBase(task));
  if (!base) return null;
  const r = await git(['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-U3', '-M', base, 'HEAD'], task.worktreePath);
  return r.code === 0 ? parseDiffRanges(r.stdout) : null;
}

/** Many diffs in the Guide ask at once: one git diff per worktree, kept briefly. */
const RANGES_TTL_MS = 30_000;
const rangesCache = new Map<string, { at: number; p: Promise<DiffRanges | null> }>();

function rangesKey(task: ReviewTask): string {
  return `${task.id}\n${task.worktreePath}\n${task.baseBranch}`;
}

function cachedRanges(task: ReviewTask): Promise<DiffRanges | null> {
  const key = rangesKey(task);
  const hit = rangesCache.get(key);
  if (hit && Date.now() - hit.at < RANGES_TTL_MS) return hit.p;
  const p = prDiffRanges(task).catch(() => null);
  rangesCache.set(key, { at: Date.now(), p });
  return p;
}

/** @internal */
export function clearRangesCacheForTests(): void {
  rangesCache.clear();
}

/** The PR's diff ranges for a review task's cards; null elsewhere, or until known. */
export function usePrRanges(task: ReviewTask | null | undefined): DiffRanges | null {
  const review = !!task?.reviewUrl;
  const key = task ? rangesKey(task) : '';
  const [ranges, setRanges] = useState<{ key: string; value: DiffRanges | null } | null>(null);
  useEffect(() => {
    if (!review || !task?.worktreePath) return;
    let live = true;
    void cachedRanges(task).then((value) => {
      if (live) setRanges({ key, value });
    });
    return () => {
      live = false;
    };
    // The key carries everything the diff reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review, key]);
  // Null until known, and null when unknown: either way nothing is judged
  // outside the diff, as the dialog does.
  return review && ranges?.key === key ? ranges.value : null;
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

/** A review task's unsent drafts for GitHub, line comments and replies, kept current. Empty for other tasks. */
export function useGithubDrafts(task: Pick<Task, 'id' | 'reviewUrl'> | null | undefined): readonly ReviewComment[] {
  const id = task?.reviewUrl ? task.id : null;
  const [rows, setRows] = useState<{ id: number | null; rows: readonly ReviewComment[] }>({ id: null, rows: [] });
  useEffect(() => {
    if (id === null) return;
    let live = true;
    const load = () =>
      void listGithubDrafts(id).then(
        (r) => {
          if (live) setRows({ id, rows: r });
        },
        (err: unknown) => console.warn('[review] could not load the drafts', err),
      );
    load();
    const off = onCommentsChanged((t) => {
      if (t === id) load();
    });
    return () => {
      live = false;
      off();
    };
  }, [id]);
  return rows.id === id && id !== null ? rows.rows : NONE;
}

const NONE: readonly ReviewComment[] = [];

async function localCommitCount(task: ReviewTask): Promise<number | null> {
  const base = await taskBase(task.worktreePath, await reviewBase(task)).catch(() => null);
  if (!base) return null;
  const r = await git(['rev-list', '--count', `${base}..HEAD`], task.worktreePath);
  const n = Number(r.stdout.trim());
  return r.code === 0 && Number.isInteger(n) ? n : null;
}

/** A file at HEAD, or null when HEAD has no such file. */
async function fileAtHead(worktreePath: string, path: string): Promise<string | null> {
  const r = await git(['show', `HEAD:${path}`], worktreePath);
  return r.code === 0 ? r.stdout : null;
}

export interface SubmitInput {
  drafts: GithubDraft[];
  /** Line drafts whose code is no longer at HEAD: sent in the summary, at their last line. */
  lost: number;
  /** Null: the base could not be found, so nothing is judged outside the diff (GitHub decides). */
  ranges: DiffRanges | null;
  commitId: string;
  /** Commits on this copy ahead of its base, for "N new commits" when GitHub has more; null when unknown. */
  localCommits: number | null;
}

/**
 * What Submit Review sends, read fresh: the drafts, each line draft found
 * again in its file at HEAD (by its text, as the cards place it), the PR's
 * diff, and the commit checked out -- the one reviewed.
 */
export async function prepareSubmit(task: ReviewTask): Promise<SubmitInput> {
  const rows = await listGithubDrafts(task.id);
  const commitId = (await gitOk(['rev-parse', 'HEAD'], task.worktreePath)).trim();
  const ranges = await prDiffRanges(task);
  const texts = new Map<string, string | null>();
  let lost = 0;
  const drafts: GithubDraft[] = [];
  for (const c of rows) {
    const d: GithubDraft = { id: c.id, path: c.path, lineStart: c.lineStart, lineEnd: c.lineEnd, body: c.body, replyTo: c.replyTo };
    if (c.replyTo === null) {
      if (!texts.has(c.path)) texts.set(c.path, await fileAtHead(task.worktreePath, c.path));
      const text = texts.get(c.path) ?? null;
      const at = text === null ? null : relocate(c, text);
      if (at && at.state === 'current') {
        if (at.lineStart !== c.lineStart || at.lineEnd !== c.lineEnd) {
          d.lineStart = at.lineStart;
          d.lineEnd = at.lineEnd;
          void moveComment(task.id, c.id, at.lineStart, at.lineEnd).catch(() => {});
        }
      } else {
        // Its code is gone: never pinned to whatever is at its old line. It
        // goes in the summary, named by where it was.
        d.lost = true;
        lost += 1;
      }
    }
    drafts.push(d);
  }
  return { drafts, lost, ranges, commitId, localCommits: await localCommitCount(task) };
}

// ---------------------------------------------------------------------------
// The real io for submitReview
// ---------------------------------------------------------------------------

async function reviewsDir(): Promise<string> {
  const { homeDir } = await import('@tauri-apps/api/path');
  return `${(await homeDir()).replace(/\/+$/, '')}/.albedo/reviews`;
}

export function submitIo(task: ReviewTask): SubmitIo {
  return {
    gh: (args) => gh(args, task.worktreePath),
    writeInput: async (json) => {
      const { mkdir, writeTextFile } = await import('@tauri-apps/plugin-fs');
      const dir = await reviewsDir();
      await mkdir(dir, { recursive: true });
      const path = `${dir}/review-${task.id}.json`;
      // Yours alone: 0600 when the file is made (mode applies on creation;
      // the file is emptied after each request, never deleted).
      await writeTextFile(path, json, { mode: 0o600 });
      return path;
    },
    clearInput: async (path) => {
      const { writeTextFile } = await import('@tauri-apps/plugin-fs');
      await writeTextFile(path, '');
    },
    markSent: (ids) => markDraftsPosted(task.id, ids),
  };
}
