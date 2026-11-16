/**
 * The skills each session can run (#349), held in memory: a full listing
 * replaces the list, a delta adds or updates; listings fed twice, or out of
 * order by the watcher, its replay and the on-demand read, come out the same.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SkillListing } from './adapter';
import {
  __resetSkills,
  foldSkillListings,
  loadSkills,
  onSkillsChange,
  recordSkillListings,
  skillsFor,
  SKILLS_READ_STEP_BYTES,
  type SkillFileAccess,
} from './skills';

afterEach(() => __resetSkills());

function listing(uuid: string, ts: number, initial: boolean, names: string[], sessionId = 's1'): SkillListing {
  return { sessionId, uuid, ts, initial, skills: names.map((n) => ({ name: n, description: `${n} @${ts}` })) };
}

describe('foldSkillListings', () => {
  it('a full listing replaces; a delta adds new skills and updates known ones in place', () => {
    const skills = foldSkillListings([
      listing('a', 1, true, ['brew-tea', 'water-plants']),
      listing('b', 2, false, ['water-plants', 'fold-laundry']),
    ]);
    expect(skills).toEqual([
      { name: 'brew-tea', description: 'brew-tea @1' },
      { name: 'water-plants', description: 'water-plants @2' },
      { name: 'fold-laundry', description: 'fold-laundry @2' },
    ]);
    // A later full listing drops what it no longer names.
    expect(foldSkillListings([listing('a', 1, true, ['brew-tea', 'water-plants']), listing('c', 3, true, ['brew-tea'])]).map((s) => s.name)).toEqual([
      'brew-tea',
    ]);
  });
});

describe('recordSkillListings', () => {
  it('is unknown until a listing is seen', () => {
    expect(skillsFor('s1')).toBeNull();
  });

  it('applies listings per session and tells listeners once per change', () => {
    const heard: string[] = [];
    onSkillsChange((sid) => heard.push(sid));
    recordSkillListings([listing('a', 1, true, ['brew-tea']), listing('x', 1, true, ['other'], 's2')]);
    recordSkillListings([listing('a', 1, true, ['brew-tea'])]); // the same line again
    expect(heard).toEqual(['s1', 's2']);
    expect(skillsFor('s1')?.map((s) => s.name)).toEqual(['brew-tea']);
    expect(skillsFor('s2')?.map((s) => s.name)).toEqual(['other']);
  });

  it('comes out the same when older listings arrive after newer ones', () => {
    // Live ingest saw the delta; the on-demand read brings the full listing before it.
    recordSkillListings([listing('b', 2, false, ['fold-laundry'])]);
    expect(skillsFor('s1')?.map((s) => s.name)).toEqual(['fold-laundry']);
    recordSkillListings([listing('a', 1, true, ['brew-tea', 'water-plants']), listing('b', 2, false, ['fold-laundry'])]);
    expect(skillsFor('s1')?.map((s) => s.name)).toEqual(['brew-tea', 'water-plants', 'fold-laundry']);
    // And anything older than the newest full listing changes nothing.
    recordSkillListings([listing('c', 3, true, ['brew-tea'])]);
    recordSkillListings([listing('old', 0, false, ['ancient'])]);
    expect(skillsFor('s1')?.map((s) => s.name)).toEqual(['brew-tea']);
  });
});

describe('loadSkills', () => {
  function line(l: SkillListing): string {
    return JSON.stringify({
      type: 'attachment',
      isSidechain: false,
      uuid: l.uuid,
      sessionId: l.sessionId,
      timestamp: new Date(l.ts).toISOString(),
      attachment: {
        type: 'skill_listing',
        isInitial: l.initial,
        names: l.skills.map((s) => s.name),
        skillCount: l.skills.length,
        content: l.skills.map((s) => `- ${s.name}: ${s.description}`).join('\n'),
      },
    });
  }

  function fileOf(text: string, path = '/p/s1.jsonl'): { access: SkillFileAccess; reads: number[] } {
    const bytes = new TextEncoder().encode(text);
    const reads: number[] = [];
    return {
      reads,
      access: {
        pathFor: async () => path,
        size: async () => bytes.length,
        read: async (_p, offset, length) => {
          reads.push(offset);
          return bytes.slice(offset, offset + length);
        },
      },
    };
  }

  it('reads backwards until a full listing, and keeps the deltas after it', async () => {
    const filler = (n: number) => `{"type":"user","message":{"content":"${'x'.repeat(n)}"}}`;
    const text = [
      line(listing('old', Date.parse('2026-11-01'), true, ['gone-skill'])),
      filler(SKILLS_READ_STEP_BYTES), // a full step: the old listing is a step further back
      line(listing('a', Date.parse('2026-11-02'), true, ['brew-tea', 'water-plants'])),
      // A line that straddles the step boundary is read whole.
      filler(SKILLS_READ_STEP_BYTES / 2),
      line(listing('b', Date.parse('2026-11-03'), false, ['fold-laundry'])),
      '',
    ].join('\n');
    const { access, reads } = fileOf(text);
    await loadSkills('s1', access);
    expect(skillsFor('s1')?.map((s) => s.name)).toEqual(['brew-tea', 'water-plants', 'fold-laundry']);
    // It stopped at the step holding the full listing, short of the file's start.
    expect(reads.every((offset) => offset > 0)).toBe(true);
  });

  it('reads once per session, and leaves a session without a file unknown', async () => {
    let asked = 0;
    const none: SkillFileAccess = {
      pathFor: async () => {
        asked++;
        return null;
      },
      size: async () => 0,
      read: async () => new Uint8Array(0),
    };
    await loadSkills('s1', none);
    await loadSkills('s1', none);
    expect(asked).toBe(1);
    expect(skillsFor('s1')).toBeNull();
  });

  it('does not read a session the watcher already fed', async () => {
    recordSkillListings([listing('a', 1, true, ['brew-tea'])]);
    const { access, reads } = fileOf('');
    await loadSkills('s1', access);
    expect(reads).toEqual([]);
  });

  it('skips another session’s listings in the same file', async () => {
    const text = [line(listing('a', 1000, true, ['mine'])), line(listing('z', 2000, true, ['theirs'], 's9')), ''].join('\n');
    await loadSkills('s1', fileOf(text).access);
    expect(skillsFor('s1')?.map((s) => s.name)).toEqual(['mine']);
  });
});
