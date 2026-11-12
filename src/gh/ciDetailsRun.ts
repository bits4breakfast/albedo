/**
 * Fetching a queued CI failure's details (#280, step 2), the effects half of
 * `ciDetails.ts`. Two sources, chosen per project:
 *
 *   - **GitHub Actions**: for each failing check that is an Actions job, the
 *     job's steps and its log -- `fetchJob` / `fetchJobLog` in gh.ts, the same
 *     calls the Checks dialog makes -- cut to the failing step by
 *     `failureLines` (checks.ts), as the dialog does.
 *   - **A command**: the project's saved `ciDetailsCommand`, run through the
 *     `ci-details-sh` shell scope (src-tauri/capabilities/default.json).
 *
 * **The command comes from the project row, and only from there.**
 * `ciShellScript` takes a `Project` and reads `ciDetailsCommand` off it;
 * nothing else reaches the script. The failing checks (names and links that
 * GitHub, a PR author or a CI system wrote) go to the command as data, in an
 * environment variable the script's fixed preamble hands to stdin -- never
 * into the script text. CLAUDE.md records this widening.
 *
 * Every fetch ends within {@link CI_DETAILS_TIMEOUT_MS}, and never throws:
 * any failure is a `failed` state with a short reason.
 */

import type { Project } from '../types';
import { fetchJob, fetchJobLog } from './gh';
import { checkSource, failedStep, failureLines } from './checks';
import { withoutAnthropicKeys } from '../lib/spawnEnv';
import {
  CI_DETAILS_TIMEOUT_MS,
  clipLog,
  commandInput,
  exitReason,
  parseCommandOutput,
  type CheckDetail,
  type CiDetailsState,
  type FailureForDetails,
} from './ciDetails';

// ---------------------------------------------------------------------------
// The shell scope
// ---------------------------------------------------------------------------

/** The scope name in capabilities/default.json. Used here and nowhere else. */
export const CI_SH_SCOPE = 'ci-details-sh';

/**
 * Before the owner's command, always, and matched by the scope's validator:
 * the Anthropic credentials go (hard rule 3), and the input becomes stdin.
 * The heredoc expands `$ALBEDO_CI_INPUT` once; what it expands to is not
 * read again by the shell, so a check name cannot become code.
 */
export const CI_SH_PREAMBLE =
  'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL\n' +
  'exec 0<<ALBEDO_CI_EOF\n' +
  '$ALBEDO_CI_INPUT\n' +
  'ALBEDO_CI_EOF\n' +
  'unset ALBEDO_CI_INPUT\n';

/** The script `/bin/sh -c` runs for this project, or null when it has no command. */
export function ciShellScript(project: Pick<Project, 'ciDetailsCommand'>): string | null {
  const cmd = project.ciDetailsCommand?.trim();
  return cmd ? `${CI_SH_PREAMBLE}${cmd}\n` : null;
}

export interface ShellOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs one script; never throws for a non-zero exit, only when it could not start. */
export type CiShellRunner = (
  script: string,
  opts: { cwd: string; input: string; timeoutMs: number },
) => Promise<ShellOutcome>;

/** Enough for 4 KB per check, with room; past this the output is not read. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

const tauriShell: CiShellRunner = async (script, { cwd, input, timeoutMs }) => {
  const { Command } = await import('@tauri-apps/plugin-shell');
  const command = Command.create(CI_SH_SCOPE, ['-c', script], {
    cwd,
    encoding: 'raw',
    // Its own process group, so a timeout stops whatever it started too.
    processGroup: true,
    // The plugin cannot unset a variable; the preamble does. Blanked here
    // as well, as phpantom.ts does, in case the preamble is ever changed.
    env: withoutAnthropicKeys({ ALBEDO_CI_INPUT: input }),
  });
  const out = { stdout: [] as Uint8Array[], stderr: [] as Uint8Array[], size: 0 };
  const take = (into: Uint8Array[]) => (chunk: Uint8Array | number[] | string) => {
    const b = chunk instanceof Uint8Array ? chunk : typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    if (out.size + b.length > MAX_OUTPUT_BYTES) return;
    out.size += b.length;
    into.push(b);
  };
  command.stdout.on('data', take(out.stdout));
  command.stderr.on('data', take(out.stderr));
  const text = (parts: Uint8Array[]) => new TextDecoder().decode(concat(parts));
  return new Promise<ShellOutcome>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const finish = (code: number | null, timedOut: boolean) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout: text(out.stdout), stderr: text(out.stderr), timedOut });
    };
    command.on('close', (p) => finish(p.code, false));
    // A read error on its output; the close that follows ends the run.
    command.on('error', (e) => console.warn('[ci details] reading the command’s output failed', e));
    command.spawn().then(
      (child) => {
        timer = setTimeout(() => {
          child.kill().catch((err: unknown) => console.warn('[ci details] could not stop the command', err));
          finish(null, true);
        }, timeoutMs);
      },
      (err: unknown) => {
        done = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
};

function concat(parts: Uint8Array[]): Uint8Array {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return all;
}

let shell: CiShellRunner = tauriShell;

/** Test seam. Returns the previous runner. */
export function setCiShellRunner(next: CiShellRunner): CiShellRunner {
  const prev = shell;
  shell = next;
  return prev;
}

