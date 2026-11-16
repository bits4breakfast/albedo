/**
 * "Review a PR…"'s questions to GitHub (#386): what is asked for what was
 * typed, and what each answer -- or failure -- comes back as.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setGhRunner, type GhRunner } from './gh';
import {
  OPEN_PRS_QUERY,
  OPEN_PRS_SEARCH,
  parseOpenPrs,
  parsePrByNumber,
  parsePrQuery,
  PR_BY_NUMBER_QUERY,
  searchOpenPrs,
  searchString,
  titleHas,
  titleHits,
} from './openPrs';

function node(over: Record<string, unknown> = {}) {
  return {
    number: 412,
    title: 'Fix timezone in the daily report',
    url: 'https://github.com/acme/relay/pull/412',
    isDraft: false,
    createdAt: '2026-11-01T10:00:00Z',
    updatedAt: '2026-11-08T10:00:00Z',
    baseRefName: 'main',
    headRefOid: 'abc123',
    state: 'OPEN',
    author: { login: 'dana' },
    commits: { totalCount: 3 },
    ...over,
  };
}

const list = (nodes: unknown[], issueCount = nodes.length) => JSON.stringify({ data: { search: { issueCount, nodes } } });
const byNumber = (pr: unknown, viewer = 'me') =>
  JSON.stringify({ data: { viewer: { login: viewer }, repository: { pullRequest: pr } } });

let prev: GhRunner | null = null;
afterEach(() => {
  if (prev) setGhRunner(prev);
  prev = null;
});

function runner(answer: (args: string[]) => { code: number; stdout: string; stderr?: string }) {
  const calls: { args: string[]; cwd?: string }[] = [];
  prev = setGhRunner(async (_p, args, cwd) => {
    calls.push({ args, cwd });
    const a = answer(args);
    return { code: a.code, stdout: a.stdout, stderr: a.stderr ?? '' };
  });
  return calls;
}

describe('parsePrQuery', () => {
  it('reads a number, with or without #, as that PR', () => {
    expect(parsePrQuery('412')).toEqual({ kind: 'number', number: 412 });
    expect(parsePrQuery(' #412 ')).toEqual({ kind: 'number', number: 412 });
    expect(parsePrQuery('# 412')).toEqual({ kind: 'number', number: 412 });
  });

  it('reads anything else as words of a title', () => {
    expect(parsePrQuery('fix  time')).toEqual({ kind: 'title', terms: ['fix', 'time'] });
    expect(parsePrQuery('412 fix')).toEqual({ kind: 'title', terms: ['412', 'fix'] });
    expect(parsePrQuery('"quoted"')).toEqual({ kind: 'title', terms: ['quoted'] });
  });

  it('reads nothing, a lone # or 0 as no number: the recent list, or a word', () => {
    expect(parsePrQuery('')).toEqual({ kind: 'recent' });
    expect(parsePrQuery('  ')).toEqual({ kind: 'recent' });
    expect(parsePrQuery('#')).toEqual({ kind: 'recent' });
    expect(parsePrQuery('0')).toEqual({ kind: 'title', terms: ['0'] });
    // Past GraphQL's Int: a word, not a lookup GitHub would refuse.
    expect(parsePrQuery('12345678901').kind).toBe('title');
  });
});

describe('searchString', () => {
  it('asks for open PRs in this repo, not yours, newest first', () => {
    expect(searchString({ kind: 'recent' })).toBe(
      'is:pr is:open archived:false -author:@me repo:{owner}/{repo} sort:updated-desc',
    );
  });

  it('adds the words as a title search', () => {
    expect(searchString({ kind: 'title', terms: ['fix', 'time'] })).toBe(`${OPEN_PRS_SEARCH} in:title fix time`);
  });

  it('quotes a word GitHub would read as a qualifier or a negation, so it cannot widen the search', () => {
    expect(searchString({ kind: 'title', terms: ['is:closed', '-author:@me', 'fix:', 'a-b', '@x'] })).toBe(
      `${OPEN_PRS_SEARCH} in:title "is:closed" "-author:@me" "fix:" "a-b" "@x"`,
    );
  });

  it('drops a trailing backslash from a quoted word, so it cannot escape the closing quote', () => {
    expect(searchString({ kind: 'title', terms: ['fix:\\', '-\\', 'ok'] })).toBe(`${OPEN_PRS_SEARCH} in:title "fix:" "-" ok`);
    expect(searchString({ kind: 'title', terms: ['@\\', 'ok'] })).toBe(`${OPEN_PRS_SEARCH} in:title "@" ok`);
  });
});

describe('parseOpenPrs', () => {
  it('reads each PR: number, title, author, age, base, head, commits; and the total', () => {
    const a = parseOpenPrs(list([node(), {}], 24));
    expect(a).toEqual({
      kind: 'list',
      total: 24,
      prs: [
        {
          url: 'https://github.com/acme/relay/pull/412',
          number: 412,
          title: 'Fix timezone in the daily report',
          author: 'dana',
          isDraft: false,
          updatedAt: Date.parse('2026-11-08T10:00:00Z'),
          baseBranch: 'main',
          headOid: 'abc123',
          commitCount: 3,
        },
      ],
    });
  });

  it('is a failure, not an empty list, for an answer that is not one', () => {
    expect(parseOpenPrs('not json').kind).toBe('failed');
    expect(parseOpenPrs(JSON.stringify({ errors: [{ message: 'x' }] })).kind).toBe('failed');
  });
});

describe('parsePrByNumber', () => {
  it('an open PR by someone else is the one row', () => {
    const a = parsePrByNumber(byNumber(node()), 412);
    expect(a).toMatchObject({ kind: 'number', number: 412, why: 'open', pr: { number: 412, author: 'dana' } });
  });

  it('says closed, merged and missing, with no row', () => {
    expect(parsePrByNumber(byNumber(node({ state: 'CLOSED' })), 412)).toMatchObject({ why: 'closed', pr: null });
    expect(parsePrByNumber(byNumber(node({ state: 'MERGED' })), 412)).toMatchObject({ why: 'merged', pr: null });
    expect(parsePrByNumber(byNumber(null), 412)).toMatchObject({ why: 'missing', pr: null });
  });

  it('leaves your own PR out, saying why', () => {
    expect(parsePrByNumber(byNumber(node({ author: { login: 'me' } })), 412)).toMatchObject({ why: 'yours', pr: null });
  });

  it('is no answer when the repository was not answered', () => {
    expect(parsePrByNumber(JSON.stringify({ data: null, errors: [] }), 412)).toBeNull();
    expect(parsePrByNumber('', 412)).toBeNull();
  });
});

describe('searchOpenPrs', () => {
  it('the recent list: one search, in the project folder, through -F so gh fills the repo', async () => {
    const calls = runner(() => ({ code: 0, stdout: list([node()]) }));
    const a = await searchOpenPrs('/r/relay', { kind: 'recent' });
    expect(a.kind).toBe('list');
    expect(calls).toEqual([
      { args: ['api', 'graphql', '-F', `q=${OPEN_PRS_SEARCH}`, '-f', `query=${OPEN_PRS_QUERY}`], cwd: '/r/relay' },
    ]);
    expect(OPEN_PRS_QUERY).toContain('first: 10');
  });

  it('a title search sends the words in:title', async () => {
    const calls = runner(() => ({ code: 0, stdout: list([]) }));
    await searchOpenPrs('/r', { kind: 'title', terms: ['time'] });
    expect(calls[0]!.args[3]).toBe(`q=${OPEN_PRS_SEARCH} in:title time`);
  });

  it('a number asks for that PR exactly', async () => {
    const calls = runner(() => ({ code: 0, stdout: byNumber(node()) }));
    const a = await searchOpenPrs('/r', { kind: 'number', number: 412 });
    expect(a).toMatchObject({ kind: 'number', why: 'open' });
    expect(calls[0]!.args).toEqual([
      'api',
      'graphql',
      '-F',
      'owner={owner}',
      '-F',
      'repo={repo}',
      '-F',
      'number=412',
      '-f',
      `query=${PR_BY_NUMBER_QUERY}`,
    ]);
  });

  it('a number that is no PR: gh exits 1 with GitHub NOT_FOUND, and that is "missing", not a failure', async () => {
    // As measured: data with a null pullRequest, and errors, on stdout.
    const stdout = JSON.stringify({
      data: { viewer: { login: 'me' }, repository: { pullRequest: null } },
      errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a PullRequest with the number of 99999.' }],
    });
    runner(() => ({ code: 1, stdout, stderr: 'gh: Could not resolve to a PullRequest with the number of 99999.' }));
    expect(await searchOpenPrs('/r', { kind: 'number', number: 99999 })).toMatchObject({ why: 'missing' });
  });

  it('a failure carries gh’s words', async () => {
    runner(() => ({ code: 4, stdout: '', stderr: 'gh auth login required\n' }));
    expect(await searchOpenPrs('/r', { kind: 'recent' })).toEqual({ kind: 'failed', message: 'gh auth login required' });
    expect(await searchOpenPrs('/r', { kind: 'number', number: 1 })).toEqual({
      kind: 'failed',
      message: 'gh auth login required',
    });
  });

  it('no gh at all is a failure that says so', async () => {
    prev = setGhRunner(async () => {
      throw new Error('spawn failed');
    });
    expect(await searchOpenPrs('/r', { kind: 'recent' })).toEqual({
      kind: 'failed',
      message: 'GitHub CLI (gh) could not be run.',
    });
  });
});

describe('title matching on screen', () => {
  it('marks every typed word, case-insensitively, part of a word included', () => {
    expect(titleHits('Fix timezone, Time', ['time'])).toEqual([4, 5, 6, 7, 14, 15, 16, 17]);
    expect(titleHits('Fix it', [])).toEqual([]);
  });

  it('a title has the words when it has every one of them', () => {
    expect(titleHas('Fix timezone in the report', ['time', 'FIX'])).toBe(true);
    expect(titleHas('Fix timezone', ['time', 'report'])).toBe(false);
  });
});
