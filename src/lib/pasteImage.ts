/**
 * Pasting a screenshot (⌘V) into the message box: the pure half.
 *
 * Claude Code takes images as file paths in the prompt, so a paste that
 * carries image bytes is written to `~/.albedo/paste/` and its path inserted,
 * exactly as a Finder drop inserts one (docs/ARCHITECTURE.md, "Images go in
 * as paths"). Not the worktree -- it would show up in `git status` as a change
 * the agent made -- and not temp, which is cleaned while a resumed session
 * still references the path.
 *
 * Nothing here touches the pty or looks at what it prints.
 */

/** Where pasted images land, relative to `$HOME`. Inside the fs scope's `$HOME/.albedo/**`. */
export const PASTE_DIR = '.albedo/paste';

/**
 * The first image a paste carries, or null for anything else.
 *
 * Only `kind === 'file'` items count: a paste from a browser can carry an
 * `image/*` string flavour alongside the text, and a text paste must behave
 * exactly as it always has. Takes the minimal shape so a test needs no DOM.
 */
export function imageFromClipboard(
  items: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }> | null | undefined,
): File | null {
  if (!items) return null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return null;
}

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * `20261017-231805-042.png`: sortable, unique to the millisecond, and free of
 * every character `shellEscapePath` would have to escape -- the path in the
 * composer stays readable. macOS screenshots paste as PNG; any type Claude
 * Code may not read is still saved as what it is, never relabelled.
 */
export function pastedImageName(type: string, at: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}` +
    `-${pad(at.getMilliseconds(), 3)}`;
  const ext = EXTENSIONS[type] ?? (type.startsWith('image/') ? type.slice(6).replace(/[^a-z0-9]/gi, '') : '');
  return `${stamp}.${ext || 'png'}`;
}

/** Absolute directory and file path for a pasted image under `home`. */
export function pastedImagePath(home: string, name: string): { dir: string; path: string } {
  const dir = `${home.replace(/\/+$/, '')}/${PASTE_DIR}`;
  return { dir, path: `${dir}/${name}` };
}

/**
 * Write a pasted image under `~/.albedo/paste/` and return its absolute path.
 *
 * The one impure function here. Needs `fs:allow-mkdir` and `fs:allow-write-file`
 * (bytes -- `allow-write-text-file` is not enough) over `$HOME/.albedo/**`.
 * Imports are lazy so the pure helpers above load in plain node for tests.
 */
export async function savePastedImage(image: Blob, at = new Date()): Promise<string> {
  const [{ homeDir }, { mkdir, writeFile }] = await Promise.all([
    import('@tauri-apps/api/path'),
    import('@tauri-apps/plugin-fs'),
  ]);
  const { dir, path } = pastedImagePath(await homeDir(), pastedImageName(image.type, at));
  await mkdir(dir, { recursive: true });
  await writeFile(path, new Uint8Array(await image.arrayBuffer()));
  return path;
}

/**
 * The composer text after inserting `insert`: separated from what is already
 * there by one space, followed by one, so the next word does not glue onto
 * the path. Identical to what a drop does.
 */
export function withInsertedPath(text: string, insert: string): string {
  return text.length === 0 || /\s$/.test(text) ? `${text}${insert} ` : `${text} ${insert} `;
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|heic|tiff?|bmp)$/i;

/**
 * A file macOS will delete shortly: the screenshot thumbnail's drag source
 * (`/var/folders/.../T/TemporaryItems/NSIRD_screencaptureui_*`) is gone moments
 * after the drop, before Claude Code reads it on send.
 */
export function isEphemeralPath(path: string): boolean {
  return /^(\/private)?\/var\/folders\//.test(path) || path.includes('/TemporaryItems/');
}

/**
 * The path to insert for a dropped file: a temporary image is copied to
 * `~/.albedo/paste/` first, as a pasted one is, and anything else is left
 * where it is. A drop is in the fs scope already (tauri-plugin-fs allows every
 * dropped path). On failure the original path goes in, which is no worse than
 * before.
 */
export async function keepDroppedFile(path: string, at = new Date()): Promise<string> {
  if (!isEphemeralPath(path) || !IMAGE_EXT_RE.test(path)) return path;
  try {
    const [{ homeDir }, { mkdir, readFile, writeFile }] = await Promise.all([
      import('@tauri-apps/api/path'),
      import('@tauri-apps/plugin-fs'),
    ]);
    const ext = (IMAGE_EXT_RE.exec(path)?.[1] ?? 'png').toLowerCase();
    const type = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    const { dir, path: kept } = pastedImagePath(await homeDir(), pastedImageName(type, at));
    await mkdir(dir, { recursive: true });
    await writeFile(kept, await readFile(path));
    return kept;
  } catch {
    return path;
  }
}
