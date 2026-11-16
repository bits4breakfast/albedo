/**
 * The `skill_listing` attachment (#349): the whole list first, then deltas,
 * each item found by its name from `names` (adapter.ts). Names and
 * descriptions here are made up; the shapes are the ones measured.
 */
import { describe, expect, it } from 'vitest';
import { parseLine, skillListingOf, skillListingsIn } from './adapter';

function listingLine(
  attachment: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    parentUuid: 'p-1',
    isSidechain: false,
    attachment: { type: 'skill_listing', ...attachment },
    type: 'attachment',
    uuid: 'u-1',
    timestamp: '2026-11-11T10:00:00.000Z',
    sessionId: 'sess-a',
    version: '2.1.322',
    ...extra,
  });
}

const INITIAL = listingLine({
  content: [
    '- brew-tea: Steep a pot of tea: green, black or oolong - at the right heat.',
    '- garden:water-plants (garden:garden-water-plants): Water the plants on the balcony.',
    '- garden:prune',
    '- review-notes: Read the meeting notes. Then list the actions.',
    'TRIGGER: whenever notes are pasted.',
    '- review: Review a draft letter.',
  ].join('\n'),
  names: ['brew-tea', 'garden:water-plants', 'garden:prune', 'review-notes', 'review'],
  skillCount: 5,
  isInitial: true,
  digests: ['a1', 'b2', 'c3', 'd4', 'e5'],
});

describe('skillListingOf', () => {
  it('reads a full listing, pairing each name with its own item', () => {
    const l = skillListingOf(INITIAL);
    expect(l).toMatchObject({ sessionId: 'sess-a', uuid: 'u-1', initial: true, ts: Date.parse('2026-11-11T10:00:00.000Z') });
    expect(l?.skills).toEqual([
      // ": " and " - " inside a description stay in it.
      { name: 'brew-tea', description: 'Steep a pot of tea: green, black or oolong - at the right heat.' },
      // A plugin skill also known by another name: the alias is not the description.
      { name: 'garden:water-plants', description: 'Water the plants on the balcony.' },
      // No description at all.
      { name: 'garden:prune', description: '' },
      // A description over two lines.
      { name: 'review-notes', description: 'Read the meeting notes. Then list the actions.\nTRIGGER: whenever notes are pasted.' },
      // A name that is the start of another does not take the other's line.
      { name: 'review', description: 'Review a draft letter.' },
    ]);
  });

  it('reads a later listing as a delta', () => {
    const l = skillListingOf(
      listingLine(
        { content: '- brew-tea: Steep a pot of tea, now with timers.', names: ['brew-tea'], skillCount: 1, isInitial: false },
        { uuid: 'u-2' },
      ),
    );
    expect(l).toMatchObject({ initial: false, uuid: 'u-2', skills: [{ name: 'brew-tea', description: 'Steep a pot of tea, now with timers.' }] });
  });

  it('reads a listing written before digests existed', () => {
    const l = skillListingOf(listingLine({ content: '- brew-tea: Tea.', names: ['brew-tea'], skillCount: 1, isInitial: true }));
    expect(l?.skills).toEqual([{ name: 'brew-tea', description: 'Tea.' }]);
  });

  it('ignores a subagent’s listing, other attachments and broken lines', () => {
    expect(skillListingOf(listingLine({ content: '- a: b', names: ['a'], isInitial: true }, { isSidechain: true }))).toBeNull();
    expect(skillListingOf(JSON.stringify({ type: 'attachment', sessionId: 's', attachment: { type: 'agent_listing_delta', note: 'skill_listing' } }))).toBeNull();
    expect(skillListingOf('{"type":"attachment","attachment":{"type":"skill_listing"')).toBeNull();
  });

  it('is never stored as a row', () => {
    expect(parseLine(INITIAL, 0)).toEqual([]);
  });

  it('finds every listing in a chunk, in file order', () => {
    const delta = listingLine({ content: '- new-one: Added.', names: ['new-one'], skillCount: 1, isInitial: false }, { uuid: 'u-3' });
    const chunk = [INITIAL, '{"type":"user","message":{"content":"hi"}}', delta, ''].join('\n');
    expect(skillListingsIn(chunk).map((l) => [l.uuid, l.initial])).toEqual([
      ['u-1', true],
      ['u-3', false],
    ]);
  });
});
