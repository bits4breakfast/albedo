import { useCallback, useEffect, useRef, useState } from 'react';
import { BUILD, type BuildInfo } from '../../lib/build';
import { KEYS, readPersisted, writePersisted } from '../persisted';
import {
  lastList,
  seenBuildCodec,
  seenRecord,
  somethingNeedsAttention,
  whatsNewSince,
  type SeenBuild,
  type WhatsNewList,
} from '../whatsNew';

/** Where the last build run is remembered. The default is localStorage; tests pass their own. */
export interface SeenStore {
  read: () => SeenBuild | null;
  write: (seen: SeenBuild) => void;
}

const localSeen: SeenStore = {
  read: () => readPersisted(KEYS.whatsNewSeen, seenBuildCodec, null),
  write: (seen) => writePersisted(KEYS.whatsNewSeen, seenBuildCodec, seen),
};

/** First look after the window has had time to draw its dialogs and cards; then this often. */
const FIRST_LOOK_MS = 1500;
const LOOK_EVERY_MS = 1000;

export interface UseWhatsNewOptions {
  /** Something not in the DOM asks for the user first: the selected task is waiting on them. */
  hold: boolean;
  build?: BuildInfo | null;
  store?: SeenStore;
  /** Defaults to the DOM check in whatsNew.ts. */
  busy?: () => boolean;
}

/**
 * What's New, once per new build (#147). At launch, compare the running build
 * with the one last run here; if there is a list, wait until nothing else is
 * asking for the user, then show it. Dismissing remembers the build. The ⋯
 * item reopens the last list at any time.
 */
export default function useWhatsNew({
  hold,
  build = BUILD,
  store = localSeen,
  busy = () => somethingNeedsAttention(document),
}: UseWhatsNewOptions) {
  // Decided once per launch, from what was remembered before it.
  const [launch] = useState(() => whatsNewSince(build, build ? store.read() : null));
  /** The launch list, until it has been dismissed. */
  const pending = useRef<WhatsNewList | null>(launch.kind === 'list' ? launch.list : null);
  const [open, setOpen] = useState<WhatsNewList | null>(null);

  // A first launch, or a new commit with nothing to list: remember it quietly.
  useEffect(() => {
    if (!build || launch.kind !== 'none') return;
    if (launch.reason === 'first-run' || launch.reason === 'no-history') store.write(seenRecord(build, null));
  }, [build, launch, store]);

  const holdRef = useRef(hold);
  holdRef.current = hold;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    if (!pending.current) return;
    let timer: number | undefined;
    const look = () => {
      timer = undefined;
      if (!pending.current) return;
      if (holdRef.current || busyRef.current()) {
        timer = window.setTimeout(look, LOOK_EVERY_MS);
        return;
      }
      setOpen(pending.current);
    };
    timer = window.setTimeout(look, FIRST_LOOK_MS);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  const dismiss = useCallback(() => {
    setOpen(null);
    if (build && pending.current) {
      store.write(seenRecord(build, pending.current));
      pending.current = null;
    }
  }, [build, store]);

  /** The ⋯ item: the launch list if it has not been dismissed yet, else the last one. */
  const reopen = useCallback(() => {
    const list = pending.current ?? lastList(build, store.read());
    if (list) setOpen(list);
  }, [build, store]);

  return { open, dismiss, reopen, available: lastList(build, null) !== null || pending.current !== null };
}
