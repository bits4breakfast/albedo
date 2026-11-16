/**
 * "Group Tool Calls" in ⋯ (#358): fold each run of tool calls in the
 * transcript into one line (toolGroups.ts). On by default, remembered in
 * localStorage like the other ⋯ preferences (persisted.ts).
 */

import { KEYS, persistedSwitch, usePersistedSwitch } from '../persisted';

const groupSwitch = persistedSwitch(KEYS.groupToolCalls);

/** Never throws: no storage reads as "on". */
export const groupToolCallsEnabled = groupSwitch.get;

export const setGroupToolCalls = groupSwitch.set;

/** The setting, for the menu that shows it and the pane that obeys it. */
export function useGroupToolCalls(): [boolean, (on: boolean) => void] {
  return usePersistedSwitch(groupSwitch);
}
