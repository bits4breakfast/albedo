/**
 * Pull-request status, derived from the PR query (`PR_QUERY`, one `gh api
 * graphql` request: what `gh pr view --json` gives, plus review threads).
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

/**
 * GitHub's `mergeable` (#236): whether the head merges into the base without
 * conflicts. `unknown` is GitHub still computing it -- it is never guessed.
 */
export type Mergeable = 'mergeable' | 'conflicting' | 'unknown';

/**
 * GitHub's `mergeStateStatus` (#236), lower-cased: whether the PR can be
 * merged now, and if not, roughly why. `unknown` covers UNKNOWN and anything
 * new.
 */
export type MergeStateStatus = 'clean' | 'blocked' | 'behind' | 'dirty' | 'unstable' | 'has-hooks' | 'draft' | 'unknown';

/**
 * One reviewer's latest say (`latestReviews`), kept only when it decides
 * something: an approval or a request for changes. A comment-only review, a
 * dismissed one or a pending draft says nothing about whether to merge.
 */
export interface PrReview {
  /** The reviewer's login. */
  author: string;
  state: 'approved' | 'changes-requested';
  /** When it was submitted (ISO). With the author and state, what makes it one review. */
  submittedAt: string;
}

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
  /**
   * GitHub's `reviewDecision`, or -- where no branch rule asks for reviews and
   * GitHub gives none -- what the latest reviews say (see `reviewOf`).
   */
  review: ReviewDecision;
  /**
   * The approvals and change requests that stand, one per reviewer. Optional
   * so a hand-built status (tests) need not spell it out; `parsePrView`
   * always sets it.
   */
  reviews?: PrReview[];
  /** Who is asked to review and has not yet: logins, or a team's name. */
  reviewRequests?: string[];
  /** The PR author's login. Empty when gh did not say. */
  author?: string;
  /**
   * `mergeable` and `mergeStateStatus` (#236). Optional, like `reviews`, so a
   * hand-built status (tests) need not spell them out; `parsePrView` always
   * sets them, `unknown` when gh did not say.
   */
  mergeable?: Mergeable;
  mergeState?: MergeStateStatus;
  checks: ChecksSummary;
  /** Every check after dedupe, failing first; the tooltip lists them. */
  lines: CheckLine[];
  /**
   * The PR's review threads (#278): inline conversations a reviewer started,
   * and how many are not resolved yet. Conversation comments cannot be
   * resolved and are not threads. Kept for an open or draft PR only; null
   * when not known (not asked, or GitHub did not say) -- the PR store keeps
   * the last known counts then, so a group never flickers on a gap.
   */
  reviewThreads?: ReviewThreads | null;
}

export interface ReviewThreads {
  total: number;
  unresolved: number;
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

function decisionOf(v: unknown): ReviewDecision {
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

/** `latestReviews`, keeping the approvals and change requests. Exported for tests. */
export function reviewsOf(v: unknown): PrReview[] {
  if (!Array.isArray(v)) return [];
  const out: PrReview[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const s = str(r.state)?.toUpperCase();
    const state = s === 'APPROVED' ? 'approved' : s === 'CHANGES_REQUESTED' ? 'changes-requested' : null;
    const author = loginOf(r.author);
    if (!state || !author) continue;
    out.push({ author, state, submittedAt: str(r.submittedAt) ?? '' });
  }
  return out;
}

function loginOf(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  return str((v as Record<string, unknown>).login);
}

/** `reviewRequests`: a user by login, a team by its name (or slug). */
function requestsOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const who = str(r.login) ?? str(r.name) ?? str(r.slug);
    if (who) out.push(who);
  }
  return out;
}

/**
 * `reviewDecision` is set only when a branch rule requires reviews. Without
 * one GitHub says nothing, even after a reviewer asked for changes -- so then
 * the latest reviews decide: any change request outranks any approval, and
 * no review at all is no decision.
 */
function reviewOf(decision: unknown, reviews: PrReview[]): ReviewDecision {
  const d = decisionOf(decision);
  if (d !== null) return d;
  if (reviews.some((r) => r.state === 'changes-requested')) return 'changes-requested';
  if (reviews.some((r) => r.state === 'approved')) return 'approved';
  return null;
}

function mergeableOf(v: unknown): Mergeable {
  const m = str(v)?.toUpperCase();
  return m === 'MERGEABLE' ? 'mergeable' : m === 'CONFLICTING' ? 'conflicting' : 'unknown';
}

const MERGE_STATES: ReadonlySet<string> = new Set(['clean', 'blocked', 'behind', 'dirty', 'unstable', 'has-hooks', 'draft']);

