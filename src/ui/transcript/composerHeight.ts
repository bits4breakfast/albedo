/**
 * How tall the message box is, given what it holds (#135).
 *
 * Its resting height is the one the user dragged it to. Content grows it from
 * there up to half as much again, then it scrolls; removing content shrinks it
 * back to the resting height, never below. With no dragged height it keeps the
 * auto-grow it always had, from its CSS min-height up to COMPOSER_MAX_PX --
 * 1.5 times a one-line box would be no growth at all.
 *
 * Whatever the rule says, it never takes more than `available`: the pane must
 * not be pushed off screen.
 */

/** Auto-grow ceiling with no dragged height. Past this the box scrolls. */
export const COMPOSER_MAX_PX = 140;

/** Smallest a dragged composer can be: one line of text. */
export const COMPOSER_MIN_PX = 28;

/** How much a dragged box may grow with its content: up to 150% of resting. */
export const COMPOSER_GROW = 1.5;

/** Transcript the box always leaves above itself, so it never fills the pane. */
export const TRANSCRIPT_MIN_PX = 120;

export interface ComposerSize {
  /** The content's natural height (the textarea's scrollHeight at `auto`). */
  content: number;
  /** The dragged height, or null for auto-grow. */
  resting: number | null;
  /** Most the box may take; Infinity when it cannot be measured. */
  available: number;
}

/** The box's height in whole pixels. */
export function composerHeight({ content, resting, available }: ComposerSize): number {
  const floor = resting ?? 0; // with no drag, the CSS min-height is the floor
  const ceiling = resting === null ? COMPOSER_MAX_PX : Math.floor(resting * COMPOSER_GROW);
  const wanted = Math.max(floor, Math.min(content, ceiling));
  return Math.round(Math.min(wanted, Math.max(COMPOSER_MIN_PX, available)));
}
