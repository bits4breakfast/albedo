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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { FileDiff, Task } from '../types';
import { loadBranchDiff, type LoadedBranchDiff } from './branchDiff';
import type { BranchDiff, GuideFile } from './blocks';
import { viewGuide, type GroupFile, type GroupView, type Guide } from './validate';
import {
  clearWriteError,
  keepLastRead,
  keepPlace,
  lastReadOf,
  loadGuide,
  loadReviewed,
  placeOf,
  reviewedKey,
  setReviewed,
  startWrite,
  useGuideStoreVersion,
  writeStateOf,
  type WriteState,
} from './store';
import { Diff, DiffAnnotationsContext } from '../ui/transcript/Diff';
import { useDiffComments } from '../ui/editor/diffComments';
import { useOpenFile } from '../ui/editor/openFile';
import { relativeTime } from '../ui/TaskList';
import { FileIcon } from '../ui/fileIcons';
import { takeGuideFocus, useGuideFocusRequests } from './openGuide';
import './guide.css';

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
  // Coming back to a task (#199): its last read shows at once, and is read
  // again behind it, as on every return to the tab.
  const [read, setLoad] = useState<Load>(() => {
    const last = lastReadOf(task.id);
    return last ? { kind: 'ready', data: last, taskId: task.id, remembered: true } : { kind: 'loading' };
  });
  const [again, setAgain] = useState(0);
  /** Write or Rewrite was pressed and the branch is being read again first. */
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);

  useEffect(() => {
    if (!active) return;
    let live = true;
    const id = task.id;
    setLoad((prev) => (prev.kind === 'ready' && prev.taskId === id ? prev : { kind: 'loading' }));
    loadBranchDiff(task.worktreePath, task.baseBranch, (rel) => readWorking(task.worktreePath, rel))
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
  }, [task.id, task.worktreePath, task.baseBranch, active, again]);

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

  const { diff } = load.data;
  const writeNow = () => {
    if (startingRef.current || stored?.kind === 'writing') return;
    startingRef.current = true;
    setStarting(true);
    // A guide is written for the branch as it is now, not as the pane last
    // read it (that read may be from an earlier visit, #199). The result is
    // saved for this task even if another is on screen when it lands.
    const id = task.id;
    const base = task.baseBranch;
    void loadBranchDiff(task.worktreePath, base, (rel) => readWorking(task.worktreePath, rel))
      .then((fresh) => {
        keepLastRead(id, fresh);
        setLoad({ kind: 'ready', data: fresh, taskId: id });
        return fresh.diff;
      })
      // The branch cannot be read just now: write for what is on screen.
      .catch(() => diff)
      .then((d) => {
        const run = startWrite(id, d, base);
        startingRef.current = false;
        setStarting(false);
        return run;
      });
  };

  if (guide === null) {
    return <GuideIntro task={task} diff={diff} write={write} onWrite={writeNow} active={active} />;
  }
  return (
    <GuideBody
      key={`${task.id}:${guide.writtenAt}`}
      task={task}
      guide={guide}
      loaded={load.data}
      fresh={load.remembered !== true}
      write={write}
      onRewrite={writeNow}
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
  active,
}: {
  task: Task;
  diff: BranchDiff;
  write: WriteState | null;
  onWrite: () => void;
  active: boolean;
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
      {write === null ? (
        <button type="button" ref={writeRef} className="gd-btn gd-btn-primary" onClick={onWrite} disabled={empty}>
          Write Guide
        </button>
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

function GuideBody({
  task,
  guide,
  loaded,
  fresh,
  write,
  onRewrite,
  active,
}: {
  task: Task;
  guide: Guide;
  loaded: LoadedBranchDiff;
  /** The read is this visit's, not a remembered one (#222: auto-resolve). */
  fresh: boolean;
  write: WriteState | null;
  onRewrite: () => void;
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

  const reviewed = loadReviewed(task.id);
  const isFileReviewed = (f: GroupFile) => reviewed.has(reviewedKey(f.path, f.blocks));
  const isGroupReviewed = (g: GroupView) => g.files.length > 0 && g.files.every(isFileReviewed);

  // The group is kept by its key, never its number: Uncommitted Only changes
  // the numbers. With no place kept, the first group still to review.
  const [place, setPlace] = useState(() => {
    const kept = placeOf(task.id, guide.writtenAt);
    if (kept) return kept;
    const next = groups.find((g) => !isGroupReviewed(g)) ?? groups[0] ?? null;
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
  const reviewedCount = groups.filter(isGroupReviewed).length;

  // The keys work once focus is in the guide. Take it when the tab comes on
  // screen, but never from someone typing (a guide finishing in the
  // background must not pull focus out of the message box or the terminal)
  // -- unless ⇧⌘G asked for it (#217).
  const rootRef = useRef<HTMLDivElement>(null);
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
    const i = nextToReview(groups, at, (g) => !g.files.some(unread));
    if (i === null) {
      setSaid(`All ${groups.length} groups reviewed`);
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
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
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
      <div className="gd-meta" data-stale={view.stale || undefined}>
        {/* Out of date, what matters leads: a narrow pane cuts from the end,
            so the base goes before the news does. Only the text is a live
            region, never the controls beside it. */}
        {view.stale ? (
          <span
            className="gd-meta-text"
            role="status"
            title={`${changed} changed since this guide was written (${new Date(guide.writtenAt).toLocaleString()}). New changes are under Unsorted. Branch vs ${guide.base}.`}
          >
            {changed} changed since it was written {writtenAgo(guide.writtenAt)} · new changes are under Unsorted · branch vs{' '}
            {guide.base}
          </span>
        ) : (
          <span className="gd-meta-text" title={new Date(guide.writtenAt).toLocaleString()}>
            Written {writtenAgo(guide.writtenAt)} · branch vs {guide.base}
          </span>
        )}
        <label className="gd-filter">
          <input type="checkbox" checked={onlyUncommitted} onChange={(e) => setOnlyUncommitted(e.target.checked)} />
          Uncommitted Only
        </label>
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
      ) : (
        <div className="gd-body">
          <section className="gd-left" aria-label="Group">
            <h2 className="gd-title">{group.title}</h2>
            <div className="gd-count-row">
              <span className="gd-count">
                {pad2(at + 1)} / {pad2(groups.length)}
              </span>
              <label className="gd-check">
                <input type="checkbox" checked={isGroupReviewed(group)} onChange={() => toggleGroup(group)} />
                Reviewed
              </label>
              {reviewedCount === groups.length ? (
                <span className="gd-all-done">
                  All {groups.length} {groups.length === 1 ? 'group' : 'groups'} reviewed
                </span>
              ) : null}
            </div>
            {group.summary ? <p className="gd-summary">{group.summary}</p> : null}
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
                      <FileIcon path={f.path} />
                      <span className="gd-file-name">
                        {name}
                        {f.blocks.length < f.totalBlocks ? (
                          <span className="gd-file-part">
                            {' '}
                            · {f.blocks.length} of {f.totalBlocks} blocks
                          </span>
                        ) : null}
                      </span>
                      <span className="gd-file-dir">{dir}</span>
                      <Counts file={f} />
                      {/* What the file does in this group (#202), under its name. */}
                      {f.note ? <span className="gd-file-note">{f.note}</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
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
            <p className="gd-rail-count" title={`${reviewedCount} of ${groups.length} groups reviewed`}>
              <span aria-hidden="true">
                {reviewedCount}
                <span className="gd-rail-of">/{groups.length}</span>
              </span>
              <span className="sr-only">
                {reviewedCount} of {groups.length} groups reviewed
              </span>
            </p>
            <div className="gd-rail-marks">
              {groups.map((g, i) => (
                <button
                  key={g.key}
                  type="button"
                  className="gd-rail-mark"
                  aria-current={i === at ? 'true' : undefined}
                  data-reviewed={isGroupReviewed(g) || undefined}
                  data-unsorted={g.unsorted || undefined}
                  onClick={() => goTo(i, false)}
                  aria-label={`${pad2(i + 1)} ${g.title}${isGroupReviewed(g) ? ', reviewed' : ''}`}
                  title={`${pad2(i + 1)} ${g.title}${isGroupReviewed(g) ? ' · Reviewed' : ''}`}
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
                onToggleReviewed={() => toggleFile(file)}
              />
            ) : null}
          </section>
        </div>
      )}
    </div>
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
  onToggleReviewed,
}: {
  task: Task;
  diff: BranchDiff;
  fresh: boolean;
  file: GroupFile;
  reviewed: boolean;
  onToggleReviewed: () => void;
}): ReactNode {
  const [whole, setWhole] = useState(false);
  const [showAnyway, setShowAnyway] = useState(false);
  const openFile = useOpenFile();
  const full = diff.files.find((f) => f.path === file.path) ?? null;
  const result = full?.result ?? null;
  const newText = result && result.kind === 'diff' && result.change !== 'deleted' ? result.newText : null;
  const comments = useDiffComments(task.id, file.path, newText, false, fresh);
  const { name, dir } = splitPath(file.path);
  const split = file.blocks.length < file.totalBlocks;
  // A stat-only file is one block standing for all of its hunks: it shows whole.
  const statBlock = file.blocks.some((id) => diff.blocks.get(id)?.hunk === null);
  const shown = useMemo(
    () => (full && result?.kind === 'diff' ? restrictDiff(result.diff, full, file.blocks, whole || statBlock) : null),
    [full, result, file.blocks, whole, statBlock],
  );

  return (
    <div className="gd-diff">
      <div className="gd-diff-head">
        <FileIcon path={file.path} />
        <span className="gd-diff-name">{name}</span>
        <span className="gd-diff-dir">{dir}</span>
        <Counts file={file} />
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
      {comments.notice ? (
        <div className="gd-banner">
          <span>{comments.notice}</span>
          <button type="button" className="gd-btn" onClick={comments.clearNotice}>
            OK
          </button>
        </div>
      ) : null}
      {comments.bar}
      <div className="gd-diff-scroll">
        {reviewed && !showAnyway ? (
          <div className="gd-collapsed">
            Reviewed.
            <button type="button" className="gd-link" onClick={() => setShowAnyway(true)}>
              Show Diff
            </button>
          </div>
        ) : result === null ? (
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
