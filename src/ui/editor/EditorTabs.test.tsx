// @vitest-environment jsdom
/**
 * The tab strip around the editors: which editor is active, where a close
 * lands, and that the last close closes the editor. FileEditor itself is
 * stubbed -- it has its own tests -- so this pins only the routing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { OpenFileRequest, Task } from '../../types';

interface StubProps {
  request: OpenFileRequest;
  active: boolean;
  onClose: () => void;
  closeSignal: number;
  initialMode: 'file' | 'diff';
  onModeChosen: (mode: 'file' | 'diff') => void;
  onModeChange: (mode: 'file' | 'diff') => void;
  onDirtyChange: (dirty: boolean) => void;
  controlsSlot: HTMLElement | null;
}
const rendered = new Map<string, StubProps>();
vi.mock('./FileEditor', async () => {
  const { useEffect, useRef } = await import('react');
  return {
    default: (props: StubProps) => {
      rendered.set(props.request.path, props);
      // Like the real editor: a bumped closeSignal closes (nothing unsaved here).
      const seen = useRef(props.closeSignal);
      useEffect(() => {
        if (props.closeSignal !== seen.current) {
          seen.current = props.closeSignal;
          props.onClose();
        }
      });
      return <div data-testid={`editor:${props.request.path}`} data-active={String(props.active)} />;
    },
  };
});

const { default: EditorTabs, forgetEditorTabs } = await import('./EditorTabs');

const task: Task = {
  id: 7, title: 't', projectId: 1, repoPath: '/repo', baseBranch: 'main', branch: 'b',
  worktreePath: '/wt', sessionId: null, ownsWorktree: true, createdBranch: true, kind: 'work',
  status: 'idle', createdAt: 0, lastActivityAt: null, seenAt: null,
};

afterEach(() => {
  cleanup();
  rendered.clear();
  forgetEditorTabs(task.id);
});

/** The pane head's slot, as App gives it. */
function headSlot(): HTMLElement {
  const slot = document.createElement('div');
  document.body.appendChild(slot);
  return slot;
}

function setup() {
  const onCloseAll = vi.fn();
  const props = { task, readOnly: false, onCloseAll, closeSignal: 0, headSlot: headSlot() };
  const view = render(<EditorTabs {...props} request={{ path: 'a.php' }} />);
  const open = (path: string, closeSignal = 0, step = false) =>
    view.rerender(<EditorTabs {...props} closeSignal={closeSignal} request={{ path }} step={step} />);
  const tabs = () =>
    screen.getAllByRole('tab').map((t) => `${t.textContent?.replace('✕', '')}${t.getAttribute('aria-selected') === 'true' ? '*' : ''}`);
  return { view, open, tabs, onCloseAll, props };
}

describe('EditorTabs', () => {
  it('opens each file in its own tab, and only the active editor is active', () => {
    const { open, tabs } = setup();
    open('b.php');
    expect(tabs()).toEqual(['a.php', 'b.php*']);
    expect(screen.getByTestId('editor:a.php').dataset.active).toBe('false');
    expect(screen.getByTestId('editor:b.php').dataset.active).toBe('true');
  });

  it('accepts absolute and relative spellings of one file as the same tab', () => {
    const { open, tabs } = setup();
    open('/wt/a.php');
    expect(tabs()).toEqual(['a.php*']);
  });

  it('closing a jumped-to file returns to the file the jump started from', () => {
    const { open, tabs } = setup();
    open('b.php');
    fireEvent.click(screen.getAllByRole('tab')[0]!); // back on a.php
    open('c.php'); // a ⌘B from a.php
    expect(tabs()).toEqual(['a.php', 'c.php*', 'b.php']);
    fireEvent.click(screen.getByRole('button', { name: 'Close c.php' }));
    expect(tabs()).toEqual(['a.php*', 'b.php']);
  });

  it('a newly opened file starts in the last mode chosen', () => {
    const { open } = setup();
    expect(rendered.get('a.php')!.initialMode).toBe('file');
    act(() => rendered.get('a.php')!.onModeChosen('diff'));
    open('b.php');
    expect(rendered.get('b.php')!.initialMode).toBe('diff');
    act(() => rendered.get('b.php')!.onModeChosen('file'));
    open('c.php');
    expect(rendered.get('c.php')!.initialMode).toBe('file');
  });

  it('draws the tabs in the pane head, and nothing there without one', () => {
    const { props, view } = setup();
    expect(props.headSlot.querySelector('[role="tablist"]')).not.toBeNull();
    view.rerender(<EditorTabs {...props} headSlot={null} request={{ path: 'a.php' }} />);
    expect(screen.queryAllByRole('tab')).toEqual([]);
    // The editor stays mounted, so its buffer survives the Transcript tab.
    expect(screen.getByTestId('editor:a.php')).toBeTruthy();
  });

  it('hands the active editor the slot for its controls', () => {
    setup();
    const slot = rendered.get('a.php')!.controlsSlot;
    expect(slot?.className).toBe('ed-head-controls');
  });

  it('marks a tab showing its diff', () => {
    const { open, tabs } = setup();
    open('b.php');
    act(() => rendered.get('a.php')!.onModeChange('diff'));
    expect(tabs()).toEqual(['a.phpDiff', 'b.php*']);
    act(() => rendered.get('a.php')!.onModeChange('file'));
    expect(tabs()).toEqual(['a.php', 'b.php*']);
  });

  it('a step from the Files list replaces the active tab instead of adding one', () => {
    const { open, tabs } = setup();
    open('b.php');
    open('c.php', 0, true);
    expect(tabs()).toEqual(['a.php', 'c.php*']);
    open('a.php', 0, true); // already open: switched to, not duplicated
    expect(tabs()).toEqual(['a.php*', 'c.php']);
  });

  it('a step never replaces a tab with unsaved edits: the file opens beside it', () => {
    const { open, tabs } = setup();
    act(() => rendered.get('a.php')!.onDirtyChange(true));
    open('b.php', 0, true);
    expect(tabs()).toEqual(['a.php', 'b.php*']);
  });

  it('⌘W closes the active tab, and the last close closes the editor', () => {
    const { view, props, onCloseAll } = setup();
    act(() => view.rerender(<EditorTabs {...props} closeSignal={1} request={{ path: 'a.php' }} />));
    expect(screen.queryAllByRole('tab')).toEqual([]);
    expect(onCloseAll).toHaveBeenCalledOnce();
  });
});
