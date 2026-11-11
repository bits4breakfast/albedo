/**
 * "Group Tool Calls" in ⋯ (#358): fold each run of tool calls in the
 * transcript into one line (toolGroups.ts). On by default, remembered in
 * localStorage like the other ⋯ preferences (persisted.ts).
 */

import { useSyncExternalStore } from 'react';
import { KEYS, readPersisted, writePersisted, type Codec } from '../persisted';

/** Only 'off' is stored; on removes the key. */
const onOff: Codec<boolean> = {
  decode: (raw) => raw !== 'off',
  encode: (on) => (on ? null : 'off'),
};

const listeners = new Set<() => void>();
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Never throws: no storage reads as "on". */
export function groupToolCallsEnabled(): boolean {
  return readPersisted(KEYS.groupToolCalls, onOff, true);
}

export function setGroupToolCalls(on: boolean): void {
  writePersisted(KEYS.groupToolCalls, onOff, on);
  for (const l of [...listeners]) l();
}

/** The setting, for the menu that shows it and the pane that obeys it. */
export function useGroupToolCalls(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, groupToolCallsEnabled);
  return [on, setGroupToolCalls];
}
