/**
 * What the editor does with a file that is not text.
 *
 * A picture is shown as a picture, and any other binary as a short notice of
 * what it is -- never decoded as text, which fills the editor with replacement
 * characters and invites a Save that would corrupt the file.
 *
 * SVG is deliberately absent: it is text, it is edited as text, and its diff
 * is a text diff.
 */

/** The image types WebKit renders, by extension. */
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  heic: 'image/heic',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

/** The MIME type to show `path` as an image with, or null when it is not one. */
export function imageTypeForPath(path: string): string | null {
  const dot = path.lastIndexOf('.');
  if (dot < 0 || dot < path.lastIndexOf('/')) return null;
  return IMAGE_TYPES[path.slice(dot + 1).toLowerCase()] ?? null;
}

/** "12 KB", "3.4 MB": a size to read, not to compare. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
