/**
 * @vitest-environment jsdom
 *
 * A task's one-line summary (#262): in the task row's tooltip and accessible
 * description, never as a visible second line, and edited with the name in
 * the rename field.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Task } from '../types';

vi.mock('../gh/prStore', () => ({
  getPrStatus: () => null,
  usePrPolling: () => {},
  usePrStatusVersion: () => 0,
}));
vi.mock('../git/branchSync', () => ({ useBranchSync: () => {} }));

const { default: TaskTitleEdit } = await import('./TaskTitleEdit');
const { default: TaskList } = await import('./TaskList');
const { SUMMARY_HINT } = await import('./taskRename');

afterEach(cleanup);

const task = (id: number, title: string, summary: string | null): Task => ({
  id, title, projectId: 1, repoPath: '/r/app', baseBranch: 'main', branch: `b${id}`,
  worktreePath: `/w/b${id}`, sessionId: `s${id}`, ownsWorktree: true, createdBranch: true, kind: 'work',
  status: 'idle', createdAt: 1, lastActivityAt: 1, seenAt: null, summary, reviewUrl: null, apiError: null, apiErrorText: null, spunFromTaskId: null,
});

const name = () => screen.getByRole('textbox', { name: 'Task name' }) as HTMLInputElement;
const summaryField = () => screen.getByRole('textbox', { name: 'Task summary' }) as HTMLInputElement;

describe('the task row', () => {
  it('puts the summary in the row tooltip after the title and in its description; no visible second line', () => {
    const { container } = render(
      <TaskList
        tasks={[task(1, 'ABC-1234', 'Import pictures from a URL'), task(2, 'ABC-1235', null)]}
        selectedId={null}
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );
    const withOne = container.querySelector('[data-task-id="1"]') as HTMLElement;
    const without = container.querySelector('[data-task-id="2"]') as HTMLElement;
    expect(withOne.getAttribute('title')?.startsWith('ABC-1234\nImport pictures from a URL\n')).toBe(true);
    // Shown nowhere in the row itself: the row is laid out as before.
    expect(withOne.textContent).not.toContain('Import pictures');
    expect(withOne.querySelector('.task-summary')).toBeNull();
    // Reachable without a pointer.
    const id = withOne.getAttribute('aria-describedby');
    expect(id).toBe('task-summary-1');
    const desc = container.querySelector(`#${id}`) as HTMLElement;
    expect(desc.textContent).toBe('Import pictures from a URL');
    expect(desc.hidden).toBe(true);
    expect(withOne.contains(desc)).toBe(false);
    // A row without one keeps the tooltip it had: title, then branch.
    expect(without.getAttribute('title')).toBe('ABC-1235\nb2');
    expect(without.hasAttribute('aria-describedby')).toBe(false);
  });

  it("Rename Task… edits the summary on the row's second line, and clearing it saves null", () => {
    const onRename = vi.fn();
    const onSummary = vi.fn();
    const t = task(3, 'ABC-1236', 'Import pictures from a URL');
    const { container } = render(
      <TaskList tasks={[t]} selectedId={null} onSelect={() => {}} onNew={() => {}} onRename={onRename} onSummary={onSummary} />,
    );
    const row = container.querySelector('[data-task-id="3"]') as HTMLElement;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole('menuitem', { name: /Rename Task…/ }));
    expect(row.contains(summaryField())).toBe(true);
    expect(summaryField().value).toBe('Import pictures from a URL');
    fireEvent.change(summaryField(), { target: { value: '   ' } });
    fireEvent.keyDown(summaryField(), { key: 'Enter' });
    expect(onSummary).toHaveBeenCalledWith(t, null);
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Task summary' })).toBeNull();
  });

  it('without a summary handler, the rename field has no summary field', () => {
    const { container } = render(
      <TaskList tasks={[task(4, 'ABC-1237', null)]} selectedId={null} onSelect={() => {}} onNew={() => {}} onRename={() => {}} />,
    );
    fireEvent.contextMenu(container.querySelector('[data-task-id="4"]') as HTMLElement);
    fireEvent.click(screen.getByRole('menuitem', { name: /Rename Task…/ }));
    expect(screen.queryByRole('textbox', { name: 'Task summary' })).toBeNull();
  });
});

describe('TaskTitleEdit with a summary', () => {
  function open(summary: string | null = null) {
    const onSave = vi.fn();
    const onSaveSummary = vi.fn();
    const onDone = vi.fn();
    const view = render(
      <TaskTitleEdit title="ABC-1234" summary={summary} onSave={onSave} onSaveSummary={onSaveSummary} onDone={onDone} />,
    );
    return { onSave, onSaveSummary, onDone, ...view };
  }

  it('opens on the name, with the summary field after it, empty and saying what it is', () => {
    open();
    expect(document.activeElement).toBe(name());
    expect(summaryField().value).toBe('');
    expect(summaryField().placeholder).toBe('Summary (optional)');
    expect(summaryField().title).toBe(SUMMARY_HINT);
  });

  it('saves a new summary, cleaned to one line, without touching the title', () => {
    const { onSave, onSaveSummary, onDone } = open();
    fireEvent.change(summaryField(), { target: { value: '  Import pictures\tfrom  a URL ' } });
    fireEvent.keyDown(summaryField(), { key: 'Enter' });
    expect(onSaveSummary).toHaveBeenCalledTimes(1);
    expect(onSaveSummary).toHaveBeenCalledWith('Import pictures from a URL');
    expect(onSave).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('saves both when both changed; Return in the name saves the summary too', () => {
    const { onSave, onSaveSummary } = open('Old summary');
    fireEvent.change(name(), { target: { value: 'ABC-1234 pictures' } });
    fireEvent.change(summaryField(), { target: { value: 'Import pictures from a URL' } });
    fireEvent.keyDown(name(), { key: 'Enter' });
    expect(onSave).toHaveBeenCalledWith('ABC-1234 pictures');
    expect(onSaveSummary).toHaveBeenCalledWith('Import pictures from a URL');
  });

  it('empty clears it (null); unchanged saves nothing', () => {
    const a = open('Import pictures from a URL');
    fireEvent.change(summaryField(), { target: { value: '' } });
    fireEvent.keyDown(summaryField(), { key: 'Enter' });
    expect(a.onSaveSummary).toHaveBeenCalledWith(null);
    a.unmount();

    const b = open('Import pictures from a URL');
    fireEvent.keyDown(summaryField(), { key: 'Enter' });
    expect(b.onSaveSummary).not.toHaveBeenCalled();
    expect(b.onDone).toHaveBeenCalledTimes(1);
  });

  it('Escape puts both back', () => {
    const { onSave, onSaveSummary, onDone } = open('Old');
    fireEvent.change(name(), { target: { value: 'New' } });
    fireEvent.change(summaryField(), { target: { value: 'New summary' } });
    fireEvent.keyDown(summaryField(), { key: 'Escape' });
    expect(onSave).not.toHaveBeenCalled();
    expect(onSaveSummary).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('Tab goes to the summary and Shift+Tab back, and that move is not leaving', () => {
    const behind = vi.fn();
    const onSave = vi.fn();
    const onDone = vi.fn();
    render(
      <div onKeyDown={(e) => behind(e.key)}>
        <TaskTitleEdit title="ABC-1234" summary={null} onSave={onSave} onSaveSummary={() => {}} onDone={onDone} />
      </div>,
    );
    fireEvent.keyDown(name(), { key: 'Tab' });
    expect(document.activeElement).toBe(summaryField());
    fireEvent.blur(name(), { relatedTarget: summaryField() });
    fireEvent.keyDown(summaryField(), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(name());
    fireEvent.blur(summaryField(), { relatedTarget: name() });
    // The area cycle behind saw neither, and nothing closed.
    expect(behind).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(summaryField()).toBeTruthy();
  });

  it('leaving the pair saves; removed without a blur, it saves too', () => {
    const a = open();
    fireEvent.change(summaryField(), { target: { value: 'Import pictures from a URL' } });
    fireEvent.blur(summaryField(), { relatedTarget: null });
    expect(a.onSaveSummary).toHaveBeenCalledWith('Import pictures from a URL');
    a.unmount();

    const b = open();
    fireEvent.change(summaryField(), { target: { value: 'Import pictures from a URL' } });
    b.unmount();
    expect(b.onSaveSummary).toHaveBeenCalledTimes(1);
  });
});
