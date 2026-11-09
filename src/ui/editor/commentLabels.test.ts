import { describe, expect, it } from 'vitest';
import { cardState, draftPlaceholder, draftSaveLabel } from './commentLabels';

describe('a draft for GitHub (#287)', () => {
  it('says it goes with Submit Review, with Edit and only Delete behind ⋯', () => {
    expect(cardState({ sentAt: null, github: 'draft' })).toEqual({
      state: 'waiting',
      chip: 'Draft · goes with Submit Review',
      main: 'edit',
      more: ['delete'],
    });
  });

  it('says so when its lines are outside the diff', () => {
    expect(cardState({ sentAt: null, github: 'draft' }, 0, true).chip).toBe('Draft · not in the diff: goes in the summary');
  });

  it('leaves a comment for Claude exactly as before', () => {
    expect(cardState({ sentAt: null, github: null }).chip).toBe('Waiting · goes with your next message');
    expect(cardState({ sentAt: null }).chip).toBe('Waiting · goes with your next message');
    // "outside" means nothing for a comment that does not go to GitHub.
    expect(cardState({ sentAt: null, github: null }, 0, true).chip).toBe('Waiting · goes with your next message');
  });

  it('names the box and its button by where it goes', () => {
    expect(draftSaveLabel('draft', false)).toBe('Add Draft');
    expect(draftSaveLabel(null, false)).toBe('Comment');
    expect(draftSaveLabel('draft', true)).toBe('Save');
    expect(draftPlaceholder('draft')).toMatch(/Submit Review/);
    expect(draftPlaceholder(null)).toMatch(/for Claude/);
  });
});
