import { describe, expect, it } from 'vitest';
import { activateTab, closeTab, EMPTY_TABS, openTab, replaceActiveTab, type TabsState } from './tabsModel';

const open = (s: TabsState, key: string, line?: number) => openTab(s, key, { path: key, line: line ?? null });
const keys = (s: TabsState) => s.tabs.map((t) => t.key);
const activeKey = (s: TabsState) => s.tabs.find((t) => t.id === s.active)?.key ?? null;

describe('tabsModel', () => {
  it('opens a new file in a tab right after the active one', () => {
    let s = open(open(open(EMPTY_TABS, 'a.php'), 'b.php'), 'c.php');
    s = activateTab(s, s.tabs[0]!.id);
    s = open(s, 'd.php');
    expect(keys(s)).toEqual(['a.php', 'd.php', 'b.php', 'c.php']);
    expect(activeKey(s)).toBe('d.php');
  });

  it('switches to a file that is already open, with the new line', () => {
    let s = open(open(EMPTY_TABS, 'a.php'), 'b.php');
    s = open(s, 'a.php', 42);
    expect(keys(s)).toEqual(['a.php', 'b.php']);
    expect(activeKey(s)).toBe('a.php');
    expect(s.tabs[0]!.request.line).toBe(42);
  });

  it('closing a tab goes back to the one used before it, not its neighbour', () => {
    // a, then b and c opened, then back to a and a jump from a to d.
    let s = open(open(open(EMPTY_TABS, 'a.php'), 'b.php'), 'c.php');
    s = activateTab(s, s.tabs[0]!.id);
    s = open(s, 'd.php');
    s = closeTab(s, s.active!);
    expect(activeKey(s)).toBe('a.php');
    s = closeTab(s, s.active!);
    expect(activeKey(s)).toBe('c.php');
  });

  it('closing an inactive tab leaves the active one alone', () => {
    let s = open(open(EMPTY_TABS, 'a.php'), 'b.php');
    s = closeTab(s, s.tabs[0]!.id);
    expect(keys(s)).toEqual(['b.php']);
    expect(activeKey(s)).toBe('b.php');
  });

  it('closing the last tab leaves nothing active', () => {
    const s = closeTab(open(EMPTY_TABS, 'a.php'), 1);
    expect(s.tabs).toEqual([]);
    expect(s.active).toBeNull();
  });

  it('a step replaces the active tab, or switches to the file if it is open', () => {
    let s = open(open(EMPTY_TABS, 'a.php'), 'b.php');
    s = replaceActiveTab(s, 'c.php', { path: 'c.php' });
    expect(keys(s)).toEqual(['a.php', 'c.php']);
    s = replaceActiveTab(s, 'a.php', { path: 'a.php' });
    expect(keys(s)).toEqual(['a.php', 'c.php']);
    expect(activeKey(s)).toBe('a.php');
  });
});