function mergeStateOf(v: unknown): MergeStateStatus {
  const m = str(v)?.toLowerCase().replace(/_/g, '-') ?? '';
  return MERGE_STATES.has(m) ? (m as MergeStateStatus) : 'unknown';
}

function stateOf(state: unknown, isDraft: unknown, mergedAt: string | null): PrState {
  const s = str(state)?.toUpperCase();
  if (s === 'MERGED' || mergedAt) return 'merged';
  if (s === 'CLOSED') return 'closed';
  return isDraft === true ? 'draft' : 'open';
}

/** A PR from the record `gh pr view --json` prints, or the same fields flattened from GraphQL. */
function prFromRecord(d: Record<string, unknown>): PrStatus | null {
  if (typeof d.number !== 'number' || !Number.isFinite(d.number)) return null;
  const mergedAt = str(d.mergedAt);
  const lines = checkLines(d.statusCheckRollup);
  const reviews = reviewsOf(d.latestReviews);
  return {
    number: d.number,
    url: str(d.url) ?? '',
    title: str(d.title) ?? '',
    state: stateOf(d.state, d.isDraft, mergedAt),
    headRefName: str(d.headRefName) ?? '',
    baseRefName: str(d.baseRefName) ?? '',
    headSha: str(d.headRefOid) ?? '',
    mergedAt,
    review: reviewOf(d.reviewDecision, reviews),
    reviews,
    reviewRequests: requestsOf(d.reviewRequests),
    author: loginOf(d.author) ?? '',
    mergeable: mergeableOf(d.mergeable),
    mergeState: mergeStateOf(d.mergeStateStatus),
    checks: summarizeChecks(lines),
    lines,
  };
}

/**
 * Parse `gh pr view --json number,url,state,isDraft,title,reviewDecision,
 * statusCheckRollup,mergedAt,headRefName,baseRefName,headRefOid,
 * latestReviews,reviewRequests,author,mergeable,mergeStateStatus`. Returns null
 * for anything that is not recognisably a PR -- the caller treats that exactly
 * like "no PR". It carries no review threads: `gh pr view` cannot ask for them.
 */
