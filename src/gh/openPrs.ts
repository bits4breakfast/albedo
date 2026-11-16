/**
 * Any open PR in a project's repo, for "Review a PR…" (#386): the Reviewing
 * tab lists only PRs whose review is asked of you, and this finds the rest
 * without asking anything of GitHub but a search. Nothing here writes.
 *
 * One `gh api graphql` request per question:
 *
 *   recent  the 10 most recently updated open PRs, without your own
 *   title   open PRs whose title has the words typed (GitHub matches whole
 *           words: "time" does not find "timezone")
 *   number  that PR exactly, open or not, so a closed one can be said so
 *
 * `{owner}/{repo}` is gh's own placeholder, filled from the folder's remote,
 * as in reviewRequests.ts. Unlike that module, a failure here carries gh's
 * words: the person typing is waiting on the answer, and "nothing" would be a
 * lie.
 */

import { gh, ghMessage } from './gh';

/** Open PRs by others in the folder's repo, newest first. */
export const OPEN_PRS_SEARCH = 'is:pr is:open archived:false -author:@me repo:{owner}/{repo} sort:updated-desc';
export const OPEN_PRS_LIMIT = 10;

const FIELDS = `number title url isDraft createdAt updatedAt baseRefName headRefOid state
  author { login }
  commits { totalCount }`;

export const OPEN_PRS_QUERY = `query OpenPrs($q: String!) {
  search(query: $q, type: ISSUE, first: ${OPEN_PRS_LIMIT}) { issueCount nodes { ... on PullRequest { ${FIELDS} } } }
}`;

export const PR_BY_NUMBER_QUERY = `query PrByNumber($owner: String!, $repo: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) { ${FIELDS} } }
}`;

/** What a row of the dropdown shows, and what opening it as a review task needs. */
export interface OpenPr {
  url: string;
  number: number;
  title: string;
  author: string | null;
  isDraft: boolean;
  updatedAt: number;
  /** The branch it merges into: what a review task is measured against. */
  baseBranch: string;
  headOid: string;
  commitCount: number;
}

export type PrQuery =
  | { kind: 'recent' }
  | { kind: 'number'; number: number }
  | { kind: 'title'; terms: string[] };

/**
 * What was typed, as a question. A number, with or without `#`, is that PR;
 * anything else is words of a title. Nothing (or a lone `#`) is the recent
 * list.
 */
