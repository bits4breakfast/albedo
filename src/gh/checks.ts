/**
 * A pull request's checks in detail: each job's steps, and why a failing one
 * failed. The Checks dialog's data, derived from four `gh` answers:
 *
 *   gh pr checks <n> --json ...           one entry per check (reruns collapsed)
 *   gh run view <run> --json jobs         a job's steps, with state and times
 *   gh api .../actions/jobs/<job>/logs    a job's raw log
 *   gh api .../check-runs/<id>/annotations  file, line and message
 *
 * Pure, like prStatus.ts: `gh.ts` runs the commands and hands stdout here, so
 * every decision can be pinned with captured output (src/gh/fixtures).
 *
 * The per-job log endpoint, not `gh run view --log-failed`: measured on gh
 * 2.97, `--log-failed` refuses ("run ... is still in progress") until the
 * whole RUN completes, while the endpoint serves a job's log as soon as that
 * job does -- and a failed job in a run that is still going is exactly when
 * someone is waiting on the answer.
 *
 * Log text is untrusted: it is cleaned to plain text here (no ANSI, no
 * runner markers) and only ever rendered as text.
 */

import type { CheckLine } from './prStatus';

// ---------------------------------------------------------------------------
// gh pr checks
// ---------------------------------------------------------------------------

/** gh's `bucket`, with its two odd words made plain. */
export type CheckState = 'fail' | 'pending' | 'pass' | 'skipped' | 'cancelled';

/**
 * Where a check's details live, read off its link:
 *   - `actions`: a GitHub Actions job (`/actions/runs/<run>/job/<job>`) --
 *     steps, log and annotations,
 *   - `check-run`: another app's check run on GitHub (`/<o>/<r>/runs/<id>`),
 *     CodeQL for one -- annotations only,
 *   - `external`: anything else, a status from another host or a whole run in
 *     another repository -- a link and nothing more.
 */
export type CheckSource =
  | { kind: 'actions'; host: string; repo: string; runId: string; jobId: string }
  | { kind: 'check-run'; host: string; repo: string; id: string }
  | { kind: 'external'; host: string | null };

export interface PrCheck {
  /** "CI / linux": workflow and job, as the badge's tooltip names it. */
  name: string;
  state: CheckState;
  startedAt: string | null;
  completedAt: string | null;
  link: string | null;
  description: string;
  source: CheckSource;
}

const STATE_OF_BUCKET: Record<string, CheckState> = {
  fail: 'fail',
  pending: 'pending',
  pass: 'pass',
  skipping: 'skipped',
  cancel: 'cancelled',
};

/** Failing first: it is the reason the dialog was opened. */
const STATE_ORDER: Record<CheckState, number> = { fail: 0, pending: 1, cancelled: 2, pass: 3, skipped: 4 };

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** GitHub's "not yet": the zero time, which gh passes through as a date. */
export function timeOrNull(v: unknown): string | null {
  const s = str(v);
  if (!s || s.startsWith('0001-')) return null;
  return Number.isFinite(Date.parse(s)) ? s : null;
}

const ACTIONS_JOB = /^\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)\/?$/;
const CHECK_RUN = /^\/([^/]+\/[^/]+)\/runs\/(\d+)\/?$/;

/** Read a check's link for where its details are. Exported for tests. */
export function checkSource(link: string | null): CheckSource {
  if (!link) return { kind: 'external', host: null };
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return { kind: 'external', host: null };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { kind: 'external', host: null };
  const job = ACTIONS_JOB.exec(u.pathname);
  if (job) return { kind: 'actions', host: u.host, repo: job[1]!, runId: job[2]!, jobId: job[3]! };
  const run = CHECK_RUN.exec(u.pathname);
  if (run) return { kind: 'check-run', host: u.host, repo: run[1]!, id: run[2]! };
  return { kind: 'external', host: u.host };
}

/**
 * Parse `gh pr checks --json bucket,completedAt,description,link,name,
 * startedAt,workflow`. Null for anything that is not a list -- "cannot tell",
 * never "no checks".
 */
export function parsePrChecks(stdout: string): PrCheck[] | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  const out: PrCheck[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    const job = str(e.name) ?? 'check';
    const workflow = str(e.workflow);
    const link = str(e.link);
    out.push({
      name: workflow ? `${workflow} / ${job}` : job,
      // A bucket gh adds later reads as running: never a false green.
      state: STATE_OF_BUCKET[str(e.bucket) ?? ''] ?? 'pending',
      startedAt: timeOrNull(e.startedAt),
      completedAt: timeOrNull(e.completedAt),
      link,
      description: str(e.description) ?? '',
      source: checkSource(link),
    });
  }
  return out.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.name.localeCompare(b.name));
}

