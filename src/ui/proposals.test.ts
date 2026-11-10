/**
 * Proposed tasks (#332), pure: which project a proposal lands in, which ones
 * the list shows for the active project tab, newest first.
 */
import { describe, expect, it } from 'vitest';
import type { Project, Task } from '../types';
import type { QueuedRequest, SessionRequest } from './requestQueue';
import { promptPreview, proposalProjectId, proposalsInScope } from './proposals';

const projects = [
  { id: 1, name: 'video-player' },
  { id: 2, name: 'Ticket-Desk' },
] as Project[];
const tasks = [
  { id: 3, projectId: 1 },
  { id: 4, projectId: 2 },
  { id: 5, projectId: 77 }, // a project Albedo no longer knows
] as Task[];

const ask = (id: string, over: Partial<SessionRequest> = {}): SessionRequest => ({
  id,
  taskId: 3,
  at: 1_000,
  tool: 'request_session',
  title: `Proposal ${id}`,
  prompt: 'p',
  reason: 'r',
  project: null,
  branch: null,
  ...over,
});
const notice: QueuedRequest = { id: 'n', taskId: 3, at: 5_000, tool: 'notify_blocked', message: 'VPN' };

describe('proposalProjectId', () => {
  it('is the project the request names, ignoring case', () => {
    expect(proposalProjectId(ask('a', { project: 'ticket-desk' }), tasks, projects)).toBe(2);
  });
  it("else the asking task's", () => {
    expect(proposalProjectId(ask('a'), tasks, projects)).toBe(1);
    expect(proposalProjectId(ask('a', { project: 'no-such-project' }), tasks, projects)).toBe(1);
  });
  it('null when neither is known', () => {
    expect(proposalProjectId(ask('a', { taskId: 99 }), tasks, projects)).toBeNull();
  });
});

describe('proposalsInScope', () => {
  const items: QueuedRequest[] = [
    ask('old', { at: 1_000 }),
    notice,
    ask('named', { at: 3_000, project: 'Ticket-Desk' }),
    ask('new', { at: 4_000 }),
    ask('lost', { at: 2_000, taskId: 5 }),
  ];

  it('with no tab bar, shows every request for a session, newest first, and nothing else', () => {
    expect(proposalsInScope(items, null, tasks, projects).map((r) => r.id)).toEqual(['new', 'named', 'lost', 'old']);
  });

  it("a project's tab shows the proposals that would land in it", () => {
    expect(proposalsInScope(items, { project: projects[0]! }, tasks, projects).map((r) => r.id)).toEqual(['new', 'old']);
    // Named for project 2, though asked from a task in project 1.
    expect(proposalsInScope(items, { project: projects[1]! }, tasks, projects).map((r) => r.id)).toEqual(['named']);
  });

  it('the Other tab takes those whose project is unknown, so none is hidden', () => {
    expect(proposalsInScope(items, { project: null }, tasks, projects).map((r) => r.id)).toEqual(['lost']);
  });

  it('keeps arrival order reversed for the same time', () => {
    const same = [ask('first'), ask('second')];
    expect(proposalsInScope(same, null, tasks, projects).map((r) => r.id)).toEqual(['second', 'first']);
  });
});

describe('promptPreview', () => {
  it('keeps the first lines and says when there is more', () => {
    expect(promptPreview('a\nb\nc\nd\ne')).toBe('a\nb\nc\nd\n…');
    expect(promptPreview('short')).toBe('short');
    expect(promptPreview('x'.repeat(400)).endsWith('…')).toBe(true);
  });
});
