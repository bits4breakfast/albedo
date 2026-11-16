/**
 * The `/` list's rules (#349): where it opens, the matching order, the first
 * sentence a row shows, and which skill a message starts with.
 */
import { describe, expect, it } from 'vitest';
import { firstSentence, leadingSkill, rankSkills, skillTrigger, splitSkillName } from './skillMenu';

const SKILLS = [
  { name: 'brew-tea', description: 'Steep a pot of tea. Green or black.' },
  { name: 'reviewer-notes', description: 'Turn meeting notes into actions.' },
  { name: 'letter-review', description: 'Review a draft letter for tone.' },
  { name: 'garden:review-beds', description: 'Check the flower beds for weeds.' },
  { name: 'fold-laundry', description: 'Fold and sort clean laundry; review the socks last.' },
  { name: 'water-plants', description: 'Water the plants on the balcony.' },
];

describe('skillTrigger', () => {
  it('opens on / at the start of the message', () => {
    expect(skillTrigger('/', 1)).toEqual({ start: 0, end: 1, query: '' });
    expect(skillTrigger('/rev', 4)).toEqual({ start: 0, end: 4, query: 'rev' });
  });

  it('opens right after whitespace, a line break included', () => {
    expect(skillTrigger('please /br', 10)).toEqual({ start: 7, end: 10, query: 'br' });
    expect(skillTrigger('first line\n/br', 14)).toEqual({ start: 11, end: 14, query: 'br' });
  });

  it('does not open inside a word or a path', () => {
    expect(skillTrigger('src/ui', 4)).toBeNull();
    expect(skillTrigger('look at src/ui', 14)).toBeNull();
    expect(skillTrigger('and/or', 4)).toBeNull();
    // A path from the root: the token runs into another `/`.
    expect(skillTrigger('/Users/me/notes.txt', 6)).toBeNull();
    expect(skillTrigger('/Users/me/notes.txt', 19)).toBeNull();
    expect(skillTrigger('see /tmp/x', 8)).toBeNull();
  });

  it('closes on a space before anything is picked, and when the caret leaves the token', () => {
    expect(skillTrigger('/rev ', 5)).toBeNull();
    expect(skillTrigger('/rev and more', 13)).toBeNull();
    // The caret before the `/`.
    expect(skillTrigger('ask /rev', 3)).toBeNull();
  });

  it('with the caret inside the token, the token still runs to its end', () => {
    expect(skillTrigger('/review now', 3)).toEqual({ start: 0, end: 7, query: 're' });
  });

  it('takes a plugin prefix as part of the name', () => {
    expect(skillTrigger('/garden:rev', 11)).toEqual({ start: 0, end: 11, query: 'garden:rev' });
  });
});

describe('rankSkills', () => {
  const names = (q: string) => rankSkills(SKILLS, q).map((i) => i.skill.name);

  it('lists everything, in the session’s order, for an empty query', () => {
    expect(names('')).toEqual(SKILLS.map((s) => s.name));
  });

  it('puts names that start with the query first, then names that hold it, then descriptions', () => {
    expect(names('rev')).toEqual([
      // Starts: the plugin prefix need not be typed.
      'reviewer-notes',
      'garden:review-beds',
      // Holds.
      'letter-review',
      // Description only.
      'fold-laundry',
    ]);
  });

  it('matches regardless of case, and with the prefix typed', () => {
    expect(names('REV')).toEqual(names('rev'));
    expect(names('garden:r')).toEqual(['garden:review-beds']);
  });

  it('marks the matched part: in the name, past a prefix, or in the row’s description', () => {
    const [notes, beds, letter, laundry] = rankSkills(SKILLS, 'rev');
    expect(notes?.nameHits).toEqual([0, 1, 2]);
    expect(beds?.nameHits).toEqual([7, 8, 9]); // after "garden:"
    expect(letter?.nameHits).toEqual([7, 8, 9]);
    expect(laundry?.nameHits).toEqual([]);
    const at = 'Fold and sort clean laundry; review the socks last.'.indexOf('review');
    expect(laundry?.descHits).toEqual([at, at + 1, at + 2]);
  });

  it('matches nothing for a query nothing holds', () => {
    expect(names('zzz')).toEqual([]);
  });
});

describe('splitSkillName', () => {
  it('splits a plugin prefix off', () => {
    expect(splitSkillName('garden:review-beds')).toEqual({ prefix: 'garden:', base: 'review-beds' });
    expect(splitSkillName('brew-tea')).toEqual({ prefix: '', base: 'brew-tea' });
  });
});

describe('firstSentence', () => {
  it('stops at the first sentence or line', () => {
    expect(firstSentence('Steep a pot of tea. Green or black.')).toBe('Steep a pot of tea.');
    expect(firstSentence('One line\nAnother line')).toBe('One line');
    expect(firstSentence('Use e.g. a kettle. Then pour.')).toBe('Use e.g. a kettle.');
    expect(firstSentence('No full stop at all')).toBe('No full stop at all');
    expect(firstSentence('')).toBe('');
  });
});

describe('leadingSkill', () => {
  it('names the skill the message starts with, followed by a space or the end', () => {
    expect(leadingSkill('/brew-tea', SKILLS)?.name).toBe('brew-tea');
    expect(leadingSkill('/brew-tea green please', SKILLS)?.name).toBe('brew-tea');
    expect(leadingSkill('  /brew-tea', SKILLS)?.name).toBe('brew-tea');
  });

  it('is null for an unknown name, a name cut short, text first, or no listing', () => {
    expect(leadingSkill('/brew-te', SKILLS)).toBeNull();
    expect(leadingSkill('/brew-teas', SKILLS)).toBeNull();
    expect(leadingSkill('please /brew-tea', SKILLS)).toBeNull();
    expect(leadingSkill('/brew-tea', null)).toBeNull();
  });
});
