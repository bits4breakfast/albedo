/**
 * What a fired trigger says (#448): the card's words, and for Draft the
 * facts appended to your template.
 *
 *   merged     the PR number, title and merge commit
 *   ciFailed   the failure as CI Details gathers it (`formatCiFailure`): each
 *              failing check, and its step and log tail when the project asks
 *              for them and they were fetched
 *   review     the review threads with something new from someone else
 *   approved   who approved, the checks, and that there are no conflicts
 *
 * Pure, except `reviewFacts`, which is handed the threads fetched for the
 * event (one request per event, never a loop).
 */

import { reviewerNames } from '../gh/prStatus';
import type { ReviewThread } from '../gh/reviewThreads';
import { formatCiFailure, shortSha, type QueuedCiFailure } from '../ui/transcript/ciFailure';
import type { TriggerFire } from './detect';
import type { TriggerMode } from './settings';
import type { TriggerCard } from './store';

/** No one card's facts run past this; what is cut says so. */
export const FACTS_MAX_CHARS = 12_000;
/** One comment's body, at most. */
const COMMENT_MAX_CHARS = 1_500;

function quoted(title: string): string {
  return title.trim() ? ` "${title.trim()}"` : '';
}

function cut(text: string, max: number, what: string): string {
  return text.length <= max ? text : `${text.slice(0, max).replace(/\s+$/, '')}\n[… ${what} cut here]`;
}

/** "PR #412 "Title", merged as 3f9c2e1." */
export function mergedFacts(f: Extract<TriggerFire, { event: 'merged' }>): string {
  const commit = f.mergeCommit ? shortSha(f.mergeCommit) : null;
  return `PR #${f.prNumber}${quoted(f.prTitle)}, ${commit ? `merged as ${commit}` : 'merged'}.`;
}

/** The failure as the CI queue keeps it, from the checks that fired. */
export function ciFailureOf(card: Pick<TriggerCard, 'prNumber' | 'sha' | 'checks' | 'at'>): QueuedCiFailure {
  return { prNumber: card.prNumber, sha: card.sha ?? `#${card.prNumber}`, checks: card.checks ?? [], queuedAt: card.at };
}

/** "Approved by alice, 6 of 6 checks passed, no conflicts." */
export function approvedWhy(f: Extract<TriggerFire, { event: 'approved' }>): string {
  const n = f.approvers.length;
  const who = n === 0 ? 'Approved' : n === 1 ? `Approved by ${f.approvers[0]}` : `Approved by ${n} reviewers`;
  const checks = f.checks === 0 ? 'no checks' : `${f.checks} of ${f.checks} ${f.checks === 1 ? 'check' : 'checks'} passed`;
  return `${who}, ${checks}, no conflicts.`;
}

function approvedFacts(f: Extract<TriggerFire, { event: 'approved' }>): string {
  const who = f.approvers.length ? ` by ${reviewerNames(f.approvers)}` : '';
  const checks = f.checks === 0 ? 'it has no checks' : `its ${f.checks === 1 ? 'check' : `${f.checks} checks`} passed`;
  return `PR #${f.prNumber}${quoted(f.prTitle)} is approved${who}, ${checks}, and it has no conflicts.`;
}

/** "Changes requested by alice · 2 review threads with new comments". */
function reviewWhy(f: Extract<TriggerFire, { event: 'review' }>): string {
  const parts: string[] = [];
  if (f.changesBy.length) parts.push(`Changes requested by ${reviewerNames(f.changesBy)}`);
  if (f.newThreads > 0) parts.push(`${f.newThreads} review ${f.newThreads === 1 ? 'thread' : 'threads'} with new comments`);
  return parts.join(' · ');
}

/**
 * The unresolved threads with a comment from someone other than you since
 * `since`, each whole (every comment in it, for the context).
 */
export function newThreads(threads: readonly ReviewThread[], since: number, viewer: string): ReviewThread[] {
  const me = viewer.toLowerCase();
  return threads.filter(
    (t) => !t.isResolved && t.comments.some((c) => c.createdAt > since && (c.author ?? '').toLowerCase() !== me),
  );
}

function threadText(t: ReviewThread): string {
  const line = t.line ?? t.originalLine;
  const where = `${t.path}${line ? `:${line}` : ''}${t.isOutdated ? ' (outdated)' : ''}`;
  const comments = t.comments.map((c) => `  ${c.author ?? 'someone'}: ${cut(c.body.trim(), COMMENT_MAX_CHARS, 'comment').replace(/\n/g, '\n    ')}`);
  return [`- ${where}`, ...comments].join('\n');
}

/**
 * The review's facts: what was said, then each thread with something new.
 * `threads` null: they could not be fetched, and the facts say so and link
 * the PR rather than pretending there were none.
 */
