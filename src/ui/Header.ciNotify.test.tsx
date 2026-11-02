/**
 * @vitest-environment jsdom
 *
 * "Notify About PRs: Checks and Reviews" (#159, relabelled for #180) is a
 * toggle in the header's ⋯ menu, beside the theme -- where a person finds
 * it, not only a stored key.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import Header from './Header';

afterEach(cleanup);

function renderHeader(ciNotify: boolean, onCiNotifyChange = vi.fn()) {
  render(
    <Header
      onReconcile={() => {}}
      onProjects={() => {}}
      onSessions={() => {}}
      onShortcuts={() => {}}
      blockedCount={0}
      theme="system"
      onThemeChange={() => {}}
      ciNotify={ciNotify}
      onCiNotifyChange={onCiNotifyChange}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  return onCiNotifyChange;
}

describe('Header: Notify About PRs: Checks and Reviews', () => {
  it('shows the setting as a checked toggle and turns it off', () => {
    const change = renderHeader(true);
    const item = screen.getByRole('menuitemcheckbox', { name: /Notify About PRs: Checks and Reviews/ });
    expect(item.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(item);
    expect(change).toHaveBeenCalledWith(false);
  });

  it('turns it back on', () => {
    const change = renderHeader(false);
    const item = screen.getByRole('menuitemcheckbox', { name: /Notify About PRs: Checks and Reviews/ });
    expect(item.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(item);
    expect(change).toHaveBeenCalledWith(true);
  });
});
