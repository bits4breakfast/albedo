/**
 * The skills each session can run, for the composer's `/` list (#349).
 *
 * Claude Code tells the model which skills it has in a `skill_listing`
 * attachment (`SkillListing`, adapter.ts, where the format lives): the whole
 * list with the first prompt of each process, then deltas of added or
 * changed skills. An attachment is a bookkeeping line and is never stored as
 * a row, so the list cannot be derived from the database. It is held here in
 * memory, per session, fed three ways:
 *
 *  - by the capture watcher, as it ingests each chunk;
 *  - by the watcher's one-off replay of a file's recent history, the first
 *    time the file grows this run (watcher.ts, as the queue is);
 *  - by `loadSkills`, the first time the composer asks for a session nothing
 *    has fed yet: after a restart, an idle session's file does not grow, and
 *    its last full listing can sit 80 MB back in it (measured here).
 *
 * The three overlap and arrive in any order, so this keeps every listing
 * from the newest full one on, by its line's id, and folds them in time
 * order: a full listing replaces the list, a delta adds or updates skills.
 */

import { skillListingsIn, type SkillListing } from './adapter';

/** One skill, as the composer shows it. */
export interface Skill {
  name: string;
  description: string;
}

export interface Held {
  /** From the newest full listing on, in time order. */
  listings: SkillListing[];
  skills: Skill[];
}

const held = new Map<string, Held>();
/** Sessions `loadSkills` has already read this run. */
const tried = new Set<string>();
const listeners = new Set<(sessionId: string) => void>();

/** What the listings say, folded in order: a full one replaces, a delta adds or updates. */
export function foldSkillListings(listings: readonly SkillListing[]): Skill[] {
  const out = new Map<string, Skill>();
  for (const l of listings) {
    if (l.initial) out.clear();
    for (const s of l.skills) {
      // An update keeps its place in the list; a new skill goes at the end.
      out.set(s.name, { name: s.name, description: s.description });
    }
  }
  return [...out.values()];
}

/**
 * Add listings to a session's held state. Returns the new state, or null when
 * nothing changed (every listing already held, or older than the newest full
 * one).
 */
export function addSkillListings(was: Held | undefined, incoming: readonly SkillListing[]): Held | null {
  const known = new Set(was?.listings.map((l) => l.uuid));
  const fresh = incoming.filter((l) => !known.has(l.uuid));
  if (fresh.length === 0) return null;
  // Stable: listings with the same time keep the order they came in.
  const all = [...(was?.listings ?? []), ...fresh].sort((a, b) => a.ts - b.ts);
  let from = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i]!.initial) {
      from = i;
      break;
    }
  }
  const listings = all.slice(from);
  if (was && listings.length === was.listings.length && listings.every((l, i) => l === was.listings[i])) return null;
  return { listings, skills: foldSkillListings(listings) };
}

/** Called by the watcher with the listings in each chunk, in file order. */
export function recordSkillListings(listings: readonly SkillListing[]): void {
  if (listings.length === 0) return;
  const bySession = new Map<string, SkillListing[]>();
  for (const l of listings) {
    const list = bySession.get(l.sessionId) ?? [];
    list.push(l);
    bySession.set(l.sessionId, list);
  }
  for (const [sid, list] of bySession) {
    const next = addSkillListings(held.get(sid), list);
    if (next === null) continue;
    held.set(sid, next);
    for (const cb of [...listeners]) cb(sid);
  }
}

/** The session's skills, or null when no listing has been seen for it. */
export function skillsFor(sessionId: string): readonly Skill[] | null {
  return held.get(sessionId)?.skills ?? null;
}

/** Subscribe to changes; the callback gets the session that changed. */
export function onSkillsChange(cb: (sessionId: string) => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** How much of a transcript `loadSkills` reads per step, backwards from the end. */
export const SKILLS_READ_STEP_BYTES = 8 * 1024 * 1024;

export interface SkillFileAccess {
  /** The session's main transcript, or null when Albedo holds none. */
  pathFor: (sessionId: string) => Promise<string | null>;
  size: (path: string) => Promise<number>;
  read: (path: string, offset: number, length: number) => Promise<Uint8Array>;
}

/**
 * Read a session's listings from its transcript, once per session per run,
 * when nothing has fed it yet. Backwards in steps from the end, until a step
 * holds a full listing: everything from there on is what the session can run
 * now. Only listing lines are kept, so a large file costs reading time, not
 * memory. Anything that fails leaves the session unknown, which shows "No
 * skills yet".
 */
export async function loadSkills(sessionId: string, access?: SkillFileAccess): Promise<void> {
  if (held.has(sessionId) || tried.has(sessionId)) return;
  tried.add(sessionId);
  try {
    const fs = access ?? (await defaultAccess());
    const path = await fs.pathFor(sessionId);
    if (path === null) return;
    const listings = await readListingsBackwards(fs, path, sessionId);
    if (listings.length > 0) recordSkillListings(listings);
  } catch (err) {
    console.warn('skills: could not read the session’s skill listing', err);
  }
}

async function readListingsBackwards(fs: SkillFileAccess, path: string, sessionId: string): Promise<SkillListing[]> {
  const decoder = new TextDecoder();
  let end = await fs.size(path);
  /** The start of the line the later step began inside; it ends in this one. */
  let carry: Uint8Array = new Uint8Array(0);
  let found: SkillListing[] = [];
  while (end > 0) {
    const start = Math.max(0, end - SKILLS_READ_STEP_BYTES);
    const bytes = await fs.read(path, start, end - start);
    const joined = new Uint8Array(bytes.length + carry.length);
    joined.set(bytes, 0);
    joined.set(carry, bytes.length);
    let whole = joined;
    if (start > 0) {
      const nl = joined.indexOf(0x0a);
      if (nl < 0) {
        // One line longer than the step: keep reading it.
        carry = joined;
        end = start;
        continue;
      }
      carry = joined.subarray(0, nl);
      whole = joined.subarray(nl + 1);
    }
    const here = skillListingsIn(decoder.decode(whole)).filter((l) => l.sessionId === sessionId);
    found = [...here, ...found];
    if (here.some((l) => l.initial)) break;
    end = start;
  }
  return found;
}

async function defaultAccess(): Promise<SkillFileAccess> {
  // Imported when first needed.
  const [{ transcriptPathFor }, { stat }, { readRange }] = await Promise.all([
    import('../db/reminders'),
    import('@tauri-apps/plugin-fs'),
    import('./fileTail'),
  ]);
  return { pathFor: transcriptPathFor, size: async (path) => (await stat(path)).size, read: readRange };
}

/** Test seam. */
export function __resetSkills(): void {
  held.clear();
  tried.clear();
  listeners.clear();
}
