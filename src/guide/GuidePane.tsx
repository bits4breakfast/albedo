/**
 * The Review Guide (#186): a branch's changes grouped by what they do, in
 * reading order, each group with a short summary and its diffs beside it.
 *
 * A tab of the reading pane, so it has the full width:
 *
 *   left   the group: title, NN / NN, Reviewed, summary, its files with +/-
 *   rail   one mark per group, for where you are
 *   right  the picked file's diff, only this group's blocks of it, unchanged
 *          lines folded (the one diff component, transcript/Diff.tsx, with the
 *          editor's comment gutter)
 *
 * Who writes it, what it may say, and what Albedo checks are in writer.ts,
 * validate.ts and blocks.ts. This file only shows the result.
 *
 * Keys, while focus is in the guide (and not in a text field): ⌥↑ / ⌥↓ the
 * previous / next group, ↑ / ↓ the files in the group, ⌥⏎ mark the group
 * Reviewed and go to the next. None of them is bound anywhere else in the app
 * (shortcuts.ts); CodeMirror's ⌥↑/⌥↓ (move line) never sees them, since the
 * guide has no editor in it.
 *
 * Search (#413, GuideSearch.tsx), anywhere in a written guide, its fields
 * too: ⌘F this file, ⇧⌘F all the guide's files. ⇧⌘F is Find in Files
 * everywhere else; here it is stopped before the window's binding hears it.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { FileDiff, Task } from '../types';
import { loadBranchDiff, type LoadedBranchDiff } from './branchDiff';
import type { BranchDiff, GuideFile } from './blocks';
import { commentMarks, groupComments, NO_COMMENTS, tallyTotal, type CommentTally } from './commentMarks';
import { sendWaitingComments } from '../ui/transcript/composerBridge';
import { ON_ITS_WAY, sendLabel, useToSend, useToSendFrozen } from '../ui/transcript/toSend';
import { carefulWhy, viewGuide, type CarefulMark, type GroupFile, type GroupView, type Guide } from './validate';
import { asFocus, firstMatch, projectFocus, type GuideFocus } from './focus';
import { chosenFocus, draftOf, GuideOptions, useTaskProject } from './GuideOptions';
import { GUIDE_AREA_ATTR } from '../ui/shortcuts';
import { FlagIcon } from '../ui/icons';
import '../ui/worktree.css';
import { useMeasuredBase } from '../ui/useMeasuredBase';
import { useGithubDrafts } from '../ui/reviewDrafts';
import {
  clearWriteError,
  ensureNotes,
  focusNotes,
  keepLastRead,
  keepPlace,
  lastReadOf,
  loadGuide,
  loadReviewed,
  notesStateOf,
  placeOf,
  retryNotes,
  reviewedKey,
  focusDraftOf,
  setFocusDraft,
  setReviewed,
  startWrite,
  useGuideStoreVersion,
  writeStateOf,
  type WriteState,
} from './store';
import { Diff, DiffAnnotationsContext, isOneSided, layoutToggleLabel, useDiffLayout } from '../ui/transcript/Diff';
import { useDiffComments } from '../ui/editor/diffComments';
import { useOpenFile } from '../ui/editor/openFile';
import { relativeTime } from '../ui/TaskList';
import { FileIcon } from '../ui/fileIcons';
import { takeGuideFocus, useGuideFocusRequests } from './openGuide';
import { CommentCount, commentsSaid } from './CommentCount';
import GuideMap from './GuideMap';
import SinceReview from './SinceReview';
import { updateRecordOf, useSinceChanges, useSinceReviewVersion, type ChangesLoad, type UpdateRecord } from './copyUpdate';
import OverflowMenu from '../ui/OverflowMenu';
import { NO_SEARCH, searchDiff } from '../ui/transcript/Diff';
import {
  AllGuideFiles,
  CLOSED_SEARCH,
  SEARCH_DEBOUNCE_MS,
  SearchBar,
  type FocusAsk,
  type GuideSearchState,
  type SearchBarProps,
  type SearchScope,
} from './GuideSearch';
import { linesOf, type GuideHit } from './search';
import { CONTEXT_MODELS, contextActive, gatherContextInput, loadContextSettings, useContextSettings, type ContextModel } from './context';
import { CONTEXT_MENU_LABEL, ContextFailureBanner, ContextSection, GuideContextSheet, useElapsed } from './GuideContext';
import './guide.css';

/**
 * Read or Map (#288), per task, for this run of the app: coming back to a
 * task, or a Rewrite, keeps the view it was left in.
 */
type PaneView = 'read' | 'map';
const VIEW_TITLE: Record<PaneView, string> = {
  read: 'The groups in reading order, with their diffs',
  map: 'The change’s files and their imports, by group',
};
const views = new Map<number, PaneView>();

export function resetGuideViewsForTests(): void {
  views.clear();
}

/** The working-tree side of one file; null when it does not exist. */
async function readWorking(worktreePath: string, rel: string): Promise<string | null> {
  const fs = await import('@tauri-apps/plugin-fs');
  const absolute = `${worktreePath.replace(/\/+$/, '')}/${rel}`;
  try {
    return await fs.readTextFile(absolute);
  } catch (err) {
    if (!(await fs.exists(absolute).catch(() => true))) return null;
    throw err;
  }
}

/** The read of the branch, for the task it was read for. */
type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; taskId: number }
  // `remembered`: the last visit's read, shown at once while the branch is
  // read again (#199). Not the file as it is now, so it resolves no comment.
  | { kind: 'ready'; data: LoadedBranchDiff; taskId: number; remembered?: boolean };

export interface GuidePaneProps {
  task: Task;
  /** The Guide tab is on screen: the diff is re-read each time it comes back. */
  active: boolean;
}

