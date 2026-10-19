import { describe, expect, it } from 'vitest';
import { SUBMIT_DELAY_IMAGE_MS, SUBMIT_DELAY_MS, submitDelayFor } from './ptyInput';

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
