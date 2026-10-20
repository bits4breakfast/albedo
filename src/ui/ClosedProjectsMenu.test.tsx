/**
 * @vitest-environment jsdom
 *
 * TODO §9a: the menu opened inside `.project-tabs`, whose `overflow-y: hidden`
 * clipped it to nothing. jsdom cannot see clipping, so what is pinned here is
 * the structural fix -- the menu is NOT a descendant of the strip -- plus the
 * dismissal model that has to come with leaving the tree.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ClosedProjectsMenu, { menuPosition } from './ClosedProjectsMenu';
import type { Project } from '../types';

afterEach(cleanup);

const project = (id: number, name: string) => ({ id, name }) as Project;

function mount(onRestore = vi.fn()) {
  render(
    <div className="project-tabs" data-testid="strip">
      <ClosedProjectsMenu hidden={[project(1, 'albedo'), project(2, 'guru')]} onRestore={onRestore} />
    </div>,
  );
  return onRestore;
}

describe('ClosedProjectsMenu', () => {
  it('renders the menu outside the clipping strip', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: '+2 Closed' }));
    const menu = screen.getByRole('menu');
    expect(screen.getByTestId('strip').contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
  });

  it('restores the chosen project and closes', () => {
    const onRestore = mount();
    fireEvent.click(screen.getByRole('button', { name: '+2 Closed' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'guru' }));
    expect(onRestore).toHaveBeenCalledWith(2);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on Esc and returns focus to the chip', () => {
    mount();
    const chip = screen.getByRole('button', { name: '+2 Closed' });
    fireEvent.click(chip);
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'albedo' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it('closes on a press outside, but not on a press inside', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: '+2 Closed' }));
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'albedo' }));
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('toggles from the chip without the outside-press handler reopening it', () => {
    mount();
    const chip = screen.getByRole('button', { name: '+2 Closed' });
    fireEvent.click(chip);
    fireEvent.pointerDown(chip);
    fireEvent.click(chip);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('moves between items with the arrow keys, wrapping', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: '+2 Closed' }));
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'guru' }));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'albedo' }));
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'guru' }));
  });
});

describe('menuPosition', () => {
  it('right-aligns under the chip', () => {
    expect(menuPosition({ left: 400, right: 480, bottom: 30 }, 1200)).toEqual({ left: 310, top: 32 });
  });

  it('stays inside the window on both sides', () => {
    expect(menuPosition({ left: 1150, right: 1260, bottom: 30 }, 1200).left).toBe(1200 - 170 - 8);
    expect(menuPosition({ left: 0, right: 60, bottom: 30 }, 1200).left).toBe(8);
  });
});
