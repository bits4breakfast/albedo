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

/**
 * An image path as the composer writes one: absolute or `~/`, with shell
 * specials backslash-escaped (shellEscapePath), ending in an image extension.
 */
const IMAGE_PATH_TOKEN_RE =
  /(^|\s)((?:~\/|\/)(?:\\.|[^\s\\])*?\.(?:png|jpe?g|gif|webp|heic|tiff?|bmp))(?=\s|$)/gi;

export interface PasteSegment {
  text: string;
  /** A lone image path: Claude Code turns it into an attachment. */
  image: boolean;
}

/**
 * The message cut into the pastes it is sent as.
 *
 * Claude Code makes a pasted path into an image attachment only when the
 * paste IS the path. One paste holding text and a path together arrives as
 * text, and the picture never reaches the model. So each image path goes as a
 * paste of its own, and the text around it as the pastes between.
 */
export function pasteSegments(body: string): PasteSegment[] {
  const out: PasteSegment[] = [];
  let at = 0;
  for (const m of body.matchAll(IMAGE_PATH_TOKEN_RE)) {
    // The leading whitespace (group 1) stays with the text before the path.
    const path = m[2] as string;
    const start = (m.index ?? 0) + (m[1] as string).length;
    if (start > at) out.push({ text: body.slice(at, start), image: false });
    out.push({ text: path, image: true });
    at = start + path.length;
  }
  if (at < body.length) out.push({ text: body.slice(at), image: false });
  return out.filter((s) => s.text.length > 0);
}

/** How long to wait between the paste and the Enter. */
export function submitDelayFor(body: string): number {
  return IMAGE_PATH_RE.test(body) ? SUBMIT_DELAY_IMAGE_MS : SUBMIT_DELAY_MS;
}
