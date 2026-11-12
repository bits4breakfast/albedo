/**
 * What a file-changing tool call changed, as old/new text pairs: one reading
 * shared by the row's diff (MessageRow) and the tool-run line's counts
 * (toolGroups), so the two cannot disagree (#362). They did: a NotebookEdit
 * with no `old_source` counted its new cell as added lines on the run's line,
 * and opened, the row showed no diff at all.
 *
 * A pair needs both sides, except Write, whose old side is the empty file.
 */

import type { Message } from '../../types';
import { isObj, str, targetOf, toolInput } from './ToolChip';

export const DIFF_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export interface EditPairs {
  path: string;
  pairs: Array<{ oldText: string; newText: string }>;
  /**
   * Whether the pairs' line numbers are real file lines: true for Write (a
   * whole file from line 1), false for edits, whose texts are fragments.
   */
  absoluteLines: boolean;
}

/** The call's old/new pairs; null for a call that is not an edit or carries no complete pair. */
export function editPairsOf(message: Message): EditPairs | null {
  const tool = message.toolName ?? '';
  if (!DIFF_TOOLS.has(tool)) return null;
  const input = toolInput(message);
  const path = targetOf(message) ?? 'file';
  const pairs: EditPairs['pairs'] = [];
  if (tool === 'Write') {
    const content = str(input.content);
    if (content !== null) pairs.push({ oldText: '', newText: content });
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