export default function GuidePane({ task, active }: GuidePaneProps): ReactNode {
  useGuideStoreVersion();
  // The copy's last Update Copy (#352): "Since your review" and the groups
  // with new code. Its new head is in the read's deps, so the branch is read
  // again once the copy moves.
  useSinceReviewVersion();
  const update = task.reviewUrl ? updateRecordOf(task.id) : null;
  const sinceChanges = useSinceChanges(task.worktreePath, update);
  const since =
    update && !update.hidden && sinceChanges ? <SinceReview task={task} record={update} changes={sinceChanges} /> : null;
  // Measured against the branch the header shows it merging into (#237).
  const measured = useMeasuredBase(task);
  const measuredBase = measured.base;
  // Coming back to a task (#199): its last read shows at once, and is read
  // again behind it, as on every return to the tab.
  const [read, setLoad] = useState<Load>(() => {
    const last = lastReadOf(task.id);
    return last ? { kind: 'ready', data: last, taskId: task.id, remembered: true } : { kind: 'loading' };
  });
  const [again, setAgain] = useState(0);
  // The project's Guide defaults (#295), Albedo's without a project.
  const project = useTaskProject(task.projectId ?? null);
  const defaults = projectFocus(project);
  /** Write or Rewrite was pressed and the branch is being read again first. */
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  /**
   * The project's Review Guide Context sheet (#444). `rewrite`: opened from
   * the guide's Edit…, so a save that changes the settings writes the guide
   * again with a fresh Context.
   */
  const [sheet, setSheet] = useState<{ rewrite: boolean } | null>(null);

  useEffect(() => {
    if (!active) return;
    let live = true;
    const id = task.id;
    setLoad((prev) => (prev.kind === 'ready' && prev.taskId === id ? prev : { kind: 'loading' }));
    loadBranchDiff(task.worktreePath, measuredBase, (rel) => readWorking(task.worktreePath, rel))
      .then((data) => {
        if (!live) return;
        keepLastRead(id, data);
        setLoad({ kind: 'ready', data, taskId: id });
      })
      .catch((err: unknown) => {
        if (live) setLoad({ kind: 'error', message: err instanceof Error ? err.message : String(err), taskId: id });
      });
    return () => {
      live = false;
    };
  }, [task.id, task.worktreePath, measuredBase, active, again, update?.next]);

  const guide = loadGuide(task.id);
  const stored = writeStateOf(task.id);
  // Reading the branch before a write already counts as writing: one press.
  const write: WriteState | null = starting && stored?.kind !== 'writing' ? { kind: 'writing', progress: null } : stored;
  // Another task's read is never shown for this one.
  const load: Load = read.kind !== 'loading' && read.taskId !== task.id ? { kind: 'loading' } : read;

  if (load.kind === 'loading') return <div className="gd-message">Reading the branch’s changes…</div>;
  if (load.kind === 'error') {
    return (
      <div className="gd-message" data-tone="error">
        Could not read the branch’s changes
        <div className="gd-message-sub">{load.message}</div>
        <button type="button" className="gd-btn" onClick={() => setAgain((n) => n + 1)}>
          Try Again
        </button>
      </div>
    );
  }

  // The base could not be found (#237): the read is against HEAD, so a guide
  // would be of uncommitted changes only, or none. Say why, never an empty guide.
  if (!load.data.fromMergeBase && measuredBase !== '' && measured.settled) {
    return (
      <div className="gd-message" data-tone="error">
        Can’t find the base branch <code>{measuredBase}</code>
        <div className="gd-message-sub">
          {measured.target?.from === 'pr'
            ? `The pull request merges into it${task.baseBranch && task.baseBranch !== measuredBase ? `; the task was cut from ${task.baseBranch}` : ''}.`
            : 'The task was cut from it.'}{' '}
          Git has no local or origin copy of it, so there is nothing to measure the branch against. Fetch it, then try again.
        </div>
        <button type="button" className="gd-btn" onClick={() => setAgain((n) => n + 1)}>
          Try Again
        </button>
      </div>
    );
  }

  const { diff } = load.data;
  const writeNow = (focus: GuideFocus, freshContext = false) => {
    if (startingRef.current || stored?.kind === 'writing') return;
    startingRef.current = true;
    setStarting(true);
    // A guide is written for the branch as it is now, not as the pane last
    // read it (that read may be from an earlier visit, #199). The result is
    // saved for this task even if another is on screen when it lands.
    const id = task.id;
    const base = measuredBase;
    void loadBranchDiff(task.worktreePath, base, (rel) => readWorking(task.worktreePath, rel))
      .then((fresh) => {
        keepLastRead(id, fresh);
        setLoad({ kind: 'ready', data: fresh, taskId: id });
        return fresh.diff;
      })
      // The branch cannot be read just now: write for what is on screen.
      .catch(() => diff)
      .then(async (d) => {
        // The project's Context step (#444), when it has instructions: read
        // from its file now, so a write never starts on settings not yet read.
        const projectId = task.projectId ?? null;
        const settings = projectId === null ? null : await loadContextSettings(projectId);
        const contextTask = { id, title: task.title, branch: task.branch, worktreePath: task.worktreePath, reviewUrl: task.reviewUrl };
        const plan = contextActive(settings)
          ? { settings, input: () => gatherContextInput(contextTask, base), force: freshContext, previous: loadGuide(id)?.context ?? null }
          : undefined;
        const run = startWrite(id, d, base, focus, plan);
        startingRef.current = false;
        setStarting(false);
        return run;
      });
  };

  // What the guide was written with; a guide from before #295 rewrites with the project's.
  const guideFocus = guide ? (asFocus(guide.focus) ?? defaults) : defaults;
  const projectId = task.projectId ?? null;
  const contextSheet =
    sheet !== null && projectId !== null ? (
      <GuideContextSheet
        projectId={projectId}
        projectName={project?.name ?? 'this project'}
        task={task}
        base={measuredBase}
        onClose={() => setSheet(null)}
        onSaved={(changed) => {
          // Edit… on a guide's Context: what it says now is written again.
          if (sheet.rewrite && changed) writeNow(guideFocus, true);
        }}
      />
    ) : null;
  const openContext = projectId === null ? undefined : (rewrite: boolean) => setSheet({ rewrite });

  // Rewrite With Other Options… is open (#295): a draft over a written guide.
  // Kept in the store, so a task switch (the pane remounts) comes back to it.
  const editing = guide !== null && focusDraftOf(task.id) !== null;
  if (guide === null || editing) {
    const start = guide === null ? defaults : guideFocus;
    return (
      <>
        <GuideIntro
          since={since}
          task={task}
          diff={diff}
          write={write}
          // The draft is kept until the write succeeds (store.startWrite), so
          // Try Again writes with what was typed.
          onWrite={() => writeNow(chosenFocus(task.id, start))}
          onCancel={editing ? () => setFocusDraft(task.id, null) : undefined}
          active={active}
          options={
            <GuideOptions
              taskId={task.id}
              diff={diff}
              start={start}
              project={project}
              defaults={defaults}
              // Read only while writing: the lists are cleared once it succeeds.
              disabled={write?.kind === 'writing'}
            />
          }
          onOpenContext={openContext ? () => openContext(false) : undefined}
        />
        {contextSheet}
      </>
    );
  }
  return (
    <>
      <GuideBody
        key={`${task.id}:${guide.writtenAt}`}
        since={since}
        update={update}
        sinceChanges={sinceChanges}
        task={task}
        guide={guide}
        loaded={load.data}
        fresh={load.remembered !== true}
        baseSettled={measured.settled}
        write={write}
        onRewrite={() => writeNow(guideFocus)}
        onEditOptions={() => {
          // Never over a draft already typed.
          if (focusDraftOf(task.id) === null) setFocusDraft(task.id, draftOf(guideFocus));
        }}
        onOpenContext={openContext}
        onRetryContext={() => writeNow(guideFocus, true)}
        active={active}
      />
      {contextSheet}
    </>
  );
}

// ---------------------------------------------------------------------------
// No guide yet
// ---------------------------------------------------------------------------

const ERROR_TITLE: Record<Extract<WriteState, { kind: 'error' }>['error'], string> = {
  missing: 'Claude Code isn’t installed',
  timeout: 'Claude Code took too long',
  invalid: 'The answer wasn’t a usable guide',
  failed: 'Couldn’t write the guide',
};

