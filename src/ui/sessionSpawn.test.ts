import { describe, expect, it } from 'vitest';
import { isResumePlan, planSpawn } from './sessionSpawn';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NEW = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const newId = () => NEW;

describe('planSpawn', () => {
  it('starts a task that never had a session under an id Albedo chose', () => {
    expect(planSpawn({ sessionId: null, transcriptExists: null, newId })).toEqual({
      args: ['--session-id', NEW],
      sessionId: NEW,
      mode: 'new',
      modelFrom: null,
    });
  });

  it('resumes the task session when its transcript exists', () => {
    const plan = planSpawn({ sessionId: A, transcriptExists: true, newId });
    expect(plan).toEqual({ args: ['--resume', A], sessionId: A, mode: 'resume', modelFrom: A });
    expect(isResumePlan(plan)).toBe(true);
  });

  it('resumes when it cannot tell, rather than claiming an id that may be taken', () => {
    expect(planSpawn({ sessionId: A, transcriptExists: null, newId }).mode).toBe('resume');
  });

  it('reuses an id Claude Code never wrote a transcript for, instead of a resume it would reject', () => {
    const plan = planSpawn({ sessionId: A, transcriptExists: false, newId });
    expect(plan).toEqual({ args: ['--session-id', A], sessionId: A, mode: 'reuse', modelFrom: null });
    expect(isResumePlan(plan)).toBe(false);
  });

  it('starts fresh under a new id when asked, whatever the task had or History passed', () => {
    const plan = planSpawn({ sessionId: A, pending: ['--resume', B], fresh: true, transcriptExists: true, newId });
    expect(plan).toMatchObject({ args: ['--session-id', NEW], sessionId: NEW, mode: 'new' });
  });

  it('continues a past session from History under its own id', () => {
    expect(planSpawn({ sessionId: B, pending: ['--resume', B], transcriptExists: null, newId })).toEqual({
      args: ['--resume', B],
      sessionId: B,
      mode: 'continue',
      modelFrom: B,
    });
  });

  it('forks under the id History chose, keeping the source model', () => {
    const plan = planSpawn({
      sessionId: NEW,
      pending: ['--resume', A, '--fork-session', '--session-id', NEW],
      transcriptExists: null,
      newId: () => 'unused',
    });
    expect(plan).toEqual({
      args: ['--resume', A, '--fork-session', '--session-id', NEW],
      sessionId: NEW,
      mode: 'fork',
      modelFrom: A,
    });
  });

  it('chooses the fork id itself when none was passed', () => {
    const plan = planSpawn({ sessionId: null, pending: ['--resume', A, '--fork-session'], transcriptExists: null, newId });
    expect(plan.args).toEqual(['--resume', A, '--fork-session', '--session-id', NEW]);
    expect(plan.sessionId).toBe(NEW);
  });

  it('restarting a fork resumes the fork, not the original (History args are first-spawn only)', () => {
    // Terminal drops `pending` after the first spawn; this is the second.
    expect(planSpawn({ sessionId: NEW, transcriptExists: true, newId })).toMatchObject({
      args: ['--resume', NEW],
      mode: 'resume',
    });
  });
});
