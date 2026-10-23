/**
 * What kind of file a row names, by shape: the Project tree, the Changes rows
 * and Quick Open draw the same glyph for the same file.
 *
 * One hand-drawn set on the 16-unit grid and 1.5 stroke of BranchIcon /
 * FolderIcon, in currentColor. The glyphs are told apart by silhouette, not
 * colour, so each surface paints them in one existing text token and no new
 * contrast pair is introduced. Decorative: the file name beside one is the
 * label, so every glyph is aria-hidden (Glyph does that).
 */

import type { ReactNode } from 'react';
import { Glyph } from './icons';

export type FileIconKind =
  | 'php'
  | 'react'
  | 'script'
  | 'data'
  | 'manifest'
  | 'config'
  | 'docs'
  | 'styles'
  | 'markup'
  | 'image'
  | 'shell'
  | 'sql'
  | 'lock'
  | 'file';

/** Each kind's names, turned round into a lookup. */
function byKind(names: Partial<Record<FileIconKind, readonly string[]>>): ReadonlyMap<string, FileIconKind> {
  const out = new Map<string, FileIconKind>();
  for (const [kind, list] of Object.entries(names) as [FileIconKind, readonly string[]][]) {
    for (const n of list) out.set(n, kind);
  }
  return out;
}

/**
 * By extension, lower-cased. Only the last extension counts here; the
 * multi-dot names that mean something else (`.blade.php`) are in iconFor.
 */
const BY_EXTENSION = byKind({
  php: ['php', 'phtml'],
  react: ['jsx', 'tsx'],
  script: ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'],
  data: ['json'],
  config: ['yml', 'yaml', 'toml', 'ini'],
  docs: ['md', 'mdx', 'txt'],
  styles: ['css', 'scss', 'sass'],
  markup: ['html', 'twig'],
  image: ['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp'],
  shell: ['sh'],
  sql: ['sql'],
  lock: ['lock'],
});

/** Whole names, lower-cased, that say more than their extension. */
const BY_NAME = byKind({
  manifest: ['composer.json', 'package.json'],
  lock: ['package-lock.json', 'pnpm-lock.yaml'],
  shell: ['dockerfile', 'makefile', 'gnumakefile'],
});

/** The glyph for a file, from its path (worktree-relative or absolute). */
export function iconFor(path: string): FileIconKind {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const named = BY_NAME.get(name);
  if (named !== undefined) return named;
  if (name === '.env' || name.startsWith('.env.')) return 'config';
  if (name.endsWith('.blade.php')) return 'markup';
  // `Dockerfile.dev`, `api.dockerfile`: still a build recipe.
  if (name.startsWith('dockerfile.') || name.endsWith('.dockerfile')) return 'shell';
  const dot = name.lastIndexOf('.');
  // No extension, or a dotfile with none (`.gitignore`): the generic page.
  if (dot <= 0) return 'file';
  return BY_EXTENSION.get(name.slice(dot + 1)) ?? 'file';
}

/** A page with its corner folded: the fallback, and the outline Docs writes on. */
const PAGE = 'M4 1.75h5.25l3.25 3.25v8.5c0 .41-.34.75-.75.75h-7.75a.75.75 0 0 1-.75-.75v-11c0-.41.34-.75.75-.75z';
const PAGE_FOLD = 'M9.25 1.75V5h3.25';

const DRAWN: Record<FileIconKind, ReactNode> = {
  // An oval with a P: the shape of the PHP mark, without its lettering.
  php: (
    <>
      <ellipse cx="8" cy="8" rx="6.5" ry="4.75" />
      <path d="M6.75 10.5v-5h1.5a1.5 1.5 0 0 1 0 3h-1.5" />
    </>
  ),
  // An atom: three orbits and a nucleus.
  react: (
    <>
      <ellipse cx="8" cy="8" rx="6.5" ry="2.5" />
      <ellipse cx="8" cy="8" rx="6.5" ry="2.5" transform="rotate(60 8 8)" />
      <ellipse cx="8" cy="8" rx="6.5" ry="2.5" transform="rotate(120 8 8)" />
      <path d="M8 8h0" />
    </>
  ),
  // Curly braces: code.
  script: (
    <path d="M5.5 2.25c-1.25 0-1.75.5-1.75 1.75v2c0 1-.5 2-1.5 2 1 0 1.5 1 1.5 2v2c0 1.25.5 1.75 1.75 1.75M10.5 2.25c1.25 0 1.75.5 1.75 1.75v2c0 1 .5 2 1.5 2-1 0-1.5 1-1.5 2v2c0 1.25-.5 1.75-1.75 1.75" />
  ),
  // Square brackets round a column of values.
  data: <path d="M5.25 2.25h-2v11.5h2M10.75 2.25h2v11.5h-2M8 5h0M8 8h0M8 11h0" />,
  // A box: the file that names what the project depends on.
  manifest: <path d="M8 1.75l5.5 3v6.5L8 14.25l-5.5-3v-6.5zM2.5 4.75L8 7.75l5.5-3M8 7.75v6.5" />,
  // Three sliders, each set somewhere different.
  config: (
    <>
      <path d="M2 4h7M12 4h2M2 8h2M7 8h7M2 12h5.5M10.5 12h3.5" />
      <circle cx="10.5" cy="4" r="1.5" />
      <circle cx="5.5" cy="8" r="1.5" />
      <circle cx="9" cy="12" r="1.5" />
    </>
  ),
  // The page, written on.
  docs: <path d={`${PAGE}${PAGE_FOLD}M5.75 8h4.5M5.75 10.75h4.5`} />,
  // A drop of paint.
  styles: <path d="M8 1.75c2.75 3.25 4.25 5.5 4.25 7.75a4.25 4.25 0 0 1-8.5 0C3.75 7.25 5.25 5 8 1.75z" />,
  // A tag: angle brackets and a slash.
  markup: <path d="M5 4.5L1.75 8 5 11.5M11 4.5L14.25 8 11 11.5M9.25 3l-2.5 10" />,
  // A framed picture: a sun over a hill.
  image: (
    <>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.25" />
      <circle cx="5.5" cy="6.25" r="1.25" />
      <path d="M2 12l4-3.75 2.75 2.5 2-1.75 3.25 3" />
    </>
  ),
  // A terminal prompt.
  shell: (
    <>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.25" />
      <path d="M4.5 6.25L6.75 8 4.5 9.75M8.25 10.25h3.25" />
    </>
  ),
  // A database cylinder.
  sql: (
    <>
      <ellipse cx="8" cy="3.75" rx="5.25" ry="1.75" />
      <path d="M2.75 3.75v8.5c0 .97 2.35 1.75 5.25 1.75s5.25-.78 5.25-1.75v-8.5M2.75 8c0 .97 2.35 1.75 5.25 1.75S13.25 8.97 13.25 8" />
    </>
  ),
  // A padlock: generated, pinned, not edited by hand.
  lock: (
    <>
      <rect x="3.25" y="7.25" width="9.5" height="6.75" rx="1.25" />
      <path d="M5.5 7.25V5a2.5 2.5 0 0 1 5 0v2.25" />
    </>
  ),
  file: <path d={`${PAGE}${PAGE_FOLD}`} />,
};

/** The glyph for a file. `className` places it; the colour is the caller's. */
export function FileIcon({ path, size = 14, className }: { path: string; size?: number; className?: string }) {
  return (
    <Glyph size={size} className={className}>
      {DRAWN[iconFor(path)]}
    </Glyph>
  );
}
