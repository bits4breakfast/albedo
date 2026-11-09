/**
 * @vitest-environment jsdom
 *
 * "Keep the Mac Awake While Tasks Run" (#283) is a toggle in the header's
 * ⋯ menu, beside the PR notifications -- where a person finds it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import Header from './Header';

afterEach(cleanup);

function renderHeader(keepAwake: boolean | undefined, onKeepAwakeChange = vi.fn()) {
  render(
    <Header
      onReconcile={() => {}}
      onProjects={() => {}}
      onSessions={() => {}}
      onShortcuts={() => {}}
      blockedCount={0}
      theme="system"
      onThemeChange={() => {}}
      ciNotify
      onCiNotifyChange={() => {}}
      keepAwake={keepAwake}
      onKeepAwakeChange={keepAwake === undefined ? undefined : onKeepAwakeChange}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  return onKeepAwakeChange;
}

describe('Header: Keep the Mac Awake While Tasks Run', () => {
  it('shows the setting as a checked toggle, after the PR notifications, and turns it off', () => {
    const change = renderHeader(true);
    const item = screen.getByRole('menuitemcheckbox', { name: /Keep the Mac Awake While Tasks Run/ });
    expect(item.getAttribute('aria-checked')).toBe('true');
    const toggles = screen.getAllByRole('menuitemcheckbox').map((e) => e.textContent ?? '');
    const at = toggles.findIndex((t) => t.includes('Keep the Mac Awake'));
    expect(toggles[at - 1]).toMatch(/Notify About PRs/);
    fireEvent.click(item);
    expect(change).toHaveBeenCalledWith(false);
  });

  it('turns it back on', () => {
    const change = renderHeader(false);
    const item = screen.getByRole('menuitemcheckbox', { name: /Keep the Mac Awake While Tasks Run/ });
    expect(item.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(item);
    expect(change).toHaveBeenCalledWith(true);
  });

  it('is not shown without the setting', () => {
    renderHeader(undefined);
    expect(screen.queryByRole('menuitemcheckbox', { name: /Keep the Mac Awake/ })).toBeNull();
  });
});
