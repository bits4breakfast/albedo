/**
 * What a file-changing tool call changed, as old/new text pairs: one reading
 * shared by the row's diff (MessageRow) and the tool-run line's counts
 * (toolGroups), so the two cannot disagree (#362). They did: a NotebookEdit
 * with no `old_source` counted its new cell as added lines on the run's line,
 * and opened, the row showed no diff at all.
 *
 * A pair needs both sides, except Write. A Write's old side is the file as it
 * was when its result says it replaced one (#387), and the empty file when it
 * made one or nothing says which. A Write that failed changed nothing: no
 * pairs at all.
 */

import type { Message } from '../../types';
import { writeResultOf, type WritePatchHunk } from '../../capture/adapter';
import { isObj, str, targetOf, toolInput, toolResultIsError } from './ToolChip';

export const DIFF_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export interface EditPairs {
  path: string;
  pairs: Array<{ oldText: string; newText: string }>;
  /**
   * Whether the pairs' line numbers are real file lines: true for Write (a
   * whole file from line 1), false for edits, whose texts are fragments.
   */
  absoluteLines: boolean;
  /**
   * A replaced file whose result has no old text, only its change as hunks
   * (#387): the change itself, with `pairs` empty. The row draws these hunks
   * and the run's line counts their lines, so the two still agree.
   */
  patch?: WritePatchHunk[];
}

/**
 * A replaced file is diffed against the file as it was only up to this many
 * characters, old and new together (#387); past it the row is today's whole
 * listing. Writes seen in real transcripts are a few thousand characters
 * (the largest old file seen, ~6K). Building the row's diff near a million
 * characters measured 155-316 ms; at 200K the worst case is about a fifth of
 * that, paid once per result (the row's diff and the run's count are both
 * cached per row object). The Myers search behind it is capped at an edit
 * distance of 1,200, so the cost grows with size, not with size squared.
 */
export const WRITE_DIFF_MAX_CHARS = 200_000;

/**
 * What a Write did, as its result tells it (#387):
 *  - `created`: a new file.
 *  - `replaced`: an existing file, whose old text is `originalFile`.
 *  - `patched`: an existing file whose result keeps only the change, as
 *    hunks (`originalFile: null`, Claude Code 2.1.301-2.1.312).
 *  - `failed`: its result is an error; nothing was written.
 *  - `unknown`: no result yet, or one that does not say (an older
 *    transcript): read as today, the whole content as added lines.
 * Null for any call that is not a Write.
 */
export type WriteOutcome =
  | { kind: 'created' }
  | { kind: 'replaced'; originalFile: string; content: string }
  | { kind: 'patched'; patch: WritePatchHunk[]; content: string }
  | { kind: 'failed' }
  | { kind: 'unknown' };

export function writeOutcomeOf(message: Message, result: Message | null): WriteOutcome | null {
  if (message.toolName !== 'Write') return null;
  if (result === null) return UNKNOWN;
  let outcome = outcomes.get(result);
  if (outcome === undefined) {
    outcome = readOutcome(result);
    outcomes.set(result, outcome);
  }
  return outcome;
}

const UNKNOWN: WriteOutcome = Object.freeze({ kind: 'unknown' });

/*
 * Read once per result row: the row, the run's line and the chip all ask, and
 * a result line past the adapter's parse-cache limit (256K characters, a
 * large file written) would otherwise be parsed again for each. Rows are
 * never changed once captured, so the row object is the key; weak, so an
 * entry goes with its row.
 */
const outcomes = new WeakMap<Message, WriteOutcome>();

function readOutcome(result: Message): WriteOutcome {
  if (toolResultIsError(result)) return Object.freeze({ kind: 'failed' });
  const written = writeResultOf(result.rawJson);
  if (written === null) return UNKNOWN;
  if (written.kind === 'create') return Object.freeze({ kind: 'created' });
  if (written.patch !== null) return Object.freeze({ kind: 'patched', patch: written.patch, content: written.content });
  const originalFile = written.originalFile ?? '';
  // Too large to diff on a render: the whole listing, as before.
  if (originalFile.length + written.content.length > WRITE_DIFF_MAX_CHARS) return UNKNOWN;
  return Object.freeze({ kind: 'replaced', originalFile, content: written.content });
}

/**
 * The call's old/new pairs; null for a call that is not an edit, carries no
 * complete pair, or is a Write that failed. `result` is the call's paired
 * result, when it has arrived: only a Write reads it.
 */
export function editPairsOf(message: Message, result: Message | null = null): EditPairs | null {
  const tool = message.toolName ?? '';
  if (!DIFF_TOOLS.has(tool)) return null;
  const input = toolInput(message);
  const path = targetOf(message) ?? 'file';
  const pairs: EditPairs['pairs'] = [];
  if (tool === 'Write') {
    const write = writeOutcomeOf(message, result);
    if (write?.kind === 'failed') return null;
    if (write?.kind === 'patched') return { path, pairs: [], absoluteLines: true, patch: write.patch };
    // A replaced file diffs the result's `content`, the file as it is now on
    // disk, which can differ from what was sent (a memory file gets front
    // matter stamped on it, say); the chip's input view shows what was sent.
    if (write?.kind === 'replaced') pairs.push({ oldText: write.originalFile, newText: write.content });
    else {
      const content = str(input.content);
      if (content !== null) pairs.push({ oldText: '', newText: content });
    }
  } else if (tool === 'MultiEdit') {
    for (const edit of Array.isArray(input.edits) ? input.edits : []) {
      if (!isObj(edit)) continue;
      const oldText = str(edit.old_string);
      const newText = str(edit.new_string);
      if (oldText !== null && newText !== null) pairs.push({ oldText, newText });
    }
  } else {
    const oldText = str(input.old_string) ?? str(input.old_source);
    const newText = str(input.new_string) ?? str(input.new_source);
    if (oldText !== null && newText !== null) pairs.push({ oldText, newText });
  }
  return pairs.length > 0 ? { path, pairs, absoluteLines: tool === 'Write' } : null;
}
