/**
 * What "Send N Comments" and Approve answer (#348), and the comments kept
 * until then.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => ({ waiting: new Set<string>(), listener: null as null | ((t: number) => void) }));
vi.mock('../../capture/previewGate', () => ({
  isPreviewWaiting: (id: string) => gate.waiting.has(id),
  onPreviewChange: (cb: (t: number) => void) => {
    gate.listener = cb;
    return () => {
      gate.listener = null;
    };
  },
}));

const c = await import('./previewComments');

const at = (n: number) => 1_000 + n;

beforeEach(() => {
  c.__resetPreviewComments();
  gate.waiting = new Set(['r-1']);
});

describe('composeChanges', () => {
  it('names the version, then each comment; a pin with its number and where it sits', () => {
    const text = c.composeChanges([
      { id: 'b', version: 2, pin: null, text: 'Otherwise good. Keep the dashed border.', addedAt: at(1) },
      { id: 'a', version: 2, pin: { n: 1, x: 62, y: 18 }, text: 'Approve… should be the primary button, filled.', addedAt: at(2) },
    ]);
    expect(text).toBe(
      [
        'changes requested on v2:',
        '1. (pin 1, about 62% across and 18% down the page) Approve… should be the primary button, filled.',
        '2. Otherwise good. Keep the dashed border.',
      ].join('\n'),
    );
  });

  it('says which version each comment is on when there are several, newest first', () => {
    const text = c.composeChanges([
      { id: 'a', version: 1, pin: { n: 1, x: 5, y: 5 }, text: 'Old spacing was better.', addedAt: at(1) },
      { id: 'b', version: 2, pin: null, text: 'Line one\nline two', addedAt: at(2) },
    ]);
    expect(text).toBe(
      [
        'changes requested on v2 and v1:',
        '1. (on v2) Line one',
        '   line two',
        '2. (on v1, pin 1, about 5% across and 5% down the page) Old spacing was better.',
      ].join('\n'),
    );
  });
});

describe('commentCount', () => {
  it("counts the numbered items, never a comment's own further lines (#356)", () => {
    expect(c.commentCount('changes requested on v2:\n1. Fill it.\n   12. not an item\n2. (pin 1, top left) Move it.')).toBe(2);
    expect(c.commentCount('approved')).toBe(0);
  });
});

describe('composeApproval', () => {
  it('is "approved" for the version waiting, and names an earlier one shown', () => {
    expect(c.composeApproval(3, 3)).toBe('approved');
    expect(c.composeApproval(1, 3)).toBe('approved v1, not v3: build v1 as shown');
  });
});

describe('the comments kept', () => {
  it('numbers pins per version and rounds where they sit', () => {
    const one = c.addPreviewComment('r-1', { version: 2, pin: { x: 61.6, y: 17.9 }, text: ' Bigger ' }, at(1));
    const two = c.addPreviewComment('r-1', { version: 2, pin: { x: 120, y: -3 }, text: 'Here' }, at(2));
    const other = c.addPreviewComment('r-1', { version: 1, pin: { x: 1, y: 1 }, text: 'There' }, at(3));
    expect(one?.pin).toEqual({ n: 1, x: 62, y: 18 });
    expect(one?.text).toBe('Bigger');
    expect(two?.pin).toEqual({ n: 2, x: 100, y: 0 });
    expect(other?.pin?.n).toBe(1);
    expect(c.addPreviewComment('r-1', { version: 2, pin: null, text: '   ' })).toBeNull();
    expect(c.previewCommentsOf('r-1')).toHaveLength(3);
    c.removePreviewComment('r-1', one!.id);
    expect(c.previewCommentsOf('r-1').map((x) => x.text)).toEqual(['Here', 'There']);
  });

  it('go when their call stops waiting', () => {
    c.addPreviewComment('r-1', { version: 1, pin: null, text: 'x' });
    expect(c.previewCommentsOf('r-1')).toHaveLength(1);
    gate.waiting.delete('r-1');
    gate.listener?.(7);
    expect(c.previewCommentsOf('r-1')).toHaveLength(0);
  });
});
