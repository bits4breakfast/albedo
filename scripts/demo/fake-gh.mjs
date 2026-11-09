#!/usr/bin/env node
// The demo profile's `gh`: answers what Albedo asks about the made-up pull
// requests in ~/.albedo-demo/prs.json, so tasks can show open PRs, their
// checks and their review state without a GitHub repository:
//
//   gh api graphql … -f branch=<b> -f query=<PR_QUERY>   the PR badge and its group
//   gh api graphql … -F requested=… -f query=<REVIEWS_QUERY>  the Reviewing tab (reviews.json)
//   gh pr view <branch> --json …                           a branch's PR (New Task)
//   gh pr checks <n> --json …                              the Checks dialog
//   gh run view <run> -R <repo> --json jobs                a job's steps
//   gh api user --jq .login                                who is signed in
//   gh api graphql … -F number=<n> -f query=<THREADS_QUERY>  a PR's review threads (#287)
//   gh api -X POST repos/…/pulls/<n>/reviews --input <f>   Submit Review: recorded, and
//   gh api -X POST repos/…/pulls/<n>/comments/<id>/replies  shown as threads from then on
//
// Anything else fails the way gh does when there is no PR, which Albedo reads
// as "no badge" (or, for a merge, shows as the refusal).

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const file = join(homedir(), '.albedo-demo', 'prs.json');
const prs = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
const reviewsFile = join(homedir(), '.albedo-demo', 'reviews.json');
const reviews = existsSync(reviewsFile) ? JSON.parse(readFileSync(reviewsFile, 'utf8')) : {};
// What Submit Review sent (#287), one JSON line per request, so a demo
// review shows up as threads afterwards. Never sent anywhere.
const postedFile = join(homedir(), '.albedo-demo', 'posted-reviews.jsonl');
const posted = () =>
  existsSync(postedFile)
    ? readFileSync(postedFile, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l))
    : [];

const fail = (msg) => {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
};
const print = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);

const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] ?? null : null;
};
const fieldsArg = () => (flag('--json') ?? '').split(',');
const pick = (obj, fields) => Object.fromEntries(fields.filter((f) => f in obj).map((f) => [f, obj[f]]));

/** `-f key=value` and `-F key=value` pairs, as gh api takes them. */
function apiFields() {
  const out = {};
  args.forEach((a, i) => {
    if ((a === '-f' || a === '-F') && args[i + 1]) {
      const v = args[i + 1];
      const eq = v.indexOf('=');
      if (eq > 0) out[v.slice(0, eq)] = v.slice(eq + 1);
    }
  });
  return out;
}

function headOf(branch) {
  try {
    return execFileSync('git', ['rev-parse', branch], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const runId = (pr) => 4100 + pr.number;
const jobId = (pr, i) => 52000 + pr.number * 10 + i;

/** One run per check, finished a few minutes ago, or still going. */
function checksOf(pr) {
  const done = Date.now() - 6 * 60_000;
  return pr.checks.map((c, i) => ({
    name: c.name,
    state: c.state,
    workflow: 'CI',
    startedAt: new Date(done - (90 + i * 40) * 1000).toISOString(),
    completedAt: c.state === 'pending' ? null : new Date(done).toISOString(),
    link: `${pr.url.replace(/\/pull\/\d+$/, '')}/actions/runs/${runId(pr)}/job/${jobId(pr, i)}`,
  }));
}

const CONCLUSION = { pass: 'SUCCESS', fail: 'FAILURE' };

/** The PR as PR_QUERY (src/gh/prStatus.ts) asks for it. */
function graphqlNode(branch, pr) {
  const reviews = pr.reviews ?? [];
  const threads = pr.threads ?? { total: 0, unresolved: 0 };
  const approved = reviews.some((r) => r.state === 'APPROVED');
  const changes = reviews.some((r) => r.state === 'CHANGES_REQUESTED');
  return {
    number: pr.number,
    url: pr.url,
    state: 'OPEN',
    isDraft: false,
    title: pr.title,
    reviewDecision: changes ? 'CHANGES_REQUESTED' : approved ? 'APPROVED' : null,
    mergedAt: null,
    headRefName: branch,
    baseRefName: pr.base,
    headRefOid: headOf(branch),
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    author: { __typename: 'User', login: 'sam-rivera' },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: checksOf(pr).map((c) => ({
                  __typename: 'CheckRun',
                  name: c.name,
                  checkSuite: { workflowRun: { workflow: { name: c.workflow } } },
                  status: c.state === 'pending' ? 'IN_PROGRESS' : 'COMPLETED',
                  conclusion: CONCLUSION[c.state] ?? null,
                  startedAt: c.startedAt,
                  completedAt: c.completedAt,
                  detailsUrl: c.link,
                })),
              },
            },
          },
        },
      ],
    },
    latestReviews: {
      nodes: reviews.map((r) => ({ author: { login: r.author }, submittedAt: ago(r.minutesAgo), state: r.state })),
    },
    reviewRequests: { nodes: [] },
    reviewThreads: {
      totalCount: threads.total,
      nodes: Array.from({ length: threads.total }, (_, i) => ({ isResolved: i >= threads.unresolved })),
    },
  };
}

