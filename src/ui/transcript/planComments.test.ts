/**
 * @vitest-environment jsdom
 *
 * #272: comments on a waiting plan are kept per prompt, survive the card going
 * away (a task switch) and a reload, and leave only when their prompt does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingPrompt } from '../../capture/hookEvents';
import { onPromptChange } from '../../capture/hookEvents';
import { KEYS } from '../persisted';
import {
  PLAN_COMMENTS_MAX_AGE_MS,
  __resetPlanComments,
  addPlanComment,
  editPlanComment,
  inDocumentOrder,
  planCommentKey,
  planCommentsOf,
  removePlanComment,
} from './planComments';

vi.mock('../../capture/hookEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../capture/hookEvents')>()),
  onPromptChange: vi.fn(() => () => {}),
}));

/** This environment's localStorage is not a working Storage: give it one. */
function installStorage(): Map<string, string> {
  const data = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
  return data;
}

let storage: Map<string, string>;
beforeEach(() => {
  storage = installStorage();
  __resetPlanComments();
  vi.mocked(onPromptChange).mockClear();
});
afterEach(() => __resetPlanComments());

const KEY = planCommentKey(3, '7-1700000000000');
const OTHER = planCommentKey(3, '8-1700000000000');
const ELSEWHERE = planCommentKey(4, '7-1700000000000');

/** The prompt-change listener the store put in, to play events through it. */
function listener(): (taskId: number, next: PendingPrompt | null) => void {
  planCommentsOf(null); // the first read puts it in
  const cb = vi.mocked(onPromptChange).mock.calls.at(-1)?.[0];
  if (!cb) throw new Error('no listener');
  return cb;
}

const question = (requestId: string | null): PendingPrompt => ({
  kind: 'question',
  toolUseId: null,
  questions: [],
  rawQuestions: [],
  requestId,
  at: 1,
});

describe('plan comments', () => {
  it('add, edit, remove', () => {
    const a = addPlanComment(KEY, { quote: 'one', offset: 10, comment: 'first' });
    const b = addPlanComment(KEY, { quote: 'two', offset: 2, comment: 'second' });
    expect(planCommentsOf(KEY).map((c) => c.comment)).toEqual(['first', 'second']);
    editPlanComment(KEY, a.id, '  changed ');
    expect(planCommentsOf(KEY)[0]?.comment).toBe('changed');
    editPlanComment(KEY, a.id, '   '); // empty is not an edit
    expect(planCommentsOf(KEY)[0]?.comment).toBe('changed');
    removePlanComment(KEY, b.id);
    expect(planCommentsOf(KEY).map((c) => c.id)).toEqual([a.id]);
    removePlanComment(KEY, a.id);
    expect(planCommentsOf(KEY)).toEqual([]);
    expect(storage.has(KEYS.planComments)).toBe(false);
  });

  it('are numbered in the document’s order, not the order they were added', () => {
    addPlanComment(KEY, { quote: 'later', offset: 50, comment: 'b' }, 1);
    addPlanComment(KEY, { quote: 'earlier', offset: 5, comment: 'a' }, 2);
    expect(inDocumentOrder(planCommentsOf(KEY)).map((c) => c.comment)).toEqual(['a', 'b']);
  });

  it('are kept per prompt', () => {
    addPlanComment(KEY, { quote: 'q', offset: 0, comment: 'mine' });
    expect(planCommentsOf(OTHER)).toEqual([]);
    expect(planCommentsOf(ELSEWHERE)).toEqual([]);
  });

  it('survive a reload: storage is their copy', () => {
    addPlanComment(KEY, { quote: 'q', offset: 0, comment: 'kept' });
    __resetPlanComments();
    expect(planCommentsOf(KEY).map((c) => c.comment)).toEqual(['kept']);
  });

  it('a day after the last change, they are gone', () => {
    addPlanComment(KEY, { quote: 'q', offset: 0, comment: 'old' }, Date.now() - PLAN_COMMENTS_MAX_AGE_MS - 1);
    __resetPlanComments();
    expect(planCommentsOf(KEY)).toEqual([]);
  });
});

describe('plan comments leave with their prompt, however it was answered', () => {
  it('the prompt is gone (answered, here or in the terminal): its comments go', () => {
    const changed = listener();
    addPlanComment(KEY, { quote: 'q', offset: 0, comment: 'c' });
    addPlanComment(ELSEWHERE, { quote: 'q', offset: 0, comment: 'other task' });
    changed(3, null);
    expect(planCommentsOf(KEY)).toEqual([]);
    expect(planCommentsOf(ELSEWHERE)).toHaveLength(1);
  });

  it('another prompt replaced it: the old one’s comments go', () => {
    const changed = listener();
    addPlanComment(KEY, { quote: 'q', offset: 0, comment: 'c' });
    changed(3, question('8-1700000000000'));
    expect(planCommentsOf(KEY)).toEqual([]);
  });

  it('the same prompt again (its request id) keeps them', () => {
    const changed = listener();
    addPlanComment(KEY, { quote: 'q', offset: 0, comment: 'c' });
    changed(3, question('7-1700000000000'));
    expect(planCommentsOf(KEY)).toHaveLength(1);
  });

  it('a click alone never clears them: only the prompt changing does', () => {
    listener();
    addPlanComment(KEY, { quote: 'q', offset: 0, comment: 'c' });
    // No prompt change was published: nothing went.
    expect(planCommentsOf(KEY)).toHaveLength(1);
  });
});
