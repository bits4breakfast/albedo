#!/usr/bin/env node
// @ts-check
// Dependency embargo (#146): fail when a lockfile change brings in a package
// version published less than EMBARGO_DAYS ago (MAJOR_EMBARGO_DAYS for a new
// major). A compromised release is usually caught and pulled within days, so
// waiting a week keeps most of them out of Albedo.
//
//   node scripts/check-release-age.mjs --base <git ref> [--head <git ref>]
//
// Only versions that are new or changed between base and head are checked;
// an old pin is never re-checked. Head defaults to the working tree.
//
// Overrides: `.dependency-embargo-allow.json` at the repo root (read from
// head, so the entry shows up in the PR diff), one entry per exact version
// with a reason. See CONTRIBUTING.md, "Dependencies".
//
// Exit codes: 0 all clear, 1 a version is under embargo, 2 could not verify
// (registry unreachable, bad allow file, bad arguments). Fails closed: a
// version whose publish time cannot be read is never let through.
//
// Zero dependencies, Node 22+ (global fetch).

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const EMBARGO_DAYS = 7;
export const MAJOR_EMBARGO_DAYS = 14;
export const NPM_LOCK = 'package-lock.json';
export const CARGO_LOCK = 'src-tauri/Cargo.lock';
export const ALLOW_FILE = '.dependency-embargo-allow.json';
const NPM_REGISTRY = 'https://registry.npmjs.org/';
const CRATES_IO_SOURCES = new Set([
  'registry+https://github.com/rust-lang/crates.io-index',
  'sparse+https://index.crates.io/',
]);
const USER_AGENT = 'albedo-dependency-embargo (https://github.com/bits4breakfast/albedo)';
const DAY_MS = 86_400_000;

/**
 * @typedef {'npm' | 'cargo'} Ecosystem
 * @typedef {{ ecosystem: Ecosystem, name: string, version: string,
 *   registry: boolean, source: string }} LockEntry
 *   `registry` is true when the version comes from the public registry and can
 *   be checked; otherwise `source` says what it is (git, file, link, ...).
 * @typedef {LockEntry & { previous: string[], major: boolean }} Change
 * @typedef {{ ecosystem: Ecosystem, name: string, version: string, reason: string }} AllowEntry
 */

/**
 * Parses a lockfileVersion 2/3 package-lock.json. One entry per distinct
 * name@version; the root project and workspace folders are not packages.
 * @param {string} text
 * @returns {LockEntry[]}
 */
export function parseNpmLock(text) {
  if (!text.trim()) return [];
  const lock = JSON.parse(text);
  const packages = lock.packages;
  if (!packages || typeof packages !== 'object') {
    throw new Error(`${NPM_LOCK}: no "packages" map (lockfileVersion ${lock.lockfileVersion}); lockfileVersion 2 or 3 is required`);
  }
  /** @type {Map<string, LockEntry>} */
  const out = new Map();
  for (const [key, entry] of Object.entries(packages)) {
    const at = key.lastIndexOf('node_modules/');
    if (at === -1) continue; // "" is the root project; other keys are workspace folders
    const name = typeof entry.name === 'string' ? entry.name : key.slice(at + 'node_modules/'.length);
    let version = typeof entry.version === 'string' ? entry.version : '';
    const resolved = typeof entry.resolved === 'string' ? entry.resolved : '';
    let registry = false;
    let source;
    if (entry.link) source = `link to ${resolved || '?'}`;
    else if (entry.inBundle) source = 'bundled inside its parent package';
    else if (resolved.startsWith(NPM_REGISTRY)) {
      registry = true;
      source = 'npm';
    } else if (!resolved) source = 'no "resolved" field';
    else source = resolved;
    if (!version) version = '(none)';
    const id = `${name}@${version}@${registry}`;
    if (!out.has(id)) out.set(id, { ecosystem: 'npm', name, version, registry, source });
  }
  return [...out.values()];
}

/**
 * Parses Cargo.lock's [[package]] tables (name, version, source).
 * A package without `source` is a local path crate (the app itself).
 * @param {string} text
 * @returns {LockEntry[]}
 */
