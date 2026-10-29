/**
 * Which task sent a message from another Claude session.
 *
 * Exact, never a guess on the name: the receiving line's `origin.msg_id` is
 * the id the sender's `SendMessage` result reports (adapter.ts). The sender's
 * row is in the database once its transcript was captured, and its task is the
 * one to open. A session no task owns -- a plain terminal -- has no task.
 */

import { findToolResults } from '../db';
import { SEND_MESSAGE_TOOL, sentMessageIdOf } from './adapter';

/** Found senders. A miss is not kept: the sender may not be captured yet. */
const found = new Map<string, number>();

export async function senderTaskOf(msgId: string): Promise<number | null> {
  const hit = found.get(msgId);
  if (hit !== undefined) return hit;
  // A tool result elsewhere can quote the id (a search over transcripts, say),
  // so the match is confirmed on the structure, not on the text alone.
  const rows = await findToolResults(SEND_MESSAGE_TOOL, msgId);
  const sender = rows.find((r) => r.taskId !== null && sentMessageIdOf(r.rawJson) === msgId);
  if (!sender || sender.taskId === null) return null;
  found.set(msgId, sender.taskId);
  return sender.taskId;
}

/** @internal for tests */
export function __resetSenders(): void {
  found.clear();
}
