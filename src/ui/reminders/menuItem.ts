import type { OverflowItem } from '../OverflowMenu';

/**
 * "Remind Me…" for the task's ⋯ menus (#156, #331): opens the dialog that sets
 * one and lists those still to come, which the item counts.
 */
export function remindMenuItem(pending: number, onSelect: () => void): OverflowItem {
  return {
    id: 'remind',
    label: 'Remind Me…',
    aside: pending > 0 ? `${pending} set` : undefined,
    title: 'A note that comes back on this task at a time you choose',
    onSelect,
  };
}
