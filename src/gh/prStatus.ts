/**
 * Pull-request status, derived from `gh pr view --json`.
 *
 * Pure: no spawning, no Tauri. `gh.ts` runs the command and hands the stdout
 * here, so every decision about what a PR "is" can be pinned with fixture JSON.
 *
 * This is a third channel, alongside the pty and the transcript: GitHub's own
 * JSON API, read through `gh`. It says nothing about the session -- it is
 * about the branch -- so it never touches `Message` or the transcript tables.
 */

export type PrState = 'open' | 'draft' | 'merged' | 'closed';

/**
 * One line of CI, after collapsing reruns. `skipped` covers SKIPPED and
 * NEUTRAL: GitHub counts both as "not blocking", and so does `gh pr checks`.
 */
export type CheckBucket = 'pass' | 'fail' | 'pending' | 'skipped';

export interface CheckLine {
  name: string;
  bucket: CheckBucket;
  url: string | null;
  /**
   * Why a `fail` line failed, when it was not a plain failure: "cancelled",
   * "timed out", ... Absent for a plain failure and for every other bucket.
   */
  reason?: string;
}

export type ChecksSummary =
  | { kind: 'none' }
  | { kind: 'passing'; total: number }
  | { kind: 'failing'; failing: number; total: number }
  | { kind: 'pending'; pending: number; total: number };

export type ReviewDecision = 'approved' | 'changes-requested' | 'review-required' | null;

export interface PrStatus {
  number: number;
  url: string;
  title: string;
  state: PrState;
  /** GitHub's own answer: the head ref the PR is from. */
  headRefName: string;
  /** The branch the PR merges into. Empty when gh did not say. */
  baseRefName: string;
  /**
   * The head commit the checks ran on (`headRefOid`). Empty when gh did not
   * say. A new one is a push: what was decided about the old checks is over.
   */
  headSha: string;
  mergedAt: string | null;
  review: ReviewDecision;
  checks: ChecksSummary;
  /** Every check after dedupe, failing first; the tooltip lists them. */
  lines: CheckLine[];
}

// ---------------------------------------------------------------------------
// statusCheckRollup
// ---------------------------------------------------------------------------

/*
 * The rollup is a union, and `gh` passes it through with `__typename`:
 *
 *   CheckRun       { name, workflowName, status, conclusion, startedAt,
 *                    completedAt, detailsUrl }    -- GitHub Actions, Apps
 *   StatusContext  { context, state, startedAt?, createdAt?, targetUrl }
 *                                                 -- the legacy commit status API
 *
 * Reruns are NOT collapsed by GitHub: a re-triggered job appears once per run
 * (cli/cli #14722 lists `label-external` three times). Counting raw entries
 * would report "2 failing" for a job that failed once and then passed, which is
 * exactly the moment the owner is watching. So entries are keyed by name and
 * the most recent one wins -- the rule `gh pr checks` itself applies.
 */

type RawRollupEntry = Record<string, unknown>;

const FAIL_CONCLUSIONS = new Set([
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'STALE',
]);
const SKIP_CONCLUSIONS = new Set(['SKIPPED', 'NEUTRAL']);

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function bucketOf(e: RawRollupEntry): CheckBucket {
  // A StatusContext has `state`; a CheckRun has `status` + `conclusion`.
  // Typename first, shape second: an older gh may omit __typename.
  const isContext = e.__typename === 'StatusContext' || (e.__typename === undefined && 'context' in e);
  if (isContext) {
    const state = str(e.state)?.toUpperCase();
    if (state === 'SUCCESS') return 'pass';
    if (state === 'FAILURE' || state === 'ERROR') return 'fail';
    return 'pending'; // PENDING, EXPECTED, or anything new
  }
  const status = str(e.status)?.toUpperCase();
  if (status !== 'COMPLETED') return 'pending';
  const conclusion = str(e.conclusion)?.toUpperCase() ?? '';
  if (conclusion === 'SUCCESS') return 'pass';
  if (SKIP_CONCLUSIONS.has(conclusion)) return 'skipped';
  if (FAIL_CONCLUSIONS.has(conclusion)) return 'fail';
  // Completed with a conclusion we do not know. Treating it as failing is the
  // safe direction: a false red is investigated, a false green is merged.
  return 'fail';
}

/** The words for a failure that was not a plain one; see `CheckLine.reason`. */
function reasonOf(e: RawRollupEntry): string | undefined {
  const raw = str(e.conclusion) ?? (str(e.state)?.toUpperCase() === 'ERROR' ? 'ERROR' : null);
  const c = raw?.toUpperCase();
  if (!c || c === 'FAILURE' || c === 'SUCCESS' || SKIP_CONCLUSIONS.has(c)) return undefined;
  return c.toLowerCase().replace(/_/g, ' ');
}

function nameOf(e: RawRollupEntry): string {
  const context = str(e.context);
  if (context) return context;
  const name = str(e.name) ?? 'check';
  const workflow = str(e.workflowName);
  return workflow ? `${workflow} / ${name}` : name;
}

function timeOf(e: RawRollupEntry): number {
  const t = str(e.startedAt) ?? str(e.createdAt) ?? str(e.completedAt);
  const ms = t ? Date.parse(t) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

const BUCKET_ORDER: Record<CheckBucket, number> = { fail: 0, pending: 1, pass: 2, skipped: 3 };

/** Collapse reruns and bucket each check. Exported for tests. */
export function checkLines(rollup: unknown): CheckLine[] {
  if (!Array.isArray(rollup)) return [];
  const latest = new Map<string, { at: number; line: CheckLine }>();
  for (const raw of rollup) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as RawRollupEntry;
    const name = nameOf(e);
    const at = timeOf(e);
    const prev = latest.get(name);
    // `>=`: with equal (or missing) timestamps the later array entry wins,
    // which is the order GitHub returns runs in.
    if (prev && at < prev.at) continue;
    const bucket = bucketOf(e);
    const line: CheckLine = { name, bucket, url: str(e.detailsUrl) ?? str(e.targetUrl) };
    const reason = bucket === 'fail' ? reasonOf(e) : undefined;
    if (reason) line.reason = reason;
    latest.set(name, { at, line });
  }
  return [...latest.values()]
    .map((v) => v.line)
    .sort((a, b) => BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket] || a.name.localeCompare(b.name));
}