/** The same PR as `gh pr view --json` prints it. */
function prView(branch, pr) {
  const node = graphqlNode(branch, pr);
  return {
    ...node,
    latestReviews: node.latestReviews.nodes,
    reviewRequests: [],
    statusCheckRollup: node.commits.nodes[0].commit.statusCheckRollup.contexts.nodes.map(({ checkSuite, ...c }) => ({
      ...c,
      workflowName: checkSuite.workflowRun.workflow.name,
    })),
  };
}

/** A job and its steps, as `gh run view --json jobs` lists them. */
function jobOf(pr, c, i) {
  const running = c.state === 'pending';
  const steps = ['Set up job', 'Run actions/checkout@v4', 'Install dependencies', `Run npm run ${c.name}`, 'Complete job'];
  return {
    databaseId: jobId(pr, i),
    name: c.name,
    status: running ? 'in_progress' : 'completed',
    conclusion: running ? '' : c.state === 'pass' ? 'success' : 'failure',
    url: c.link,
    steps: steps.map((name, n) => {
      const waiting = running && n >= 3;
      return {
        number: n + 1,
        name,
        status: waiting ? (n === 3 ? 'in_progress' : 'queued') : 'completed',
        conclusion: waiting ? '' : c.state === 'fail' && n === 3 ? 'failure' : 'success',
        startedAt: waiting && n > 3 ? null : c.startedAt,
        completedAt: waiting ? null : (c.completedAt ?? c.startedAt),
      };
    }),
  };
}

/** A PR asking for your review, as REVIEWS_QUERY (src/gh/reviewRequests.ts) asks for it. */
function reviewNode(repoName, r) {
  const me = { __typename: 'User', login: 'sam-rivera' };
  const reviewer = r.team ? { __typename: 'Team', slug: r.team } : me;
  const requested = r.section === 'requested';
  return {
    number: r.number,
    title: r.title,
    url: `https://github.com/example/${repoName}/pull/${r.number}`,
    isDraft: false,
    createdAt: ago(r.lastCommitMinutes + 60),
    updatedAt: ago(Math.min(r.lastCommitMinutes, ...(r.talk ?? []).map((t) => t.minutesAgo))),
    additions: r.additions,
    deletions: r.deletions,
    headRefOid: r.head ?? `${r.number}`.padStart(40, '0'),
    baseRefName: 'main',
    author: { login: r.author },
    commits: { totalCount: r.commits, nodes: [{ commit: { committedDate: ago(r.lastCommitMinutes) } }] },
    comments: { nodes: (r.talk ?? []).map((t) => ({ author: { login: t.author }, createdAt: ago(t.minutesAgo) })) },
    reviews: { nodes: [] },
    reviewRequests: { nodes: requested ? [{ requestedReviewer: reviewer }] : [] },
    timelineItems: {
      nodes: requested
        ? [{ __typename: 'ReviewRequestedEvent', createdAt: ago(r.requestedMinutes), requestedReviewer: reviewer }]
        : [],
    },
  };
}

/** The hunk GitHub would quote for a line of a file the PR adds whole. */
function hunkOf(text, line) {
  const lines = (text ?? '').split('\n').slice(0, line);
  return `@@ -0,0 +1,${line} @@\n${lines.map((l) => `+${l}`).join('\n')}`;
}

/** Comment ids: the scenario's from 7000, Submit Review's from 8000. */
function threadsOf(r) {
  const out = (r.threads ?? []).map((t, i) => ({
    id: `PRRT_demo_${r.number}_${i}`,
    isResolved: t.resolved === true,
    isOutdated: false,
    path: t.path,
    line: t.line,
    startLine: null,
    originalLine: t.line,
    diffSide: 'RIGHT',
    comments: {
      nodes: t.comments.map((c, j) => ({
        databaseId: 7000 + r.number * 10 + i * 100 + j,
        author: { login: c.author },
        body: c.body,
        createdAt: ago(c.minutesAgo),
        diffHunk: hunkOf(r.files?.[t.path], t.line),
      })),
    },
  }));
  let id = 8000;
  for (const p of posted().filter((x) => x.number === r.number)) {
    if (p.kind === 'review') {
      for (const c of p.review.comments ?? []) {
        out.push({
          id: `PRRT_demo_posted_${id}`,
          isResolved: false,
          isOutdated: false,
          path: c.path,
          line: c.line,
          startLine: c.start_line ?? null,
          originalLine: c.line,
          diffSide: 'RIGHT',
          comments: {
            nodes: [{ databaseId: id, author: { login: 'sam-rivera' }, body: c.body, createdAt: p.at, diffHunk: hunkOf(r.files?.[c.path], c.line) }],
          },
        });
        id += 1;
      }
    } else {
      const t = out.find((x) => x.comments.nodes[0].databaseId === p.to);
      t?.comments.nodes.push({ databaseId: id, author: { login: 'sam-rivera' }, body: p.body, createdAt: p.at, diffHunk: '' });
      id += 1;
    }
  }
  return out;
}

