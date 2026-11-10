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
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { FileDiff, Task } from '../types';
import { loadBranchDiff, type LoadedBranchDiff } from './branchDiff';
import type { BranchDiff, GuideFile } from './blocks';
import { commentMarks, groupCommentCount, useOpenComments } from './commentMarks';
import { useWaitingCodeComments } from '../ui/transcript/codeComments';
import { useComments } from '../ui/transcript/drafts';
import { sendWaitingComments } from '../ui/transcript/composerBridge';
import { useQueuedCi } from '../ui/transcript/ciFailure';
import { carefulWhy, viewGuide, type CarefulMark, type GroupFile, type GroupView, type Guide } from './validate';
import { asFocus, firstMatch, projectFocus, type GuideFocus } from './focus';
import { chosenFocus, draftOf, GuideOptions, useTaskProject } from './GuideOptions';
import { FlagIcon } from '../ui/icons';
import '../ui/worktree.css';
import { useMeasuredBase } from '../ui/useMeasuredBase';
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
import OverflowMenu from '../ui/OverflowMenu';
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
  }, [task.id, task.worktreePath, measuredBase, active, again]);

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
  const writeNow = (focus: GuideFocus) => {
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
      .then((d) => {
        const run = startWrite(id, d, base, focus);
        startingRef.current = false;
        setStarting(false);
        return run;
      });
  };

  // What the guide was written with; a guide from before #295 rewrites with the project's.
  const guideFocus = guide ? (asFocus(guide.focus) ?? defaults) : defaults;
  // Rewrite With Other Options… is open (#295): a draft over a written guide.
  // Kept in the store, so a task switch (the pane remounts) comes back to it.
  const editing = guide !== null && focusDraftOf(task.id) !== null;
  if (guide === null || editing) {
    const start = guide === null ? defaults : guideFocus;
    return (
      <GuideIntro
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
      />
    );
  }
  return (
    <GuideBody
      key={`${task.id}:${guide.writtenAt}`}
      task={task}
      guide={guide}
      loaded={load.data}
      fresh={load.remembered !== true}
      write={write}
      onRewrite={() => writeNow(guideFocus)}
      onEditOptions={() => {
        // Never over a draft already typed.
        if (focusDraftOf(task.id) === null) setFocusDraft(task.id, draftOf(guideFocus));
      }}
      active={active}
    />
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

function GuideIntro({
  task,
  diff,
  write,
  onWrite,
  onCancel,
  active,
  options,
}: {
  task: Task;
  diff: BranchDiff;
  write: WriteState | null;
  onWrite: () => void;
  /** Rewriting with other options (#295): back to the guide, nothing written. */
  onCancel?: () => void;
  active: boolean;
  /** The lists to set aside and mark (#295). */
  options: ReactNode;
}): ReactNode {
  const empty = diff.order.length === 0;
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
        Written by Claude Haiku in a separate, one-time run with no tools. This task’s session is not touched.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The guide
// ---------------------------------------------------------------------------

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
function RowCounts({ file, comments }: { file: GroupFile; comments: number }): ReactNode {
  if (file.stat === 'binary' || file.stat === 'too-large') {
    return (
      <span className="gd-file-counts">
        <CommentCount n={comments} />
        <span className="gd-counts gd-counts-wide">{file.stat === 'binary' ? 'Binary' : 'Too large'}</span>
      </span>
    );
  }
  return (
    <span className="gd-file-counts">
      {comments > 0 ? <CommentCount n={comments} /> : <span />}
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
  task,
  guide,
  loaded,
  fresh,
  write,
  onRewrite,
  onEditOptions,
  active,
}: {
  task: Task;
  guide: Guide;
  loaded: LoadedBranchDiff;
  /** The read is this visit's, not a remembered one (#222: auto-resolve). */
  fresh: boolean;
  write: WriteState | null;
  onRewrite: () => void;
  /** Rewrite With Other Options… (#295). */
  onEditOptions: () => void;
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

  // Every comment waiting to go with the next message, the composer's queue:
  // on code (this guide, the editor, diffs) and on transcript passages (#254).
  const commentCount = useWaitingCodeComments(task.id).length + useComments(task.id).length;
  // And a PR's failing checks, queued for Claude like a comment (#280).
  const ciWaiting = useQueuedCi(task.id) !== null;
  const waitingCount = commentCount + (ciWaiting ? 1 : 0);
  // The transcript is shown after (#254): where it lands, sent or held.
  const sendComments = () => void sendWaitingComments(task.id);
  const commentsWord = `${commentCount} ${commentCount === 1 ? 'Comment' : 'Comments'}`;
  const sendButton =
    waitingCount > 0 ? (
      <button
        type="button"
        className={view.stale ? 'gd-btn' : 'gd-btn gd-btn-primary'}
        onClick={sendComments}
        aria-keyshortcuts="Meta+Enter"
        title="Send everything waiting to Claude now, and show the transcript (⌘↩). What you're typing in the message box stays there."
      >
        Send {ciWaiting ? (commentCount > 0 ? `CI Failure + ${commentsWord}` : 'CI Failure') : commentsWord}
      </button>
    ) : null;

  // Where the open comments are (#252), so one left on a file is found again here.
  const openComments = useOpenComments(task.id);
  const marks = useMemo(() => commentMarks(groups, diff, openComments), [groups, diff, openComments]);
  const fileComments = (g: GroupView, f: GroupFile) => marks.get(g.key)?.get(f.path) ?? 0;

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

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, select, [contenteditable="true"]')) return;
    // ⌘⏎: Send Comments (#256). A comment box is a textarea, returned above,
    // so there ⌘⏎ still saves the comment and never sends.
    if (e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && (e.code === 'Enter' || e.code === 'NumpadEnter')) {
      if (waitingCount === 0) return;
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
    <div className="gd" ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown} aria-label="Review Guide">
      {/* One row, one Rewrite (#197): a guide the branch has moved on from
          says so here, on the banner's ground, rather than in a second row
          with a second button. */}
      <div className="gd-meta" ref={metaRef} data-stale={view.stale || undefined}>
        {/* Out of date, what matters leads: a narrow pane cuts from the end,
            so the base goes before the news does. Only the text is a live
            region, never the controls beside it. */}
        {view.stale ? (
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
        {/* Out of date, Rewrite leads and Send Comments waits beside it;
            otherwise comments waiting make Send the row's action (#254). */}
        {view.stale ? sendButton : null}
        <button
          type="button"
          // The one thing to do about an out-of-date guide: the primary action then.
          className={view.stale ? 'gd-btn gd-btn-primary' : 'gd-btn'}
          onClick={onRewrite}
          disabled={write?.kind === 'writing'}
          title="Ask Claude Haiku for a new guide of the branch as it is now"
        >
          {write?.kind === 'writing' ? 'Rewriting…' : 'Rewrite'}
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
          ]}
        />
      </div>
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
              <label className="gd-check">
                <input type="checkbox" checked={isGroupReviewed(group)} onChange={() => toggleGroup(group)} />
                Reviewed
              </label>
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
                  data-comments={groupCommentCount(marks, g.key) > 0 || undefined}
                  onClick={() => goTo(i, false)}
                  aria-label={`${g.setAside ? '' : `${pad2(i + 1)} `}${g.title}${isGroupReviewed(g) ? ', reviewed' : ''}${commentsSaid(groupCommentCount(marks, g.key), ', ')}`}
                  title={`${g.setAside ? '' : `${pad2(i + 1)} `}${g.title}${isGroupReviewed(g) ? ' · Reviewed' : ''}${commentsSaid(groupCommentCount(marks, g.key), ' · ')}`}
                />
              ))}
            </div>
          </nav>

          <section className="gd-right" aria-label="Diff">
            {file ? (
              <GuideFileDiff
                key={`${group.key}:${file.path}`}
                task={task}
                diff={diff}
                fresh={fresh}
                file={file}
                reviewed={isFileReviewed(file)}
                commentCount={group ? fileComments(group, file) : 0}
                onToggleReviewed={() => toggleFile(file)}
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

function GuideFileDiff({
  task,
  diff,
  fresh,
  file,
  reviewed,
  commentCount,
  onToggleReviewed,
}: {
  task: Task;
  diff: BranchDiff;
  fresh: boolean;
  file: GroupFile;
  reviewed: boolean;
  commentCount: number;
  onToggleReviewed: () => void;
}): ReactNode {
  const [whole, setWhole] = useState(false);
  const openFile = useOpenFile();
  const full = diff.files.find((f) => f.path === file.path) ?? null;
  const result = full?.result ?? null;
  const newText = result && result.kind === 'diff' && result.change !== 'deleted' ? result.newText : null;
  const comments = useDiffComments(task.id, file.path, newText, false, fresh, task);
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

  return (
    <div className="gd-diff">
      <div className="gd-diff-head">
        <FileIcon path={file.path} />
        <span className="gd-diff-name">{name}</span>
        <span className="gd-diff-dir">{dir}</span>
        <Counts file={file} />
        <CommentCount n={commentCount} />
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
        <label className="gd-check gd-diff-check">
          <input type="checkbox" checked={reviewed} onChange={onToggleReviewed} />
          Reviewed
        </label>
      </div>
      {/* Why the file changes in this group (#224), under its header (#264):
          outside the scroll, so it stays with the header as the diff scrolls. */}
      {file.note || file.careful ? (
        // Both notes: one label column, so their texts start at one x (#295 review).
        <div className="gd-diff-why" data-both={file.note && file.careful ? true : undefined}>
          {file.careful ? (
            <p className="gd-diff-why-text" data-careful="true" title={carefulTitle(file.careful)}>
              <span className="gd-diff-why-label">
                <FlagIcon className="gd-careful-icon" />
                Careful
              </span>
              <span className="gd-diff-why-body">
                <CarefulWords mark={file.careful} />
              </span>
            </p>
          ) : null}
          {file.note ? (
            <p className="gd-diff-why-text">
              <span className="gd-diff-why-label">Why</span>
              <span className="gd-diff-why-body">{file.note}</span>
            </p>
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
