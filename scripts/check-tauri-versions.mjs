#!/usr/bin/env node
// @ts-check
// Tauri's JS and Rust halves in step (#177): fail when an `@tauri-apps/*`
// package and its crate differ in major.minor -- the check `tauri build` and
// `tauri dev` make before anything else, run here on every push so a one-sided
// bump fails on its own PR and not on the next local build. Dependabot bumps
// npm and cargo in separate groups (and the embargo can hold one back), which
// is how #160 moved `@tauri-apps/api` to 2.12 while `tauri` stayed on 2.11.
//
//   node scripts/check-tauri-versions.mjs
//
// Pairs, as the CLI makes them: `@tauri-apps/api` with `tauri`, and
// `@tauri-apps/plugin-<x>` with `tauri-plugin-<x>`. Versions are the installed
// ones, from package-lock.json and src-tauri/Cargo.lock. Exit 0 in step, 1 not.
//
// Zero dependencies.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CARGO_LOCK, NPM_LOCK, parseCargoLock } from './check-release-age.mjs';

/**
 * The top-level `@tauri-apps/*` packages of a package-lock.json, by name.
 * Nested copies are left out: the app imports the top-level one.
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function tauriNpmVersions(text) {
  const packages = JSON.parse(text).packages ?? {};
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const [key, entry] of Object.entries(packages)) {
    const m = /^node_modules\/(@tauri-apps\/[^/]+)$/.exec(key);
    if (m && m[1] && typeof entry.version === 'string') out.set(m[1], entry.version);
  }
  return out;
}

/**
 * The crate an `@tauri-apps/*` package must match; null when it has none
 * (`@tauri-apps/cli`, the CLI's per-platform binaries).
 * @param {string} npmName
 */
export function crateFor(npmName) {
  if (npmName === '@tauri-apps/api') return 'tauri';
  const m = /^@tauri-apps\/plugin-(.+)$/.exec(npmName);
  return m ? `tauri-plugin-${m[1]}` : null;
}

/** @param {string} v */
const majorMinor = (v) => v.split('.').slice(0, 2).join('.');

/**
 * Every pair whose major.minor differ. A package whose crate is not in the
 * lockfile is not a pair (a JS-only helper), so it is not reported.
 * @param {Map<string, string>} npm
 * @param {Map<string, string>} cargo
 * @returns {{ npm: string; npmVersion: string; crate: string; crateVersion: string }[]}
 */
export function mismatches(npm, cargo) {
  const out = [];
  for (const [name, npmVersion] of npm) {
    const crate = crateFor(name);
    const crateVersion = crate ? cargo.get(crate) : undefined;
    if (!crate || crateVersion === undefined) continue;
    if (majorMinor(npmVersion) !== majorMinor(crateVersion)) out.push({ npm: name, npmVersion, crate, crateVersion });
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const npm = tauriNpmVersions(readFileSync(NPM_LOCK, 'utf8'));
  /** @type {Map<string, string>} */
  const cargo = new Map();
  for (const e of parseCargoLock(readFileSync(CARGO_LOCK, 'utf8'))) if (e.registry) cargo.set(e.name, e.version);
  const bad = mismatches(npm, cargo);
  if (bad.length === 0) {
    console.log(`Tauri JS and Rust packages in step (${npm.size} @tauri-apps packages checked).`);
    process.exit(0);
  }
  console.log('Tauri JS and Rust packages differ in major.minor; `tauri build` refuses this:');
  for (const b of bad) console.log(`  ${b.crate} (${b.crateVersion}) : ${b.npm} (${b.npmVersion})`);
  console.log('Bump both sides together (a crate and its @tauri-apps package), within the dependency embargo.');
  process.exit(1);
}