/**
 * The badge's own lines as checks, to draw the dialog at once while
 * `gh pr checks` is asked for the times. Same names, same order rule.
 */
export function checksFromLines(lines: CheckLine[]): PrCheck[] {
  return lines
    .map((l) => ({
      name: l.name,
      state: l.bucket,
      startedAt: null,
      completedAt: null,
      link: l.url,
      description: '',
      source: checkSource(l.url),
    }))
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// gh run view --json jobs
// ---------------------------------------------------------------------------

export type StepState = 'pass' | 'fail' | 'running' | 'pending' | 'skipped' | 'cancelled';

export interface JobStep {
  number: number;
  name: string;
  state: StepState;
  startedAt: string | null;
  completedAt: string | null;
}

export interface JobDetail {
  id: string;
  name: string;
  state: StepState;
  /** True once the job has finished: its steps and log will not change. */
  completed: boolean;
  url: string | null;
  steps: JobStep[];
}

function stepState(status: unknown, conclusion: unknown): StepState {
  const s = str(status)?.toLowerCase();
  if (s === 'in_progress') return 'running';
  if (s !== 'completed') return 'pending'; // queued, waiting, pending
  switch (str(conclusion)?.toLowerCase()) {
    case 'success':
      return 'pass';
    case 'skipped':
    case 'neutral':
      return 'skipped';
    case 'cancelled':
      return 'cancelled';
    default:
      // failure, timed_out, or a word we do not know: the safe direction.
      return 'fail';
  }
}

/** Parse `gh run view <run> --json jobs` and pick one job. Null when it is not there. */
export function parseRunJob(stdout: string, jobId: string): JobDetail | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  const jobs = (data as { jobs?: unknown } | null)?.jobs;
  if (!Array.isArray(jobs)) return null;
  const raw = jobs.find((j) => j && typeof j === 'object' && String((j as Record<string, unknown>).databaseId) === jobId);
  if (!raw) return null;
  const j = raw as Record<string, unknown>;
  const steps: JobStep[] = [];
  for (const s of Array.isArray(j.steps) ? j.steps : []) {
    if (!s || typeof s !== 'object') continue;
    const r = s as Record<string, unknown>;
    if (typeof r.number !== 'number') continue;
    steps.push({
      number: r.number,
      name: str(r.name) ?? `Step ${r.number}`,
      state: stepState(r.status, r.conclusion),
      startedAt: timeOrNull(r.startedAt),
      completedAt: timeOrNull(r.completedAt),
    });
  }
  const state = stepState(j.status, j.conclusion);
  return {
    id: jobId,
    name: str(j.name) ?? '',
    state,
    completed: state !== 'running' && state !== 'pending',
    url: str(j.url),
    steps: steps.sort((a, b) => a.number - b.number),
  };
}

/** The step to explain: the first that failed. Null when none did (a setup failure, say). */
export function failedStep(job: JobDetail): JobStep | null {
  return job.steps.find((s) => s.state === 'fail') ?? null;
}

// ---------------------------------------------------------------------------
// The job log
// ---------------------------------------------------------------------------

/*
 * A job log is one file for every step, each line prefixed with its time:
 *
 *   2026-10-23T10:11:47.2690954Z ##[group]Run npx vitest run
 *   2026-10-23T10:11:47.2691226Z <ESC>[36;1mnpx vitest run<ESC>[0m
 *   ...                           shell:, env: -- the step's own header
 *   2026-10-23T10:11:47.2756433Z ##[endgroup]
 *   ...                           the step's output
 *   2026-10-23T10:12:17.5778779Z ##[error]AssertionError: expected ...
 *   Expected: "sent"              <- a multi-line message: no timestamp
 *   2026-10-23T10:12:17.6225497Z ##[error]Process completed with exit code 1.
 *   2026-10-23T10:12:17.6337406Z Post job cleanup.
 *
 * `##[group]` does NOT mark steps: an action opens several of its own groups
 * ("Cache Configuration"), and a named step's group carries its command, not
 * its name. What does mark a step is time: `gh run view --json jobs` gives
 * each step's start and end, to the second. So a step is the first `##[group]`
 * from its start second on, through its last `##[error]` before its end second
 * is over -- the error line ends a failed step, and stops the post-job
 * cleanup that follows in the same second from reading as its output.
 */

