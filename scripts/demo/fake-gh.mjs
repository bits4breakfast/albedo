#!/usr/bin/env node
// The demo profile's `gh`: answers `gh pr view` and `gh pr checks` for the
// made-up pull requests in ~/.albedo-demo/prs.json, so a task can show an
// open PR with green checks without a GitHub repository. Anything else fails
// the way gh does when there is no PR, which Albedo reads as "no badge".

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const file = join(homedir(), '.albedo-demo', 'prs.json');
const prs = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};

const fail = (msg) => {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
};

const fieldsArg = () => {
  const i = args.indexOf('--json');
  return i >= 0 ? (args[i + 1] ?? '').split(',') : [];
};
const pick = (obj, fields) => Object.fromEntries(fields.filter((f) => f in obj).map((f) => [f, obj[f]]));

function headOf(branch) {
  try {
    return execFileSync('git', ['rev-parse', branch], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** One finished run per check, all passed, a few minutes ago. */
function checksOf(pr) {
  const done = Date.now() - 6 * 60_000;
  return pr.checks.map((name, i) => ({
    name,
    workflow: 'CI',
    startedAt: new Date(done - (90 + i * 40) * 1000).toISOString(),
    completedAt: new Date(done).toISOString(),
    link: `${pr.url.replace(/\/pull\/\d+$/, '')}/actions/runs/${4100 + pr.number}/job/${52000 + i}`,
  }));
}

if (args[0] === 'pr' && args[1] === 'view') {
  const branch = args[2];
  const pr = prs[branch];
  if (!pr) fail(`no pull requests found for branch "${branch}"`);
  const view = {
    number: pr.number,
    url: pr.url,
    state: 'OPEN',
    isDraft: false,
    title: pr.title,
    reviewDecision: '',
    mergedAt: null,
    headRefName: branch,
    baseRefName: pr.base,
    headRefOid: headOf(branch),
    statusCheckRollup: checksOf(pr).map((c) => ({
      __typename: 'CheckRun',
      name: c.name,
      workflowName: c.workflow,
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      startedAt: c.startedAt,
      completedAt: c.completedAt,
      detailsUrl: c.link,
    })),
  };
  process.stdout.write(`${JSON.stringify(pick(view, fieldsArg()))}\n`);
} else if (args[0] === 'pr' && args[1] === 'checks') {
  const pr = Object.values(prs).find((p) => String(p.number) === args[2]);
  if (!pr) fail(`no pull request found for #${args[2]}`);
  const rows = checksOf(pr).map((c) => pick({ ...c, bucket: 'pass', description: '' }, fieldsArg()));
  process.stdout.write(`${JSON.stringify(rows)}\n`);
} else {
  fail(`The demo profile's gh only answers "gh pr view" and "gh pr checks" (asked: gh ${args.join(' ')}).`);
}
