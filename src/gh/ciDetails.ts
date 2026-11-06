/**
 * What a queued CI failure carries beyond names and links (#280, step 2):
 * per failing check, the step that failed and the end of its log. Pure: the
 * fetching is `ciDetailsRun.ts`, the queue is `ui/transcript/ciFailure.ts`.
 *
 * Each project says where details come from (`Project.ciDetails`):
 *   - `link`: nowhere. Claude reads the failure with its own tools.
 *   - `actions`: GitHub Actions, through what the Checks dialog fetches.
 *   - `command`: a command the owner saved on the project, run with the
 *     contract below.
 *
 * ## The command contract
 *
 * Run as `/bin/sh -c <the saved command>` in the task's folder, at most
 * {@link CI_DETAILS_TIMEOUT_MS}, with `ANTHROPIC_API_KEY` (and the other
 * Anthropic credentials) removed from its environment.
 *
 *   stdin   {"pr": 14, "head": "<sha>", "checks": [{"name", "conclusion", "link"}]}
 *           (`head` is "" when GitHub named no commit; `link` may be null)
 *   stdout  {"checks": [{"name": "build", "step": "Run tests", "log": "..."}]}
 *           matched by name; `step` and `log` are optional; `log` is a string
 *           (or a list of lines); checks it does not name, and names that are
 *           not failing, are ignored.
 *
 * Anything else -- a non-zero exit, a timeout, output that is not that JSON --
 * and the failure still queues, with names and links and one line on why
 * there are no details.
 *
 * Log text is untrusted, from a log or a command alike: it is cleaned to
 * plain text (`cleanLogLine`: no escapes, no control characters, long lines
 * cut) and only ever rendered as text.
 */

import { cleanLogLine } from './checks';

/** A fetch never holds the item longer than this. */
export const CI_DETAILS_TIMEOUT_MS = 30_000;
/** Per check: the last 40 lines... */
export const DETAIL_TAIL_LINES = 40;
/** ...and at most 4 KB of them (UTF-8), cut from the top. */
export const DETAIL_MAX_BYTES = 4096;

/** One failing check's details. */
export interface CheckDetail {
  name: string;
  /** The step that failed, when known. */
  step: string | null;
  /** The end of its log, oldest first; empty when there is none. */
  log: string[];
  /** Lines cut from the top to fit the limits. */
  more: number;
}

/**
 * Where a queued failure's details stand.
 *   - `none`: the project asks for name and link only; nothing is shown.
 *   - `fetching`: asked for, not back yet (never kept across a restart).
 *   - `ready`: back; `checks` holds the ones that had any.
 *   - `failed`: could not be had; `reason` says why, briefly.
 */
export type CiDetailsState =
  | { state: 'none' }
  | { state: 'fetching' }
  | { state: 'ready'; checks: CheckDetail[] }
  | { state: 'failed'; reason: string };

/** What a fetch is about: the queued failure, as far as details care. */
export interface FailureForDetails {
  prNumber: number;
  /** `headKey`: a full SHA, or `#<pr>` when gh named none. */
  sha: string;
  checks: readonly { name: string; conclusion: string; url: string | null }[];
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const bytes = (s: string) => new TextEncoder().encode(s).length;

/**
 * The end of a log within the limits: the last {@link DETAIL_TAIL_LINES}
 * lines, then fewer while they are over {@link DETAIL_MAX_BYTES}. Trailing
 * blank lines go first; `more` counts every line left out.
 */
export function clipLog(lines: readonly string[]): { log: string[]; more: number } {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === '') end--;
  const out: string[] = [];
  let size = 0;
  for (let i = end - 1; i >= 0 && out.length < DETAIL_TAIL_LINES; i--) {
    const line = lines[i]!;
    const next = size + bytes(line) + (out.length > 0 ? 1 : 0);
    if (next > DETAIL_MAX_BYTES) break;
    size = next;
    out.unshift(line);
  }
  return { log: out, more: end - out.length };
}

/** A command's log text as plain lines, cleaned like a job log's. */
export function cleanLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const t = cleanLogLine(raw);
    if (t !== null) out.push(t);
  }
  return out;
}

/** One line, plain and short, for a reason or a step name. */
export function oneLine(text: string, max = 120): string {
  const t = (cleanLogLine(text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '') ?? '').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// ---------------------------------------------------------------------------
// The command's input and output
// ---------------------------------------------------------------------------

export interface CommandInput {
  pr: number;
  head: string;
  checks: { name: string; conclusion: string; link: string | null }[];
}

/** What the command reads on stdin. */
export function commandInput(f: FailureForDetails): CommandInput {
  return {
    pr: f.prNumber,
    head: f.sha.startsWith('#') ? '' : f.sha,
    checks: f.checks.map((c) => ({ name: c.name, conclusion: c.conclusion, link: c.url })),
  };
}

export type ParsedOutput = { ok: true; checks: CheckDetail[] } | { ok: false; reason: string };

/**
 * The command's stdout, read for the checks that are failing (`names`).
 * Unknown names and unknown fields are ignored; a check named twice keeps
 * its first entry.
 */
export function parseCommandOutput(stdout: string, names: readonly string[]): ParsedOutput {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: stdout.trim() === '' ? 'the command printed nothing' : 'its output is not JSON' };
  }
  const list = (data as { checks?: unknown } | null)?.checks;
  if (typeof data !== 'object' || data === null || !Array.isArray(list)) {
    return { ok: false, reason: 'its output has no "checks" list' };
  }
  const wanted = new Set(names);
  const found = new Map<string, CheckDetail>();
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== 'string' || !wanted.has(e.name) || found.has(e.name)) continue;
    const step = typeof e.step === 'string' && e.step.trim() !== '' ? oneLine(e.step) : null;
    const text =
      typeof e.log === 'string'
        ? e.log
        : Array.isArray(e.log) && e.log.every((l) => typeof l === 'string')
          ? (e.log as string[]).join('\n')
          : '';
    found.set(e.name, { name: e.name, step, ...clipLog(cleanLines(text)) });
  }
  if (found.size === 0) return { ok: false, reason: 'its output names none of the failing checks' };
  // In the queue's order, not the command's.
  return { ok: true, checks: names.flatMap((n) => (found.has(n) ? [found.get(n)!] : [])) };
}

/** Why a command gave nothing usable: its exit, and its own first words. */
export function exitReason(code: number | null, stderr: string): string {
  const said = oneLine(stderr);
  const how = code === null ? 'the command was stopped' : `the command exited with ${code}`;
  return said ? `${how}: ${said}` : how;
}

// ---------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------

/** A check's details as the message carries them, under its "- name: …" line. */
export function formatCheckDetail(d: CheckDetail): string[] {
  const out: string[] = [];
  if (d.step) out.push(`  step: ${d.step}`);
  if (d.log.length > 0) {
    out.push(d.more > 0 ? `  log (last ${d.log.length} lines):` : '  log:');
    for (const l of d.log) out.push(`    ${l}`);
  }
  return out;
}

/** The line a failed fetch adds, in the item and in the message. */
export function failedDetailsLine(reason: string): string {
  return `Details could not be fetched: ${reason}.`;
}
