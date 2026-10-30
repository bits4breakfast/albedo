/**
 * The editor's one-line notice that PHP navigation is answering by text
 * search, and why: PHPantom couldn't start (#73), or it isn't installed
 * (#172). Navigation works either way -- git grep answers -- so this is the
 * only sign that same-named methods may match and inheritance is missed.
 *
 * What PHPantom's state is comes from `phpantomAvailability` (the pool knows,
 * the UI doesn't guess). What is still to be said lives here:
 *
 * - couldn't start: until OK, once per run (the pool keeps that flag).
 * - not installed: until OK, and OK is remembered on this machine. It is a
 *   choice the user may have made on purpose, so it is said once and then
 *   left alone; installing later needs no notice.
 */

import { useSyncExternalStore } from 'react';
import {
  dismissPhpantomFailure,
  isPhpPath,
  phpantomAvailability,
  phpantomFailure,
  subscribePhpantom,
} from '../../lsp/phpantom';
import { flagCodec, KEYS, readPersisted, writePersisted } from '../persisted';

/** The install route the notice copies: bundled into the app, pinned with the build. */
export const PHPANTOM_INSTALL_COMMAND = './build.sh --install --with-phpantom';

/** Both ways to get it, for the notice's tooltip. Albedo itself never downloads it. */
export const PHPANTOM_INSTALL_HELP =
  `Go to Declaration, Find Usages and Go to Implementation answer by git grep, ` +
  `so a list can hold same-named methods and miss what inheritance reaches. ` +
  `To install PHPantom: ${PHPANTOM_INSTALL_COMMAND} (bundled into the app), ` +
  `or scripts/install-phpantom.sh (into ~/.albedo/bin).`;

export type PhpantomNotice = { kind: 'failed'; reason: string } | { kind: 'missing' };

let missingDismissed: boolean | null = null;
const listeners = new Set<() => void>();

function isMissingDismissed(): boolean {
  if (missingDismissed === null) missingDismissed = readPersisted(KEYS.phpantomMissingDismissed, flagCodec, false);
  return missingDismissed;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const off = subscribePhpantom(listener);
  return () => {
    listeners.delete(listener);
    off();
  };
}

/** One snapshot string, so `useSyncExternalStore` sees a stable value. */
function snapshot(): string {
  const failure = phpantomFailure();
  if (failure !== null) return `failed:${failure}`;
  if (phpantomAvailability() === 'not-installed' && !isMissingDismissed()) return 'missing';
  return '';
}

/** "Not installed" seen: not shown again on this machine. */
export function dismissPhpantomMissing(): void {
  missingDismissed = true;
  writePersisted(KEYS.phpantomMissingDismissed, flagCodec, true);
  for (const l of listeners) l();
}

/** Dismiss whichever notice is showing. */
export function dismissPhpantomNotice(notice: PhpantomNotice): void {
  if (notice.kind === 'failed') dismissPhpantomFailure();
  else dismissPhpantomMissing();
}

/** The notice to show for the open file: on a PHP file only, the one place it matters. */
export function usePhpantomNotice(path: string | null): PhpantomNotice | null {
  const snap = useSyncExternalStore(subscribe, snapshot);
  if (path === null || !isPhpPath(path) || snap === '') return null;
  if (snap === 'missing') return { kind: 'missing' };
  return { kind: 'failed', reason: snap.slice('failed:'.length) };
}

/** Tests only: forget the remembered dismissal, as a fresh launch would read it. */
export function __resetPhpantomNotice(): void {
  missingDismissed = null;
}
