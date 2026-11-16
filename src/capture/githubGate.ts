/**
 * A review task's session asking about its GitHub comments (#427): the four
 * GitHub tools of Albedo's MCP server, answered here.
 *
 * ## A narrow widening, by the owner's decision
 *
 * CLAUDE.md, "Two channels". On a review task -- a pull request opened in
 * Albedo to review -- the session may:
 *
 *   list_github_drafts       the user's GitHub Drafts not yet submitted
 *   delete_github_draft(id)  remove one; shown in the task with Undo
 *   list_posted_comments     the user's own review comments on the PR
 *   delete_posted_comment    ask; deleted on GitHub only from a click
 *
 * and nothing else: no adding, editing or submitting drafts, and nobody
 * else's comments. Only the calling session's task, which is the inbox
 * file's (the id Albedo put in the server's environment), never anything in
 * the request.
 *
 * ## The pipe
 *
 *   the agent calls mcp__albedo__<tool>
 *     albedo-mcp appends a line to ~/.albedo/inbox/task-<id>.jsonl, and WAITS
 *       inbox.ts hands it here
 *         this module writes ~/.albedo/previews/answer-<task>-<req>.json
 *           albedo-mcp reads it, deletes it, and returns it as the result
 *
 * The answer files are a preview's (previewGate.ts): same folder, same name,
 * one per request. The first three are answered at once, with no click, and
 * only while the call can still be waiting: the server gives up after
 * `APP_ANSWER_TIMEOUT_MS` (30 s), and a line older than {@link ACT_WINDOW_MS}
 * -- half that -- is never acted on, so a call that timed out changed
 * nothing. `delete_posted_comment` waits for the user, as a preview does:
 * its card ("Waiting on You · Delete a comment on GitHub?") is the only
 * thing that deletes anything on GitHub, and only while that exact call
 * still waits.
 *
 * ## GitHub
 *
 * Through `gh`, as the rest of the review does (reviewThreads.ts reads,
 * reviewSubmit.ts posts). A comment is deleted only when GitHub says, right
 * before the delete, that its author is the signed-in user and that it is on
 * this task's PR: asked once when the card is made, and again on the click.
 */

import { homeDir } from '@tauri-apps/api/path';
import { mkdir, rename, writeTextFile } from '@tauri-apps/plugin-fs';
import type { Task } from '../types';
import { commentLocation, deleteComment, listGithubDrafts, sideOf, type ReviewComment } from '../db/comments';
import { parsePrUrl, type PrRef } from '../git/reviewCheckout';
import { gh, ghMessage, loadViewerLogin } from '../gh/gh';
import { isDraftBeingEdited, noteDraftRemoved } from './draftRemovals';
import { ALBEDO_DIR } from './hookEvents';
import { onGithubLine, type GithubLine } from './inbox';
import { MAX_ANSWER_CHARS, previewAnswerFileName } from './previewGate';

/** A delete call's line: a draft's, or a posted comment's. */
type DeleteLine = Extract<GithubLine, { commentId: number }>;

/** Lines older than this are never acted on: half the server's 30 s wait. */
export const ACT_WINDOW_MS = 15_000;

/** What a GitHub tool's answer needs to know about the task. */
export type GateTask = Pick<Task, 'id' | 'reviewUrl' | 'worktreePath' | 'status'>;

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export interface Answer {
  text: string;
  isError: boolean;
}

const ok = (text: string): Answer => ({ text, isError: false });
const refuse = (text: string): Answer => ({ text, isError: true });

const NOT_REVIEW =
  'This task is not a review of a pull request, so it has no GitHub Drafts or PR comments. These tools work only in a review task.';

