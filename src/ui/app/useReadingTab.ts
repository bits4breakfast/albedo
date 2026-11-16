import { useCallback, useRef } from 'react';
import type { SetStateAction } from 'react';
import useTaskTabs from './useTaskTabs';
import type useLayout from './useLayout';
import type { RightTab } from './useLayout';

/**
 * The reading pane's tab: the selected task's own (#314), or the project
 * view's. Setting it changes the selected task's unless a task is named --
 * a request about a task that is not on screen yet (revealing it, its
 * guide, its transcript) must land on that task, not on the one leaving.
 */
export default function useReadingTab(
  selectedId: number | null,
  projectRightTab: RightTab,
  setProjectRightTab: ReturnType<typeof useLayout>['setRightTab'],
) {
  const { tabFor, setTabFor } = useTaskTabs();
  const rightTab: RightTab = selectedId !== null ? tabFor(selectedId) : projectRightTab;
  const tabTaskRef = useRef(selectedId);
  tabTaskRef.current = selectedId;
  /**
   * The tab each task (or the project view, under -1) was on when the editor
   * took the pane (#322), so closing the editor goes back there rather than
   * always to Transcript.
   */
  const beforeEditorRef = useRef(new Map<number, RightTab>());
  const setRightTab = useCallback(
    (action: SetStateAction<RightTab>, taskId?: number) => {
      const id = taskId ?? tabTaskRef.current;
      const key = id ?? -1;
      const tracked = (current: RightTab): RightTab => {
        const next = typeof action === 'function' ? action(current) : action;
        if (next === 'editor' && current !== 'editor') beforeEditorRef.current.set(key, current);
        return next;
      };
      if (id === null) setProjectRightTab(tracked);
      else setTabFor(id, tracked);
    },
    [setProjectRightTab, setTabFor],
  );

  return { rightTab, setRightTab, tabTaskRef, beforeEditorRef };
}
