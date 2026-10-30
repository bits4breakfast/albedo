/**
 * What vite.config.ts embeds as `__ALBEDO_BUILD__`: run at build time, under
 * Node, never in the app (it imports `node:child_process`; only the Vite
 * config imports this file).
 *
 * Fails soft, part by part. Outside a git checkout, or with no `git` at all,
 * the whole thing is null, as before. A history that cannot be read (a
 * shallow clone reads fine, just shorter) is an empty list, and a remote that
 * is not GitHub is a null `repo`: the build still says which commit it is.
 * No network: every command reads the local repository.
 */

import { execFileSync } from 'node:child_process';
import type { BuildCommit, BuildInfo } from './build';

/** Runs `git <args>` and returns its trimmed stdout; throws when git fails or is missing. */
export type GitRunner = (args: string[]) => string;

/** How much first-parent history to embed: enough for months of merges, a few KB. */
export const HISTORY_LIMIT = 300;

// ASCII unit and record separators: neither can appear in a one-line subject.
const FIELD = '\x1f';
const RECORD = '\x1e';

/** `git` run in `cwd` (default: the current folder). `bin` is for tests: a git that is not there. */
export function gitRunner(cwd?: string, bin = 'git'): GitRunner {
  return (args) =>
    execFileSync(bin, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/**
 * A squash merge's subject ends in its PR number: `Title (#123)`. Only the
 * last one is the PR -- `Title (#57) (#68)` is issue #57 merged as PR #68 --
 * so only the last is taken off.
 */
export function splitSubject(subject: string): { subject: string; pr: number | null } {
  const m = /^(.*?)\s*\(#(\d+)\)\s*$/.exec(subject);
  if (!m || m[1] === '') return { subject: subject.trim(), pr: null };
  return { subject: m[1]!, pr: Number(m[2]) };
}

/** `git log --format=%h%x1f%s%x1e` output as commits, newest first. Malformed records are skipped. */
export function parseHistory(raw: string): BuildCommit[] {
  const out: BuildCommit[] = [];
  for (const record of raw.split(RECORD)) {
    const line = record.replace(/^\s+/, '');
    const at = line.indexOf(FIELD);
    if (at <= 0) continue;
    const sha = line.slice(0, at).trim();
    if (!/^[0-9a-f]{4,40}$/.test(sha)) continue;
    out.push({ sha, ...splitSubject(line.slice(at + 1)) });
  }
  return out;
}

/**
 * The repository's GitHub page from its `origin` URL, in any of the forms git
 * accepts: `git@github.com:o/r.git`, `ssh://git@github.com/o/r`,
 * `https://github.com/o/r.git`. Null for anything that is not GitHub: a PR
 * number is then shown without a link rather than linked somewhere wrong.
 */
export function githubRepoUrl(remote: string): string | null {
  const m =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/(?:[^@/]+@)?github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      remote.trim(),
    );
  if (!m) return null;
  return `https://github.com/${m[1]}/${m[2]}`;
}

/** Which commit this build is, its recent history, and where its PRs live. Null outside a git checkout. */
export function buildInfo(git: GitRunner = gitRunner(), now: Date = new Date()): BuildInfo | null {
  let sha: string;
  let dirty: boolean;
  try {
    sha = git(['rev-parse', '--short', 'HEAD']);
    dirty = git(['status', '--porcelain']) !== '';
  } catch {
    return null;
  }
  let history: BuildCommit[] = [];
  try {
    history = parseHistory(
      git(['log', '--first-parent', '-n', String(HISTORY_LIMIT), `--format=%h${FIELD}%s${RECORD}`]),
    );
  } catch {
    /* no history to show; the build is still identified */
  }
  let repo: string | null = null;
  try {
    repo = githubRepoUrl(git(['remote', 'get-url', 'origin']));
  } catch {
    /* no origin */
  }
  return { sha, dirty, at: now.toISOString(), repo, history };
}
