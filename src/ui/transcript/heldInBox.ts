/**
 * Held messages taken into the message box to be edited as one (#399): ↑ in
 * an empty box. What the box shows for them, and what goes back on send.
 *
 * They are joined oldest first with a blank line (`RUN_JOINER`, as a release
 * joins messages that go together), then shown the way the band's own Edit
 * shows one: each paste as its token, each quoted passage as its token, each
 * reference as `@Title`. Images and attached files are paths in the text, so
 * they come along where they were.
 *
 * The outbox (outbox.ts) keeps the messages, the composer the box.
 */

import { draftOf } from './pastedText';
import { unmarkMentions, type Mention } from './mentions';
import { unmarkQuotes } from './transcriptQuotes';
import { RUN_JOINER, inBoxFor, putBackFromBox, tasksWithHeld, type HeldMessage } from './outbox';
import { getDraft } from './drafts';

export interface HeldAsDraft {
  /** What the box shows. */
  text: string;
  /** Paste tokens' texts, by number (pastedText.ts). */
  pastes: Map<number, string>;
  /** References, by token (mentions.ts). */
  mentions: Map<string, Mention>;
  /**
   * Quoted passages' markers, by number (transcriptQuotes.ts). Not kept with
   * the draft: worked out again from the same messages, which do not change
   * while they are in the box, so the numbers are the same.
   */
  quotes: Map<number, string>;
}

/** The held messages, oldest first, as one draft for the box. */
export function heldAsDraft(held: readonly Pick<HeldMessage, 'text'>[]): HeldAsDraft {
  // Pastes first, as the band's Edit does: a paste's own text is never read
  // for quotes or references.
  const d = draftOf(held.map((h) => h.text).join(RUN_JOINER));
  const q = unmarkQuotes(d.text);
  const u = unmarkMentions(q.text);
  return { text: u.text, pastes: d.pastes, mentions: u.mentions, quotes: q.quotes };
}

/** The task whose message box is on screen; its own mount and unmount look after it. */
let shownBox: number | null = null;

/** The composer tells this which task's box it shows, and null when it goes. */
export function noteBoxShown(taskId: number | null): void {
  shownBox = taskId;
}

/**
 * Held messages in a box that has no draft to show them -- the app stopped
 * before the draft was written, or it expired -- go back to the queue:
 * nothing else would ever let them go. The box on screen is skipped: an
 * emptied box there is being rewritten, and putting them back under it would
 * make its Send a second message beside them; its own unmount decides.
 */
export function putBackWhereNoDraft(now = Date.now()): void {
  for (const taskId of tasksWithHeld()) {
    if (taskId === shownBox || inBoxFor(taskId).length === 0) continue;
    if ((getDraft(taskId, now)?.text ?? '').trim() === '') putBackFromBox(taskId);
  }
}

let reconciled = false;

/**
 * `putBackWhereNoDraft`, once per run: the first task-list read after
 * startup, the crash case it exists for. Later refreshes (every few seconds
 * while a turn runs) leave the box alone.
 */
export function putBackWhereNoDraftAtStartup(now = Date.now()): void {
  if (reconciled) return;
  reconciled = true;
  putBackWhereNoDraft(now);
}

/** Test seam: forget the startup run and the box on screen. */
export function __resetHeldInBox(): void {
  reconciled = false;
  shownBox = null;
}
