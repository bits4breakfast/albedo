/**
 * The task list's Reviewing tab (#287): PRs whose review is asked of you in
 * the project shown, grouped as reviewActivity.ts orders them.
 *
 * A row opens the PR in Albedo: the first click checks it out as a review
 * task (openReview.ts) and selects it; once there is one, a click selects
 * it. Either way the PR's activity so far counts as seen. GitHub is one
 * click further, from the task.
 *
 * Review tasks whose PR has left the list -- merged, closed, or no longer
 * asking for you -- stay listed last, so they can still be read and
 * archived.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Project, Task } from '../types';
import {
  activityWords,
  REVIEW_GROUP_TITLE,
  startWords,
  type ReviewGroup,
  type ReviewRow,
} from '../gh/reviewActivity';
import { markSeen, type ReviewListState } from '../gh/reviewStore';
import type { ReviewPr } from '../gh/reviewRequests';
import { openReviewTask, reviewTaskFor } from './openReview';
import './reviewlist.css';

export interface ReviewListProps {
  project: Project | null;
  state: ReviewListState;
  groups: readonly ReviewGroup[];
  /** The project's live review tasks. */
  reviewTasks: readonly Task[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  /** A PR was just checked out as a review task. Absent: rows without a task cannot open. */
  onOpened?: (task: Task) => void;
  /** The age shown at a row's end ("2h"), as the task rows show theirs. */
  age: (ts: number) => string;
}

function prNumberOf(url: string): string {
  return /\/pull\/(\d+)/.exec(url)?.[1] ?? '';
}

function Row({
  row,
  task,
  selected,
  opening,
  error,
  onClick,
  age,
}: {
  row: ReviewRow;
  task: Task | null;
  selected: boolean;
  opening: boolean;
  error: string | null;
  onClick: () => void;
  age: (ts: number) => string;
}) {
  const { pr, activity } = row;
  const news = activityWords(activity);
  // How far into it you are (#315): only on Review Started's rows.
  const progress = row.start ? startWords(row.start) : [];
  return (
    <>
      <button
        type="button"
        className="review-row"
        data-unseen={activity.unseen || undefined}
        data-selected={selected || undefined}
        aria-busy={opening || undefined}
        disabled={opening}
        title={[`#${pr.number} ${pr.title}`, pr.author ? `by ${pr.author}` : '', task ? 'Open the review' : 'Check out and review in Albedo']
          .filter(Boolean)
          .join('\n')}
        onClick={onClick}
      >
        <span className="review-title">
          <span className="review-number">#{pr.number}</span> {pr.title}
        </span>
        <span className="review-age">
          {activity.unseen && <span className="review-dot" aria-label="New activity" role="img" />}
          {age(row.at)}
        </span>
        <span className="review-meta">
          {opening && <span className="review-news">Checking out…</span>}
          {pr.isDraft && <span>Draft</span>}
          {pr.author && <span>{pr.author}</span>}
          {news.length > 0 && <span className="review-news">{news.join(' · ')}</span>}
          {progress.map((p) => (
            <span key={p}>{p}</span>
          ))}
          {pr.teams.length > 0 && <span>team {pr.teams[0]}</span>}
          <span className="review-size">
            <span className="review-add">+{pr.additions}</span> <span className="review-del">−{pr.deletions}</span>
          </span>
        </span>
      </button>
      {error && (
        <p className="review-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export default function ReviewList({
  project,
  state,
  groups,
  reviewTasks,
  selectedId,
  onSelect,
  onOpened,
  age,
}: ReviewListProps) {
  const [opening, setOpening] = useState<string | null>(null);
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());

  const open = async (pr: ReviewPr) => {
    markSeen(pr);
    const existing = reviewTaskFor(reviewTasks, pr.url);
    if (existing) {
      onSelect(existing.id);
      return;
    }
    if (!project || !onOpened || opening) return;
    setOpening(pr.url);
    setErrors((m) => {
      const next = new Map(m);
      next.delete(pr.url);
      return next;
    });
    try {
      onOpened(await openReviewTask(project, pr));
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      setErrors((m) => new Map(m).set(pr.url, `Could not check out #${pr.number}: ${why}`));
    } finally {
      setOpening(null);
    }
  };

  if (!project) {
    return <p className="review-empty">Add a project to see the reviews asked of you there.</p>;
  }

  const listed = new Set(groups.flatMap((g) => g.rows.map((r) => r.pr.url)));
  const leftOver = state.kind === 'ready' ? reviewTasks.filter((t) => t.reviewUrl && !listed.has(t.reviewUrl)) : [];

  let body: ReactNode = null;
  if (state.kind === 'loading') body = <p className="review-empty">Asking GitHub…</p>;
  else if (state.kind === 'unavailable') {
    body = (
      <p className="review-empty">
        Can't ask GitHub about {project.name}: <code>gh</code> isn't signed in, it's offline, or the project has no
        GitHub remote.
      </p>
    );
  } else if (groups.length === 0 && leftOver.length === 0) {
    body = <p className="review-empty">No reviews asked of you in {project.name}.</p>;
  }

  return (
    <>
      {body}
      {groups.map((g) => (
        <div key={g.key} className="task-group" role="group" aria-labelledby={`review-group-${g.key}`}>
          <div className="group-label review-group-label" id={`review-group-${g.key}`}>
            <span>{REVIEW_GROUP_TITLE[g.key]}</span>
            <span className="group-count">{g.rows.length}</span>
          </div>
          {g.rows.map((row) => {
            const task = reviewTaskFor(reviewTasks, row.pr.url);
            return (
              <Row
                key={row.pr.url}
                row={row}
                task={task}
                selected={task !== null && task.id === selectedId}
                opening={opening === row.pr.url}
                error={errors.get(row.pr.url) ?? null}
                onClick={() => void open(row.pr)}
                age={age}
              />
            );
          })}
        </div>
      ))}
      {leftOver.length > 0 && (
        <div className="task-group" role="group" aria-labelledby="review-group-left">
          <div className="group-label review-group-label" id="review-group-left">
            <span>Closed or No Longer Asked</span>
            <span className="group-count">{leftOver.length}</span>
          </div>
          {leftOver.map((t) => (
            <button
              key={t.id}
              type="button"
              className="review-row"
              data-selected={t.id === selectedId || undefined}
              onClick={() => onSelect(t.id)}
            >
              <span className="review-title">
                <span className="review-number">#{prNumberOf(t.reviewUrl ?? '')}</span> {t.title}
              </span>
              <span className="review-age">{age(t.lastActivityAt ?? t.createdAt)}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
