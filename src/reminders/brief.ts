/**
 * What a reminder sends when it comes back in a task other than the one it
 * was set on: that task's session is not there to remember anything, so the
 * message carries a brief.
 *
 *   - The session's own summary, when a session set the reminder (#157).
 *   - Otherwise the origin session's last answer, word for word, read from its
 *     transcript on disk (Albedo's copy of an archived task's rows is purged),
 *     and the transcript's path, so Claude can read more of it.
 *
 * The transcript is parsed by the adapter (`parseTranscript`), the one file
 * that knows its format; this only picks rows.
 */

import { fullBodyOf, parseTranscript } from '../capture/adapter';
import type { ParsedMessage, Reminder } from '../types';

/**
 * The session's last answer: the assistant text at the end of the main
 * conversation (subagents left out), joined when it came in several rows.
 * A tool call or a prompt after it ends the run. Null when there is none.
 */
export function lastAnswerOf(rows: readonly ParsedMessage[]): string | null {
  const main = rows.filter((r) => r.agentId === null && r.role !== 'system');
  let end = main.length - 1;
  // The answer is what the last turn ended on: the newest assistant text.
  while (end >= 0 && !(main[end]!.role === 'assistant' && (main[end]!.body ?? '').trim() !== '')) end--;
  if (end < 0) return null;
  const parts: string[] = [];
  for (let i = end; i >= 0; i--) {
    const r = main[i]!;
    if (r.role !== 'assistant') break;
    const body = (fullBodyOf(r) ?? '').trim();
    if (body !== '') parts.unshift(body);
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/** Test seam: reading a file needs the Tauri runtime. */
export type TextReader = (path: string) => Promise<string>;

let readText: TextReader = async (path) => {
  const fs = await import('@tauri-apps/plugin-fs');
  return fs.readTextFile(path);
};

/** @internal for tests. Returns the previous reader. */
export function __setTextReader(next: TextReader): TextReader {
  const prev = readText;
  readText = next;
  return prev;
}

/** The last answer in a transcript file, or null when it cannot be read. */
export async function lastAnswerIn(path: string): Promise<string | null> {
  try {
    return lastAnswerOf(parseTranscript(await readText(path)));
  } catch (err) {
    console.warn('[reminders] could not read the transcript for a brief:', path, err);
    return null;
  }
}

export interface Brief {
  /** 'summary': the session's own; 'last-answer': its last answer, verbatim. */
  kind: 'summary' | 'last-answer';
  text: string;
  transcriptPath: string | null;
}

/** The brief for a reminder, or null when there is nothing to say. */
export async function briefFor(r: Pick<Reminder, 'brief' | 'transcriptPath'>, transcriptPath: string | null = r.transcriptPath): Promise<Brief | null> {
  if (r.brief !== null && r.brief.trim() !== '') return { kind: 'summary', text: r.brief.trim(), transcriptPath };
  if (transcriptPath === null) return null;
  const answer = await lastAnswerIn(transcriptPath);
  return answer === null ? null : { kind: 'last-answer', text: answer, transcriptPath };
}

/** The line the brief starts with, in the message and in the transcript. */
export const BRIEF_LEAD = 'Brief from the session that set this reminder';

/**
 * The reminder's text, then its brief: plain prose for Claude. The lead line
 * is what the transcript finds to fold the brief (envelopes.ts).
 */
export function withBrief(text: string, brief: Brief | null): string {
  if (brief === null) return text.trim();
  const what = brief.kind === 'summary' ? 'its summary' : 'its last answer, verbatim';
  const where = brief.transcriptPath ? ` Its transcript: ${brief.transcriptPath}` : '';
  return `${text.trim()}\n\n---\n${BRIEF_LEAD} (${what}).${where}\n\n${brief.text}`;
}