function WriteStatus({ taskId, write, onRetry }: { taskId: number; write: WriteState | null; onRetry: () => void }): ReactNode {
  if (write === null) return null;
  if (write.kind === 'writing' && write.context) {
    return <ContextSteps write={write} />;
  }
  if (write.kind === 'writing') {
    return (
      <div className="gd-status" role="status" aria-live="polite">
        <span className="gd-spinner" aria-hidden="true" />
        Writing the guide…
        {write.progress && write.progress.of > 1 ? (
          <span className="gd-status-sub">
            {write.progress.label} · step {write.progress.step} of {write.progress.of}
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <div className="gd-status" data-tone="error" role="alert">
      <span className="gd-status-title">{ERROR_TITLE[write.error]}</span>
      <span className="gd-status-sub">{write.message} Nothing was saved.</span>
      <span className="gd-status-actions">
        <button type="button" className="gd-btn gd-btn-primary" onClick={onRetry}>
          Try Again
        </button>
        <button type="button" className="gd-btn" onClick={() => clearWriteError(taskId)}>
          Dismiss
        </button>
      </span>
    </div>
  );
}

/**
 * A write with a Context step (#444): its steps, the current one in the
 * strong tier, with the Context step's seconds while it runs.
 */
function ContextSteps({ write }: { write: Extract<WriteState, { kind: 'writing' }> }): ReactNode {
  const ctx = write.context!;
  const elapsed = useElapsed(ctx.done ? null : ctx.startedAt);
  const grouping = write.progress && write.progress.of > 1 ? `${write.progress.label} · step ${write.progress.step} of ${write.progress.of}` : 'Grouping the changes';
  return (
    <div className="gd-status gd-steps" role="status" aria-live="polite">
      <span className="gd-step" data-on={!ctx.done || undefined}>
        {ctx.done ? null : <span className="gd-spinner" aria-hidden="true" />}
        Reading context · your instructions{ctx.done ? '' : ` · ${elapsed}s`}
      </span>
      <span className="gd-step" data-on={ctx.done || undefined}>
        {ctx.done ? <span className="gd-spinner" aria-hidden="true" /> : null}
        {grouping}
      </span>
      <span className="gd-step">Writing the notes</span>
    </div>
  );
}

function modelLabel(id: ContextModel): string {
  return CONTEXT_MODELS.find((m) => m.id === id)?.label ?? id;
}

function GuideIntro({
  since,
  task,
  diff,
  write,
  onWrite,
  onCancel,
  active,
  options,
  onOpenContext,
}: {
  /** "Since your review" (#352), above everything else. */
  since: ReactNode;
  task: Task;
  diff: BranchDiff;
  write: WriteState | null;
  onWrite: () => void;
  /** Rewriting with other options (#295): back to the guide, nothing written. */
  onCancel?: () => void;
  active: boolean;
  /** The lists to set aside and mark (#295). */
  options: ReactNode;
  /** The project's Review Guide Context sheet (#444); none without a project. */
  onOpenContext?: () => void;
}): ReactNode {
  const empty = diff.order.length === 0;
  // The project's Context step (#444), said where the run is described.
  const projectContext = useContextSettings(task.projectId ?? null);
  const contextOn = contextActive(projectContext) ? projectContext : null;
  // ⇧⌘G with no guide yet (#217): to Write Guide, or the intro itself when
  // there is nothing to write or it is being written.
  const introRef = useRef<HTMLDivElement>(null);
  const writeRef = useRef<HTMLButtonElement>(null);
  const focusAsked = useGuideFocusRequests();
  useEffect(() => {
    if (!active || !takeGuideFocus(task.id)) return;
    const button = writeRef.current;
    (button && !button.disabled ? button : introRef.current)?.focus({ preventScroll: true });
  }, [active, focusAsked, task.id]);
  return (
    <div className="gd-intro" ref={introRef} tabIndex={-1}>
      {since}
      <h2 className="gd-intro-title">Review Guide</h2>
      <p className="gd-intro-text">
        This branch’s changes, grouped by what they do and put in reading order, with a summary of each group beside its
        diffs.
      </p>
      <p className="gd-intro-facts">
        {empty
          ? `No changes against ${task.baseBranch} yet.`
          : `${diff.files.length} ${diff.files.length === 1 ? 'file' : 'files'} · ${diff.order.length} ${
              diff.order.length === 1 ? 'block' : 'blocks'
            } · against ${task.baseBranch}, committed and uncommitted`}
      </p>
      {empty ? null : options}
      {write === null ? (
        <span className="gd-intro-actions">
          <button type="button" ref={writeRef} className="gd-btn gd-btn-primary" onClick={onWrite} disabled={empty}>
            {onCancel ? 'Rewrite Guide' : 'Write Guide'}
          </button>
          {onCancel ? (
            <button type="button" className="gd-btn" onClick={onCancel}>
              Cancel
            </button>
          ) : null}
        </span>
      ) : null}
      <WriteStatus taskId={task.id} write={write} onRetry={onWrite} />
      <p className="gd-intro-note">
        Written by Claude Haiku in a separate, one-time run with no tools
        {contextOn ? `, after a Context step on Claude ${modelLabel(contextOn.model)} that may use only the tools you listed` : ''}.
        This task’s session is not touched.
        {onOpenContext ? (
          <>
            {' '}
            <button type="button" className="gd-link gd-intro-link" onClick={onOpenContext}>
              {CONTEXT_MENU_LABEL}
            </button>
          </>
        ) : null}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The guide
// ---------------------------------------------------------------------------

/**
 * Where a key is the user's text, for ⌘R and ⇧⌘R: a text field, never a
 * checkbox, radio or button, which take no letters.
 */
const TYPING_FIELD =
  'textarea, select, [contenteditable="true"], input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"])';

/** The last mark ⌘R or ⇧⌘R made, which the same key undoes. */
interface LastMark {
  kind: 'file' | 'group';
  /** What it marked: only what was not marked already. */
  keys: string[];
  /** Where it was made, to go back to, and what to say there. */
  group: string;
  path: string;
  said: string;
  /** When it was made: past {@link UNDO_MS}, the key marks again. */
  at: number;
  /** The groups and their files then: if they change, the mark is forgotten. */
  shape: string;
}

/**
 * How long the same key undoes its mark. A reader who moves on without a key
 * or a click -- scrolling the next file with the trackpad -- and then marks
 * it must not unmark the previous one.
 */
export const UNDO_MS = 2000;

/** The groups as the Reviewed keys see them: an undo is only safe on the same. */
function shapeOf(groups: readonly GroupView[]): string {
  return groups.map((g) => `${g.key}:${g.files.map((f) => reviewedKey(f.path, f.blocks)).join(',')}`).join('|');
}

const MODIFIER_KEYS: ReadonlySet<string> = new Set(['Meta', 'Shift', 'Control', 'Alt', 'CapsLock', 'Fn']);

/** ⌘R is the file's key, ⇧⌘R the group's; null for any other key. */
function markKind(e: KeyboardEvent): 'file' | 'group' | null {
  if (e.code !== 'KeyR' || !e.metaKey || e.ctrlKey || e.altKey) return null;
  return e.shiftKey ? 'group' : 'file';
}

function writtenAgo(at: number): string {
  const age = relativeTime(at, Date.now());
  return age === 'now' ? 'just now' : `${age} ago`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function splitPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf('/');
  return i === -1 ? { name: path, dir: '' } : { name: path.slice(i + 1), dir: path.slice(0, i + 1) };
}

/**
 * A file row's figures in three fixed columns -- comments, +, − -- each
 * right-aligned, so they line up from row to row whatever a row lacks.
 */
function RowCounts({ file, comments }: { file: GroupFile; comments: CommentTally }): ReactNode {
  if (file.stat === 'binary' || file.stat === 'too-large') {
    return (
      <span className="gd-file-counts">
        <CommentCount tally={comments} />
        <span className="gd-counts gd-counts-wide">{file.stat === 'binary' ? 'Binary' : 'Too large'}</span>
      </span>
    );
  }
  return (
    <span className="gd-file-counts">
      {tallyTotal(comments) > 0 ? <CommentCount tally={comments} /> : <span />}
      <span className="gd-counts">{file.added > 0 ? <span className="gd-add">+{file.added}</span> : null}</span>
      <span className="gd-counts">{file.removed > 0 ? <span className="gd-del">−{file.removed}</span> : null}</span>
    </span>
  );
}

function Counts({ file }: { file: GroupFile }): ReactNode {
  if (file.stat === 'binary' || file.stat === 'too-large') {
    return <span className="gd-counts">{file.stat === 'binary' ? 'Binary' : 'Too large'}</span>;
  }
  return (
    <span className="gd-counts">
      {file.added > 0 ? <span className="gd-add">+{file.added}</span> : null}
      {file.removed > 0 ? <span className="gd-del">−{file.removed}</span> : null}
    </span>
  );
}

/** The whole change's size (#250): every file of the branch, not the filter's. Pure. */
export function changeTotals(diff: BranchDiff): { files: number; added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const f of diff.files) {
    added += f.added;
    removed += f.removed;
  }
  return { files: diff.files.length, added, removed };
}

/**
 * "· 14 files +320 −45", right after the base (#250). Never cut: the text
 * before it gives way first. The +/− are the file counts' tokens, cleared on
 * this row's two grounds (guideTotalsContrast.test.ts).
 */
function ChangeTotals({ diff, base }: { diff: BranchDiff; base: string }): ReactNode {
  const t = changeTotals(diff);
  const files = t.files === 1 ? '1 file' : `${t.files} files`;
  const said = `${files} changed, ${t.added} ${t.added === 1 ? 'line' : 'lines'} added, ${t.removed} removed, branch vs ${base}`;
  return (
    <span className="gd-meta-totals" title={said} aria-label={said} role="note">
      <span aria-hidden="true">· {files}</span>
      <span className="gd-counts" aria-hidden="true">
        <span className="gd-add">+{t.added}</span>
        <span className="gd-del">−{t.removed}</span>
      </span>
    </span>
  );
}

function GuideBody({
  since,
  update,
  sinceChanges,
  task,
  guide,
  loaded,
  fresh,
  baseSettled,
  write,
  onRewrite,
  onEditOptions,
  onOpenContext,
  onRetryContext,
  active,
}: {
  /** "Since your review" (#352), at the top. */
  since: ReactNode;
  /** The copy's last update and what it changed (#352), for the groups' "changed". */
  update: UpdateRecord | null;
  sinceChanges: ChangesLoad | null;
  task: Task;
  guide: Guide;
  loaded: LoadedBranchDiff;
  /** The read is this visit's, not a remembered one (#222: auto-resolve). */
  fresh: boolean;
  /** #402: gh has answered for the PR, so the base is final: a removed comment may resolve. */
  baseSettled: boolean;
  write: WriteState | null;
  onRewrite: () => void;
  /** Rewrite With Other Options… (#295). */
  onEditOptions: () => void;
  /** The project's Review Guide Context sheet (#444); `rewrite` from the section's Edit…. None without a project. */
  onOpenContext?: (rewrite: boolean) => void;
  /** The Context step again, then the guide (#444): the failure banner's Try Again. */
  onRetryContext: () => void;
  active: boolean;
}): ReactNode {
  const { diff, uncommitted } = loaded;
  const [onlyUncommitted, setOnlyUncommitted] = useState(false);
  const view = useMemo(() => viewGuide(guide, diff), [guide, diff]);
  const groups = useMemo<GroupView[]>(() => {
    if (!onlyUncommitted) return view.groups;
    return view.groups
      .map((g) => ({ ...g, files: g.files.filter((f) => uncommitted.has(f.path)) }))
      .filter((g) => g.files.length > 0);
  }, [view, onlyUncommitted, uncommitted]);

  const changed = view.changedFiles.length === 1 ? '1 file' : `${view.changedFiles.length} files`;
  const [shownView, setShownView] = useState<PaneView>(() => views.get(task.id) ?? 'read');
  const showView = (v: PaneView) => {
    views.set(task.id, v);
    setShownView(v);
  };

  // To Send (#404), the list every view reads: a PR's failing checks (#280),
  // comments on code (this guide, the editor, diffs) and on transcript
  // passages (#254). Send N shows the same N as the list above the box.
  const toSend = useToSend(task.id);
  const waitingCount = toSend.count;
  // A send already carries them (#404): a second would carry them again.
  const sendFrozen = useToSendFrozen(task.id);
  // The transcript is shown after (#254): where it lands, sent or held.
  const sendComments = () => void sendWaitingComments(task.id);
  const sendButton =
    waitingCount > 0 ? (
      <button
        type="button"
        className={view.stale ? 'gd-btn' : 'gd-btn gd-btn-primary'}
        onClick={sendComments}
        disabled={sendFrozen}
        aria-keyshortcuts="Meta+Shift+S Meta+Enter"
        title={
          sendFrozen
            ? ON_ITS_WAY
            : `Send the ${waitingCount} To Send to Claude now, and show the transcript (⇧⌘S, or ⌘↩ here). What you're typing in the message box stays there.`
        }
      >
        {sendLabel(waitingCount)}{' '}
        <span className="gd-btn-key" aria-hidden="true">
          ⇧⌘S
        </span>
      </button>
    ) : null;

  // Where the open comments are (#252, #440), so one left on a file is found
  // again here: To Send's and, on a review task, the GitHub Drafts, in one
  // bubble. Sent, resolved and posted ones are in neither list. Send N above
  // still counts To Send alone: it is what Send sends.
  const drafts = useGithubDrafts(task);
  const marks = useMemo(() => commentMarks(groups, diff, toSend.code, drafts), [groups, diff, toSend.code, drafts]);
  const fileComments = (g: GroupView, f: GroupFile) => marks.get(g.key)?.get(f.path) ?? NO_COMMENTS;

  const reviewed = loadReviewed(task.id);
  const isFileReviewed = (f: GroupFile) => reviewed.has(reviewedKey(f.path, f.blocks));
  const isGroupReviewed = (g: GroupView) => g.files.length > 0 && g.files.every(isFileReviewed);
  // The reading the guide leads you through (#295): every group but Set
  // Aside, which is listed last. Its count, "All reviewed" and Reviewed and
  // Next leave it out; Next and the rail still reach it.
  const led = groups.filter((g) => !g.setAside);
  const focus = asFocus(guide.focus);
  // Ticked once, at other blocks: the file changed since it was reviewed (#248).
  const reviewedPaths = new Set([...reviewed].map((k) => k.slice(0, k.lastIndexOf('#'))));
  const changedSinceReview = (f: GroupFile) => !isFileReviewed(f) && reviewedPaths.has(f.path);
  // New code since the copy you had (#352): the files Update Copy changed.
  // A group holding any is "changed"; one you had ticked is "Reviewed
  // before" -- its tick went with the old blocks, as every tick does.
  // The record is read afresh each render; its heads are what matter.
  const hasUpdate = update !== null;
  const updatedPaths = useMemo(
    () => new Set(hasUpdate && sinceChanges?.kind === 'ready' ? sinceChanges.changes.files.map((f) => f.path) : []),
    [hasUpdate, sinceChanges],
  );
  const groupChanged = (g: GroupView) => g.files.filter((f) => updatedPaths.has(f.path)).length;
  // Ticked in THIS group before: a mark on the file whose blocks were all the
  // group's as the guide placed them. Unsorted has no blocks of its own to
  // ask, so any mark on the file counts there.
  const tickedInGroup = (g: GroupView, path: string) => {
    const own = g.index === null ? null : new Set(guide.groups[g.index]?.blocks ?? []);
    for (const k of reviewed) {
      const at = k.lastIndexOf('#');
      if (at <= 0 || k.slice(0, at) !== path) continue;
      const ids = k.slice(at + 1).split(',').filter(Boolean);
      if (own === null || (ids.length > 0 && ids.every((id) => own.has(id)))) return true;
    }
    return false;
  };
  const reviewedBefore = (g: GroupView) =>
    !isGroupReviewed(g) && g.files.some((f) => updatedPaths.has(f.path) && tickedInGroup(g, f.path));
  // The guide is of the copy before the update: the banner says so, in those words.
  const forPreviousCopy = view.stale && update !== null && guide.writtenAt < update.at;

  // The group is kept by its key, never its number: Uncommitted Only changes
  // the numbers. With no place kept, the first group still to review.
  const [place, setPlace] = useState(() => {
    const kept = placeOf(task.id, guide.writtenAt);
    if (kept) return kept;
    const next = led.find((g) => !isGroupReviewed(g)) ?? groups[0] ?? null;
    return { writtenAt: guide.writtenAt, group: next?.key ?? null, picked: {} as Readonly<Record<string, string>> };
  });
  const picked = place.picked;
  useEffect(() => keepPlace(task.id, place), [task.id, place]);
  const found = groups.findIndex((g) => g.key === place.group);
  const at = found >= 0 ? found : 0;
  const group = groups[at] ?? null;
  // What a screen reader hears when the group changes under it (#201): the
  // rail's own buttons say it already, so a click on one says nothing.
  const [said, setSaid] = useState('');
  const goTo = (i: number, announce = true) => {
    const n = Math.max(0, Math.min(groups.length - 1, i));
    const g = groups[n];
    if (!g) return;
    setPlace((p) => ({ ...p, group: g.key }));
    if (announce && n !== at) setSaid(`Group ${n + 1} of ${groups.length}: ${g.title}`);
  };
  const setPicked = (next: (p: Readonly<Record<string, string>>) => Record<string, string>) =>
    setPlace((p) => ({ ...p, picked: next(p.picked) }));
  // A group opens at the last file opened in it; on a first visit, at its
  // first file still to read; with none, at its first file. However you
  // arrive: a move, a review, or the rail.
  const file = group
    ? (group.files.find((f) => f.path === picked[group.key]) ??
      group.files.find((f) => !isFileReviewed(f)) ??
      group.files[0] ??
      null)
    : null;
  // What is on screen is what was opened, so coming back finds it even when
  // its marks have changed since.
  const shownKey = group && file && picked[group.key] !== file.path ? `${group.key}\n${file.path}` : null;
  useEffect(() => {
    if (shownKey === null) return;
    const [g, path] = shownKey.split('\n') as [string, string];
    setPlace((p) => ({ ...p, picked: { ...p.picked, [g]: path } }));
  }, [shownKey]);
  const reviewedCount = led.filter(isGroupReviewed).length;

  // The notes come after the groups, a call per group (#224): queue the
  // groups still without them -- after a restart too -- and keep the one in
  // view at the front. The guide read for this is the latest, by ref, so a
  // note landing (a new object, the same guide) does not queue again.
  const guideRef = useRef(guide);
  guideRef.current = guide;
  const groupIndex = group?.index ?? null;
  const groupIndexRef = useRef(groupIndex);
  groupIndexRef.current = groupIndex;
  useEffect(() => {
    ensureNotes(task.id, guideRef.current, diff, groupIndexRef.current ?? undefined);
  }, [task.id, guide.writtenAt, diff]);
  useEffect(() => {
    if (groupIndex !== null) focusNotes(task.id, guide.writtenAt, groupIndex);
  }, [task.id, guide.writtenAt, groupIndex]);
  const notesState = groupIndex === null ? null : notesStateOf(task.id, guide.writtenAt, groupIndex);

  // The keys work once focus is in the guide. Take it when the tab comes on
  // screen, but never from someone typing (a guide finishing in the
  // background must not pull focus out of the message box or the terminal)
  // -- unless ⇧⌘G asked for it (#217).
  const rootRef = useRef<HTMLDivElement>(null);

  // The toolbar gives way (#288 review): the text shrinks to nothing first;
  // past that, Read · Map and Uncommitted Only go into a ⋯ at the row's end
  // rather than the row overflowing where it fit before the toggle. Measured,
  // not guessed: the row's full width is what it needed when it overflowed.
  const metaRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const fullWidth = useRef(0);
  const fitRow = useCallback(() => {
    const el = metaRef.current;
    if (!el) return;
    setCompact((was) => {
      if (!was && el.scrollWidth > el.clientWidth + 0.5) {
        fullWidth.current = el.scrollWidth;
        return true;
      }
      if (was && el.clientWidth >= fullWidth.current) return false;
      return was;
    });
  }, []);
  useLayoutEffect(fitRow);
  useEffect(() => {
    const el = metaRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fitRow);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitRow]);

  useEffect(() => {
    if (!active) return;
    const now = document.activeElement;
    if (now && now !== document.body && now.closest('textarea, input, select, [contenteditable="true"], .xterm')) return;
    rootRef.current?.focus({ preventScroll: true });
  }, [active]);
  const focusAsked = useGuideFocusRequests();
  useEffect(() => {
    if (active && takeGuideFocus(task.id)) rootRef.current?.focus({ preventScroll: true });
  }, [active, focusAsked, task.id]);

  const pickFile = useCallback(
    (path: string) => {
      if (group) setPicked((p) => ({ ...p, [group.key]: path }));
    },
    [group],
  );

  // Reviewing moves you on (#201): to the next group still to review, after
  // this one first and then any skipped before it. With none left it stays,
  // and the header says so.
  const advance = () => {
    const now = loadReviewed(task.id);
    const unread = (f: GroupFile) => !now.has(reviewedKey(f.path, f.blocks));
    const i = nextToReview(groups, at, (g) => g.setAside || !g.files.some(unread));
    if (i === null) {
      setSaid(led.length === 0 ? NOTHING_TO_REVIEW : `All ${led.length} groups reviewed`);
      return;
    }
    const g = groups[i]!;
    setPlace((p) => ({ ...p, group: g.key }));
    setSaid(`Group ${i + 1} of ${groups.length}: ${g.title}`);
  };

  const toggleFile = (f: GroupFile) => {
    const on = !isFileReviewed(f);
    setReviewed(task.id, [reviewedKey(f.path, f.blocks)], on);
    // Ticking a file moves on to the next one still to read, as a reviewer
    // would; the last one finishes the group, and that moves to the next group.
    if (on && group) {
      const i = group.files.indexOf(f);
      const next = [...group.files.slice(i + 1), ...group.files.slice(0, i)].find((x) => x !== f && !isFileReviewed(x));
      if (next) pickFile(next.path);
      else advance();
    }
  };

  // Unticking never moves.
  const toggleGroup = (g: GroupView, on = !isGroupReviewed(g)) => {
    setReviewed(
      task.id,
      g.files.map((f) => reviewedKey(f.path, f.blocks)),
      on,
    );
    if (on) advance();
  };

  const stepGroup = (delta: number) => goTo(at + delta);

  // ⌘R and ⇧⌘R (#390, #391): the two Reviewed boxes, from the keyboard. Each
  // toggles and moves on exactly as a click on its box does. Pressed again
  // within UNDO_MS, with no other key, click, wheel or move between and the
  // groups as they were, it undoes the mark it just made and goes back to
  // where it was made: the owner's "pressing again undoes". Read's,
  // anywhere in it, as the other keys are; a checkbox or button with focus
  // is not typing, so they work from there too, but not from a comment box,
  // the search field or any other text field, nor from an open menu. ⇧⌘R is Remote Control everywhere else: that binding stands aside
  // inside a guide on screen (GUIDE_AREA, shortcuts.ts), so it never fires
  // here, even on the Map. From `code`, as the app's ⇧⌘R is; Command only. A
  // held key does not repeat: auto-repeat would toggle a run of files.
  const lastMark = useRef<LastMark | null>(null);
  // Anything else -- a key, a click, the window losing focus, a wheel or
  // trackpad scroll in the guide -- forgets it. A wheel, not `scroll`: the
  // guide scrolls itself as a file opens, and that is not the reader moving.
  useEffect(() => {
    const forget = (e: Event) => {
      const m = lastMark.current;
      if (m === null) return;
      if (e instanceof KeyboardEvent && (MODIFIER_KEYS.has(e.key) || markKind(e) === m.kind)) return;
      if (e.type === 'wheel' && !(e.target instanceof Node && rootRef.current?.contains(e.target))) return;
      lastMark.current = null;
    };
    window.addEventListener('keydown', forget, true);
    window.addEventListener('pointerdown', forget, true);
    window.addEventListener('wheel', forget, { capture: true, passive: true });
    window.addEventListener('blur', forget);
    return () => {
      window.removeEventListener('keydown', forget, true);
      window.removeEventListener('pointerdown', forget, true);
      window.removeEventListener('wheel', forget, { capture: true });
      window.removeEventListener('blur', forget);
    };
  }, []);

  const undoMark = (m: LastMark) => {
    lastMark.current = null;
    setReviewed(task.id, m.keys, false);
    setPlace((p) => ({ ...p, group: m.group, picked: { ...p.picked, [m.group]: m.path } }));
    setSaid(m.said);
  };

  const reviewKey = (e: ReactKeyboardEvent<HTMLDivElement>): boolean => {
    const kind = markKind(e.nativeEvent);
    if (kind === null || !active) return false;
    const t = e.target as HTMLElement;
    if (t.closest(TYPING_FIELD) || t.closest('[role="menu"]')) return false;
    e.preventDefault();
    if (e.repeat || shownView === 'map' || !group || !file) return true;
    // The box with focus may go with the file it belongs to: keep focus in
    // the guide, so the next press is heard here too.
    if (document.activeElement !== rootRef.current) rootRef.current?.focus({ preventScroll: true });
    const m = lastMark.current;
    lastMark.current = null;
    if (m !== null && m.kind === kind && Date.now() - m.at < UNDO_MS && m.shape === shapeOf(groups)) {
      undoMark(m);
      return true;
    }
    const files = kind === 'group' ? group.files : [file];
    const keys = files.filter((f) => !isFileReviewed(f)).map((f) => reviewedKey(f.path, f.blocks));
    if (kind === 'group') toggleGroup(group);
    else toggleFile(file);
    // Only a mark is remembered: an unmark stays where it is, and the key
    // again simply marks it once more.
    if (keys.length > 0) {
      const said = kind === 'group' ? `Unmarked ${group.title}` : `Unmarked ${splitPath(file.path).name}`;
      lastMark.current = { kind, keys, group: group.key, path: file.path, said, at: Date.now(), shape: shapeOf(groups) };
    }
    return true;
  };

  // Focus never falls out of the guide on its own: a box that unmounts with
  // focus in it (a file's header as the next opens, a comment box saved or
  // cancelled) leaves it on the page's body, where the guide's keys are not
  // heard and ⇧⌘R would be Remote Control. Watched on the DOM, not on this
  // component's renders: a comment box goes in a render of its own. Focus
  // put elsewhere on purpose -- a click outside, the terminal, another tab --
  // is never taken back.
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    let inside = el.contains(document.activeElement);
    // Left for nothing, and not known yet whether by a click (it stays in
    // the page) or by being removed (it goes): an engine may say so before
    // the removal or not at all.
    let lost: Node | null = null;
    const regain = () => {
      if (lost?.isConnected) return;
      const now = document.activeElement;
      if (inside && activeRef.current && (now === null || now === document.body)) el.focus({ preventScroll: true });
    };
    const onIn = () => {
      inside = true;
      lost = null;
    };
    const onOut = (e: FocusEvent) => {
      const to = e.relatedTarget;
      if (to instanceof Node) {
        inside = el.contains(to);
        return;
      }
      const from = e.target as Node;
      lost = from;
      window.setTimeout(() => {
        if (lost !== from) return;
        lost = null;
        // Still in the page: a click on something that takes no focus, the
        // user's choice. Gone: a removal, not a choice.
        if (from.isConnected) inside = false;
        else regain();
      }, 0);
    };
    const watch = new MutationObserver(regain);
    watch.observe(el, { childList: true, subtree: true });
    el.addEventListener('focusin', onIn);
    el.addEventListener('focusout', onOut);
    return () => {
      watch.disconnect();
      el.removeEventListener('focusin', onIn);
      el.removeEventListener('focusout', onOut);
    };
  }, []);

  // Search (#413). The field takes focus once per ⌘F / ⇧⌘F, a switch or an
  // opened match, also when its bar mounts after the request (another file).
  const [search, setSearch] = useState<GuideSearchState>(CLOSED_SEARCH);
  const [focusTick, setFocusTick] = useState(0);
  // ⌘F / ⇧⌘F select the text, as every Find does; the switch and an opened
  // match leave it be, so the next key goes on typing.
  const searchFocus = useRef<FocusAsk>(null);
  const takeSearchFocus = useCallback(() => {
    const asked = searchFocus.current;
    searchFocus.current = null;
    return asked;
  }, []);
  const openSearch = (scope: SearchScope, ask: FocusAsk = 'select') => {
    if (shownView === 'map') showView('read');
    searchFocus.current = ask;
    setFocusTick((n) => n + 1);
    setSearch((s) => ({ ...s, open: true, scope }));
  };
  // The text searched: what was typed, once typing pauses. Never a search
  // per keystroke on a large guide; empty at once. The current match is the
  // last search's until the new one lands: never one picked from stale matches.
  const [searched, setSearched] = useState('');
  const searchedRef = useRef('');
  useEffect(() => {
    const apply = () => {
      if (search.query === searchedRef.current) return;
      searchedRef.current = search.query;
      setSearched(search.query);
      setSearch((s) => (s.current === null ? s : { ...s, current: null }));
    };
    if (search.query === '') {
      apply();
      return;
    }
    const t = setTimeout(apply, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search.query]);
  const closeSearch = () => {
    setSearch((s) => ({ ...s, open: false, current: null }));
    rootRef.current?.focus({ preventScroll: true });
  };
  // A match in All Guide Files: its file, in its group, on This File.
  const openHit = (hit: GuideHit) => {
    const i = groups.findIndex((g) => g.key === hit.groupKey);
    setPlace((p) => ({ ...p, group: hit.groupKey, picked: { ...p.picked, [hit.groupKey]: hit.path } }));
    if (i >= 0 && i !== at) setSaid(`Group ${i + 1} of ${groups.length}: ${groups[i]!.title}`);
    searchFocus.current = 'caret';
    setFocusTick((n) => n + 1);
    setSearch((s) => ({ ...s, scope: 'file', current: { path: hit.path, key: hit.key } }));
  };
  const searchBar: SearchBarProps = {
    scope: search.scope,
    query: search.query,
    onQuery: (query) => setSearch((s) => ({ ...s, query })),
    onScope: (scope) => openSearch(scope, 'caret'),
    onClose: closeSearch,
    focusTick,
    takeFocus: takeSearchFocus,
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // ⌘F / ⇧⌘F (#413): search, from anywhere in the guide, its fields too.
    // Stopped here, so the window's ⇧⌘F (Find in Files) never hears it.
    if (e.code === 'KeyF' && e.metaKey && !e.ctrlKey && !e.altKey && group !== null) {
      e.preventDefault();
      e.stopPropagation();
      openSearch(e.shiftKey ? 'all' : 'file');
      return;
    }
    const t = e.target as HTMLElement;
    if (reviewKey(e)) return;
    if (t.closest('input, textarea, select, [contenteditable="true"]')) return;
    // Esc closes the search from anywhere in the guide but a field (a
    // comment's Esc is its own); handled, so full screen stays (#267).
    if (e.key === 'Escape' && search.open && !e.defaultPrevented) {
      // Handled, and here only: the editor's Esc on the window closes its file.
      e.preventDefault();
      e.stopPropagation();
      closeSearch();
      return;
    }
    // ⌘⏎: Send N (#256, #404), not while a send already carries them. A
    // comment box is a textarea, returned above, so there ⌘⏎ still saves
    // the comment and never sends.
    if (e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && (e.code === 'Enter' || e.code === 'NumpadEnter')) {
      if (waitingCount === 0 || sendFrozen) return;
      e.preventDefault();
      sendComments();
      return;
    }
    // The group and file keys are Read's; the map is moved through with Tab.
    if (e.metaKey || e.ctrlKey || e.shiftKey || shownView === 'map') return;
    if (e.altKey && (e.code === 'ArrowDown' || e.code === 'ArrowUp')) {
      e.preventDefault();
      stepGroup(e.code === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.altKey && (e.code === 'Enter' || e.code === 'NumpadEnter')) {
      e.preventDefault();
      if (group) toggleGroup(group, true);
      return;
    }
    if (!e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && group && file) {
      e.preventDefault();
      const i = group.files.indexOf(file);
      const next = group.files[Math.max(0, Math.min(group.files.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) pickFile(next.path);
    }
  };

  return (
    // A focus stop of its own, so its keys work from a click anywhere in it.
    <div
      className="gd"
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      aria-label="Review Guide"
      // On screen, ⇧⌘R is the group's key here, not Remote Control
      // (shortcuts.ts). A hidden guide stays mounted and claims nothing.
      {...(active ? { [GUIDE_AREA_ATTR]: '' } : {})}
    >
      {/* One row, one Rewrite (#197): a guide the branch has moved on from
          says so here, on the banner's ground, rather than in a second row
          with a second button. */}
      <div className="gd-meta" ref={metaRef} data-stale={view.stale || undefined}>
        {/* Out of date, what matters leads: a narrow pane cuts from the end,
            so the base goes before the news does. Only the text is a live
            region, never the controls beside it. */}
        {forPreviousCopy ? (
          <span
            className="gd-meta-text"
            role="status"
            title={`The Guide was written ${writtenAgo(guide.writtenAt)}, before Update Copy. Groups marked changed have new code in them. Branch vs ${guide.base}.`}
          >
            The Guide was written for your previous copy. Groups marked <b>changed</b> have new code in them.
          </span>
        ) : view.stale ? (
          <span
            className="gd-meta-text"
            role="status"
            title={`${changed} changed since this guide was written (${new Date(guide.writtenAt).toLocaleString()}). A changed file stays in its group and needs reviewing again; files new to the branch are under Unsorted. Branch vs ${guide.base}.`}
          >
            {changed} changed since it was written {writtenAgo(guide.writtenAt)} · shown in their groups, to review again · branch vs{' '}
            {guide.base}
          </span>
        ) : (
          <span className="gd-meta-text" title={new Date(guide.writtenAt).toLocaleString()}>
            Written {writtenAgo(guide.writtenAt)} · branch vs {guide.base}
          </span>
        )}
        <ChangeTotals diff={diff} base={guide.base} />
        {/* Read or Map (#288): which view of the same guide, so it leads the
            controls; the filter applies to both. */}
        {compact ? null : (
          <>
            <span className="seg seg-compact" role="group" aria-label="View">
              <button type="button" aria-pressed={shownView === 'read'} onClick={() => showView('read')} title={VIEW_TITLE.read}>
                Read
              </button>
              <button type="button" aria-pressed={shownView === 'map'} onClick={() => showView('map')} title={VIEW_TITLE.map}>
                Map
              </button>
            </span>
            <label className="gd-filter">
              <input type="checkbox" checked={onlyUncommitted} onChange={(e) => setOnlyUncommitted(e.target.checked)} />
              Uncommitted Only
            </label>
          </>
        )}
        {/* Out of date, Rewrite leads and Send N sits beside it; otherwise
            anything To Send makes Send N the row's action (#254, #404). */}
        {view.stale ? sendButton : null}
        <button
          type="button"
          // The one thing to do about an out-of-date guide: the primary action then.
          className={view.stale ? 'gd-btn gd-btn-primary' : 'gd-btn'}
          onClick={onRewrite}
          disabled={write?.kind === 'writing'}
          title="Ask Claude Haiku for a new guide of the branch as it is now"
        >
          {write?.kind === 'writing'
            ? write.context && !write.context.done
              ? 'Reading Context…'
              : forPreviousCopy
                ? 'Updating Guide…'
                : 'Rewriting…'
            : forPreviousCopy
              ? 'Update Guide'
              : 'Rewrite'}
        </button>
        {view.stale ? null : sendButton}
        {/* The rest in ⋯ (#295): Rewrite With Other Options… always; Read ·
            Map and the filter too once the row has given way (#288). */}
        <OverflowMenu
          label="More guide actions"
          items={[
            ...(compact
              ? [
                  { id: 'read', label: 'Read', radio: true, checked: shownView === 'read', title: VIEW_TITLE.read, onSelect: () => showView('read') },
                  { id: 'map', label: 'Map', radio: true, checked: shownView === 'map', title: VIEW_TITLE.map, onSelect: () => showView('map') },
                  { id: 'uncommitted', label: 'Uncommitted Only', checked: onlyUncommitted, group: true, onSelect: () => setOnlyUncommitted((on) => !on) },
                ]
              : []),
            {
              id: 'options',
              label: 'Rewrite With Other Options…',
              group: compact,
              disabled: write?.kind === 'writing',
              title: 'Change what this guide sets aside and marks, then write it again',
              onSelect: onEditOptions,
            },
            ...(onOpenContext
              ? [
                  {
                    id: 'context',
                    label: CONTEXT_MENU_LABEL,
                    title: 'What this project’s guides also look up in your own tools, and which tools they may use',
                    onSelect: () => onOpenContext(false),
                  },
                ]
              : []),
          ]}
        />
      </div>
      {since ? <div className="gd-since-wrap">{since}</div> : null}
      {guide.context ? (
        <div className="gd-context-wrap">
          <ContextSection context={guide.context} onEdit={onOpenContext ? () => onOpenContext(true) : undefined} />
        </div>
      ) : null}
      {guide.contextFailure && !guide.context ? (
        <ContextFailureBanner reason={guide.contextFailure.reason} onRetry={onRetryContext} busy={write?.kind === 'writing'} />
      ) : null}
      {guide.fallback ? <div className="gd-banner">{guide.fallback}</div> : null}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {said}
      </div>
      {write?.kind === 'error' ? <WriteStatus taskId={task.id} write={write} onRetry={onRewrite} /> : null}

      {group === null ? (
        <div className="gd-message">
          {onlyUncommitted ? 'Nothing uncommitted on this branch.' : 'No changes against the base.'}
        </div>
      ) : shownView === 'map' ? (
        <GuideMap
          worktreePath={task.worktreePath}
          diff={diff}
          groups={groups}
          marks={marks}
          current={file?.path ?? null}
          // The box or row pressed goes with the map: focus stays in the
          // guide, so its keys work at once, never on the page's body.
          onOpen={(key, path) => {
            setPlace((p) => ({ ...p, group: key, picked: { ...p.picked, [key]: path } }));
            showView('read');
            rootRef.current?.focus({ preventScroll: true });
          }}
          onOpenGroup={(key) => {
            setPlace((p) => ({ ...p, group: key }));
            showView('read');
            rootRef.current?.focus({ preventScroll: true });
          }}
        />
      ) : (
        <div className="gd-body">
          <section className="gd-left" aria-label="Group">
            <h2 className="gd-title">{group.title}</h2>
            <div className="gd-count-row">
              {group.setAside ? (
                <span className="gd-count" title="Set Aside is not in the guide’s count of groups to review">
                  Not counted
                </span>
              ) : (
                <span className="gd-count">
                  {pad2(at + 1)} / {pad2(led.length)}
                </span>
              )}
              <label className="gd-check" title="Mark the group reviewed (⇧⌘R)">
                <input
                  type="checkbox"
                  checked={isGroupReviewed(group)}
                  onChange={() => toggleGroup(group)}
                  aria-keyshortcuts="Meta+Shift+R"
                />
                Reviewed
              </label>
              {groupChanged(group) > 0 ? (
                <span className="gd-changed" title="This group has new code since your previous copy">
                  changed
                </span>
              ) : null}
              {groupChanged(group) > 0 && reviewedBefore(group) ? (
                <span className="gd-reviewed-before">
                  Reviewed before · {groupChanged(group)} {groupChanged(group) === 1 ? 'file' : 'files'} changed
                </span>
              ) : null}
              {led.length === 0 ? (
                // Every file set aside (#295 review): nothing the guide counts.
                <span className="gd-none-to-review">{NOTHING_TO_REVIEW}</span>
              ) : reviewedCount === led.length ? (
                <span className="gd-all-done">
                  All {led.length} {led.length === 1 ? 'group' : 'groups'} reviewed
                </span>
              ) : null}
            </div>
            {group.summary ? <p className="gd-summary">{group.summary}</p> : null}
            <CarefulHead files={group.files} onPick={pickFile} />
            <ul className="gd-files" aria-label="Files in this group">
              {group.files.map((f) => {
                const { name, dir } = splitPath(f.path);
                const done = isFileReviewed(f);
                return (
                  <li key={f.path}>
                    <button
                      type="button"
                      className="gd-file"
                      aria-current={f === file ? 'true' : undefined}
                      data-reviewed={done || undefined}
                      onClick={() => pickFile(f.path)}
                      title={f.path}
                    >
                      <span className="gd-file-mark" aria-hidden="true">
                        {done ? '✓' : ''}
                      </span>
                      {/* The name keeps its room: the parts after it give way first (#264). */}
                      <span className="gd-file-name">
                        <span className="gd-file-base">{name}</span>
                        {f.blocks.length < f.totalBlocks ? (
                          <span className="gd-file-part">
                            {' '}
                            · {f.blocks.length} of {f.totalBlocks} blocks
                          </span>
                        ) : null}
                        {changedSinceReview(f) ? <span className="gd-file-part"> · changed since review</span> : null}
                      </span>
                      <span className="gd-file-dir">{dir}</span>
                      <RowCounts file={f} comments={fileComments(group, f)} />
                      {f.careful ? <CarefulLine mark={f.careful} /> : null}
                      {/* The note's gist, one short line (#264); the note itself
                          is under the diff's header. While it is being written, a
                          placeholder its size (#224). A guide from before #264 has no
                          line: nothing here, never the long note cut down. */}
                      {group.setAside ? (
                        <AsideLine pattern={focus ? firstMatch(focus.setAside, f.path) : null} />
                      ) : f.line ? (
                        <span className="gd-file-line" title={f.line}>
                          {f.line}
                        </span>
                      ) : f.notable && notesState === 'pending' ? (
                        <span className="gd-file-line gd-file-line-pending" aria-hidden="true" data-testid="note-pending" />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
            {notesState === 'failed' && groupIndex !== null ? (
              <p className="gd-notes-failed">
                Notes could not be written.{' '}
                <button type="button" className="gd-link" onClick={() => retryNotes(task.id, guide.writtenAt, groupIndex)}>
                  Retry
                </button>
              </p>
            ) : null}
            <div className="gd-nav">
              <button type="button" className="gd-btn" onClick={() => stepGroup(-1)} disabled={at === 0} title="Previous group (⌥↑)">
                ‹ Previous
              </button>
              <button
                type="button"
                className="gd-btn"
                onClick={() => stepGroup(1)}
                disabled={at >= groups.length - 1}
                title="Next group (⌥↓)"
              >
                Next ›
              </button>
              <span className="gd-nav-hint">⌥⏎ Reviewed and Next</span>
            </div>
          </section>

          <nav className="gd-rail" aria-label="Groups">
            {/* No count when there is nothing to count (#295 review): every file set aside. */}
            {led.length > 0 ? (
              <p className="gd-rail-count" title={`${reviewedCount} of ${led.length} groups reviewed`}>
                <span aria-hidden="true">
                  {reviewedCount}
                  <span className="gd-rail-of">/{led.length}</span>
                </span>
                <span className="sr-only">
                  {reviewedCount} of {led.length} groups reviewed
                </span>
              </p>
            ) : null}
            <div className="gd-rail-marks">
              {groups.map((g, i) => (
                <button
                  key={g.key}
                  type="button"
                  className="gd-rail-mark"
                  aria-current={i === at ? 'true' : undefined}
                  data-reviewed={isGroupReviewed(g) || undefined}
                  data-unsorted={g.unsorted || undefined}
                  data-aside={g.setAside || undefined}
                  data-comments={tallyTotal(groupComments(marks, g.key)) > 0 || undefined}
                  data-changed={groupChanged(g) > 0 || undefined}
                  onClick={() => goTo(i, false)}
                  aria-label={`${g.setAside ? '' : `${pad2(i + 1)} `}${g.title}${isGroupReviewed(g) ? ', reviewed' : ''}${groupChanged(g) > 0 ? ', changed' : ''}${commentsSaid(groupComments(marks, g.key), ', ')}`}
                  title={`${g.setAside ? '' : `${pad2(i + 1)} `}${g.title}${isGroupReviewed(g) ? ' · Reviewed' : ''}${groupChanged(g) > 0 ? ' · changed' : ''}${commentsSaid(groupComments(marks, g.key), ' · ')}`}
                />
              ))}
            </div>
          </nav>

          <section className="gd-right" aria-label="Diff">
            {search.open && search.scope === 'all' ? (
              <AllGuideFiles groups={groups} diff={diff} searched={searched} onOpen={openHit} {...searchBar} />
            ) : null}
            {/* Kept mounted and laid out under All Guide Files, only covered:
                a comment being written in it, its layout, Whole File and
                scroll all stay (display: none would measure it 0 wide and
                turn a split diff unified, remounting every row). */}
            {file ? (
              <GuideFileDiff
                covered={search.open && search.scope === 'all'}
                key={`${group.key}:${file.path}`}
                task={task}
                diff={diff}
                fresh={fresh}
                fromMergeBase={loaded.fromMergeBase}
                baseSettled={baseSettled}
                file={file}
                reviewed={isFileReviewed(file)}
                commentCount={group ? fileComments(group, file) : NO_COMMENTS}
                onToggleReviewed={() => toggleFile(file)}
                search={search.open ? search : null}
                searched={searched}
                searchBar={searchBar}
                onCurrent={(key) => setSearch((s) => ({ ...s, current: { path: file.path, key } }))}
              />
            ) : null}
          </section>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Review carefully and Set Aside (#295)
// ---------------------------------------------------------------------------

const NOTHING_TO_REVIEW = 'Nothing to review: every file is set aside';

/** The full reason, for a tooltip: both sources when there are two. */
function carefulTitle(m: CarefulMark): string {
  return `Review carefully: ${carefulWhy(m)}${m.reason && m.pattern ? ` (also matches ${m.pattern})` : ''}`;
}

/** The reason in words: the writer's line, or the pattern in mono. */
function CarefulWords({ mark }: { mark: CarefulMark }): ReactNode {
  if (mark.reason) return <>{mark.reason}</>;
  return (
    <>
      Matches <span className="gd-pattern">{mark.pattern}</span>
    </>
  );
}

/**
 * One note under the diff's header, Careful or Why (#397): at most two lines,
 * then Show All when it runs longer, which opens it in place as Show Less.
 * Whether it runs longer is measured, at the note's real width and again
 * whenever that changes; a note that fits has no button. A note starts closed:
 * the diff is keyed by group and file, so another file mounts a fresh one.
 * Open, it is held to 40vh and scrolls (guide.css), so the diff stays in reach.
 *
 * What is clipped depends on the band (guide.css): alone, the label and text
 * flow as one (`.gd-diff-why-flow`); with both notes, the text beside its
 * label column (`.gd-diff-why-body`). Only the clipped one has a height, the
 * other is inline or `display: contents`, so both are measured.
 */
function DiffNote({
  careful,
  name,
  title,
  label,
  children,
}: {
  careful?: boolean;
  name: string;
  title?: string;
  label: ReactNode;
  children: ReactNode;
}): ReactNode {
  const ref = useRef<HTMLParagraphElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [longer, setLonger] = useState(false);
  // The button had focus when it was found no longer needed (Show Less on a
  // note that now fits, or a wider pane): focus goes to the note, not the page.
  const refocus = useRef(false);
  // Open, nothing is clipped to measure: it ran longer when it was opened.
  const measure = useCallback(() => {
    const p = ref.current;
    if (!p || open) return;
    const clipped = [p.querySelector('.gd-diff-why-flow'), p.querySelector('.gd-diff-why-body')];
    const next = clipped.some((el) => el !== null && el.scrollHeight > el.clientHeight + 1);
    if (!next && button.current !== null && document.activeElement === button.current) refocus.current = true;
    setLonger(next);
  }, [open]);
  // Every render: the text, the band's layout or the theme may have changed.
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    if (longer || !refocus.current) return;
    refocus.current = false;
    ref.current?.focus({ preventScroll: true });
  }, [longer]);
  useEffect(() => {
    const p = ref.current;
    if (!p || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(p);
    return () => ro.disconnect();
  }, [measure]);
  const action = open ? 'Show Less' : 'Show All';
  return (
    <p className="gd-diff-why-text" data-careful={careful ? 'true' : undefined} data-clamped={open ? undefined : 'true'} tabIndex={-1} ref={ref}>
      {/* The tooltip on the text only: not on Show All. */}
      <span className="gd-diff-why-flow" title={title}>
        <span className="gd-diff-why-label">{label}</span>
        <span className="gd-diff-why-body">{children}</span>
      </span>
      {longer ? (
        <button ref={button} type="button" className="gd-link gd-diff-why-more" aria-expanded={open} aria-label={`${action} of ${name}`} onClick={() => setOpen((o) => !o)}>
          {action}
        </button>
      ) : null}
    </p>
  );
}

/** A careful file's line in its group's list: the flag and why, in --warn. */
function CarefulLine({ mark }: { mark: CarefulMark }): ReactNode {
  return (
    <span className="gd-file-careful" title={carefulTitle(mark)}>
      <FlagIcon className="gd-careful-icon" />
      <span>
        <span className="sr-only">Review carefully: </span>
        <CarefulWords mark={mark} />
      </span>
    </span>
  );
}

/** A set-aside file's line: the pattern that set it aside, where a note's gist goes. */
function AsideLine({ pattern }: { pattern: string | null }): ReactNode {
  if (!pattern) return null;
  return (
    <span className="gd-file-line" title={`Set aside: matches ${pattern}`}>
      Matches <span className="gd-pattern">{pattern}</span>
    </span>
  );
}

/** At the top of a group: its careful files by name, each opening it. Names only: the reasons are in the rows. */
function CarefulHead({ files, onPick }: { files: readonly GroupFile[]; onPick: (path: string) => void }): ReactNode {
  const careful = files.filter((f) => f.careful !== null);
  if (careful.length === 0) return null;
  return (
    <p className="gd-careful-head">
      <FlagIcon className="gd-careful-icon" />
      <span className="gd-careful-head-label">Review carefully:</span>
      {/* One item, so a second line hangs under the first name, not the flag. */}
      <span className="gd-careful-names">
        {careful.map((f) => (
          <button key={f.path} type="button" className="gd-link" onClick={() => onPick(f.path)} title={`${f.path}: ${carefulWhy(f.careful!)}`}>
            {splitPath(f.path).name}
          </button>
        ))}
      </span>
    </p>
  );
}

/**
 * The next group still to review after `at`, wrapping to any skipped before
 * it; null when every other group is done. Pure.
 */
export function nextToReview<T>(groups: readonly T[], at: number, done: (g: T) => boolean): number | null {
  for (let k = 1; k < groups.length; k++) {
    const i = (at + k) % groups.length;
    if (!done(groups[i]!)) return i;
  }
  return null;
}

// ---------------------------------------------------------------------------
// One file's diff, this group's blocks only
// ---------------------------------------------------------------------------

/** The file's diff restricted to `blocks`, or all of it. Pure. */
export function restrictDiff(full: FileDiff, file: GuideFile, blocks: readonly string[], whole: boolean): FileDiff {
  if (whole) return full;
  const keep = new Set(blocks);
  return { ...full, hunks: full.hunks.filter((_, i) => keep.has(file.blocks[i] ?? '')) };
}

const NO_MATCHES: never[] = [];

function GuideFileDiff({
  task,
  diff,
  fresh,
  fromMergeBase,
  baseSettled,
  file,
  reviewed,
  commentCount,
  onToggleReviewed,
  search,
  searchBar,
  onCurrent,
  covered,
  searched,
}: {
  task: Task;
  diff: BranchDiff;
  fresh: boolean;
  /** #402: the old side is a merge base, not HEAD standing in for one. */
  fromMergeBase: boolean;
  baseSettled: boolean;
  file: GroupFile;
  reviewed: boolean;
  commentCount: CommentTally;
  onToggleReviewed: () => void;
  /** The guide's search while it is open (#413); This File's is drawn here. */
  search: GuideSearchState | null;
  searchBar: SearchBarProps;
  /** Another match of This File is the current one. */
  onCurrent: (key: string) => void;
  /** All Guide Files is over it. */
  covered: boolean;
  /** The text searched, once typing pauses. */
  searched: string;
}): ReactNode {
  const [whole, setWhole] = useState(false);
  const openFile = useOpenFile();
  const full = diff.files.find((f) => f.path === file.path) ?? null;
  const result = full?.result ?? null;
  const newText = result && result.kind === 'diff' && result.change !== 'deleted' ? result.newText : null;
  // Comments on removed lines (#402) point at the base, the old side: only a
  // merge base, never HEAD standing in for one.
  const oldText = fromMergeBase && result && result.kind === 'diff' && result.change !== 'added' ? result.oldText : null;
  const comments = useDiffComments(task.id, file.path, newText, false, fresh, task, oldText, baseSettled);
  const { name, dir } = splitPath(file.path);
  const split = file.blocks.length < file.totalBlocks;
  // A stat-only file is one block standing for all of its hunks: it shows whole.
  const statBlock = file.blocks.some((id) => diff.blocks.get(id)?.hunk === null);
  const shown = useMemo(
    () => (full && result?.kind === 'diff' ? restrictDiff(result.diff, full, file.blocks, whole || statBlock) : null),
    [full, result, file.blocks, whole, statBlock],
  );
  // The diff's layout, toggled from this header (#264): the same rule the
  // diff's own header uses, measured on the scroll it is drawn in.
  const layout = useDiffLayout();
  const hasLines = shown !== null && shown.hunks.length > 0;
  // A new or deleted file is one column, whatever the toggle says (#337): judged
  // on the whole file, so one group's slice of an edit is never mistaken for it.
  const oneSided = useMemo(() => (result?.kind === 'diff' ? isOneSided(result.diff) : false), [result]);

  // This File (#413): what the diff shows, searched as it draws it.
  const query = search?.scope === 'file' ? searched : '';
  // Split only for a search, and once per read of the branch (search.ts).
  const searching = query !== '';
  const sources = useMemo(() => (searching && result?.kind === 'diff' ? linesOf(result) : null), [searching, result]);
  // Made once here, and handed to the diff to draw.
  const found = useMemo(() => (query !== '' && shown && sources ? searchDiff(shown, sources, query) : null), [query, shown, sources]);
  const matches = found?.matches ?? NO_MATCHES;
  const picked = search?.current?.path === file.path ? search.current.key : null;
  const index = Math.max(0, matches.findIndex((m) => m.key === picked));
  const currentKey = matches[index]?.key ?? null;
  // The view follows the current match.
  const scrollRef = layout.ref;
  useEffect(() => {
    if (currentKey === null) return;
    scrollRef.current?.querySelector('.tx-d-hit-cur')?.scrollIntoView?.({ block: 'center', inline: 'nearest' });
  }, [currentKey, query, scrollRef]);
  const searchCount =
    query === '' ? '' : matches.length === 0 ? 'No matches' : `${index + 1} of ${matches.length}${found?.capped ? '+' : ''}`;
  // Closing the search keeps the line it was on (the diff keeps it drawn):
  // the view stays on it, though the lines around other matches fold away.
  const lastFound = useRef<{ side: string; line: number } | null>(null);
  const open = search !== null;
  useEffect(() => {
    if (open) {
      const m = matches[index];
      lastFound.current = m ? { side: m.side, line: m.line } : null;
      return;
    }
    const at = lastFound.current;
    lastFound.current = null;
    if (!at || typeof requestAnimationFrame === 'undefined') return;
    requestAnimationFrame(() =>
      scrollRef.current
        ?.querySelector(`[data-${at.side}-line="${at.line}"]`)
        ?.scrollIntoView?.({ block: 'center', inline: 'nearest' }),
    );
  }, [open, matches, index, scrollRef]);

  return (
    <div className="gd-diff" data-covered={covered || undefined} inert={covered} aria-hidden={covered || undefined}>
      <div className="gd-diff-head">
        <FileIcon path={file.path} />
        <span className="gd-diff-name">{name}</span>
        <span className="gd-diff-dir">{dir}</span>
        <Counts file={file} />
        <CommentCount tally={commentCount} />
        {/* Everything that acts on the file together at the end (#320): the
            layout toggle sat by the size, so a short path left a gap between
            it and Open that read as two unrelated groups. */}
        <span className="gd-diff-gap" />
        {hasLines && !oneSided ? (
          <button
            type="button"
            className="gd-link gd-diff-layout"
            onClick={layout.toggle}
            aria-label={`${layoutToggleLabel(layout.resolved)} View`}
            title={layout.resolved === 'split' ? 'Show the diff unified' : 'Show the diff side by side'}
          >
            {layoutToggleLabel(layout.resolved)}
          </button>
        ) : null}
        {split ? (
          <button type="button" className="gd-link" onClick={() => setWhole((w) => !w)} aria-pressed={whole}>
            {whole ? `Only This Group’s ${file.blocks.length} of ${file.totalBlocks}` : `Whole File (${file.totalBlocks} blocks)`}
          </button>
        ) : null}
        <button type="button" className="gd-link" onClick={() => openFile({ path: file.path })} title="Open the file in the editor">
          Open
        </button>
        <label className="gd-check gd-diff-check" title="Mark this file reviewed (⌘R)">
          <input type="checkbox" checked={reviewed} onChange={onToggleReviewed} aria-keyshortcuts="Meta+R" />
          Reviewed
        </label>
      </div>
      {search?.scope === 'file' ? (
        <SearchBar
          {...searchBar}
          count={searchCount}
          hint="↩ next · ⇧↩ previous · Esc closes"
          onKeys={(e) => {
            if (e.key !== 'Enter' || e.metaKey || e.altKey || e.ctrlKey) return;
            e.preventDefault();
            // The matches are of the text before the last keys: wait for these.
            if (searchBar.query !== searched) return;
            const n = matches.length;
            if (n === 0) return;
            onCurrent(matches[(index + (e.shiftKey ? -1 : 1) + n) % n]!.key);
          }}
        />
      ) : null}
      {/* Why the file changes in this group (#224), under its header (#264):
          outside the scroll, so it stays with the header as the diff scrolls. */}
      {file.note || file.careful ? (
        // Both notes: one label column, so their texts start at one x (#295 review).
        <div className="gd-diff-why" data-both={file.note && file.careful ? true : undefined}>
          {file.careful ? (
            <DiffNote
              careful
              name="Careful"
              title={carefulTitle(file.careful)}
              label={
                <>
                  <FlagIcon className="gd-careful-icon" />
                  Careful
                </>
              }
            >
              <CarefulWords mark={file.careful} />
            </DiffNote>
          ) : null}
          {file.note ? (
            <DiffNote name="Why" label="Why">
              {file.note}
            </DiffNote>
          ) : null}
        </div>
      ) : null}
      {comments.notice ? (
        <div className="gd-banner">
          <span>{comments.notice}</span>
          <button type="button" className="gd-btn" onClick={comments.clearNotice}>
            OK
          </button>
        </div>
      ) : null}
      {comments.bar}
      <div className="gd-diff-scroll" ref={layout.ref}>
        {/* A reviewed file shows its diff like any other (#228): the ticked
            box above and the rail say it is reviewed. */}
        {result === null ? (
          <div className="gd-message">This file is no longer in the change.</div>
        ) : result.kind === 'binary' ? (
          <div className="gd-message">Binary file. No text diff to show.</div>
        ) : result.kind === 'too-large' ? (
          <div className="gd-message">
            Too large to diff here ({(result.bytes / 1_000_000).toFixed(1)} MB).
          </div>
        ) : result.kind === 'diff' && shown ? (
          shown.hunks.length === 0 ? (
            <div className="gd-message">No line changes{result.change === 'renamed' ? ': renamed only' : ''}.</div>
          ) : (
            <DiffAnnotationsContext.Provider value={comments.annotations}>
              <Diff
                key={`${file.path}:${whole}`}
                diff={shown}
                layout={oneSided ? 'unified' : layout.resolved}
                head={false}
                expand={{ oldText: result.oldText, newText: result.newText }}
                absoluteLines={result.change !== 'deleted'}
                contextPath={null}
                showPath={false}
                // Not null while the bar is open, even empty or on All
                // Guide Files: null is a close, which keeps the found line.
                search={search ? { result: found ?? NO_SEARCH, current: currentKey } : null}
              />
            </DiffAnnotationsContext.Provider>
          )
        ) : (
          <div className="gd-message">Nothing to show for this file.</div>
        )}
      </div>
    </div>
  );
}