export function reviewFacts(f: Extract<TriggerFire, { event: 'review' }>, threads: readonly ReviewThread[] | null): string {
  const head = `Review on PR #${f.prNumber}${quoted(f.prTitle)}: ${reviewWhy(f)}.`;
  if (threads === null) return `${head}\nAlbedo couldn't read the threads; they are on ${f.prUrl}`;
  if (threads.length === 0) return head;
  return cut([head, '', ...threads.map(threadText)].join('\n'), FACTS_MAX_CHARS, 'review');
}

/**
 * A review that fired while an earlier review card still waits as it fired:
 * one card for both, covering everything since the earlier one -- it replaces
 * that card (`addTriggerCard`), so nothing it said is lost.
 */
export function widenReview(
  f: Extract<TriggerFire, { event: 'review' }>,
  earlier: TriggerCard | undefined,
): Extract<TriggerFire, { event: 'review' }> {
  if (!earlier?.review) return f;
  return {
    ...f,
    since: Math.min(f.since, earlier.review.since),
    changesBy: [...new Set([...earlier.review.changesBy, ...f.changesBy])],
    newThreads: earlier.review.newThreads + f.newThreads,
  };
}

/** The card's head and row word for a fire. */
export function wordsFor(f: TriggerFire): { subject: string; label: string; why?: string } {
  switch (f.event) {
    case 'merged':
      return { subject: `PR #${f.prNumber} was merged`, label: 'PR merged' };
    case 'ciFailed':
      return { subject: `CI failed on PR #${f.prNumber}`, label: 'CI failed' };
    case 'review':
      return {
        subject: `New review on PR #${f.prNumber}`,
        label: f.changesBy.length ? 'Changes requested' : 'New review comments',
        why: reviewWhy(f),
      };
    case 'approved':
      return { subject: `PR #${f.prNumber} is approved and its checks are green`, label: 'Approved', why: approvedWhy(f) };
  }
}

/** What fired it, so the same event is one card. */
function keyOf(f: TriggerFire, at: number): string {
  switch (f.event) {
    case 'merged':
      return `merged:${f.prNumber}`;
    case 'ciFailed':
      return `ciFailed:${f.prNumber}:${f.sha}:${f.checks.map((c) => c.name).join(',')}`;
    case 'review':
      return `review:${f.prNumber}:${at}`;
    case 'approved':
      return `approved:${f.prNumber}:${f.sha}`;
  }
}

/**
 * The card for a fire, given its response. `facts` is the review's, built
 * from its fetched threads (`reviewFacts`); every other event's are built here.
 */
export function cardFor(f: TriggerFire, mode: Exclude<TriggerMode, 'off'>, template: string, at: number, facts?: string): TriggerCard {
  const words = wordsFor(f);
  const card: TriggerCard = {
    id: keyOf(f, at),
    event: f.event,
    mode,
    at,
    prNumber: f.prNumber,
    prTitle: f.prTitle,
    prUrl: f.prUrl,
    subject: words.subject,
    label: words.label,
    template: mode === 'draft' ? template : '',
    facts: '',
    ...(words.why ? { why: words.why } : {}),
  };
  if (f.event === 'ciFailed') {
    card.sha = f.sha;
    card.checks = f.checks;
  }
  if (f.event === 'approved') card.sha = f.sha;
  if (f.event === 'review') card.review = { since: f.since, changesBy: f.changesBy, newThreads: f.newThreads };
  card.facts =
    facts ??
    (f.event === 'merged'
      ? mergedFacts(f)
      : f.event === 'ciFailed'
        ? formatCiFailure(ciFailureOf(card))
        : f.event === 'approved'
          ? approvedFacts(f)
          : reviewFacts(f, []));
  return card;
}

/**
 * The CI facts to show and send now: the failure as the CI queue holds it for
 * the same commit -- with the step and log tail CI Details fetched -- else as
 * it fired. `queued` is `queuedCiOf(taskId)`.
 */
export function liveFacts(card: TriggerCard, queued: QueuedCiFailure | null): string {
  if (card.event === 'ciFailed' && queued && queued.sha === card.sha) return formatCiFailure(queued);
  return card.facts;
}

/** The draft as it stands: your edit, else the template, a blank line, and the facts. */
export function draftText(card: TriggerCard, queued: QueuedCiFailure | null): string {
  if (card.text !== undefined) return card.text;
  const facts = liveFacts(card, queued);
  const template = card.template.trim();
  return template ? `${template}\n\n${facts}` : facts;
}

/** The task row's word: "PR merged · draft ready", "Approved · ready to merge". */
export function rowWord(card: TriggerCard): string {
  return `${card.label} · ${card.mode === 'draft' ? 'draft ready' : card.event === 'approved' ? 'ready to merge' : 'waiting'}`;
}
