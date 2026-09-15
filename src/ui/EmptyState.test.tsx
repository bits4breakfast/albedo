/**
 * @vitest-environment jsdom
 *
 * Smoke test for the DOM harness, on the cheapest real target.
 *
 * The environment is selected by the docblock above, PER FILE. There is no
 * global jsdom setting on purpose: the pure suites (adapter, diff, paths, git
 * parsing, sessions, the SQLite harness) run in node and should keep running
 * in node — jsdom costs roughly 0.4s of environment setup per file that asks
 * for it, and the suite's speed is worth protecting.
 *
 * `emptyStateContent` is a pure function and needs no DOM at all, so it also
 * serves as a control: if it were awkward here, that would say something about
 * the environment rather than about the test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import EmptyState, { emptyStateContent } from './EmptyState';
import type { Project } from '../types';

// Vitest globals are off in this project, so React Testing Library cannot
// register its own auto-cleanup. Every component test file needs this line.
afterEach(cleanup);

const project: Project = {
  id: 1,
  name: 'upsellguru',
  repoPath: '/Users/x/www/upsellguru',
  worktreeRoot: '/Users/x/www/worktrees',
  defaultBaseBranch: null,
  taskPromptTemplate: null,
  createdAt: 1,
  archivedAt: null,
};

describe('emptyStateContent — the decision, without a DOM', () => {
  it('offers "add a project" ONLY when there are no projects', () => {
    expect(emptyStateContent(0, null).action).toBe('add-project');
    expect(emptyStateContent(0, null).key).toBe('no-projects');
  });

  it('never infers "no projects" from the absence of tasks', () => {
    // The bug that shipped twice: a user who had just created a project was
    // told to create a project. A button offering the thing you have already
    // done implies the previous step did not take.
    expect(emptyStateContent(1, project).action).toBe('new-task');
    expect(emptyStateContent(3, null).action).toBe('new-task');
  });

  it('distinguishes "this project is empty" from "no tasks anywhere"', () => {
    expect(emptyStateContent(1, project).key).toBe('project-empty');
    expect(emptyStateContent(1, null).key).toBe('no-tasks');
  });
});

describe('EmptyState — rendered in a real DOM', () => {
  it('renders the decision and wires the matching action', () => {
    const onAddProject = vi.fn();
    const onNewTask = vi.fn();
    render(
      <EmptyState projectCount={0} activeProject={null} onAddProject={onAddProject} onNewTask={onNewTask} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add a project' }));
    expect(onAddProject).toHaveBeenCalledTimes(1);
    expect(onNewTask).not.toHaveBeenCalled();
  });

  it('wires the OTHER action once a project exists', () => {
    const onAddProject = vi.fn();
    const onNewTask = vi.fn();
    render(
      <EmptyState projectCount={1} activeProject={project} onAddProject={onAddProject} onNewTask={onNewTask} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    expect(onNewTask).toHaveBeenCalledTimes(1);
    expect(onAddProject).not.toHaveBeenCalled();
  });

  it('renders no button at all when there is no handler for the decision', () => {
    render(<EmptyState projectCount={0} activeProject={null} onNewTask={vi.fn()} />);
    // the decision is add-project, but only onNewTask was supplied
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('exposes the decision in the markup for the styling to key off', () => {
    const { container } = render(<EmptyState projectCount={1} activeProject={project} variant="pane" />);
    const el = container.querySelector('.empty-state');
    expect(el?.getAttribute('data-state')).toBe('project-empty');
    expect(el?.getAttribute('data-variant')).toBe('pane');
  });
});