/** Cut to `max` characters, saying so. */
function clip(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, max).join('')}… (cut, ${chars.length} characters in all)`;
}

/**
 * Items as JSON within the answer's cap: whole items while they fit, then a
 * count of those left out. Never a cut in the middle of one.
 */
function fitted<T>(head: Record<string, unknown>, key: string, items: readonly T[]): string {
  const budget = MAX_ANSWER_CHARS - 200;
  let n = items.length;
  for (;;) {
    const body = { ...head, [key]: items.slice(0, n), ...(n < items.length ? { leftOut: items.length - n } : {}) };
    const text = JSON.stringify(body, null, 1);
    if (text.length <= budget || n === 0) return text;
    n = Math.max(0, Math.floor(n * 0.8));
  }
}

/** The drafts, as `list_github_drafts` gives them. Pure. */
export function draftsAnswer(pr: PrRef, drafts: readonly ReviewComment[]): string {
  const items = drafts.map((d) => ({
    id: d.id,
    path: d.path,
    side: sideOf(d),
    lines: [d.lineStart, d.lineEnd],
    ...(d.replyTo === null ? { code: clip(d.anchorText, 2_000) } : { replyTo: d.replyTo }),
    body: clip(d.body, 4_000),
  }));
  return fitted({ pr: `${pr.owner}/${pr.repo}#${pr.number}` }, 'drafts', items);
}

// ---------------------------------------------------------------------------
// GitHub's side: the user's own comments on the PR
// ---------------------------------------------------------------------------

export interface PostedComment {
  id: number;
  author: string | null;
  path: string;
  /** On the PR's current diff; null when GitHub has it outdated (then `originalLine`). */
  line: number | null;
  originalLine: number | null;
  side: 'LEFT' | 'RIGHT';
  body: string;
  createdAt: number;
  url: string | null;
  inReplyTo: number | null;
  /** The API url of the PR it is on, when GitHub said. */
  prApiUrl: string | null;
}

/** The fields kept, one JSON object per comment (what `gh --jq` prints, page by page). */
const COMMENT_JQ =
  '{id, author: .user.login, path, line, original_line, side, body, created_at, html_url, in_reply_to_id, pull_request_url}';

function posInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null;
}

/** One comment as `COMMENT_JQ` prints it; null when it is not one. */
export function parsePosted(v: unknown): PostedComment | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const id = posInt(o.id);
  if (id === null || typeof o.path !== 'string') return null;
  const at = typeof o.created_at === 'string' ? Date.parse(o.created_at) : NaN;
  return {
    id,
    author: typeof o.author === 'string' ? o.author : null,
    path: o.path,
    line: posInt(o.line),
    originalLine: posInt(o.original_line),
    side: o.side === 'LEFT' ? 'LEFT' : 'RIGHT',
    body: typeof o.body === 'string' ? o.body : '',
    createdAt: Number.isFinite(at) ? at : 0,
    url: typeof o.html_url === 'string' ? o.html_url : null,
    inReplyTo: posInt(o.in_reply_to_id),
    prApiUrl: typeof o.pull_request_url === 'string' ? o.pull_request_url : null,
  };
}

/** Each line of gh's output that is a comment. */
export function parsePostedLines(stdout: string): PostedComment[] {
  const out: PostedComment[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const c = parsePosted(JSON.parse(line));
      if (c) out.push(c);
    } catch {
      /* not a comment */
    }
  }
  return out;
}

function sameLogin(a: string | null, b: string): boolean {
  return a !== null && a.toLowerCase() === b.toLowerCase();
}

/** Whether GitHub's own record puts the comment on this PR. */
export function onThisPr(c: Pick<PostedComment, 'prApiUrl'>, pr: PrRef): boolean {
  if (c.prApiUrl === null) return false;
  const want = `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`.toLowerCase();
  return c.prApiUrl.toLowerCase().replace(/\/+$/, '').endsWith(want);
}

function hostArgs(pr: PrRef): string[] {
  return pr.host === 'github.com' ? [] : ['--hostname', pr.host];
}

function repoPath(pr: PrRef): string {
  return `repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}`;
}

/** The posted-comments answer. Pure. */
export function postedAnswer(pr: PrRef, login: string, comments: readonly PostedComment[]): string {
  const items = comments.map((c) => ({
    id: c.id,
    path: c.path,
    line: c.line ?? c.originalLine,
    ...(c.line === null ? { outdated: true } : {}),
    side: c.side,
    body: clip(c.body, 4_000),
    createdAt: c.createdAt > 0 ? new Date(c.createdAt).toISOString() : null,
    url: c.url,
    ...(c.inReplyTo !== null ? { inReplyTo: c.inReplyTo } : {}),
  }));
  return fitted({ pr: `${pr.owner}/${pr.repo}#${pr.number}`, author: login }, 'comments', items);
}

