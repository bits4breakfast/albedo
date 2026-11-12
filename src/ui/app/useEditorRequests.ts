import { useCallback, useMemo, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { OpenFileRequest, Task } from '../../types';
import { forgetEditorTabs } from '../editor/EditorTabs';
import { markReadOnly, type OpenFileOptions } from '../editor/openFile';
import { markUserActivated } from '../editor/outsideFile';
import { filesNamed } from '../../git/codeIndex';
import { isBareName } from '../../lib/paths';
import type { QuickOpenMode } from '../quickOpenModel';
import type useLayout from './useLayout';
import type { RightTab } from './useLayout';
import type useReadingTab from './useReadingTab';

/**
 * Files asked to open in the editor: the pending request, scoped to the
 * task it came from, the entry point every renderer gets through
 * FileOpenContext, closing the editor, and the task the editor is for.
 */
export default function useEditorRequests({
  selected,
  selectedId,
  selectedRef,
  browseTask,
  browseTaskRef,
  filesColumnShown,
  setRightTab,
  setMode,
  setQuickSeed,
  setQuickOpen,
  tabTaskRef,
  beforeEditorRef,
}: {
  selected: Task | null;
  selectedId: number | null;
  selectedRef: MutableRefObject<Task | null>;
  browseTask: Task | null;
  browseTaskRef: MutableRefObject<Task | null>;
  filesColumnShown: boolean;
  setRightTab: ReturnType<typeof useReadingTab>['setRightTab'];
  setMode: ReturnType<typeof useLayout>['setMode'];
  setQuickSeed: Dispatch<SetStateAction<{ text: string } | null>>;
  setQuickOpen: Dispatch<SetStateAction<QuickOpenMode | null>>;
  tabTaskRef: MutableRefObject<number | null>;
  beforeEditorRef: MutableRefObject<Map<number, RightTab>>;
}) {
  /** Pending file-open, scoped to the task it was requested from. */
  const [openRequest, setOpenRequest] = useState<{
    taskId: number;
    request: OpenFileRequest;
    step?: boolean;
  } | null>(null);

  // File-open entry point handed to every renderer via context. Reads the
  // selection through a ref so the context value stays referentially stable --
  // transcript rows subscribe to it and should not re-render on every select.
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const filesColumnShownRef = useRef(filesColumnShown);
  filesColumnShownRef.current = filesColumnShown;

  const openFile = useCallback((request: OpenFileRequest, options?: OpenFileOptions) => {
    const taskId = selectedIdRef.current ?? browseTaskRef.current?.id ?? null;
    if (taskId === null) return;
    // A bare name from the transcript (`Foo.php` in backticks) is looked up:
    // one file by that name opens; none or several open Go to File with the
    // name typed, rather than an empty new file at the worktree root.
    const show = (req: OpenFileRequest) => {
      // The exact object the editor gets: only it may grant a file outside
      // the worktree, and only because a person clicked (outsideFile.ts).
      if (options?.activated) markUserActivated(req);
      if (options?.readOnly) markReadOnly(req);
      setOpenRequest({ taskId, request: req, step: options?.step });
      // A step keeps the Files tab on screen: the list is what is being walked.
      setRightTab((t) => (options?.step && t === 'files' && !filesColumnShownRef.current ? t : 'editor'));
      // The editor is useless behind a full-width terminal. The project view
      // has no terminal, and its pane shows whatever the mode.
      if (selectedIdRef.current !== null) setMode((m) => (m === 'pty' ? 'split' : m));
    };
    const root = (selectedRef.current ?? browseTaskRef.current)?.worktreePath ?? null;
    if (!options?.lookup || !isBareName(request.path) || root === null) {
      show(request);
      return;
    }
    void filesNamed(root, request.path)
      .catch(() => [] as string[])
      .then((found) => {
        const only = found.length === 1 ? found[0] : undefined;
        if (only !== undefined) {
          show({ ...request, path: only });
          return;
        }
        setQuickSeed({ text: request.path });
        setQuickOpen('file');
      });
  }, []);

  /** Close the editor and every tab in it (the pane's ✕, or the last tab closing). */
  const openRequestRef = useRef(openRequest);
  openRequestRef.current = openRequest;
  const closeEditor = useCallback(() => {
    const open = openRequestRef.current;
    if (open) forgetEditorTabs(open.taskId);
    setOpenRequest(null);
    // Back to where the file was opened from (#322): the Guide, Files or
    // Transcript. App's derivation still turns a tab with nothing to show
    // (a Guide for a chat) into Transcript.
    const key = tabTaskRef.current ?? -1;
    setRightTab((t) => (t === 'editor' ? (beforeEditorRef.current.get(key) ?? 'transcript') : t));
  }, [setRightTab]);

  /** Bumped by ⌘W: the editor closes its active tab. */
  const [editorCloseSignal, setEditorCloseSignal] = useState(0);
  /** The active tab's file, for the files list and Quick Open. */
  const [editorActivePath, setEditorActivePath] = useState<string | null>(null);

  /** The editor only exists for the task its request came from. */
  const editorTask = useMemo(() => {
    if (!openRequest) return null;
    if (selected) return openRequest.taskId === selected.id ? selected : null;
    return browseTask && openRequest.taskId === browseTask.id ? browseTask : null;
  }, [openRequest, selected, browseTask]);

  return {
    openRequest,
    openRequestRef,
    openFile,
    closeEditor,
    editorCloseSignal,
    setEditorCloseSignal,
    editorActivePath,
    setEditorActivePath,
    editorTask,
  };
}
