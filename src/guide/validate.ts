/**
 * Holding the model's proposal to Albedo's facts (#186). Pure.
 *
 * The model proposes groups of block ids, with words. Albedo checks that
 * every block lands in exactly one group: an id it never handed out is
 * dropped, a second claim on a block loses to the first, and a block no group
 * names goes to **Unsorted**. Nothing is ever hidden.
 *
 * The same rule applies again when a guide is shown against a diff that has
 * moved on since it was written: groups keep only the blocks that still
 * exist, and blocks the guide never saw go to Unsorted.
 */

import { fnv1a, type BranchDiff, type StatReason } from './blocks';

/**
 * A file's note in a group (#202) is shown only when the group has more than
 * one file and the file has at least this many changed lines in it (added
 * plus removed, Albedo's counts): a `+1 −1` registration reads faster as its
 * diff than as a sentence. The owner's threshold.
 */
export const NOTE_MIN_LINES = 5;

/** A group as the model proposed it, after validation. */
export interface GuideGroup {
  title: string;
  summary: string;
  blocks: string[];
  /**
   * path -> a line or two on why the file changes in this group (#202), for
   * paths among the group's blocks only. Written after the groups, one call
   * per group (#224): absent while they are still to be written (and on
   * guides from before notes), `{}` once asked and there were none, or the
   * group was too large to ask about.
   */
  notes?: Record<string, string>;
}

/** A written guide, as cached (store.ts). */
export interface Guide {
  /** The diff it was written for. */
  diffHash: string;
  writtenAt: number;
  /** What the branch was compared with, for the header ("branch vs main"). */
  base: string;
  groups: GuideGroup[];
  /** path -> the block ids it had then: what "changed since" is measured with. */
  files: Record<string, string[]>;
  /**
   * Set when Albedo grouped by folder on its own, saying why (budget.ts).
   * The groups then have no summaries.
   */
  fallback: string | null;
}

/** What the model returned, before anything is trusted. */
export interface Proposal {
  groups: Array<{ title: string; summary: string; blocks: string[]; notes?: Array<{ path: string; note: string }> }>;
}

/** A note longer than this is cut: about two lines under a file name (#224). */
export const NOTE_MAX_CHARS = 240;

/**
 * The model's notes, held to the rule: only for `allowed` paths, the first per
 * path, on one line, cut at {@link NOTE_MAX_CHARS}. The one gate every note
 * passes, whichever call wrote it.
 */
export function cleanNotes(raw: ReadonlyArray<{ path: string; note: string }>, allowed: ReadonlySet<string>): Record<string, string> {
  const notes: Record<string, string> = {};
  for (const n of raw) {
    const note = n.note.replace(/\s+/g, ' ').trim();
    if (!note || !allowed.has(n.path) || Object.hasOwn(notes, n.path)) continue;
    notes[n.path] = note.length > NOTE_MAX_CHARS ? `${note.slice(0, NOTE_MAX_CHARS - 1).trimEnd()}…` : note;
  }
  return notes;
}

export interface Validated {
  groups: GuideGroup[];
  /** Ids the model named that this diff does not have. */
  unknown: string[];
  /** Ids claimed by more than one group (kept in the first). */
  duplicates: string[];
  /** Known ids no group named: Unsorted. */
  missing: string[];
}

/**
 * The id inside what the model wrote. Asked for bare ids, it sometimes adds
 * the path or brackets (`"[a1b2] src/x.ts"`); the id is the first token.
 */