/** The review in the scenario a `repos/<owner>/<repo>/pulls/<n>` path names. */
function reviewAt(repoName, number) {
  const key = Object.keys(reviews).find((k) => k.split('/').pop() === repoName);
  return (key ? reviews[key] : []).find((r) => r.number === Number(number)) ?? null;
}

const [a0, a1, a2] = args;
const postPath = args.find((a) => /^repos\/[^/]+\/[^/]+\/pulls\/\d+\//.test(a));

if (a0 === 'api' && a1 === 'graphql' && 'requested' in apiFields()) {
  // The Reviewing tab's one request: the PRs asking for your review here.
  // process.cwd() is the real path; the keys may go through a symlink (/var on macOS).
  const repo = Object.keys(reviews).find((k) => existsSync(k) && realpathSync(k) === process.cwd());
  const list = repo ? reviews[repo] : [];
  const name = (repo ?? process.cwd()).split('/').pop();
  const of = (section) => list.filter((r) => r.section === section).map((r) => reviewNode(name, r));
  print({
    data: { viewer: { login: 'sam-rivera' }, requested: { nodes: of('requested') }, reviewed: { nodes: of('reviewed') } },
  });
} else if (a0 === 'api' && a1 === 'graphql' && /query Threads/.test(apiFields().query ?? '')) {
  // A review task's threads (src/gh/reviewThreads.ts).
  const { repo, number } = apiFields();
  const r = reviewAt(repo, number);
  if (!r) fail('GraphQL: Could not resolve to a PullRequest with the number of ' + number + '.');
  print({ data: { repository: { pullRequest: { reviewThreads: { nodes: threadsOf(r) } } } } });
} else if (a0 === 'api' && postPath) {
  // Submit Review (src/gh/reviewSubmit.ts): recorded, never sent.
  const [, , repoName, , number, rest, id] = postPath.split('/');
  if (!reviewAt(repoName, number)) fail('gh: Not Found (HTTP 404)');
  const at = new Date().toISOString();
  if (rest === 'reviews') {
    const review = JSON.parse(readFileSync(flag('--input'), 'utf8'));
    appendFileSync(postedFile, `${JSON.stringify({ kind: 'review', number: Number(number), at, review })}\n`);
    print({ id: 1, state: review.event === 'APPROVE' ? 'APPROVED' : review.event === 'REQUEST_CHANGES' ? 'CHANGES_REQUESTED' : 'COMMENTED' });
  } else if (rest === 'comments' && id) {
    const body = apiFields().body ?? '';
    appendFileSync(postedFile, `${JSON.stringify({ kind: 'reply', number: Number(number), at, to: Number(id), body })}\n`);
    print({ id: 2, body });
  } else {
    fail('gh: Not Found (HTTP 404)');
  }
} else if (a0 === 'api' && a1 === 'graphql') {
  // The PR store's one request: the PRs whose head is the branch.
  const { branch } = apiFields();
  const pr = prs[branch];
  print({ data: { repository: { pullRequests: { nodes: pr ? [graphqlNode(branch, pr)] : [] } } } });
} else if (a0 === 'pr' && a1 === 'view') {
  const pr = prs[a2];
  if (!pr) fail(`no pull requests found for branch "${a2}"`);
  print(pick(prView(a2, pr), fieldsArg()));
} else if (a0 === 'pr' && a1 === 'checks') {
  const pr = Object.values(prs).find((p) => String(p.number) === a2);
  if (!pr) fail(`no pull request found for #${a2}`);
  print(checksOf(pr).map((c) => pick({ ...c, bucket: c.state, description: '' }, fieldsArg())));
} else if (a0 === 'run' && a1 === 'view') {
  const pr = Object.values(prs).find((p) => String(runId(p)) === a2);
  if (!pr) fail(`could not find any workflow run with ID ${a2}`);
  print({ jobs: checksOf(pr).map((c, i) => jobOf(pr, c, i)) });
} else if (a0 === 'api' && a1 === 'user') {
  // Who is signed in: the made-up author of the made-up pull requests.
  process.stdout.write('sam-rivera\n');
} else {
  fail(`The demo profile's gh does not answer this (asked: gh ${args.join(' ')}).`);
}