const TS = /^\uFEFF?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) ?/;
// CSI sequences (colours, cursor), OSC sequences (titles, links), and any
// other lone escape. The log is rendered as text; none of these mean anything.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;
const DROPPED_MARKER = /^##\[(?:endgroup|start-action|end-action|debug)\b/;
/** A group's title reads as a line of its own; the markers around words become words. */
const WORD_MARKER = /^##\[(group|error|warning|notice)\]/;
const MARKER_WORD: Record<string, string> = { group: '', error: 'Error: ', warning: 'Warning: ', notice: 'Notice: ' };

/** A line longer than this is minified output or a data dump: cut, so one line cannot fill the excerpt. */
export const MAX_LINE_CHARS = 400;

interface LogLine {
  /** Seconds since the epoch; a line without a stamp takes the one before it. */
  at: number;
  /** False for the continuation of a multi-line message. */
  stamped: boolean;
  /** The line after its timestamp, otherwise untouched. */
  text: string;
}

function readLog(log: string): LogLine[] {
  const out: LogLine[] = [];
  let at = 0;
  for (const raw of log.split(/\r?\n/)) {
    const m = TS.exec(raw);
    if (m) {
      const ms = Date.parse(m[1]!);
      if (Number.isFinite(ms)) at = Math.floor(ms / 1000);
      out.push({ at, stamped: true, text: raw.slice(m[0].length) });
    } else {
      out.push({ at, stamped: false, text: raw.replace(/^\uFEFF/, '') });
    }
  }
  return out;
}

/** One log line as plain text, or null for a runner marker that says nothing to a reader. */
export function cleanLogLine(text: string): string | null {
  let t = text.replace(ANSI, '').replace(CONTROL, '');
  if (DROPPED_MARKER.test(t)) return null;
  t = t.replace(WORD_MARKER, (_, w: string) => MARKER_WORD[w] ?? '');
  return t.length > MAX_LINE_CHARS ? `${t.slice(0, MAX_LINE_CHARS)}…` : t;
}

function seconds(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * The lines of one step, cleaned -- or of the whole job when `step` is null or
 * its times are unknown. Either ends at its last error and that error's
 * message. The step's opening group (its command and env) is left out: the
 * step's name already says what ran.
 */
export function stepLog(log: string, step: Pick<JobStep, 'startedAt' | 'completedAt'> | null): string[] {
  const lines = readLog(log);
  const at = (i: number): LogLine => lines[i]!;
  let from = 0;
  let to = lines.length; // exclusive
  const start = seconds(step?.startedAt ?? null);
  const end = seconds(step?.completedAt ?? null);
  if (start !== null && end !== null) {
    from = lines.findIndex((l) => l.at >= start && l.text.startsWith('##[group]'));
    if (from < 0) return [];
    to = from + 1;
    while (to < lines.length && at(to).at <= end) to++;
    const close = lines.findIndex((l, i) => i > from && i < to && l.text.startsWith('##[endgroup]'));
    if (close > 0) from = close + 1;
  }
  let lastError = -1;
  for (let i = from; i < to; i++) if (at(i).text.startsWith('##[error]')) lastError = i;
  if (lastError >= 0) {
    // The error and the unstamped lines of its message.
    to = lastError + 1;
    while (to < lines.length && !at(to).stamped) to++;
  }
  const out: string[] = [];
  for (let i = from; i < to; i++) {
    const t = cleanLogLine(at(i).text);
    if (t !== null) out.push(t);
  }
  while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
  return out;
}

/*
 * How much of the log to keep. The tail, because a failing step's last lines
 * are its verdict: on this repo's failed vitest run the step logged 317
 * lines, and its three assertion diffs and the exit line are the last 80.
 *   - The dialog shows 40: the reason, readable without scrolling the dialog
 *     (its list is at most ~600px tall, about 35 rows of --fs-sm mono).
 *   - The prompt carries up to 120 lines and 12,000 characters, about 3k
 *     tokens: room for several failures' diffs, and still a small part of a
 *     session's context. A whole job log is 150 KB here and megabytes
 *     elsewhere; pasting that would cost more context than the fix.
 */
export const VIEW_TAIL_LINES = 40;
export const PROMPT_TAIL_LINES = 120;
export const PROMPT_MAX_CHARS = 12_000;

/** The last `maxLines` lines, and no more than `maxChars` characters of them. */
export function tailLines(lines: string[], maxLines: number, maxChars = Infinity): { lines: string[]; cut: boolean } {
  const out: string[] = [];
  let chars = 0;
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const line = lines[i]!;
    chars += line.length + 1;
    if (chars > maxChars) break;
    out.unshift(line);
  }
  return { lines: out, cut: out.length < lines.length };
}

