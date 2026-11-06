/**
 * The line a message with code comments opens with, until the person writes
 * their own. Edited from the comment queue's header above the message box
 * (#222; it lived in the Files pane before). Stored only when rewritten.
 */

import { useSyncExternalStore } from 'react';
import { DEFAULT_COMMENTS_INTRO } from '../db/comments';
import { KEYS, readPersisted, writePersisted, type Codec } from './persisted';

/** The default removes the key. An empty intro is kept: no opening line at all. */
const introCodec: Codec<string> = {
  decode: (raw) => raw,
  encode: (text) => (text === DEFAULT_COMMENTS_INTRO ? null : text),
};

const listeners = new Set<() => void>();
let current: string | null = null;

export function readIntro(): string {
  if (current === null) current = readPersisted(KEYS.commentsIntro, introCodec, DEFAULT_COMMENTS_INTRO);
  return current;
}

/** Kept for this session only when storage throws. */
export function writeIntro(text: string): void {
  current = text;
  writePersisted(KEYS.commentsIntro, introCodec, text);
  for (const l of listeners) l();
}

export function useCommentsIntro(): string {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    readIntro,
  );
}

/** Test seam. */
export function __resetIntro(): void {
  current = null;
}