/**
 * Failing outranks pending: one red job is the answer to "can I stop watching",
 * even while others are still running.
 */
export function summarizeChecks(lines: CheckLine[]): ChecksSummary {
  const counted = lines.filter((l) => l.bucket !== 'skipped');
  const total = counted.length;
  if (total === 0) return { kind: 'none' };
  const failing = counted.filter((l) => l.bucket === 'fail').length;
  if (failing > 0) return { kind: 'failing', failing, total };
  const pending = counted.filter((l) => l.bucket === 'pending').length;
  if (pending > 0) return { kind: 'pending', pending, total };
  return { kind: 'passing', total };
}

// ---------------------------------------------------------------------------
// The whole PR
// ---------------------------------------------------------------------------

function reviewOf(v: unknown): ReviewDecision {
  switch (str(v)?.toUpperCase()) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes-requested';
    case 'REVIEW_REQUIRED':
      return 'review-required';
    default:
      // "" is what gh prints when the repo has no review rule.
      return null;
  }
}

function stateOf(state: unknown, isDraft: unknown, mergedAt: string | null): PrState {
  const s = str(state)?.toUpperCase();
  if (s === 'MERGED' || mergedAt) return 'merged';
  if (s === 'CLOSED') return 'closed';
  return isDraft === true ? 'draft' : 'open';
}

/**
 * Parse `gh pr view --json number,url,state,isDraft,title,reviewDecision,
 * statusCheckRollup,mergedAt,headRefName,baseRefName,headRefOid`. Returns null
 * for anything that is not recognisably a PR -- the caller treats that exactly
 * like "no PR".
 */
export function parsePrView(stdout: string): PrStatus | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.number !== 'number' || !Number.isFinite(d.number)) return null;
  const mergedAt = str(d.mergedAt);
  const lines = checkLines(d.statusCheckRollup);
  return {
    number: d.number,
    url: str(d.url) ?? '',
    title: str(d.title) ?? '',
    state: stateOf(d.state, d.isDraft, mergedAt),
    headRefName: str(d.headRefName) ?? '',
    baseRefName: str(d.baseRefName) ?? '',
    headSha: str(d.headRefOid) ?? '',
    mergedAt,
    review: reviewOf(d.reviewDecision),
    checks: summarizeChecks(lines),
    lines,
  };
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** The tone the badge is painted in. Never the only signal: see `prLabel`. */
export type PrTone = 'pass' | 'fail' | 'pending' | 'merged' | 'quiet';

/**
 * The glyph + words on the badge. Each state carries its own glyph AND a word,
 * so it reads without colour (HIG: never rely on colour alone).
 */
export function prLabel(pr: PrStatus): { glyph: string; text: string; tone: PrTone } {
  // The word alone: once merged, the checks no longer matter.
  if (pr.state === 'merged') return { glyph: '', text: 'Merged', tone: 'merged' };
  if (pr.state === 'closed') return { glyph: '×', text: 'Closed', tone: 'quiet' };
  const c = pr.checks;
  const draft = pr.state === 'draft' ? 'Draft · ' : '';
  switch (c.kind) {
    case 'failing':
      return { glyph: '✗', text: `${draft}${c.failing} Failing`, tone: 'fail' };
    case 'pending':
      return { glyph: '●', text: `${draft}Pending`, tone: 'pending' };
    case 'passing':
      return { glyph: '✓', text: `${draft}Checks`, tone: 'pass' };
    case 'none':
      return { glyph: '', text: pr.state === 'draft' ? 'Draft' : 'Open', tone: 'quiet' };
  }
}

const REVIEW_TEXT: Record<Exclude<ReviewDecision, null>, string> = {
  approved: 'approved',
  'changes-requested': 'changes requested',
  'review-required': 'review required',
};

const BUCKET_GLYPH: Record<CheckBucket, string> = { pass: '✓', fail: '✗', pending: '●', skipped: '–' };

/** Multi-line native tooltip: everything the badge had no room for. */
export function prTooltip(pr: PrStatus, opts: { clickable?: boolean; maxLines?: number } = {}): string {
  const maxLines = opts.maxLines ?? 12;
  const head = `#${pr.number} ${pr.title}`.trim();
  const facts: string[] = [pr.state];
  if (pr.review) facts.push(REVIEW_TEXT[pr.review]);
  const c = pr.checks;
  if (c.kind === 'passing') facts.push(`${c.total === 1 ? '1 check' : `${c.total} checks`} passing`);
  else if (c.kind === 'failing') facts.push(`${c.failing} of ${c.total} ${c.total === 1 ? 'check' : 'checks'} failing`);
  else if (c.kind === 'pending') facts.push(`${c.pending} of ${c.total} ${c.total === 1 ? 'check' : 'checks'} pending`);
  else facts.push('no checks');
  const out = [head, facts.join(' · ')];
  const shown = pr.lines.slice(0, maxLines);
  for (const l of shown) out.push(`${BUCKET_GLYPH[l.bucket]} ${l.name}`);
  if (pr.lines.length > shown.length) out.push(`… ${pr.lines.length - shown.length} more`);
  if (opts.clickable) out.push('Click to open on GitHub');
  return out.join('\n');
}
