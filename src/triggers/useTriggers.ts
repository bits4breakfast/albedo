/**
 * The trigger watch (#448): every PR answer the PR store already has, for
 * every live task, is handed to `triggerStep` (detect.ts), and an event a
 * project has turned on becomes a card waiting on you (store.ts).
 *
 * No `gh` polling of its own: it watches the PR store's answers go by, as the
 * merge, checks and review notices do (`mergeNotice.ts`, `ciNotice.ts`,
 * `reviewNotice.ts`), so it sees exactly what they see, as often. The one
 * request it makes is for a review event's threads -- once per event, so the
 * draft can carry them.
 *
 * Skipped: archived tasks, chats (no PR), and review tasks -- a colleague's PR
 * you review: none of these events is yours to act on there.
 *
 * Nothing here sends, merges or posts. It only records a card; the card's
 * buttons are the only way anything happens (TriggerCard.tsx).
 */

import { useEffect, useRef } from 'react';
import type { Task } from '../types';
import { getPrStatus, subscribePrStatus } from '../gh/prStore';
import { loadViewerLogin, viewerLogin } from '../gh/gh';
import type { PrStatus } from '../gh/prStatus';
import { fetchThreads, type ReviewThread } from '../gh/reviewThreads';
import { parsePrUrl } from '../git/reviewCheckout';
import { triggerStep, type TriggerFire } from './detect';
import { cardFor, newThreads, reviewFacts, widenReview } from './facts';
import { modeAllowed, onTriggerSettingsChange, triggerSettingsFor } from './settings';
import {
  addTriggerCard,
  resolveTriggerCards,
  setTriggerWatch,
  triggerCardsOf,
  triggerGen,
  triggerWatchOf,
  untouched,
} from './store';

export type TriggerTask = Pick<Task, 'id' | 'projectId' | 'status' | 'kind' | 'reviewUrl' | 'worktreePath' | 'repoPath'>;

export interface TriggerDeps {
  /** The PR's review threads, or null when they could not be fetched. */
  threads: (prUrl: string, cwd: string) => Promise<readonly ReviewThread[] | null>;
  now: () => number;
}

const productionDeps: TriggerDeps = {
  threads: async (prUrl, cwd) => {
    const ref = parsePrUrl(prUrl);
    return ref ? fetchThreads(ref, cwd) : null;
  },
  now: () => Date.now(),
};

/** Whether the watch looks at this task at all. */
export function watched(t: Pick<Task, 'status' | 'kind' | 'reviewUrl'>): boolean {
  return t.status !== 'archived' && t.kind !== 'chat' && !t.reviewUrl;
}

/**
 * One PR answer for one task. Exported for tests; `useTriggers` is the
 * production caller. Returns the fires it found (whether or not a project
 * turned them on), for the tests.
 *
 * Nothing is learned while the project's settings are not known yet: the
 * answer is left for the next one, so an event is never taken in before
 * whether it should fire is known.
 */
export function observeTriggers(
  task: TriggerTask,
  pr: PrStatus | null,
  viewer: string | null,
  deps: TriggerDeps = productionDeps,
): TriggerFire[] {
  if (!watched(task)) return [];
  retireStale(task.id, pr);
  const settings = triggerSettingsFor(task.projectId);
  if (settings === undefined) return [];
  const now = deps.now();
  const { watch, fires } = triggerStep(triggerWatchOf(task.id), pr, viewer, now);
  if (watch) setTriggerWatch(task.id, watch);
  for (const f of fires) {
    const rule = settings[f.event];
    if (rule.mode === 'off' || !modeAllowed(f.event, rule.mode)) continue;
    const mode = rule.mode;
    if (f.event !== 'review') {
      addTriggerCard(task.id, cardFor(f, mode, rule.template, now));
      continue;
    }
    // A review's draft carries its threads: fetched once, for this event --
    // and for an earlier review card still waiting as it fired, which this
    // one replaces.
    const earlier = triggerCardsOf(task.id).find((c) => c.event === 'review' && c.prNumber === f.prNumber && untouched(c));
    const fire = widenReview(f, earlier);
    const me = viewer ?? '';
    const cwd = task.worktreePath || task.repoPath;
    // Archived or deleted while the threads were on their way: no card.
    const gen = triggerGen(task.id);
    void deps
      .threads(fire.prUrl, cwd)
      .catch((err: unknown) => {
        console.warn('[triggers] could not read the review threads', err);
        return null;
      })
      .then((threads) => {
        if (triggerGen(task.id) !== gen) return;
        const fresh = threads === null ? null : newThreads(threads, fire.since, me);
        // Nothing new from anyone else (a thread you opened yourself), and no
        // change request: no card.
        if (fresh !== null && fresh.length === 0 && fire.changesBy.length === 0) return;
        // Counted as read: threads with something new from someone else, a
        // reply in an older thread included.
        const said = fresh === null ? fire : { ...fire, newThreads: fresh.length };
        addTriggerCard(task.id, cardFor(said, mode, rule.template, now, reviewFacts(said, fresh)));
      });
  }
  return fires;
}

/**
 * A card that no longer applies goes by itself, so it never pins a task in
 * Needs You: once the PR is merged or closed -- here or on GitHub -- its CI,
 * review and approval cards are moot. The merge's own card stays: it is the
 * point. Only ever removes a card.
 */
export function retireStale(taskId: number, pr: PrStatus | null): void {
  if (!pr || (pr.state !== 'merged' && pr.state !== 'closed')) return;
  resolveTriggerCards(taskId, (c) => c.prNumber === pr.number && c.event !== 'merged');
}

/**
 * Watch the PR store for every task, on screen or not, and record the cards.
 * Runs again when a project's settings arrive or change, and once the
 * signed-in login is known (review events wait for it).
 */
export function useTriggers(tasks: TriggerTask[]): void {
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  useEffect(() => {
    let live = true;
    const check = () => {
      let anyPr = false;
      for (const t of tasksRef.current) {
        if (!watched(t)) continue;
        const pr = getPrStatus(t.id);
        if (pr === undefined) continue; // not asked yet
        if (pr) anyPr = true;
        observeTriggers(t, pr, viewerLogin());
      }
      if (anyPr && viewerLogin() === null) {
        void loadViewerLogin().then((l) => {
          if (live && l) check();
        });
      }
    };
    check();
    const offs = [subscribePrStatus(check), onTriggerSettingsChange(check)];
    return () => {
      live = false;
      for (const off of offs) off();
    };
  }, []);
}