/** One comment, fresh from GitHub; a sentence for the session when it cannot be had. */
async function fetchComment(pr: PrRef, id: number, cwd: string): Promise<PostedComment | string> {
  const r = await gh(['api', ...hostArgs(pr), `${repoPath(pr)}/pulls/comments/${id}`, '--jq', COMMENT_JQ], cwd).catch(() => null);
  if (!r) return 'GitHub CLI (gh) could not be run.';
  if (r.code !== 0) return /\b404\b|Not Found/i.test(r.stderr) ? `GitHub has no review comment ${id}.` : ghMessage(r);
  return parsePostedLines(r.stdout)[0] ?? `GitHub did not return review comment ${id}.`;
}

/**
 * Whether the user may have this comment deleted: theirs, on this PR. The
 * comment when so, else why not, in a sentence for the session.
 */
async function checkOwn(pr: PrRef, id: number, cwd: string): Promise<PostedComment | string> {
  const login = await loadViewerLogin();
  if (login === null) return 'Albedo could not tell which GitHub user is signed in to gh, so it cannot check whose comment this is. Nothing was deleted.';
  const c = await fetchComment(pr, id, cwd);
  if (typeof c === 'string') return `${c} Nothing was deleted.`;
  if (!onThisPr(c, pr)) return `Comment ${id} is not on this task's pull request (#${pr.number}). Nothing was deleted.`;
  if (!sameLogin(c.author, login)) return `Comment ${id} was written by ${c.author ?? 'someone else'}, not by ${login}. Only the user's own comments can be deleted. Nothing was deleted.`;
  return c;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/** A posted comment the session asked to delete, waiting on the user. */
export interface PendingDeletion {
  /** The call's line id: its answer file's name. */
  requestId: string;
  taskId: number;
  pr: PrRef;
  comment: PostedComment;
  reason: string | null;
  /** When the session asked. */
  at: number;
  /** The task's worktree, where gh runs. */
  cwd: string;
}

let taskOf: (id: number) => GateTask | null = () => null;
let started = false;
let startedAt = 0;
let unsubscribe: (() => void) | null = null;
let cachedHome: string | null = null;
const waiting = new Map<string, PendingDeletion>();
/** Requests the server said ended: never answered or acted on after. */
const over = new Set<string>();
const listeners = new Set<(taskId: number) => void>();

function notify(taskId: number): void {
  for (const cb of [...listeners]) {
    try {
      cb(taskId);
    } catch {
      /* a broken subscriber must not stall the others */
    }
  }
}

/** Told when a task's waiting deletion appears or goes. */
export function onDeletionChange(cb: (taskId: number) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** The oldest deletion a task waits on, or null. Synchronous, from memory. */
export function pendingDeletion(taskId: number): PendingDeletion | null {
  let first: PendingDeletion | null = null;
  for (const d of waiting.values()) if (d.taskId === taskId && (first === null || d.at < first.at)) first = d;
  return first;
}

export function isDeletionWaiting(requestId: string): boolean {
  return waiting.has(requestId);
}

/** Every task with a deletion waiting on the user. */
export function tasksWaitingOnDeletion(): Set<number> {
  return new Set([...waiting.values()].map((d) => d.taskId));
}

function retire(requestId: string): void {
  const d = waiting.get(requestId);
  if (!d) return;
  waiting.delete(requestId);
  notify(d.taskId);
}

async function answersDir(): Promise<string> {
  if (cachedHome === null) cachedHome = (await homeDir()).replace(/\/+$/, '');
  return `${cachedHome}/${ALBEDO_DIR}/previews`;
}

/**
 * Write the answer the waiting server polls for: under a scratch name, then
 * renamed, so it never reads half of one. Not for a call that is over.
 */
async function writeAnswer(taskId: number, requestId: string, a: Answer): Promise<void> {
  if (over.has(requestId)) return;
  const dir = await answersDir();
  // The server makes it (owner-only) before it waits; this is the fallback.
  await mkdir(dir, { recursive: true });
  const final = `${dir}/${previewAnswerFileName(taskId, requestId)}`;
  const text = [...a.text].length > MAX_ANSWER_CHARS ? clip(a.text, MAX_ANSWER_CHARS - 100) : a.text;
  await writeTextFile(`${final}.part`, JSON.stringify(a.isError ? { text, isError: true } : { text }));
  await rename(`${final}.part`, final);
}

/** The task a line may act on: a review task's PR, or why not. */
function reviewOf(taskId: number): { task: GateTask; pr: PrRef } | Answer {
  const task = taskOf(taskId);
  if (!task || task.status === 'archived') return refuse('Albedo has no open task for this session.');
  const pr = task.reviewUrl ? parsePrUrl(task.reviewUrl) : null;
  return pr ? { task, pr } : refuse(NOT_REVIEW);
}

async function listDrafts(line: GithubLine): Promise<Answer> {
  const r = reviewOf(line.taskId);
  if ('text' in r) return r;
  return ok(draftsAnswer(r.pr, await listGithubDrafts(line.taskId)));
}

async function removeDraft(line: DeleteLine): Promise<Answer> {
  const r = reviewOf(line.taskId);
  if ('text' in r) return r;
  // Only this task's, only a draft still to be submitted.
  const row = (await listGithubDrafts(line.taskId)).find((d) => d.id === line.commentId);
  if (!row) {
    return refuse(
      `No GitHub Draft ${line.commentId} waits on this task: it was submitted or removed already, or is another task's. Call list_github_drafts for the current ones.`,
    );
  }
  // Open in an edit box: what the owner is typing must not vanish under them.
  if (isDraftBeingEdited(row.id)) {
    return refuse(`The owner is editing GitHub Draft ${row.id} right now; try again later. Nothing was removed.`);
  }
  await deleteComment(line.taskId, row.id);
  noteDraftRemoved({ row, reason: line.reason, at: Date.now() });
  return ok(
    `Removed GitHub Draft ${row.id} (${commentLocation(row)}). It had not been sent; the user sees what was removed, and can undo it.`,
  );
}

async function listPosted(line: GithubLine): Promise<Answer> {
  const r = reviewOf(line.taskId);
  if ('text' in r) return r;
  const login = await loadViewerLogin();
  if (login === null) return refuse('Albedo could not tell which GitHub user is signed in to gh, so it cannot tell which comments are theirs.');
  const res = await gh(
    ['api', ...hostArgs(r.pr), `${repoPath(r.pr)}/pulls/${r.pr.number}/comments?per_page=100`, '--paginate', '--jq', `.[] | ${COMMENT_JQ}`],
    r.task.worktreePath,
  ).catch(() => null);
  if (!res) return refuse('GitHub CLI (gh) could not be run.');
  if (res.code !== 0) return refuse(`GitHub did not list the comments: ${ghMessage(res)}`);
  const mine = parsePostedLines(res.stdout).filter((c) => sameLogin(c.author, login));
  return ok(postedAnswer(r.pr, login, mine));
}

/** A deletion asked for: checked, then a card. An answer now only when it cannot be asked. */
async function askDeletion(line: DeleteLine): Promise<Answer | null> {
  const r = reviewOf(line.taskId);
  if ('text' in r) return r;
  const c = await checkOwn(r.pr, line.commentId, r.task.worktreePath);
  if (typeof c === 'string') return refuse(c);
  if (over.has(line.id)) return null;
  waiting.set(line.id, {
    requestId: line.id,
    taskId: line.taskId,
    pr: r.pr,
    comment: c,
    reason: line.reason,
    at: line.at,
    cwd: r.task.worktreePath,
  });
  notify(line.taskId);
  return null;
}

async function handle(line: GithubLine): Promise<void> {
  if (line.tool === 'github_cancelled') {
    over.add(line.request);
    retire(line.request);
    return;
  }
  // From an earlier run: its session ended with that run, and its call too.
  if (line.at < startedAt) return;
  // The server stops waiting after 30 s; this acts only well inside that.
  if (line.tool !== 'delete_posted_comment' && Date.now() - line.at > ACT_WINDOW_MS) return;
  let answer: Answer | null;
  try {
    switch (line.tool) {
      case 'list_github_drafts':
        answer = await listDrafts(line);
        break;
      case 'delete_github_draft':
        answer = await removeDraft(line);
        break;
      case 'list_posted_comments':
        answer = await listPosted(line);
        break;
      case 'delete_posted_comment':
        answer = await askDeletion(line);
        break;
    }
  } catch (err) {
    answer = refuse(`Albedo could not do that: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (answer) await writeAnswer(line.taskId, line.id, answer);
}

/** One line at a time, in order: a cancel must follow the call it ends. */
let queue: Promise<void> = Promise.resolve();

function onLine(line: GithubLine): void {
  const work = () => handle(line).catch((err: unknown) => console.warn('[github] could not answer a session', err));
  queue = queue.then(work, work);
}

/** Resolves once every line handed over so far is handled. For tests. */
export function githubLinesSettled(): Promise<void> {
  return queue;
}

/**
 * Start answering. `lookup` finds a task by id, from the app's list. Call
 * before the inbox is read (inbox.ts `startInbox`). Idempotent; a later call
 * replaces the lookup.
 */
export function startGithubGate(lookup: (id: number) => GateTask | null, now = Date.now()): void {
  taskOf = lookup;
  if (started) return;
  started = true;
  startedAt = now;
  unsubscribe = onGithubLine(onLine);
}

/** The task's session is over (its pty exited): nothing of it waits. */
export function endTaskDeletions(taskId: number): void {
  for (const d of [...waiting.values()]) {
    if (d.taskId !== taskId) continue;
    over.add(d.requestId);
    retire(d.requestId);
  }
}

export type DeletionResult = 'deleted' | 'kept' | 'failed' | 'refused';

/** Deletions being answered now: a second click finds one here and does nothing. */
const answering = new Set<string>();

/** Whether the card's answer is on its way (the card says so, and takes no other). */
export function isDeletionAnswering(requestId: string): boolean {
  return answering.has(requestId);
}

/**
 * The user's answer on the card. Call only from a click. Keep It answers at
 * once; Delete on GitHub checks again that the comment is the user's and on
 * this PR, deletes it, and answers with what happened. Refused -- nothing
 * deleted -- when the call no longer waits, or stopped waiting meanwhile.
 * The card stays, saying so, until the answer is written.
 */
export async function answerDeletion(d: PendingDeletion, choice: 'delete' | 'keep'): Promise<DeletionResult> {
  if (!isDeletionWaiting(d.requestId) || answering.has(d.requestId)) return 'refused';
  answering.add(d.requestId);
  notify(d.taskId);
  try {
    const id = d.comment.id;
    let answer: Answer;
    let result: DeletionResult;
    if (choice === 'keep') {
      answer = ok(`The user kept comment ${id}. It was not deleted.`);
      result = 'kept';
    } else {
      const c = await checkOwn(d.pr, id, d.cwd);
      if (typeof c === 'string') {
        answer = refuse(c);
        result = 'failed';
      } else if (!isDeletionWaiting(d.requestId)) {
        // The call ended while GitHub was asked (Esc, or the session closed).
        return 'refused';
      } else {
        const r = await gh(['api', ...hostArgs(d.pr), '-X', 'DELETE', `${repoPath(d.pr)}/pulls/comments/${id}`], d.cwd).catch(() => null);
        if (r && r.code === 0) {
          answer = ok(`Deleted comment ${id} on GitHub, as the user approved.`);
          result = 'deleted';
        } else {
          answer = refuse(`The user approved, but GitHub did not delete comment ${id}: ${r ? ghMessage(r) : 'GitHub CLI (gh) could not be run.'}`);
          result = 'failed';
        }
      }
    }
    try {
      await writeAnswer(d.taskId, d.requestId, answer);
    } catch (err) {
      console.warn('[github] could not write the answer', err);
    }
    return result;
  } finally {
    answering.delete(d.requestId);
    retire(d.requestId);
  }
}

/** Test seam: a deletion waiting, as if a line GitHub vouched for had asked. */
export function __seedDeletionForTests(d: PendingDeletion): void {
  waiting.set(d.requestId, d);
  notify(d.taskId);
}

/** Test seam: forget everything. */
export function __resetGithubGate(): void {
  unsubscribe?.();
  unsubscribe = null;
  started = false;
  startedAt = 0;
  taskOf = () => null;
  waiting.clear();
  over.clear();
  answering.clear();
  listeners.clear();
  cachedHome = null;
  queue = Promise.resolve();
}
