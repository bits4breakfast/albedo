/**
 * Search in a Review Guide (#413), All Guide Files: every match in the
 * guide's files, listed under the group whose diff shows it. Pure.
 *
 * A file is searched as This File searches it (`diffSearchMatches`): the
 * file as the branch has it, with its removed lines, unchanged lines too.
 * A file split across groups is searched once, and each match is listed
 * once: a changed line, or a line in a hunk's context, under the group that
 * holds that hunk; an unchanged line outside every hunk under the first
 * group the file is in. Every group's diff of a file can show any of its
 * unchanged lines (folded), so that group always shows it.
 */

import { diffSearchMatches, type DiffMatch } from '../ui/transcript/Diff';
import type { BranchDiff } from './blocks';
import type { GroupView } from './validate';

export interface GuideHit extends DiffMatch {
  groupKey: string;
  path: string;
}

/** One line with a match, and every match on it. */
export interface GuideHitLine {
  side: 'old' | 'new';
  line: number;
  text: string;
  hits: GuideHit[];
}

export interface GuideHitFile {
  path: string;
  lines: GuideHitLine[];
}

export interface GuideHitGroup {
  key: string;
  /** "02", as the rail numbers it; null for Set Aside, which is not counted. */
  number: string | null;
  title: string;
  files: GuideHitFile[];
}

export interface GuideSearchResult {
  groups: GuideHitGroup[];
  total: number;
  /** Files with a match. */
  files: number;
  /** Stopped at the cap: there are more than `total`. */
  capped: boolean;
}

/** Past this many matches the list stops: a one-letter query must not list a whole branch. */
export const GUIDE_SEARCH_CAP = 2000;

export function searchGuide(
  groups: readonly GroupView[],
  diff: BranchDiff,
  query: string,
  cap = GUIDE_SEARCH_CAP,
): GuideSearchResult {
  const empty: GuideSearchResult = { groups: [], total: 0, files: 0, capped: false };
  if (query === '') return empty;
  // Which group shows each block, and the first group each file is in.
  const owner = new Map<string, string>();
  const first = new Map<string, string>();
  for (const g of groups) {
    for (const f of g.files) {
      if (!first.has(f.path)) first.set(f.path, g.key);
      for (const b of f.blocks) if (!owner.has(b)) owner.set(b, g.key);
    }
  }
  const found = new Map<string, GuideHit[]>();
  const paths = new Set<string>();
  let total = 0;
  let capped = false;
  for (const [path, firstGroup] of first) {
    if (capped) break;
    const file = diff.files.find((f) => f.path === path);
    if (!file || file.result.kind !== 'diff') continue;
    const r = file.result;
    for (const m of diffSearchMatches(r.diff, { oldText: r.oldText, newText: r.newText }, query)) {
      if (total >= cap) {
        capped = true;
        break;
      }
      const groupKey = (m.hunk !== null ? owner.get(file.blocks[m.hunk] ?? '') : undefined) ?? firstGroup;
      const at = `${groupKey}\n${path}`;
      const list = found.get(at) ?? [];
      list.push({ ...m, groupKey, path });
      found.set(at, list);
      paths.add(path);
      total++;
    }
  }
  const out: GuideHitGroup[] = [];
  groups.forEach((g, i) => {
    const files: GuideHitFile[] = [];
    for (const f of g.files) {
      const hits = found.get(`${g.key}\n${f.path}`);
      if (hits) files.push({ path: f.path, lines: byLine(hits) });
    }
    if (files.length > 0) {
      out.push({ key: g.key, number: g.setAside ? null : String(i + 1).padStart(2, '0'), title: g.title, files });
    }
  });
  return { groups: out, total, files: paths.size, capped };
}

/** Matches in order, one entry per line they are on. */
function byLine(hits: readonly GuideHit[]): GuideHitLine[] {
  const out: GuideHitLine[] = [];
  for (const h of hits) {
    const last = out[out.length - 1];
    if (last && last.side === h.side && last.line === h.line) last.hits.push(h);
    else out.push({ side: h.side, line: h.line, text: h.text, hits: [h] });
  }
  return out;
}
