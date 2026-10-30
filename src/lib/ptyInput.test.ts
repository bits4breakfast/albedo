import { describe, expect, it } from 'vitest';
import { pasteSegments, SUBMIT_DELAY_IMAGE_MS, SUBMIT_DELAY_MS, submitDelayFor } from './ptyInput';
import { markerSpans } from '../ui/transcript/albedoMarkers';
import { markPastes, placeholderFor } from '../ui/transcript/pastedText';

describe('submitDelayFor', () => {
  it('waits longer when the message carries an image path', () => {
    expect(submitDelayFor('look at /T/Screenshot\\ 2026-10-17\\ at\\ 14.25.44.png please')).toBe(SUBMIT_DELAY_IMAGE_MS);
    expect(submitDelayFor('/Users/me/shot.JPG')).toBe(SUBMIT_DELAY_IMAGE_MS);
  });
  it('uses the short pause otherwise', () => {
    expect(submitDelayFor('push it once tests pass')).toBe(SUBMIT_DELAY_MS);
    expect(submitDelayFor('the png format is fine')).toBe(SUBMIT_DELAY_MS);
  });
});

describe('pasteSegments', () => {
  it('sends each image path as its own paste, the text around it as the rest', () => {
    const body = '/Users/m/Desktop/Screenshot\\ 2026-10-20\\ at\\ 13.47.50.png these two options should line up';
    expect(pasteSegments(body)).toEqual([
      { text: '/Users/m/Desktop/Screenshot\\ 2026-10-20\\ at\\ 13.47.50.png', image: true },
      { text: ' these two options should line up', image: false },
    ]);
  });

  it('finds paths mid-message and side by side, and leaves plain text whole', () => {
    expect(pasteSegments('compare ~/a.png /b/c.JPG please').map((s) => s.image)).toEqual([false, true, false, true, false]);
    expect(pasteSegments('no pictures here, just src/app.tsx')).toEqual([
      { text: 'no pictures here, just src/app.tsx', image: false },
    ]);
  });

  it('keeps a paste from the message box whole, image path or not (#155)', () => {
    const log = 'build failed\nsaved /tmp/out/diff.png\nsee above\nexit 1';
    const body = markPastes(`~/shot.png and ${placeholderFor(1, log)}`, new Map([[1, log]]));
    const segments = pasteSegments(body, markerSpans(body));
    // The typed path still goes alone; the one in the paste stays in it.
    expect(segments.map((s) => s.image)).toEqual([true, false]);
    expect(segments[1]?.text).toBe(body.slice('~/shot.png'.length));
  });
});
