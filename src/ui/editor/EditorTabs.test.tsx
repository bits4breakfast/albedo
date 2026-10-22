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
  status: 'idle', createdAt: 0, lastActivityAt: null,
};

afterEach(() => {
  cleanup();
  rendered.clear();
  forgetEditorTabs(task.id);
});

function setup() {
  const onCloseAll = vi.fn();
  const props = { task, readOnly: false, onCloseAll, closeSignal: 0 };
  const view = render(<EditorTabs {...props} request={{ path: 'a.php' }} />);
  const open = (path: string, closeSignal = 0) =>
    view.rerender(<EditorTabs {...props} closeSignal={closeSignal} request={{ path }} />);
  const tabs = () => screen.getAllByRole('tab').map((t) => `${t.textContent?.replace('✕', '')}${t.getAttribute('aria-selected') === 'true' ? '*' : ''}`);
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

  it('⌘W closes the active tab, and the last close closes the editor', () => {
    const { view, props, onCloseAll } = setup();
    act(() => view.rerender(<EditorTabs {...props} closeSignal={1} request={{ path: 'a.php' }} />));
    expect(screen.queryAllByRole('tab')).toEqual([]);
    expect(onCloseAll).toHaveBeenCalledOnce();
  });
});