// ---------------------------------------------------------------------------
// The two sources
// ---------------------------------------------------------------------------

/** The project's command, on this failure, in `cwd`. */
export async function runDetailsCommand(
  project: Pick<Project, 'ciDetailsCommand'>,
  cwd: string,
  failure: FailureForDetails,
  timeoutMs = CI_DETAILS_TIMEOUT_MS,
): Promise<CiDetailsState> {
  const script = ciShellScript(project);
  if (!script) return { state: 'failed', reason: 'the project has no command' };
  let r: ShellOutcome;
  try {
    r = await shell(script, { cwd, input: JSON.stringify(commandInput(failure)), timeoutMs });
  } catch (err) {
    return { state: 'failed', reason: `the command could not be started (${err instanceof Error ? err.message : String(err)})` };
  }
  if (r.timedOut) return { state: 'failed', reason: `the command took longer than ${Math.round(timeoutMs / 1000)} s` };
  if (r.code !== 0) return { state: 'failed', reason: exitReason(r.code, r.stderr) };
  const parsed = parseCommandOutput(r.stdout, failure.checks.map((c) => c.name));
  return parsed.ok ? { state: 'ready', checks: parsed.checks } : { state: 'failed', reason: parsed.reason };
}

/** Each failing Actions job's failing step and log tail, as the Checks dialog reads them. */
export async function fetchActionsDetails(failure: FailureForDetails): Promise<CiDetailsState> {
  const jobs = failure.checks.flatMap((c) => {
    const source = checkSource(c.url);
    return source.kind === 'actions' ? [{ name: c.name, source }] : [];
  });
  if (jobs.length === 0) return { state: 'failed', reason: 'none of these checks is a GitHub Actions job' };
  const found = await Promise.all(
    jobs.map(async ({ name, source }): Promise<CheckDetail | null> => {
      const [job, log] = await Promise.all([fetchJob(source), fetchJobLog(source)]);
      if (!job) return null;
      const step = failedStep(job)?.name ?? null;
      const clipped = log === null ? { log: [], more: 0 } : clipLog(failureLines(log, job));
      return step || clipped.log.length > 0 ? { name, step, ...clipped } : null;
    }),
  );
  const checks = found.filter((d): d is CheckDetail => d !== null);
  if (checks.length === 0) return { state: 'failed', reason: 'GitHub did not give the jobs’ steps or logs' };
  return { state: 'ready', checks };
}

/** Settles with `fallback` once `ms` pass, whatever `p` is doing. */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/**
 * One failure's details, by the project's setting. `none` for name and link
 * only; otherwise `ready` or `failed`, within the time limit, never thrown.
 */
export async function fetchCiDetails(
  project: Pick<Project, 'ciDetails' | 'ciDetailsCommand'>,
  cwd: string,
  failure: FailureForDetails,
  timeoutMs = CI_DETAILS_TIMEOUT_MS,
): Promise<CiDetailsState> {
  const late: CiDetailsState = { state: 'failed', reason: `fetching took longer than ${Math.round(timeoutMs / 1000)} s` };
  switch (project.ciDetails) {
    case 'link':
      return { state: 'none' };
    case 'actions':
      return within(fetchActionsDetails(failure), timeoutMs, late);
    case 'command':
      // The runner stops the command at the limit; the race is a backstop
      // for a close event that never comes.
      return within(runDetailsCommand(project, cwd, failure, timeoutMs), timeoutMs + 1_000, late);
  }
}
