/**
 * The rules of the message box's `/` list (#349): when it opens, what it
 * lists in which order, and which skill a message starts with. The skills
 * come from the task's own session (capture/skills.ts) as plain
 * `{name, description}`; nothing here knows where they were read from.
 * State and keys are useSkillMenu.ts; the drawing is SkillPopover.tsx.
 */

import type { Skill } from '../../capture';

/** The characters a skill name is made of; anything else ends the token. */
const NAME_CHAR = /[A-Za-z0-9_.:-]/;

/**
 * The `/` under the caret, if it opens the list: at the start of the message
 * or right after whitespace, followed by name characters up to the caret. A
 * `/` inside a word or a path (`src/ui`, `/Users/me`) does not open it, nor
 * does one the caret has left (a space typed, the caret moved before it).
 * `end` is where the token ends, which may be past the caret.
 */
export function skillTrigger(text: string, caret: number): { start: number; end: number; query: string } | null {
  if (caret < 1 || caret > text.length) return null;
  const before = text.slice(0, caret);
  const slash = before.lastIndexOf('/');
  if (slash < 0) return null;
  if (slash > 0 && !/\s/.test(before[slash - 1] ?? '')) return null;
  const query = before.slice(slash + 1);
  for (const ch of query) if (!NAME_CHAR.test(ch)) return null;
  let end = caret;
  while (end < text.length && NAME_CHAR.test(text[end]!)) end++;
  // `/Users/me`: the token runs into another `/`, so it is a path.
  if (text[end] === '/') return null;
  return { start: slash, end, query };
}

/** A plugin's prefix (`garden:`) and the rest of the name. */
export function splitSkillName(name: string): { prefix: string; base: string } {
  const at = name.lastIndexOf(':');
  return at < 0 ? { prefix: '', base: name } : { prefix: name.slice(0, at + 1), base: name.slice(at + 1) };
}

/**
 * The description's first sentence, for a row: up to the first full stop,
 * question or exclamation mark followed by a capital or the end, or to the
 * first line break. The row cuts it with an ellipsis if it is still too long.
 */
export function firstSentence(description: string): string {
  const line = description.split('\n', 1)[0]?.trim() ?? '';
  const m = /^[\s\S]*?[.!?](?=\s+[A-Z(“"'`]|\s*$)/.exec(line);
  return (m ? m[0] : line).trim();
}

export interface SkillItem {
  skill: Skill;
  /** 0: the name starts with the query; 1: the name holds it; 2: the description does. */
  tier: 0 | 1 | 2;
  /** Matched characters in `skill.name`. */
  nameHits: number[];
  /** Matched characters in the row's description (its first sentence). */
  descHits: number[];
}

function range(from: number, length: number): number[] {
  return Array.from({ length }, (_, i) => from + i);
}

/**
 * The skills that match `query`, in order: names that start with it, then
 * names that hold it, then descriptions that hold it; within each, the
 * session's own order. A plugin's prefix need not be typed: "rev" starts
 * `garden:review` as it does `review`. Case does not matter. An empty query
 * lists everything.
 */
export function rankSkills(skills: readonly Skill[], query: string): SkillItem[] {
  const q = query.toLowerCase();
  const tiers: SkillItem[][] = [[], [], []];
  for (const skill of skills) {
    if (q === '') {
      tiers[0]!.push({ skill, tier: 0, nameHits: [], descHits: [] });
      continue;
    }
    const name = skill.name.toLowerCase();
    const { prefix, base } = splitSkillName(name);
    if (name.startsWith(q)) {
      tiers[0]!.push({ skill, tier: 0, nameHits: range(0, q.length), descHits: [] });
      continue;
    }
    if (base.startsWith(q)) {
      tiers[0]!.push({ skill, tier: 0, nameHits: range(prefix.length, q.length), descHits: [] });
      continue;
    }
    const inBase = base.indexOf(q);
    const inName = inBase >= 0 ? prefix.length + inBase : name.indexOf(q);
    if (inName >= 0) {
      tiers[1]!.push({ skill, tier: 1, nameHits: range(inName, q.length), descHits: [] });
      continue;
    }
    if (skill.description.toLowerCase().includes(q)) {
      const at = firstSentence(skill.description).toLowerCase().indexOf(q);
      tiers[2]!.push({ skill, tier: 2, nameHits: [], descHits: at < 0 ? [] : range(at, q.length) });
    }
  }
  return tiers.flat();
}

/**
 * The skill the message starts with, as `/name` followed by whitespace or the
 * end, or null when it starts with anything else, an unknown name included.
 */
export function leadingSkill(text: string, skills: readonly Skill[] | null): Skill | null {
  if (!skills || skills.length === 0) return null;
  const m = /^\s*\/(\S+)(?=\s|$)/.exec(text);
  if (!m) return null;
  return skills.find((s) => s.name === m[1]) ?? null;
}
