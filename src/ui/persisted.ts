/**
 * Everything Albedo keeps in localStorage: the keys, and one way to read and
 * write them.
 *
 * Only per-machine view preferences live here -- widths, which tab, which
 * notice was waved away -- and the composer's unsent drafts. Anything that has to survive a reinstall or be
 * reprocessed belongs in SQLite. Every key is listed below, so this file is
 * the whole answer to "what does the app remember outside the database".
 *
 * THE STORED STRINGS ARE A FORMAT. Users already have these values on disk,
 * so a codec may learn to read more, never to read less: numbers stay plain
 * strings, booleans stay '1'/'0', id lists stay JSON arrays. Change an
 * encoding and existing settings silently fall back to their defaults.
 *
 * Every access is wrapped: a locked-down WebView throws on `localStorage`
 * rather than returning null, and no remembered preference is worth an error.
 */

import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

export const KEYS = {
  // The frame (App.tsx and its hooks in ui/app/).
  sidebarWidth: 'albedo.shell.sidebarWidth',
  paneMode: 'albedo.shell.paneMode',
  splitRatio: 'albedo.shell.splitRatio',
  orientation: 'albedo.shell.orientation',
  selectedTask: 'albedo.shell.selectedTask',
  activeProject: 'albedo.shell.activeProject',
  rightTab: 'albedo.shell.rightTab',
  filesPinned: 'albedo.shell.filesPinned',
  filesWidth: 'albedo.shell.filesWidth',
  shellOpen: 'albedo.shell.shellDrawerOpen',
  shellHeight: 'albedo.shell.shellDrawerHeight',
  dismissedNotices: 'albedo.shell.dismissedNotices',
  /** The shell owns this one's shape; the projects manager reads and unhides. */
  hiddenProjects: 'albedo.shell.hiddenProjects',
  projectOrder: 'albedo.shell.projectOrder',
  theme: 'albedo.shell.theme',
  zoom: 'albedo.zoom',
  /** The new-task dialog's default project. */
  lastProjectId: 'albedo.worktree.lastProjectId',
  touchedMode: 'albedo.touched.mode',
  /** The Files pane: the change set, or the whole worktree as a tree. */
  touchedView: 'albedo.touched.view',
  composerPx: 'albedo.composerPx',
  /** Unsent composer drafts, one per task (transcript/drafts.ts owns the shape). */
  composerDrafts: 'albedo.composerDrafts',
  /** Absent means on. */
  notifications: 'albedo.notifications',
  commentsIntro: 'albedo.comments.intro',
  /** One per task: the model its session is launched on. */
  taskModel: (taskId: number) => `albedo.taskModel.${taskId}`,
} as const;

export interface Codec<T> {
  /** The stored string as a value, or null when it is not one (reads as the fallback). */
  decode: (raw: string) => T | null;
  /**
   * The string to store. Null removes the key -- for values whose absence
   * already means the default. Undefined leaves whatever is stored alone, for
   * a value not worth remembering.
   */
  encode: (value: T) => string | null | undefined;
}

/** The stored value, or `fallback` when there is none, it does not decode, or storage throws. */
export function readPersisted<T, F = T>(key: string, codec: Codec<T>, fallback: F): T | F {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const value = codec.decode(raw);
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

/** Remember a value. Best effort, never throws: it is only lost on restart. */
export function writePersisted<T>(key: string, codec: Codec<T>, value: T): void {
  try {
    const raw = codec.encode(value);
    if (raw === undefined) return;
    if (raw === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, raw);
  } catch {
    /* private mode / quota -- a preference is not worth an error */
  }
}

/**
 * `useState` mirrored to storage: read once at mount, written whenever the
 * value changes (including the first render, as the hand-written effects it
 * replaced did). `codec` must be a module-level constant; a new object every
 * render would rewrite the key every render.
 */
export function usePersisted<T>(
  key: string,
  codec: Codec<T>,
  fallback: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => readPersisted(key, codec, fallback));
  useEffect(() => writePersisted(key, codec, value), [key, codec, value]);
  return [value, setValue];
}

// ---------------------------------------------------------------------------
// Shared codecs
// ---------------------------------------------------------------------------

/** '1' / '0'. Anything else is not a flag. */
export const flagCodec: Codec<boolean> = {
  decode: (raw) => (raw === '1' ? true : raw === '0' ? false : null),
  encode: (value) => (value ? '1' : '0'),
};

/**
 * An id, as `String(id)`. Lenient on purpose, as the readers it replaced were:
 * anything `Number()` makes finite is accepted, which includes ''.
 */
export const idCodec: Codec<number> = {
  decode: (raw) => (Number.isFinite(Number(raw)) ? Number(raw) : null),
  encode: (value) => String(value),
};

/** A JSON array of numbers. Non-numbers inside it are dropped, not fatal. */
export const numberListCodec: Codec<number[]> = {
  decode: (raw) => {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is number => typeof v === 'number') : null;
  },
  encode: (value) => JSON.stringify(value),
};

/** A JSON array of strings. Non-strings inside it are dropped, not fatal. */
export const stringListCodec: Codec<string[]> = {
  decode: (raw) => {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : null;
  },
  encode: (value) => JSON.stringify(value),
};

/** One of a fixed set of strings; anything else reads as the fallback. */
export function oneOfCodec<T extends string>(values: readonly T[]): Codec<T> {
  return {
    decode: (raw) => ((values as readonly string[]).includes(raw) ? (raw as T) : null),
    encode: (value) => value,
  };
}
