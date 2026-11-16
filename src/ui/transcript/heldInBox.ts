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

/**
 * Held messages in a box that has no draft to show them -- the draft lost,
 * expired, or emptied while its pane was gone -- go back to the queue:
 * nothing else would ever let them go, and a box that comes up empty cannot
 * replace them. Run with the task list's refresh, the first at startup.
 */
export function putBackWhereNoDraft(now = Date.now()): void {
  for (const taskId of tasksWithHeld()) {
    if (inBoxFor(taskId).length === 0) continue;
    if ((getDraft(taskId, now)?.text ?? '').trim() === '') putBackFromBox(taskId);
  }
}
