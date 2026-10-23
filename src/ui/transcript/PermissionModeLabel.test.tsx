/**
 * @vitest-environment jsdom
 *
 * The composer's permission-mode label: every mode has a word and a tone, and
 * an unknown mode shows nothing rather than a guess.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

const harness = vi.hoisted(() => ({
  modes: new Map<string, string>(),
  listeners: new Set<(sid: string) => void>(),
  loaded: [] as string[],
}));
vi.mock('../../capture', () => ({
  permissionModeFor: (sid: string) => harness.modes.get(sid) ?? null,
  loadPermissionMode: async (sid: string) => {
    harness.loaded.push(sid);
  },
  onPermissionModeChange: (l: (sid: string) => void) => {
    harness.listeners.add(l);
    return () => harness.listeners.delete(l);
  },
}));

import type { PermissionMode } from '../../capture';
import { PermissionModeLabel, permissionModeTitle, permissionModeView } from './PermissionModeLabel';

afterEach(() => {
  cleanup();
  harness.modes.clear();
  harness.listeners.clear();
  harness.loaded = [];
});

describe('permissionModeView', () => {
  it('names every mode, and sets plan and bypass apart', () => {
    const modes: PermissionMode[] = ['default', 'auto', 'plan', 'acceptEdits', 'bypassPermissions', 'dontAsk'];
    const texts = modes.map((m) => [m, permissionModeView(m)?.text, permissionModeView(m)?.tone]);
    expect(texts).toEqual([
      ['default', 'Ask', 'quiet'],
      ['auto', 'Auto', 'quiet'],
      ['plan', 'Plan', 'plan'],
      ['acceptEdits', 'Accept Edits', 'quiet'],
      ['bypassPermissions', 'Bypass', 'bypass'],
      ['dontAsk', "Don't Ask", 'quiet'],
    ]);
  });

  it('has no label for an unknown mode', () => {
    expect(permissionModeView(null)).toBeNull();
  });

  it('says how to switch and that the label trails a switch', () => {
    const title = permissionModeTitle(permissionModeView('plan')!);
    expect(title).toContain('Plan: ');
    expect(title).toContain('Switch with ⇧⇥ in the terminal.');
    expect(title).toContain('with the next one');
  });
});

describe('PermissionModeLabel', () => {
  it('renders nothing for an unknown mode, and nothing without a session', () => {
    const { container, rerender } = render(<PermissionModeLabel sessionId="s1" />);
    expect(container.innerHTML).toBe('');
    expect(harness.loaded).toEqual(['s1']);
    rerender(<PermissionModeLabel sessionId={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the mode and follows changes to its own session only', () => {
    harness.modes.set('s1', 'auto');
    render(<PermissionModeLabel sessionId="s1" />);
    expect(screen.getByText('Auto').dataset.tone).toBe('quiet');

    act(() => {
      harness.modes.set('s1', 'bypassPermissions');
      harness.modes.set('s2', 'plan');
      for (const l of harness.listeners) l('s2');
    });
    expect(screen.queryByText('Auto')).not.toBeNull();

    act(() => {
      for (const l of harness.listeners) l('s1');
    });
    expect(screen.getByText('Bypass').dataset.tone).toBe('bypass');
  });
});