export function normalizeId(raw: string): string {
  const m = /^[\s[("'`]*([a-z0-9]+)/i.exec(raw);
  return m ? (m[1] as string).toLowerCase() : '';
}

/**
 * `pathOf` is each known block's file. With it, a group keeps notes only for
 * files among its own blocks, the first note per file; without it, none.
 */
export function validateProposal(
  proposal: Proposal,
  known: readonly string[],
  pathOf?: ReadonlyMap<string, string>,
): Validated {
  const knownSet = new Set(known);
  const placed = new Set<string>();
  const unknown: string[] = [];
  const duplicates: string[] = [];
  const groups: GuideGroup[] = [];

  for (const g of proposal.groups) {
    const blocks: string[] = [];
    for (const raw of g.blocks) {
      const id = normalizeId(raw);
      if (!knownSet.has(id)) {
        unknown.push(raw);
        continue;
      }
      if (placed.has(id)) {
        if (!blocks.includes(id)) duplicates.push(id);
        continue;
      }
      placed.add(id);
      blocks.push(id);
    }
    // A group left with no blocks has nothing to show its words against.
    if (blocks.length === 0) continue;
    const group: GuideGroup = { title: g.title.trim() || 'Untitled', summary: g.summary.trim(), blocks };
    const paths = new Set(pathOf ? blocks.flatMap((id) => pathOf.get(id) ?? []) : []);
    const notes = cleanNotes(g.notes ?? [], paths);
    if (Object.keys(notes).length > 0) group.notes = notes;
    groups.push(group);
  }
  const missing = known.filter((id) => !placed.has(id));
  return { groups, unknown, duplicates, missing };
}

// ---------------------------------------------------------------------------
// The guide against the diff as it is now
// ---------------------------------------------------------------------------

export interface GroupFile {
  path: string;
  /** This group's blocks of the file, in file order. */
  blocks: string[];
  /** How many blocks the file has in all ("2 of 5 blocks here"). */
  totalBlocks: number;
  /** Albedo's own counts over this group's blocks, never the model's. */
  added: number;
  removed: number;
  stat: StatReason | null;
  /** Why the file changes in this group (#202), when the rule allows one. */
  note: string | null;
  /** The rule allows this file a note here, written or not (#224). */
  notable: boolean;
}

export interface GroupView {
  key: string;
  /** The group's place in `guide.groups`; null for Unsorted. */
  index: number | null;
  title: string;
  summary: string;
  unsorted: boolean;
  blocks: string[];
  files: GroupFile[];
}

export interface GuideView {
  groups: GroupView[];
  /** Files whose blocks differ from when the guide was written. */
  changedFiles: string[];
  stale: boolean;
}

export const UNSORTED_TITLE = 'Unsorted';

function filesOf(blockIds: readonly string[], diff: BranchDiff): GroupFile[] {
  const byPath = new Map<string, Set<string>>();
  for (const id of blockIds) {
    const b = diff.blocks.get(id);
    if (!b) continue;
    const set = byPath.get(b.path) ?? new Set<string>();
    set.add(id);
    byPath.set(b.path, set);
  }
  const out: GroupFile[] = [];
  for (const [path, set] of byPath) {
    const file = diff.files.find((f) => f.path === path);
    if (!file) continue;
    const blocks = file.blocks.filter((id) => set.has(id));
    let added = 0;
    let removed = 0;
    for (const id of blocks) {
      const b = diff.blocks.get(id);
      added += b?.added ?? 0;
      removed += b?.removed ?? 0;
    }
    out.push({ path, blocks, totalBlocks: file.blocks.length, added, removed, stat: file.stat, note: null, notable: false });
  }
  return out;
}

/**
 * The group's files with their notes, held to the rule against the diff as it
 * is now: more than one file in the group, at least {@link NOTE_MIN_LINES}
 * changed lines of the file in it, and lines the model was shown.
 */
function withNotes(files: GroupFile[], notes: unknown): GroupFile[] {
  if (files.length < 2) return files;
  const by = typeof notes === 'object' && notes !== null ? (notes as Record<string, unknown>) : {};
  return files.map((f) => {
    if (f.stat !== null || f.added + f.removed < NOTE_MIN_LINES) return f;
    const note = Object.hasOwn(by, f.path) ? by[f.path] : undefined;
    return { ...f, notable: true, note: typeof note === 'string' && note ? note : null };
  });
}

/**
 * The files of a group the rule allows a note (#224), in file order: what a
 * notes call is asked about. Empty when there is nothing to ask.
 */
export function notableFiles(blockIds: readonly string[], diff: BranchDiff): string[] {
  return withNotes(filesOf(blockIds, diff), null)
    .filter((f) => f.notable)
    .map((f) => f.path);
}

/** Paths whose block ids are not what the guide recorded. */
export function changedSince(guide: Guide, diff: BranchDiff): string[] {
  const now = new Map(diff.files.map((f) => [f.path, f.blocks]));
  const paths = new Set([...Object.keys(guide.files), ...now.keys()]);
  const out: string[] = [];
  for (const p of paths) {
    const a = guide.files[p] ?? [];
    const b = now.get(p) ?? [];
    if (a.length !== b.length || a.some((id, i) => id !== b[i])) out.push(p);
  }
  return out.sort();
}

/**
 * Which guide group each block of the diff as it is now belongs to (#248).
 *
 * A block the guide placed stays in its group. A block it never saw (a hunk
 * changed or added after it was written: ids follow the content) goes to the
 * group of the hunk it replaced, so a file changed since it was reviewed shows
 * up, with a new key and so unreviewed, in the group it was reviewed in --
 * never in Unsorted while that group keeps reading Reviewed.
 *
 * "The hunk it replaced": the file's old and new blocks are lined up on the
 * ones they share. Between two shared blocks, the new ones take the groups of
 * the old ones that went, in order; with none gone there (a hunk added), the
 * group of the nearest shared block before it, else after it; with nothing
 * shared at all, the old blocks' groups in order. Left out (null, i.e.
 * Unsorted): a file the guide never placed, and a block it saw when written
 * and put in no group.
 */
function placeBlocks(guide: Guide, diff: BranchDiff): Map<string, number | null> {
  const groupOf = new Map<string, number>();
  guide.groups.forEach((g, i) => {
    for (const id of g.blocks) if (!groupOf.has(id)) groupOf.set(id, i);
  });
  const out = new Map<string, number | null>();
  for (const f of diff.files) {
    const old = guide.files[f.path] ?? [];
    const now = new Set(f.blocks);
    const shared = new Set(old.filter((id) => now.has(id)));
    // Old blocks that went, by the shared block they follow ('' = the start).
    const goneAfter = new Map<string, string[]>();
    let anchor = '';
    for (const id of old) {
      if (shared.has(id)) anchor = id;
      else if (!now.has(id)) goneAfter.set(anchor, [...(goneAfter.get(anchor) ?? []), id]);
    }
    const sharedGroups = f.blocks.map((id) => (shared.has(id) ? groupOf.get(id) : undefined));
    anchor = '';
    let k = 0;
    f.blocks.forEach((id, i) => {
      if (shared.has(id) || groupOf.has(id)) {
        // Known: its own group, or none if the guide placed it nowhere.
        out.set(id, groupOf.get(id) ?? null);
        if (shared.has(id)) {
          anchor = id;
          k = 0;
        }
        return;
      }
      const gone = goneAfter.get(anchor) ?? [];
      let g: number | undefined = gone.length > 0 ? groupOf.get(gone[Math.min(k, gone.length - 1)]!) : undefined;
      k++;
      for (let j = i - 1; g === undefined && j >= 0; j--) g = sharedGroups[j];
      for (let j = i + 1; g === undefined && j < sharedGroups.length; j++) g = sharedGroups[j];
      if (g === undefined) g = old.map((o) => groupOf.get(o)).find((x) => x !== undefined);
      out.set(id, g ?? null);
    });
  }
  return out;
}

/** The guide's groups over the diff as it is now, with Unsorted last. */
export function viewGuide(guide: Guide, diff: BranchDiff): GuideView {
  const place = placeBlocks(guide, diff);
  const pathOf = new Map<string, string>();
  for (const [path, ids] of Object.entries(guide.files)) for (const id of ids) pathOf.set(id, path);
  const groups: GroupView[] = [];
  guide.groups.forEach((g, i) => {
    // The group's own order, a moved-in block where its file's old ones were.
    const mine = diff.order.filter((id) => place.get(id) === i);
    const own = new Set(g.blocks);
    const blocks: string[] = [];
    const taken = new Set<string>();
    const add = (id: string) => {
      if (taken.has(id)) return;
      taken.add(id);
      blocks.push(id);
    };
    for (const id of g.blocks) {
      if (place.get(id) === i) add(id);
      else if (!diff.blocks.has(id)) {
        const path = pathOf.get(id);
        for (const n of mine) if (!own.has(n) && diff.blocks.get(n)?.path === path) add(n);
      }
    }
    for (const id of mine) add(id);
    if (blocks.length === 0) return;
    groups.push({
      key: `g${i}-${fnv1a(g.title).toString(36)}`,
      index: i,
      title: g.title,
      summary: g.summary,
      unsorted: false,
      blocks,
      files: withNotes(filesOf(blocks, diff), g.notes),
    });
  });
  const rest = diff.order.filter((id) => place.get(id) === null);
  if (rest.length > 0) {
    groups.push({
      key: 'unsorted',
      index: null,
      title: UNSORTED_TITLE,
      summary:
        guide.diffHash === diff.hash
          ? 'Changes the guide did not place in a group.'
          : 'Files the guide did not place in a group, or new since it was written.',
      unsorted: true,
      blocks: rest,
      files: filesOf(rest, diff),
    });
  }
  const changedFiles = guide.diffHash === diff.hash ? [] : changedSince(guide, diff);
  return { groups, changedFiles, stale: guide.diffHash !== diff.hash };
}
