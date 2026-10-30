#!/usr/bin/env node
// @ts-check
// Add or upgrade npm packages without taking anything published in the last
// EMBARGO_DAYS (#146): `npm install --before=<now - 7 days> <pkg...>`.
//
//   npm run deps:add -- <pkg...>        dependencies
//   npm run deps:add-dev -- <pkg...>    devDependencies (passes --save-dev)
//
// `--before` makes npm resolve every version it picks in this install as if
// it were that date, so a range like ^2 gets the newest version that is at
// least a week old, and an exact version newer than that fails (ETARGET)
// instead of being installed. The CI gate (scripts/check-release-age.mjs)
// checks the result either way; this only saves a red PR. A new major still
// needs 14 days there.

import { spawnSync } from 'node:child_process';
import { EMBARGO_DAYS } from './check-release-age.mjs';

const args = process.argv.slice(2);
if (!args.some((a) => !a.startsWith('-'))) {
  console.error('usage: npm run deps:add -- <pkg[@range]> [...]   (or deps:add-dev)');
  process.exit(2);
}
if (args.some((a) => a.startsWith('--before'))) {
  console.error('deps:add sets --before itself; leave it out.');
  process.exit(2);
}

const before = new Date(Date.now() - EMBARGO_DAYS * 86_400_000).toISOString();
const npmArgs = ['install', `--before=${before}`, ...args];
console.log(`npm ${npmArgs.join(' ')}`);

// Inside `npm run`, npm_execpath is the npm that is running us; use the same one.
const npmCli = process.env.npm_execpath;
const res = npmCli
  ? spawnSync(process.execPath, [npmCli, ...npmArgs], { stdio: 'inherit' })
  : spawnSync('npm', npmArgs, { stdio: 'inherit', shell: process.platform === 'win32' });
if (res.error) {
  console.error(`deps:add: could not run npm: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
