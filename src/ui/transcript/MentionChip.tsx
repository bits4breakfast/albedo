/**
 * A reference in your message, drawn as a chip (#154): `@Fix login retry`
 * goes to that task, as the sender of a peer message does (`useTaskOpener`);
 * `@src/foo.ts` opens the file, as any path in the transcript does
 * (`useOpenPath`). A task no longer open (archived, deleted) and a folder are
 * shown the same way but are not links: a chip that looks clickable and does
 * nothing is the bug #110 was about.
 */

import type { ReactNode } from 'react';
import { useTaskOpener } from '../openTask';
import { useActivate, useOpenPath } from './Diff';
import { isFolder, type Mention } from './mentions';
import './mentions.css';

export function MentionChip({ mention }: { mention: Mention }): ReactNode {
  const tasks = useTaskOpener();
  const openPath = useOpenPath();
  let go: (() => void) | null = null;
  let title: string;
  if (mention.kind === 'task') {
    const id = mention.taskId;
    if (id !== null && tasks.has(id)) {
      go = () => tasks.open(id);
      title = `Go to ${mention.title}`;
    } else title = `${mention.title} (no longer open in Albedo)`;
  } else if (isFolder(mention)) {
    title = `Folder ${mention.path}`;
  } else {
    // A bare name (`@Foo.php`) is looked up in the worktree, as one in backticks is.
    const path = mention.path;
    go = () => openPath(path, null, !path.includes('/'));
    title = `Open ${path}`;
  }
  // A click that was the end of a text selection is not a click (useActivate).
  const act = useActivate(() => go?.());
  const kind = mention.kind;
  if (go === null) {
    return (
      <span className="tx-mention" data-kind={kind} title={title}>
        {mention.label}
      </span>
    );
  }
  return (
    <button type="button" className="tx-mention" data-kind={kind} title={title} onMouseDown={act.onMouseDown} onClick={act.onClick}>
      {mention.label}
    </button>
  );
}