/**
 * The lines that explain a failed job: its failed step's, or, when no step
 * failed or the step has no output of its own, the whole job's.
 */
export function failureLines(log: string, job: JobDetail): string[] {
  const step = failedStep(job);
  const own = step ? stepLog(log, step) : [];
  return own.length > 0 ? own : stepLog(log, null);
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

export interface Annotation {
  path: string;
  line: number | null;
  level: 'failure' | 'warning';
  /** The message's first line; the rest repeats what the log already shows. */
  message: string;
}

/**
 * Parse `gh api repos/{o}/{r}/check-runs/{id}/annotations`. Failures first,
 * then warnings; notices are left out. So are the runner's own, which it files
 * against the path `.github` ("Process completed with exit code 1", Node
 * deprecations): they point at no file and say nothing the step does not.
 */
export function parseAnnotations(stdout: string): Annotation[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: Annotation[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const a = raw as Record<string, unknown>;
    const path = str(a.path);
    const level = str(a.annotation_level);
    if (!path || path === '.github' || (level !== 'failure' && level !== 'warning')) continue;
    const message = (str(a.message) ?? str(a.title) ?? '')
      .split('\n')
      .map((l) => cleanLogLine(l) ?? '')
      .find((l) => l.trim() !== '')
      ?.trim();
    out.push({
      path,
      line: typeof a.start_line === 'number' && a.start_line > 0 ? a.start_line : null,
      level,
      message: message ?? '',
    });
  }
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'failure' ? -1 : 1));
}

/** `path:line`, as an editor and a terminal both read it. */
export function annotationPlace(a: Pick<Annotation, 'path' | 'line'>): string {
  return a.line === null ? a.path : `${a.path}:${a.line}`;
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

export interface FixPromptInput {
  prNumber: number;
  check: string;
  /** The failed step's name; null when no step failed. */
  step: string | null;
  url: string | null;
  /** The cleaned failure lines, untrimmed: the prompt takes its own tail. */
  log: string[] | null;
  annotations: Annotation[];
}

/** A fence longer than any run of backticks in the text, so the log cannot close it. */
function fenceFor(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * What *Ask Claude to Fix* puts in the message box: the check, the step, the
 * run, the annotations and the log's tail -- what Claude would otherwise go
 * and dig out of GitHub itself.
 */
export function fixPrompt(input: FixPromptInput): string {
  const where = input.step ? `, at the step "${input.step}"` : '';
  const out = [`The CI check "${input.check}" failed on pull request #${input.prNumber}${where}.`];
  if (input.url) out.push(`Run: ${input.url}`);
  if (input.annotations.length > 0) {
    out.push('', 'Annotations:');
    for (const a of input.annotations) out.push(`- ${annotationPlace(a)} ${a.message}`.trimEnd());
  }
  if (input.log && input.log.length > 0) {
    const tail = tailLines(input.log, PROMPT_TAIL_LINES, PROMPT_MAX_CHARS);
    const body = tail.lines.join('\n');
    const fence = fenceFor(body);
    const what = input.step ? 'step' : 'job';
    out.push(
      '',
      tail.cut ? `The last ${tail.lines.length} lines of the ${what}'s log:` : `The ${what}'s log:`,
      fence,
      body,
      fence,
    );
  } else {
    out.push('', 'Its log could not be read; the run link has it.');
  }
  out.push('', 'Find the cause and fix it.');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** "41s", "2m 14s", "1h 3m". Seconds are dropped once there are hours. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * What a check or step row says about time: how long it took, how long it has
 * been running, or why there is no time.
 */
export function timeLabel(
  item: { state: CheckState | StepState; startedAt: string | null; completedAt: string | null },
  now: number,
): string {
  if (item.state === 'skipped') return 'Skipped';
  const start = item.startedAt ? Date.parse(item.startedAt) : NaN;
  if (item.state === 'pending' || item.state === 'running') {
    if (!Number.isFinite(start)) return item.state === 'running' ? 'Running' : 'Pending';
    return `Running ${formatDuration(now - start)}`;
  }
  const end = item.completedAt ? Date.parse(item.completedAt) : NaN;
  // Skipped and cancelled entries can carry an end before their start.
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return item.state === 'cancelled' ? 'Cancelled' : '';
  return formatDuration(end - start);
}
