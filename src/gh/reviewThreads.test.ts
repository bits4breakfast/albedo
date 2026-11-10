import { afterEach, describe, expect, it, vi } from 'vitest';
import { setGhRunner, type GhRunner } from './gh';
import {
  anchorOfHunk,
  fetchThreads,
  parseThreads,
  placeThread,
  refreshThreads,
  setThreadsFetcherForTests,
  threadsFor,
  THREADS_MIN_AGE_MS,
  THREADS_QUERY,
  type ReviewThread,
} from './reviewThreads';

const PR = { host: 'github.com', owner: 'example', repo: 'relay', number: 34 };

function answer(nodes: unknown[]) {
  return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } });
}

const THREAD = {
  id: 'PRRT_1',
  isResolved: false,
  isOutdated: false,
  path: 'src/retry.ts',
  line: 14,
  startLine: null,
  originalLine: 12,
  diffSide: 'RIGHT',
  comments: {
    nodes: [
      {
        databaseId: 9001,
        author: { login: 'alice' },
        body: 'Three retries?',
        createdAt: '2026-11-08T10:00:00Z',
        diffHunk: '@@ -10,3 +10,5 @@\n const a = 1;\n+  const attempts = 3;\n',
      },
      { databaseId: 9002, author: null, body: 'Agreed', createdAt: '2026-11-08T11:00:00Z', diffHunk: '' },
    ],
  },
};

describe('parseThreads', () => {
  it('reads a thread: where, state, the id a reply goes to, its code and its comments', () => {
    expect(parseThreads(answer([THREAD]))).toEqual([
      {
        id: 'PRRT_1',
        path: 'src/retry.ts',
        line: 14,
        startLine: null,
        originalLine: 12,
        side: 'RIGHT',
        isResolved: false,
        isOutdated: false,
        replyTo: 9001,
        anchor: '  const attempts = 3;',
        comments: [
          { author: 'alice', body: 'Three retries?', createdAt: Date.parse('2026-11-08T10:00:00Z') },
          { author: null, body: 'Agreed', createdAt: Date.parse('2026-11-08T11:00:00Z') },
        ],
      },
    ]);
  });

  it('keeps an outdated or resolved thread, with no line', () => {
    const [t] = parseThreads(answer([{ ...THREAD, line: null, isOutdated: true, isResolved: true }]))!;
    expect(t).toMatchObject({ line: null, isOutdated: true, isResolved: true });
  });

  it('has no anchor on the LEFT side', () => {
    expect(parseThreads(answer([{ ...THREAD, diffSide: 'LEFT' }]))![0]!.anchor).toBeNull();
  });

  it('skips a thread with no comment to reply to, and refuses what is not an answer', () => {
    expect(parseThreads(answer([{ ...THREAD, comments: { nodes: [] } }, { id: 'x' }]))).toEqual([]);
    expect(parseThreads('not json')).toBeNull();
    expect(parseThreads('{"errors":[{"message":"Could not resolve"}]}')).toBeNull();
  });
});

describe('anchorOfHunk', () => {
  it('is the last line of the hunk, without its marker', () => {
    expect(anchorOfHunk('@@ -1 +1 @@\n a\n+b')).toBe('b');
    expect(anchorOfHunk('@@ -1 +1 @@\n a\n x\n')).toBe('x');
  });
  it('skips "\\ No newline at end of file" to the line it is about', () => {
    expect(anchorOfHunk('@@ -1 +1 @@\n a\n+last\n\\ No newline at end of file\n')).toBe('last');
  });

  it('is nothing for a removed line, a header, or no hunk', () => {
    expect(anchorOfHunk('@@ -1 +1 @@\n-a')).toBeNull();
    expect(anchorOfHunk('@@ -1 +1 @@')).toBeNull();
    expect(anchorOfHunk(undefined)).toBeNull();
  });
});

describe('placeThread', () => {
  const t = parseThreads(answer([THREAD]))![0]!;
  const file = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);

  it('finds its code nearest GitHub line, so a head that moved still places it', () => {
    const lines = file(30);
    lines[15] = '  const attempts = 3;'; // line 16
    lines[2] = '  const attempts = 3;'; // line 3, further away
    expect(placeThread(t, lines.join('\n'))).toBe(16);
  });

  it('is nowhere when its code is gone, it is outdated, or it is on the left side', () => {
    expect(placeThread(t, file(30).join('\n'))).toBeNull();
    expect(placeThread({ ...t, isOutdated: true }, '  const attempts = 3;')).toBeNull();
    expect(placeThread({ ...t, side: 'LEFT' }, '  const attempts = 3;')).toBeNull();
  });

  it('is in the bar when it has no code to look for: GitHub\'s line is on GitHub\'s head, not this copy', () => {
    expect(placeThread({ ...t, anchor: null }, file(30).join('\n'))).toBeNull();
  });

  it('finds its code in a file with CRLF line ends', () => {
    const lines = file(20);
    lines[13] = '  const attempts = 3;';
    expect(placeThread(t, lines.join('\r\n'))).toBe(14);
  });
});

describe('fetchThreads', () => {
  let prev: GhRunner | null = null;
  afterEach(() => {
    if (prev) setGhRunner(prev);
    prev = null;
  });

  it('asks GraphQL for the PR by owner, repo and number, as raw fields', async () => {
    const seen: string[][] = [];
    prev = setGhRunner(async (_p, args) => {
      seen.push(args);
      return { code: 0, stdout: answer([THREAD]), stderr: '' };
    });
    expect(await fetchThreads(PR, '/wt')).toHaveLength(1);
    expect(seen[0]).toEqual([
      'api',
      'graphql',
      '-f',
      'owner=example',
      '-f',
      'repo=relay',
      '-F',
      'number=34',
      '-f',
      `query=${THREADS_QUERY}`,
    ]);
  });

  it('is null on a gh failure', async () => {
    prev = setGhRunner(async () => ({ code: 1, stdout: '', stderr: 'HTTP 401' }));
    expect(await fetchThreads(PR, '/wt')).toBeNull();
  });
});

describe('refreshThreads', () => {
  const url = 'https://github.com/example/relay/pull/34';
  const one = parseThreads(answer([THREAD]))!;

  it('fetches at most once a minute, unless forced, and keeps the last answer over a failure', async () => {
    let t = 1_000_000;
    let reply: ReviewThread[] | null = one;
    const fetch = vi.fn(async () => reply);
    setThreadsFetcherForTests(fetch, () => t);
    await refreshThreads(url, PR, '/wt');
    expect(threadsFor(url)).toEqual(one);
    t += THREADS_MIN_AGE_MS - 1;
    await refreshThreads(url, PR, '/wt');
    expect(fetch).toHaveBeenCalledTimes(1);
    reply = null;
    t += 1;
    await refreshThreads(url, PR, '/wt');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(threadsFor(url)).toEqual(one);
    await refreshThreads(url, PR, '/wt', { force: true });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('a forced fetch while one is going follows it with a fresh one, so a post just made shows', async () => {
    let release: (v: ReviewThread[]) => void = () => {};
    const fetch = vi
      .fn<() => Promise<ReviewThread[] | null>>()
      .mockImplementationOnce(() => new Promise((r) => (release = r)))
      .mockImplementation(async () => one);
    setThreadsFetcherForTests(fetch, () => 5_000_000);
    const first = refreshThreads(url, PR, '/wt');
    const forced = refreshThreads(url, PR, '/wt', { force: true });
    release([]);
    await first;
    await forced;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(threadsFor(url)).toEqual(one);
  });
});