export function parsePrView(stdout: string): PrStatus | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return prFromRecord(data as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// The PR for a branch, in one GraphQL request (#278)
// ---------------------------------------------------------------------------

/*
 * The PR store's one request per refresh. It is the query `gh pr view <branch>
 * --json …` sends itself (measured on gh 2.97 with GH_DEBUG=api), with the
 * review threads added, so the unresolved count costs no second call: gh
 * cannot ask `pr view` for threads. One request, 1 point of GitHub's GraphQL
 * budget (`rateLimit { cost }` measured 1 on a live repo, threads included).
 *
 * `first: 10` PRs for the branch, newest first (gh asks for 30: a task's
 * branch has one or two). Threads: the first 100, which is the count shown;
 * `totalCount` is exact, the unresolved count is of those 100.
 */
export const PR_QUERY = `query PrForBranch($owner: String!, $repo: String!, $branch: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(headRefName: $branch, first: 10, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes {
        number url state isDraft title reviewDecision mergedAt headRefName baseRefName headRefOid
        mergeable mergeStateStatus
        author { __typename login }
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
          __typename
          ... on StatusContext { context state targetUrl createdAt }
          ... on CheckRun { name checkSuite { workflowRun { workflow { name } } } status conclusion startedAt completedAt detailsUrl }
        } } } } } }
        latestReviews(first: 100) { nodes { author { login } submittedAt state } }
        reviewRequests(first: 100) { nodes { requestedReviewer {
          __typename
          ... on User { login }
          ... on Bot { login }
          ... on Team { name slug }
        } } }
        reviewThreads(first: 100) { totalCount nodes { isResolved } }
      }
    }
  }
}`;

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function nodesOf(v: unknown): unknown[] {
  const n = obj(v)?.nodes;
  return Array.isArray(n) ? n : [];
}

/** A rollup context as `gh pr view` prints it: a CheckRun's workflow flattened to `workflowName`. */
function rollupOf(commits: unknown): RawRollupEntry[] {
  const commit = obj(obj(nodesOf(commits)[0])?.commit);
  return nodesOf(obj(commit?.statusCheckRollup)?.contexts).flatMap((raw) => {
    const e = obj(raw);
    if (!e) return [];
    const suite = obj(e.checkSuite);
    const workflow = str(obj(obj(obj(suite?.workflowRun)?.workflow))?.name);
    const flat: RawRollupEntry = { ...e };
    delete flat.checkSuite;
    if (workflow) flat.workflowName = workflow;
    return [flat];
  });
}

/** Total and unresolved, or null when GitHub did not say. Exported for tests. */
export function threadsOf(v: unknown): ReviewThreads | null {
  const t = obj(v);
  if (!t || typeof t.totalCount !== 'number' || !Array.isArray(t.nodes)) return null;
  const unresolved = t.nodes.filter((n) => obj(n)?.isResolved === false).length;
  return { total: t.totalCount, unresolved };
}

/**
 * The PR for `branch` from {@link PR_QUERY}'s answer, chosen as `gh pr view
 * <branch>` chooses: among the PRs whose head is that branch, an open one
 * first, else the newest. Null for none, for an error answer, or for anything
 * that is not recognisably one -- the caller treats all of them as "no PR".
 */
export function parsePrGraphql(stdout: string, branch: string): PrStatus | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  const repo = obj(obj(obj(data)?.data)?.repository);
  const nodes = nodesOf(repo?.pullRequests)
    .map(obj)
    .filter((n): n is Record<string, unknown> => !!n && n.headRefName === branch);
  const node = nodes.find((n) => str(n.state)?.toUpperCase() === 'OPEN') ?? nodes[0];
  if (!node) return null;
  const author = obj(node.author);
  const pr = prFromRecord({
    ...node,
    // As `gh pr view` prints a bot's login: "app/dependabot".
    author: author?.__typename === 'Bot' && str(author.login) ? { login: `app/${str(author.login)}` } : author,
    statusCheckRollup: rollupOf(node.commits),
    latestReviews: nodesOf(node.latestReviews),
    reviewRequests: nodesOf(node.reviewRequests).map((n) => obj(n)?.requestedReviewer),
  });
  if (!pr) return null;
  // Threads matter while the PR is up for review; after that, nothing reads them.
  pr.reviewThreads = pr.state === 'open' || pr.state === 'draft' ? threadsOf(node.reviewThreads) : null;
  return pr;
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

// ---------------------------------------------------------------------------
// Review (#180)
// ---------------------------------------------------------------------------

export type ReviewTone = 'pass' | 'warn' | 'quiet';

export interface ReviewChip {
  kind: 'awaiting' | 'approved' | 'changes-requested';
  glyph: string;
  text: string;
  tone: ReviewTone;
}

const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The review chip beside the PR badge, or null for none.
 *
 *   - Open PRs only: a draft is not up for review, and once merged or closed
 *     the question is over.
 *   - Approved and Changes Requested are what GitHub (or the latest reviews)
 *     say. Awaiting Review is GitHub's REVIEW_REQUIRED, or a reviewer asked
 *     for where no rule requires one.
 *   - No decision and nobody asked: no chip. Most repos without review rules.
 *   - The owner's own PR with nobody asked (`viewer` is the signed-in gh
 *     user): no Awaiting Review. On a repo they merge themselves it would
 *     never go away. `viewer` null is "not known", and hides nothing.
 */
export function reviewChip(pr: PrStatus, viewer: string | null): ReviewChip | null {
  if (pr.state !== 'open') return null;
  if (pr.review === 'approved') return { kind: 'approved', glyph: '✓', text: 'Approved', tone: 'pass' };
  if (pr.review === 'changes-requested') {
    return { kind: 'changes-requested', glyph: '✎', text: 'Changes Requested', tone: 'warn' };
  }
  const asked = (pr.reviewRequests ?? []).length > 0;
  if (pr.review !== 'review-required' && !asked) return null;
  if (!asked && viewer && pr.author && sameLogin(pr.author, viewer)) return null;
  return { kind: 'awaiting', glyph: '◷', text: 'Awaiting Review', tone: 'quiet' };
}

function names(list: string[]): string {
  if (list.length <= 2) return list.join(' and ');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** Who approved, who asked for changes, who is still asked: the chip's tooltip. */
export function reviewTooltip(pr: PrStatus): string {
  const reviews = pr.reviews ?? [];
  const approved = reviews.filter((r) => r.state === 'approved').map((r) => r.author);
  const changes = reviews.filter((r) => r.state === 'changes-requested').map((r) => r.author);
  const asked = pr.reviewRequests ?? [];
  const out: string[] = [];
  if (changes.length) out.push(`Changes requested by ${names(changes)}`);
  if (approved.length) out.push(`Approved by ${names(approved)}`);
  if (asked.length) out.push(`Review requested from ${names(asked)}`);
  if (!out.length) out.push(pr.review === 'review-required' ? 'A review is required' : 'Awaiting review');
  out.push('Click to open the reviews on GitHub');
  return out.join('\n');
}

/** Exported for the banner: "alice", "alice and bob", "alice, bob and carol". */
export const reviewerNames = names;
