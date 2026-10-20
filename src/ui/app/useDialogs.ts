import { useState } from 'react';
import type { Task } from '../../types';
import type { NewTaskPrefill } from '../followUp';

/**
 * Which of the frame's dialogs are open, and what they were opened on. State
 * only: what opening one means (a follow-up's title, what a dialog's close
 * refreshes) stays with the code that opens it in App.tsx.
 *
 * Go to / Find in Files are not here: whether they may open depends on the
 * selection and on no other modal showing, so they live beside that.
 */
export default function useDialogs() {
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  /** Set while the new-task dialog is open as a follow-up; null otherwise. */
  const [newTaskPrefill, setNewTaskPrefill] = useState<NewTaskPrefill | null>(null);
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<Task | null>(null);
  const [moveTarget, setMoveTarget] = useState<Task | null>(null);
  /** Which verb the end-task dialog was opened with. */
  const [endIntent, setEndIntent] = useState<'archive' | 'delete'>('archive');

  return {
    newTaskOpen,
    setNewTaskOpen,
    newTaskPrefill,
    setNewTaskPrefill,
    reconcileOpen,
    setReconcileOpen,
    projectsOpen,
    setProjectsOpen,
    shortcutsOpen,
    setShortcutsOpen,
    sessionsOpen,
    setSessionsOpen,
    importOpen,
    setImportOpen,
    archiveTarget,
    setArchiveTarget,
    moveTarget,
    setMoveTarget,
    endIntent,
    setEndIntent,
  };
}
