import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Task } from '../../types';
import { applyZoom, stepZoom, storedZoom } from '../zoom';
import { pushPrompt } from '../gitPrompts';
import { sendPrompt } from '../sendPrompt';
import { GUIDE_KEY_EXCEPT, TASK_TERMINAL_INPUT, useDoubleShift, useShortcuts } from '../shortcuts';
import { stepProjectTab } from '../projectStep';
import { focusArea, modalOpen, useFocusAreaCycle } from '../focusAreas';
import type { remoteControlItem } from '../RemoteMark';
import type { QuickOpenMode } from '../quickOpenModel';
import { requestAttach, sendWaitingComments } from '../transcript/composerBridge';
import { requestGuide } from '../../guide/openGuide';
import { unmergedCommits } from '../../git/worktree';
import type useLayout from './useLayout';
import type { RightTab } from './useLayout';
import type useProjectTabs from './useProjectTabs';
import type useReadingTab from './useReadingTab';

type Layout = ReturnType<typeof useLayout>;
type ProjectTabs = ReturnType<typeof useProjectTabs>;

/**
 * The frame's keyboard: text size, ⇧⇧ and the focus-area cycle, and the
 * shortcut table (PhpStorm's keymap where it has one).
 */
export default function useAppShortcuts({
  readingTabs,
  activeTab,
  setRightTab,
  toggleQuickOpen,
  toggleFind,
  selected,
  setMode,
  remoteItem,
  setRemoteConfirmFor,
  projectView,
  filesColumnShown,
  setShellOpen,
  setShortcutsOpen,
  showTabs,
  tabs,
  switchTab,
  activeProjectTab,
  setTaskListCollapsed,
  editorShowing,
  setRenaming,
}: {
  readingTabs: RightTab[];
  activeTab: RightTab;
  setRightTab: ReturnType<typeof useReadingTab>['setRightTab'];
  toggleQuickOpen: (next: QuickOpenMode) => void;
  toggleFind: () => void;
  selected: Task | null;
  setMode: Layout['setMode'];
  remoteItem: ReturnType<typeof remoteControlItem> | null;
  setRemoteConfirmFor: Dispatch<SetStateAction<number | null>>;
  projectView: boolean;
  filesColumnShown: boolean;
  setShellOpen: Layout['setShellOpen'];
  setShortcutsOpen: Dispatch<SetStateAction<boolean>>;
  showTabs: boolean;
  tabs: ProjectTabs['tabs'];
  switchTab: ProjectTabs['switchTab'];
  activeProjectTab: ProjectTabs['activeProjectTab'];
  setTaskListCollapsed: Layout['setTaskListCollapsed'];
  editorShowing: boolean;
  setRenaming: Dispatch<SetStateAction<{ id: number; by: 'key' | 'pointer' } | null>>;
}): void {
  const stepReadingTab = useCallback(
    (delta: number) => {
      const tabs = readingTabs;
      if (tabs.length < 2) return;
      const at = tabs.indexOf(activeTab);
      const next = tabs[(((at === -1 ? 0 : at) + delta) % tabs.length + tabs.length) % tabs.length];
      if (next) setRightTab(next);
    },
    [readingTabs, activeTab],
  );

  // Text size (HIG: macOS has no Dynamic Type, so the app offers its own).
  const zoomRef = useRef(storedZoom());
  useEffect(() => {
    if (zoomRef.current !== 1) void applyZoom(zoomRef.current);
  }, []);
  const zoomTo = (z: number) => {
    zoomRef.current = z;
    void applyZoom(z);
  };

  useDoubleShift(() => toggleQuickOpen('all'));
  // Tab / Ctrl+Tab between the message box, terminal, Files and task list.
  useFocusAreaCycle();

  /**
   * ⇧⌘P: what the Files pane's Push does, for the selected task -- the same
   * prompt, through the same path (submitted on an idle session, otherwise
   * left in the message box). The message box lives in the transcript, so in
   * terminal-only mode a busy task gets the split view and a second try.
   */
  const pushSelected = async () => {
    const task = selected;
    // A chat has no branch to push, and the Files pane offers no Push for it.
    if (!task || task.status === 'archived' || task.kind === 'chat') return;
    // As the Files pane: on no branch there is nothing to push, and pushing a
    // stale detached copy could overwrite the branch with old commits.
    const remote = await unmergedCommits(task.worktreePath, task.baseBranch).catch(() => null);
    if (remote?.detached) {
      console.warn('[push] HEAD is detached in', task.worktreePath, '- nothing to push');
      return;
    }
    const text = pushPrompt(task);
    if ((await sendPrompt(task, text)) !== 'failed') return;
    setMode((m) => (m === 'pty' ? 'split' : m));
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    if ((await sendPrompt(task, text)) === 'failed') {
      console.warn('[push] no live session or message box for task', task.id);
    }
  };

  const startRename = () => {
    if (!selected || modalOpen()) return;
    setRenaming({ id: selected.id, by: 'key' });
  };

  const stepProject = (delta: number) => {
    if (!showTabs) return;
    const key = stepProjectTab(tabs.map((t) => t.key), activeProjectTab?.key ?? null, delta);
    if (key) switchTab(key);
  };

  useShortcuts({
    // PhpStorm's keymap. Live while typing: nothing in a text field, the
    // terminal included, binds ⌘O (Ctrl+O is left alone -- see shortcuts.ts).
    'mod+shift+o': () => toggleQuickOpen('file'),
    'mod+o': () => toggleQuickOpen('class'),
    'mod+alt+o': () => toggleQuickOpen('symbol'),
    'mod+shift+f': toggleFind,
    'mod+shift+p': () => void pushSelected(),
    // Remote Control, after a confirmation. Heard in the capture phase so it
    // works wherever focus is (shortcuts.ts). Only where the ⋯ item is
    // offered: a selected task with a live session and Remote Control off.
    // Already on, it does nothing -- the Remote mark beside the title opens
    // the session. Never over another dialog, as the palette.
    'mod+shift+r': {
      phase: 'capture',
      run: () => {
        if (!selected || !remoteItem) return;
        if (modalOpen()) return;
        setRemoteConfirmFor(selected.id);
      },
    },
    // The selected task's Review Guide (#207), as its ⋯ item. Not for a chat,
    // which has no branch to guide; not over a dialog; and not in the editor,
    // where ⇧⌘G is Find Previous (shortcuts.ts).
    'mod+shift+g': {
      whenTyping: 'ignore',
      typingExcept: GUIDE_KEY_EXCEPT,
      run: () => {
        if (!selected || selected.kind === 'chat') return;
        if (modalOpen()) return;
        // The key, unlike a click, takes focus into the guide (#217).
        requestGuide(selected.id, { focus: true });
      },
    },
    // Straight to a reading tab (#256), beside ⇧⌘G. Shown even from PTY
    // only, as ⌘U does. Not over a dialog.
    'mod+shift+t': () => {
      if (!selected || projectView) return;
      if (modalOpen()) return;
      setRightTab('transcript');
      setMode((m) => (m === 'pty' ? 'split' : m));
    },
    'mod+shift+e': () => {
      if (!selected && !projectView) return;
      if (modalOpen()) return;
      setMode((m) => (m === 'pty' ? 'split' : m));
      // Pinned as a column, Files has no tab: go into the column instead.
      if (filesColumnShown) {
        const col = document.querySelector<HTMLElement>('[data-focus-area="files"]');
        if (col) focusArea(col);
        return;
      }
      setRightTab('files');
    },
    // Send the selected task's waiting comments, from anywhere (#258): the
    // transcript then shows, where the message lands, sent or held.
    'mod+shift+s': () => {
      if (!selected) return;
      if (modalOpen()) return;
      sendWaitingComments(selected.id);
    },
    // The message box is in the transcript: show it, then ask it to attach.
    'mod+u': () => {
      if (!selected) return;
      const id = selected.id;
      setRightTab('transcript');
      setMode((m) => (m === 'pty' ? 'split' : m));
      if (!requestAttach(id)) window.setTimeout(() => requestAttach(id), 150);
    },
    'alt+f12': () => setShellOpen((o) => !o),
    'mod+t': () => setShellOpen((o) => !o),
    'mod+=': () => zoomTo(stepZoom(zoomRef.current, 1)),
    'mod+-': () => zoomTo(stepZoom(zoomRef.current, -1)),
    'mod+0': () => zoomTo(1),
    'mod+/': () => setShortcutsOpen((o) => !o),
    // The nth project tab, as shown in the bar. Nothing to do without one.
    'mod+alt+digit': (_e, digit) => {
      const tab = showTabs && digit !== null ? tabs[digit - 1] : undefined;
      if (tab) switchTab(tab.key);
    },
    // The previous / next tab, stopping at the ends; lands like the digit above.
    // The task list as a rail of group counts, or back (#266). Live while
    // typing, as ⇧⌘T: no field claims ⌥⌘T (shortcuts.ts). Not over a dialog.
    'mod+alt+t': () => {
      if (modalOpen()) return;
      setTaskListCollapsed((c) => !c);
    },
    'mod+shift+[': () => stepProject(-1),
    'mod+shift+]': () => stepProject(1),
    // Only where the switch is shown: not over the editor (see the switch).
    'mod+\\': () => {
      if (!editorShowing) setMode((m) => (m === 'pty' ? 'split' : m === 'split' ? 'transcript' : 'pty'));
    },
    // Exempt while typing: ⌘← / ⌘→ are start/end of line in every macOS text
    // field, and this app has a composer, a title input and a code editor.
    'mod+arrowleft': { run: () => stepReadingTab(-1), whenTyping: 'ignore' },
    'mod+arrowright': { run: () => stepReadingTab(1), whenTyping: 'ignore' },
    // PhpStorm's Rename, and F2. Live in the task terminal, which gives them
    // up; not in a text field, the editor or the shell drawer (shortcuts.ts).
    // Never over a dialog.
    'shift+f6': { run: () => startRename(), whenTyping: 'ignore', typingExcept: TASK_TERMINAL_INPUT },
    f2: { run: () => startRename(), whenTyping: 'ignore', typingExcept: TASK_TERMINAL_INPUT },
  });
}
