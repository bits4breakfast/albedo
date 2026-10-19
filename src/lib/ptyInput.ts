/**
 * Timing for typing a message into Claude Code's input through the pty.
 *
 * The paste and the submitting Enter are separate writes (see submitPty in
 * Terminal.tsx): Claude Code drops an Enter that arrives on the heels of a
 * paste, and takes longer still when the paste holds an image path, which it
 * reads and turns into an attachment first.
 */

/** A path to an image, as a dropped file or a typed path would put it. */
const IMAGE_PATH_RE = /\/[^\n]*\.(png|jpe?g|gif|webp|heic|tiff?|bmp)\b/i;

export const SUBMIT_DELAY_MS = 250;
export const SUBMIT_DELAY_IMAGE_MS = 1200;

/** How long to wait between the paste and the Enter. */
export function submitDelayFor(body: string): number {
  return IMAGE_PATH_RE.test(body) ? SUBMIT_DELAY_IMAGE_MS : SUBMIT_DELAY_MS;
}