export function parsePrQuery(typed: string): PrQuery {
  const t = typed.trim();
  // Nine digits at most: GraphQL's Int is 32-bit, and no repo is near that.
  const n = /^#?\s*(\d{1,9})$/.exec(t);
  if (n) {
    const number = Number(n[1]);
    if (number > 0) return { kind: 'number', number };
  }
  const terms = t
    .replace(/^#$/, '')
    .split(/\s+/)
    .map((w) => w.replace(/"/g, ''))
    .filter((w) => w.length > 0);
  return terms.length === 0 ? { kind: 'recent' } : { kind: 'title', terms };
}

/**
 * The search string for the recent list or a title search. A word that
 * GitHub would read as a qualifier (`is:closed`, `author:x`) or a negation
 * (`-foo`) is quoted, so it cannot widen the search past "open, not yours,
 * this repo". A trailing backslash is dropped from a quoted word: it would
 * escape the closing quote. `AND`, `OR` and `NOT` typed in capitals still
 * act as GitHub's operators between the words (measured: `xterm OR types`
 * finds both), but only within those same constraints.
 */
export function searchString(q: Exclude<PrQuery, { kind: 'number' }>): string {
  if (q.kind === 'recent') return OPEN_PRS_SEARCH;
  const special = /[:\-]|^[^\p{L}\p{N}]/u;
  const words = q.terms.map((w) => (special.test(w) ? `"${w.replace(/\\+$/, '')}"` : w)).filter((w) => w !== '""');
  return `${OPEN_PRS_SEARCH} in:title ${words.join(' ')}`;
}

export type PrSearchAnswer =
  | { kind: 'list'; prs: OpenPr[]; total: number }
  | { kind: 'number'; number: number; pr: OpenPr | null; why: 'open' | 'closed' | 'merged' | 'missing' | 'yours' }
  | { kind: 'failed'; message: string };

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function prOf(raw: unknown): OpenPr | null {
  const n = obj(raw);
  const url = str(n?.url);
  const title = str(n?.title);
  const number = n?.number;
  if (!n || !url || !title || typeof number !== 'number') return null;
  const updated = Date.parse(str(n.updatedAt) ?? str(n.createdAt) ?? '');
  const count = obj(n.commits)?.totalCount;
  return {
    url,
    number,
    title,
    author: str(obj(n.author)?.login),
    isDraft: n.isDraft === true,
    updatedAt: Number.isFinite(updated) ? updated : 0,
    baseBranch: str(n.baseRefName) ?? '',
    headOid: str(n.headRefOid) ?? '',
    commitCount: typeof count === 'number' ? count : 0,
  };
}

function json(stdout: string): Record<string, unknown> | null {
  try {
    return obj(JSON.parse(stdout));
  } catch {
    return null;
  }
}

const NOT_ASKED = 'GitHub CLI (gh) could not be run.';

/** {@link OPEN_PRS_QUERY}'s answer. Pure. */
export function parseOpenPrs(stdout: string): PrSearchAnswer {
  const search = obj(obj(json(stdout)?.data)?.search);
  if (!search) return { kind: 'failed', message: 'GitHub did not answer with a list.' };
  const nodes = Array.isArray(search.nodes) ? search.nodes : [];
  // A search node that is not a PR comes back as {}: skipped.
  const prs = nodes.map(prOf).filter((p): p is OpenPr => p !== null);
  const total = typeof search.issueCount === 'number' ? search.issueCount : prs.length;
  return { kind: 'list', prs, total: Math.max(total, prs.length) };
}

/**
 * {@link PR_BY_NUMBER_QUERY}'s answer. Pure. GitHub answers a number that is
 * no PR (none, or an issue) with `pullRequest: null` and a NOT_FOUND error,
 * and gh exits 1 for it; that is an answer, not a failure.
 */
export function parsePrByNumber(stdout: string, number: number): PrSearchAnswer | null {
  const data = obj(json(stdout)?.data);
  const repo = obj(data?.repository);
  if (!data || !repo) return null;
  const raw = obj(repo.pullRequest);
  if (!raw) return { kind: 'number', number, pr: null, why: 'missing' };
  const pr = prOf(raw);
  if (!pr) return null;
  const viewer = str(obj(data.viewer)?.login);
  const state = raw.state;
  const why =
    state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : viewer !== null && pr.author === viewer ? 'yours' : 'open';
  return { kind: 'number', number, pr: why === 'open' ? pr : null, why };
}

/**
 * Ask GitHub. Never throws: gh missing, logged out, offline, no GitHub
 * remote all end as `failed`, with gh's own words when it has any.
 */
export async function searchOpenPrs(repoPath: string, q: PrQuery): Promise<PrSearchAnswer> {
  if (q.kind === 'number') {
    const r = await gh(
      [
        'api',
        'graphql',
        '-F',
        'owner={owner}',
        '-F',
        'repo={repo}',
        '-F',
        `number=${q.number}`,
        '-f',
        `query=${PR_BY_NUMBER_QUERY}`,
      ],
      repoPath,
    ).catch(() => null);
    if (!r) return { kind: 'failed', message: NOT_ASKED };
    return parsePrByNumber(r.stdout, q.number) ?? { kind: 'failed', message: ghMessage(r) };
  }
  // -F, because gh fills {owner}/{repo} only there (measured: -f sends them
  // literally). -F's conversions -- a file for a leading @, a number or a
  // boolean for the whole value -- cannot apply: the value always starts
  // with `is:pr`, whatever was typed.
  const r = await gh(['api', 'graphql', '-F', `q=${searchString(q)}`, '-f', `query=${OPEN_PRS_QUERY}`], repoPath).catch(
    () => null,
  );
  if (!r) return { kind: 'failed', message: NOT_ASKED };
  if (r.code !== 0) return { kind: 'failed', message: ghMessage(r) };
  return parseOpenPrs(r.stdout);
}

/**
 * Where each typed word appears in `title`, case-insensitively, as character
 * indices for `Highlighted`.
 */
export function titleHits(title: string, terms: readonly string[]): number[] {
  const lower = title.toLowerCase();
  const hits = new Set<number>();
  for (const term of terms) {
    const t = term.toLowerCase();
    if (!t) continue;
    for (let at = lower.indexOf(t); at !== -1; at = lower.indexOf(t, at + t.length)) {
      for (let i = at; i < at + t.length; i++) hits.add(i);
    }
  }
  return [...hits].sort((a, b) => a - b);
}

/** Whether every typed word is in `title` (part of a word counts). */
export function titleHas(title: string, terms: readonly string[]): boolean {
  const lower = title.toLowerCase();
  return terms.every((t) => lower.includes(t.toLowerCase()));
}
