/**
 * What's New (#147): which changes to list after the executable changed.
 *
 * Pure: the build embedded by vite.config.ts (lib/build.ts) and what this
 * machine remembers about the last build it ran go in, a decision comes out.
 * The hook (app/useWhatsNew.ts) owns storage and timing; the dialog
 * (WhatsNewDialog.tsx) owns the words.
 *
 * A build's sha is abbreviated (`git rev-parse --short`), and git lengthens
 * the abbreviation as a repository grows, so two shas are the same commit when
 * one is a prefix of the other -- never by plain equality.
 */

import type { BuildCommit, BuildInfo } from '../lib/build';
import type { Codec } from './persisted';

/** How many changes to list when the last build run is not in this build's history. */
export const LATEST_COUNT = 20;

/** A build this machine ran: its commit and when it was built. */
export interface BuildRef {
  sha: string;
  /** ISO build time. */
  at: string;
}

/**
 * What is remembered once a What's New is dismissed (or on the very first
 * launch): the build that was running, and the one its list started from, so
 * the ⋯ item can show the same list again. `from` is null when the list was
 * "the latest N" -- the first launch, or a last build that was not found.
 */
export interface SeenBuild extends BuildRef {
  from: BuildRef | null;
}

export type WhatsNewDecision =
  /** No embedded build (vitest, a build outside git): nothing to compare. */
  | { kind: 'none'; reason: 'no-build' }
  /** First launch on this machine: remember the build, show nothing. */
  | { kind: 'none'; reason: 'first-run' }
  /** The build last run is this one. */
  | { kind: 'none'; reason: 'same' }
  /** This executable was built before the one last run: nothing in it is new. Not remembered. */
  | { kind: 'none'; reason: 'older' }
  /** The commit changed but this build carries no history to list. Remembered silently. */
  | { kind: 'none'; reason: 'no-history' }
  | { kind: 'list'; list: WhatsNewList };

export interface WhatsNewList {
  /** Newest first. */
  changes: BuildCommit[];
  /**
   * The build the list starts after, when it was found in the history. Null
   * when it was not (too old, or the history was rewritten): `changes` is
   * then the latest few and earlier ones are not listed.
   */
  since: BuildRef | null;
  /** The running build had uncommitted changes: the list is not all of it. */
  dirty: boolean;
  /** When the running build was made (ISO). */
  builtAt: string;
  /** For PR links; null when the remote is not GitHub. */
  repo: string | null;
}

/** Same commit, allowing for abbreviations of different lengths. */
export function sameCommit(a: string, b: string): boolean {
  if (a.length < 4 || b.length < 4) return false;
  return a.startsWith(b) || b.startsWith(a);
}

function time(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? NaN : t;
}

function latest(build: BuildInfo, history: BuildCommit[]): WhatsNewList {
  return {
    changes: history.slice(0, LATEST_COUNT),
    since: null,
    dirty: build.dirty,
    builtAt: build.at,
    repo: build.repo ?? null,
  };
}

/** The changes between the build last run (`seen`) and the running one. */
export function whatsNewSince(build: BuildInfo | null, seen: BuildRef | null): WhatsNewDecision {
  if (!build) return { kind: 'none', reason: 'no-build' };
  if (!seen) return { kind: 'none', reason: 'first-run' };
  if (sameCommit(build.sha, seen.sha)) return { kind: 'none', reason: 'same' };
  const history = build.history ?? [];
  const at = history.findIndex((c) => sameCommit(c.sha, seen.sha));
  if (at === 0) return { kind: 'none', reason: 'same' };
  if (at > 0) {
    return {
      kind: 'list',
      list: {
        changes: history.slice(0, at),
        // Only the ref: `seen` may be a whole SeenBuild, and its `from` is not this list's.
        since: { sha: seen.sha, at: seen.at },
        dirty: build.dirty,
        builtAt: build.at,
        repo: build.repo ?? null,
      },
    };
  }
  // Not found. An executable built before the last one run is a downgrade:
  // its history cannot reach the newer commit, and "the latest 20" would
  // present old work as new.
  if (time(seen.at) > time(build.at)) return { kind: 'none', reason: 'older' };
  if (history.length === 0) return { kind: 'none', reason: 'no-history' };
  return { kind: 'list', list: latest(build, history) };
}

/** What the ⋯ item shows: the list last dismissed for this build, or else the latest few. */
export function lastList(build: BuildInfo | null, seen: SeenBuild | null): WhatsNewList | null {
  if (!build) return null;
  const history = build.history ?? [];
  if (seen?.from && sameCommit(seen.sha, build.sha)) {
    const d = whatsNewSince(build, seen.from);
    if (d.kind === 'list') return d.list;
  }
  return history.length > 0 ? latest(build, history) : null;
}

/** What to remember once `build` has been run (and its list, if any, dismissed). */
export function seenRecord(build: BuildInfo, list: WhatsNewList | null): SeenBuild {
  return { sha: build.sha, at: build.at, from: list?.since ?? null };
}

function asRef(v: unknown): BuildRef | null {
  if (typeof v !== 'object' || v === null) return null;
  const { sha, at } = v as Record<string, unknown>;
  return typeof sha === 'string' && sha !== '' && typeof at === 'string' ? { sha, at } : null;
}

/** JSON `{ sha, at, from }`. Anything else reads as never seen. */
export const seenBuildCodec: Codec<SeenBuild> = {
  decode: (raw) => {
    const v: unknown = JSON.parse(raw);
    const ref = asRef(v);
    if (!ref) return null;
    return { ...ref, from: asRef((v as Record<string, unknown>).from) };
  },
  encode: (value) => JSON.stringify(value),
};

/** `Oct 29`, in the user's locale; empty for a time that does not parse. */
export function shortDate(iso: string): string {
  const t = time(iso);
  return Number.isNaN(t) ? '' : new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The line under the title: when this build was made, and what the list covers. */
export function whatsNewSubtitle(list: WhatsNewList): string {
  const built = shortDate(list.builtAt);
  const n = list.changes.length;
  const count = `${n} ${n === 1 ? 'change' : 'changes'}`;
  const range = list.since
    ? `${count} since the build you last ran${shortDate(list.since.at) ? ` on ${shortDate(list.since.at)}` : ''}`
    : `The latest ${count}; earlier ones aren't listed`;
  return built ? `Built ${built} · ${range}` : range;
}

/** The PR's page, or null without a GitHub repository or a PR number. */
export function prUrl(repo: string | null, pr: number | null): string | null {
  return repo && pr !== null ? `${repo}/pull/${pr}` : null;
}

/**
 * Whether anything else on screen is asking for the user: an open dialog
 * (every one is `aria-modal`, the convention the palette and ⇧⌘R already
 * check), or the "waiting on you" card (`.tx-prompt`, PromptCard.tsx).
 * What's New waits until neither is there.
 */
export function somethingNeedsAttention(doc: Pick<Document, 'querySelector'>): boolean {
  return doc.querySelector('[aria-modal="true"], .tx-prompt') !== null;
}