export function parseCargoLock(text) {
  /** @type {LockEntry[]} */
  const out = [];
  /** @type {Record<string, string> | null} */
  let cur = null;
  const flush = () => {
    if (cur && cur.name && cur.version) {
      const source = cur.source ?? '';
      const registry = CRATES_IO_SOURCES.has(source);
      out.push({
        ecosystem: 'cargo',
        name: cur.name,
        version: cur.version,
        registry,
        source: registry ? 'crates.io' : source || 'path (local crate)',
      });
    }
    cur = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      if (line.startsWith('[[package]]')) {
        flush();
        cur = {};
      } else {
        flush(); // another table, e.g. [metadata] or [[patch.unused]]
      }
      continue;
    }
    if (!cur) continue;
    const m = /^(name|version|source)\s*=\s*"([^"]*)"\s*$/.exec(line);
    if (m && m[1] && m[2] !== undefined) cur[m[1]] = m[2];
  }
  flush();
  return out;
}

/**
 * The part of a version a semver caret range treats as breaking: the major,
 * or for 0.x the first non-zero component. 1.4.2 -> "1", 0.10.3 -> "0.10".
 * @param {string} version
 */
export function breakingKey(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return version;
  const [, maj, min, pat] = m;
  if (maj !== '0') return String(maj);
  if (min !== '0') return `0.${min}`;
  return `0.0.${pat}`;
}

/**
 * New or changed versions: in head and not in base. `previous` lists the
 * base versions of the same package; `major` is true when the package
 * existed in base and none of its base versions shares this one's breaking
 * component (a new major, or a new 0.x minor).
 * @param {LockEntry[]} base
 * @param {LockEntry[]} head
 * @returns {Change[]}
 */
export function diffEntries(base, head) {
  const key = (/** @type {LockEntry} */ e) => `${e.ecosystem}\0${e.name}\0${e.version}\0${e.registry}`;
  const baseKeys = new Set(base.map(key));
  /** @type {Map<string, LockEntry[]>} */
  const byName = new Map();
  for (const e of base) {
    const k = `${e.ecosystem}\0${e.name}`;
    const list = byName.get(k) ?? [];
    list.push(e);
    byName.set(k, list);
  }
  /** @type {Change[]} */
  const changes = [];
  const seen = new Set();
  for (const e of head) {
    const k = key(e);
    if (baseKeys.has(k) || seen.has(k)) continue;
    seen.add(k);
    const before = byName.get(`${e.ecosystem}\0${e.name}`) ?? [];
    const previous = [...new Set(before.map((b) => b.version))].sort();
    const major = before.length > 0 && !before.some((b) => breakingKey(b.version) === breakingKey(e.version));
    changes.push({ ...e, previous, major });
  }
  return changes.sort((a, b) =>
    a.ecosystem === b.ecosystem ? a.name.localeCompare(b.name) || a.version.localeCompare(b.version) : a.ecosystem.localeCompare(b.ecosystem),
  );
}

/**
 * @param {string} text contents of the allow file ('' when absent)
 * @returns {AllowEntry[]}
 */
export function parseAllowList(text) {
  if (!text.trim()) return [];
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data?.allow;
  if (!Array.isArray(list)) throw new Error(`${ALLOW_FILE}: expected {"allow": [...]}`);
  return list.map((e, i) => {
    const where = `${ALLOW_FILE}: entry ${i + 1}`;
    if (!e || typeof e !== 'object') throw new Error(`${where} is not an object`);
    if (e.ecosystem !== 'npm' && e.ecosystem !== 'cargo') throw new Error(`${where}: "ecosystem" must be "npm" or "cargo"`);
    for (const f of ['name', 'version', 'reason']) {
      if (typeof e[f] !== 'string' || !e[f].trim()) throw new Error(`${where}: "${f}" is required`);
    }
    return { ecosystem: e.ecosystem, name: e.name, version: e.version, reason: e.reason.trim() };
  });
}

/**
 * The age decision for one checked version.
 * @param {{ publishedAt: Date, now: Date, major: boolean, days?: number, majorDays?: number }} o
 */
export function decideAge({ publishedAt, now, major, days = EMBARGO_DAYS, majorDays = MAJOR_EMBARGO_DAYS }) {
  const embargoDays = major ? majorDays : days;
  const ageDays = (now.getTime() - publishedAt.getTime()) / DAY_MS;
  const clearsAt = new Date(publishedAt.getTime() + embargoDays * DAY_MS);
  return { ok: ageDays >= embargoDays, ageDays, embargoDays, clearsAt };
}

