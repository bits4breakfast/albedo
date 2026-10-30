/**
 * The message box's `@` list (#154), drawn above the box: other open tasks
 * under "Tasks", then this worktree's files and folders under "Files".
 * State and keys are `useMentions`; this only draws and takes clicks.
 *
 * A listbox the textarea controls (`aria-activedescendant`), so focus stays
 * in the text the whole time, as in Quick Open; rows take no focus and a
 * click on one never steals it.
 */

import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { FileIcon, FolderGlyph } from '../fileIcons';
import { Highlighted } from '../Highlighted';
import { statusLabel } from '../StatusDot';
import type { MentionList } from './useMentions';
import type { MentionItem } from './mentions';
import './mentions.css';

export function mentionOptionId(listId: string, i: number): string {
  return `${listId}-${i}`;
}

export function MentionPopover({ list, listId }: { list: MentionList; listId: string }): ReactNode {
  const listRef = useRef<HTMLDivElement>(null);
  // Keep the highlighted row in view while arrowing.
  useEffect(() => {
    if (!list.open) return;
    listRef.current?.querySelector<HTMLElement>(`[aria-selected="true"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [list.open, list.active]);
  if (!list.open) return null;
  const { tasks, paths, active } = list;
  const row = (item: MentionItem, i: number): ReactNode => (
    <div
      key={item.key}
      id={mentionOptionId(listId, i)}
      role="option"
      aria-selected={i === active}
      className="mn-row"
      data-kind={item.kind}
      // Move, not enter: a list scrolling under a resting pointer must not
      // drag the selection with it.
      onMouseMove={() => i !== active && list.setActive(i)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => list.pick(item)}
    >
      {item.kind === 'task' ? (
        <>
          <span className="mn-name">
            <Highlighted text={item.task.title} hits={item.hits} className="mn-hit" />
          </span>
          <span className="mn-where">{item.projectName ?? ''}</span>
          <span className="mn-status">{statusLabel(item.task.status)}</span>
        </>
      ) : (
        <>
          <span className="mn-name">
            {item.kind === 'folder' ? (
              <FolderGlyph open={false} className="mn-icon" />
            ) : (
              <FileIcon path={item.path} className="mn-icon" />
            )}
            <Highlighted text={item.name} hits={item.nameHits} className="mn-hit" />
          </span>
          {/* Truncated from the start: the end of a path tells two apart. */}
          <span className="mn-where mn-path">
            <bdi>
              <Highlighted text={item.dir} hits={item.dirHits} className="mn-hit" />
            </bdi>
          </span>
        </>
      )}
    </div>
  );

  return (
    <div className="mn-pop">
      <div className="mn-list" id={listId} ref={listRef} role="listbox" aria-label="Mention a task or a file">
        {tasks.length > 0 ? (
          <div role="group" aria-labelledby={`${listId}-tasks`}>
            <div className="mn-head" id={`${listId}-tasks`}>
              Tasks
            </div>
            {tasks.map((t, i) => row(t, i))}
          </div>
        ) : null}
        <div role="group" aria-labelledby={`${listId}-files`}>
          <div className="mn-head" id={`${listId}-files`}>
            Files
          </div>
          {paths.length > 0 ? (
            paths.map((p, i) => row(p, tasks.length + i))
          ) : (
            <div className="mn-note">
              {list.indexing ? 'Reading the worktree…' : list.query === '' ? 'Type to search files and folders' : `No file matches “${list.query}”`}
            </div>
          )}
        </div>
      </div>
      <div className="mn-foot" aria-hidden="true">
        ↑↓ Move · ↵ or ⇥ Insert · Esc Close
      </div>
    </div>
  );
}