/** @param {string} name */
export function npmPackumentUrl(name) {
  // "@scope/pkg" -> "@scope%2fpkg"; the registry wants the @ literal.
  return NPM_REGISTRY + encodeURIComponent(name).replace(/^%40/, '@');
}

/** @param {string} name @param {string} version */
export function cratesVersionUrl(name, version) {
  return `https://crates.io/api/v1/crates/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 */
async function getJson(fetchImpl, url) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 500 * attempt));
    try {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 404) throw Object.assign(new Error(`${url}: 404 not found`), { permanent: true });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      if (/** @type {any} */ (err)?.permanent) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Creates a publish-time lookup. npm: the full packument's `time[version]`
 * (the abbreviated install document has no `time`, measured 2026-10-30),
 * fetched once per name. crates.io: `version.created_at`; crates.io requires
 * a descriptive User-Agent.
 * @param {typeof fetch} fetchImpl
 */
export function publishTimeLookup(fetchImpl) {
  /** @type {Map<string, Promise<any>>} */
  const packuments = new Map();
  /** @param {LockEntry} e @returns {Promise<Date>} */
  return async (e) => {
    let iso;
    if (e.ecosystem === 'npm') {
      let doc = packuments.get(e.name);
      if (!doc) {
        doc = getJson(fetchImpl, npmPackumentUrl(e.name));
        packuments.set(e.name, doc);
      }
      iso = (await doc)?.time?.[e.version];
    } else {
      iso = (await getJson(fetchImpl, cratesVersionUrl(e.name, e.version)))?.version?.created_at;
    }
    const date = typeof iso === 'string' ? new Date(iso) : null;
    if (!date || Number.isNaN(date.getTime())) {
      throw new Error(`no publish time for ${e.name}@${e.version} in the ${e.ecosystem === 'npm' ? 'npm registry' : 'crates.io'} response`);
    }
    return date;
  };
}

/**
 * Runs `fn` over `items` with at most `limit` in flight.
 * @template T, R
 * @param {T[]} items @param {number} limit @param {(t: T) => Promise<R>} fn
 * @returns {Promise<PromiseSettledResult<R>[]>}
 */
export async function mapLimit(items, limit, fn) {
  /** @type {PromiseSettledResult<R>[]} */
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(/** @type {T} */ (items[i])) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * The whole check, without I/O of its own beyond `fetchImpl`.
 * @param {{ base: { npm: string, cargo: string }, head: { npm: string, cargo: string },
 *   allow: string, now: Date, fetchImpl: typeof fetch, days?: number, majorDays?: number,
 *   concurrency?: number }} o
 * @returns {Promise<{ code: 0 | 1 | 2, lines: string[] }>}
 */
export async function checkReleaseAge({ base, head, allow, now, fetchImpl, days = EMBARGO_DAYS, majorDays = MAJOR_EMBARGO_DAYS, concurrency = 8 }) {
  const lines = [];
  const changes = [
    ...diffEntries(parseNpmLock(base.npm), parseNpmLock(head.npm)),
    ...diffEntries(parseCargoLock(base.cargo), parseCargoLock(head.cargo)),
  ];
  const allowList = parseAllowList(allow);
  const label = (/** @type {Change} */ c) =>
    `${c.ecosystem} ${c.name} ${c.previous.length ? `${c.previous.join(', ')} -> ` : '(new) '}${c.version}`;

  const skipped = changes.filter((c) => !c.registry);
  const checked = changes.filter((c) => c.registry);
  lines.push(`Dependency embargo: ${days} days, ${majorDays} for a new major. ${checked.length} new or changed registry version(s), ${skipped.length} skipped.`);
  if (skipped.length) {
    lines.push('', 'Skipped (not from the public registry, so no publish time to check -- review by hand):');
    for (const c of skipped) lines.push(`  ${label(c)}  [${c.source}]`);
  }
  if (!checked.length) return { code: 0, lines };

  const lookup = publishTimeLookup(fetchImpl);
  const results = await mapLimit(checked, concurrency, lookup);
  const blocked = [];
  const unverified = [];
  lines.push('', 'Checked:');
  checked.forEach((c, i) => {
    const r = /** @type {PromiseSettledResult<Date>} */ (results[i]);
    const allowed = allowList.find((a) => a.ecosystem === c.ecosystem && a.name === c.name && a.version === c.version);
    if (r.status === 'rejected') {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      if (allowed) lines.push(`  ALLOWED     ${label(c)}  (publish time unknown: ${msg}) -- ${allowed.reason}`);
      else {
        unverified.push(c);
        lines.push(`  UNVERIFIED  ${label(c)}  -- ${msg}`);
      }
      return;
    }
    const d = decideAge({ publishedAt: r.value, now, major: c.major, days, majorDays });
    const when = `published ${r.value.toISOString().slice(0, 10)}, ${d.ageDays.toFixed(1)} days ago, embargo ${d.embargoDays}d${c.major ? ' (new major)' : ''}`;
    if (d.ok) lines.push(`  ok          ${label(c)}  (${when})`);
    else if (allowed) lines.push(`  ALLOWED     ${label(c)}  (${when}) -- ${allowed.reason}`);
    else {
      blocked.push(c);
      lines.push(`  EMBARGOED   ${label(c)}  (${when}; clears ${d.clearsAt.toISOString().slice(0, 16).replace('T', ' ')} UTC)`);
    }
  });

  if (blocked.length) {
    lines.push(
      '',
      `${blocked.length} version(s) are younger than the embargo. Wait until they clear, pin an older version,`,
      `or, for an urgent fix, add each to ${ALLOW_FILE} with a reason (reviewed in this PR).`,
    );
  }
  if (unverified.length) {
    lines.push(
      '',
      `${unverified.length} version(s) could not be verified, so the check fails closed: the registry was`,
      'unreachable or did not report a publish time. Rerun the job; if it persists, check the registry status.',
    );
  }
  if (!blocked.length && !unverified.length) lines.push('', 'All new versions are past the embargo.');
  return { code: unverified.length ? 2 : blocked.length ? 1 : 0, lines };
}

/** @param {string} ref @param {string} path */
function gitShow(ref, path) {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const stderr = String(/** @type {any} */ (err)?.stderr ?? '');
    // The file not existing at that ref means "no packages", not an error.
    if (/does not exist in|exists on disk, but not in/.test(stderr)) return '';
    throw new Error(`git show ${ref}:${path} failed: ${stderr.trim() || err}`);
  }
}

/** @param {string} path */
function readWorking(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {{ base?: string, head?: string, days: number, majorDays: number }} */
  const o = { days: EMBARGO_DAYS, majorDays: MAJOR_EMBARGO_DAYS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    const num = () => {
      const n = Number(val());
      if (!Number.isFinite(n) || n < 0) throw new Error(`${a} needs a number of days`);
      return n;
    };
    if (a === '--base') o.base = val();
    else if (a === '--head') o.head = val();
    else if (a === '--days') o.days = num();
    else if (a === '--major-days') o.majorDays = num();
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.base) throw new Error('--base <git ref> is required');
  return o;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`check-release-age: ${err instanceof Error ? err.message : err}`);
    console.error('usage: node scripts/check-release-age.mjs --base <ref> [--head <ref>] [--days 7] [--major-days 14]');
    process.exit(2);
  }
  const { base: baseRef, head: headRef } = opts;
  try {
    const read = (/** @type {string} */ p) => (headRef ? gitShow(headRef, p) : readWorking(p));
    const result = await checkReleaseAge({
      base: { npm: gitShow(/** @type {string} */ (baseRef), NPM_LOCK), cargo: gitShow(/** @type {string} */ (baseRef), CARGO_LOCK) },
      head: { npm: read(NPM_LOCK), cargo: read(CARGO_LOCK) },
      allow: read(ALLOW_FILE),
      now: new Date(),
      fetchImpl: fetch,
      days: opts.days,
      majorDays: opts.majorDays,
    });
    console.log(`Base ${baseRef}, head ${headRef ?? 'working tree'}.`);
    for (const l of result.lines) console.log(l);
    process.exit(result.code);
  } catch (err) {
    console.error(`check-release-age: ${err instanceof Error ? err.message : err}`);
    console.error('Failing closed: nothing was verified.');
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
