/**
 * NewTaskDialog — create a task, which means creating a git worktree.
 *
 * The dialog's job is to make the consequence visible *before* it happens: the
 * derived branch name and the full worktree path are shown live and read-only,
 * so the user knows exactly where the work will land. That matters more since
 * the location became a per-project choice, not a fixed `~/agents/...`. When
 * git refuses, git's own stderr is shown verbatim — never flattened into
 * "something went wrong".
 *
 * Owner: worktree workstream (M3).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, Task } from '../types';
import { createTask } from '../db';
import { listProjects } from '../db/projects';
import { nameTask } from '../git/slug';
import {
  GitError,
  composeWorktreePath,
  createWorktree,
  listBranches,
  undoCreateWorktree,
} from '../git/worktree';
import ProjectsDialog from './ProjectsDialog';
import { readLastProjectId, writeLastProjectId } from './projectPrefs';
import { loadDefaultModel, loadModelChoices, type ModelChoice } from '../capture/modelCatalog';
import { setTaskModel } from './taskModel';
import './worktree.css';

export interface NewTaskDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (t: Task) => void;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function NewTaskDialog({ open, onClose, onCreated }: NewTaskDialogProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [projectsOpen, setProjectsOpen] = useState(false);

  const [title, setTitle] = useState('');
  /** '' means the user's Claude Code default; anything else is passed as --model. */
  const [model, setModel] = useState('');
  const [modelChoices, setModelChoices] = useState<ModelChoice[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [baseBranch, setBaseBranch] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesBusy, setBranchesBusy] = useState(false);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const [home, setHome] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; kind: string } | null>(null);

  const titleRef = useRef<HTMLInputElement | null>(null);
  // Guards against a slow branch probe resolving after the user switched project.
  const probeSeq = useRef(0);

  const project = useMemo(
    () => projects.find((p) => p.id === projectId) ?? null,
    [projects, projectId],
  );

  // --- load projects ------------------------------------------------------

  const loadProjects = useCallback(async (select?: number) => {
    setProjectsLoading(true);
    setProjectsError(null);
    try {
      const list = await listProjects();
      setProjects(list);
      setProjectId((current) => {
        // 1. An explicit choice (the project just created) always wins.
        if (select !== undefined && list.some((p) => p.id === select)) return select;
        // 2. Whatever is already selected, if it still exists.
        if (current !== null && list.some((p) => p.id === current)) return current;
        // 3. The last one used.
        const remembered = readLastProjectId();
        if (remembered !== null && list.some((p) => p.id === remembered)) return remembered;
        // 4. The most recently CREATED one -- not the alphabetically first.
        // listProjects sorts by name, so list[0] is arbitrary; right after
        // adding a second project the useful default is the new one.
        return list.reduce<Project | null>(
          (newest, p) => (newest === null || p.createdAt > newest.createdAt ? p : newest),
          null,
        )?.id ?? null;
      });
    } catch (e) {
      setProjectsError(messageOf(e));
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadProjects();
    void (async () => {
      try {
        const { homeDir } = await import('@tauri-apps/api/path');
        setHome(await homeDir());
      } catch {
        setHome('');
      }
    })();
  }, [open, loadProjects]);

  useEffect(() => {
    if (open) return;
    setTitle('');
    setError(null);
    setBusy(false);
  }, [open]);

  useEffect(() => {
    if (open) titleRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy && !projectsOpen) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, projectsOpen, onClose]);

  // --- branches for the selected project ----------------------------------

  useEffect(() => {
    if (!open || !project) {
      setBranches([]);
      setBaseBranch('');
      return;
    }
    const seq = ++probeSeq.current;
    setBranchesBusy(true);
    setBranchesError(null);
    setBranches([]);
    void (async () => {
      try {
        const bs = await listBranches(project.repoPath);
        if (seq !== probeSeq.current) return;
        setBranches(bs.all);
        // The project's default wins when it is set and still exists; the
        // repo's current branch is the fallback.
        const preferred =
          project.defaultBaseBranch && bs.all.includes(project.defaultBaseBranch)
            ? project.defaultBaseBranch
            : bs.all.includes(bs.current)
              ? bs.current
              : (bs.all[0] ?? '');
        setBaseBranch(preferred);
      } catch (e) {
        if (seq !== probeSeq.current) return;
        setBranchesError(messageOf(e));
      } finally {
        if (seq === probeSeq.current) setBranchesBusy(false);
      }
    })();
  }, [open, project]);

  // Models come from Claude Code's own files, so the list and the default are
  // whatever Claude Code would offer and start with. The pick resets per open.
  useEffect(() => {
    if (!open) return;
    setModel('');
    let live = true;
    void Promise.all([loadModelChoices(), loadDefaultModel()]).then(([choices, def]) => {
      if (!live) return;
      setModelChoices(choices);
      setDefaultModel(def);
    });
    return () => {
      live = false;
    };
  }, [open]);

  // --- derived values, shown live -----------------------------------------

  // One derivation for the key, the branch and the directory, so what the
  // dialog shows is exactly what gets created.
  const naming = useMemo(() => (title.trim() ? nameTask(title) : null), [title]);
  const branch = naming?.branch ?? '';
  const worktreePath = useMemo(
    () =>
      project && naming ? composeWorktreePath(project.worktreeRoot, naming.dirName, home) : '',
    [project, naming, home],
  );

  const canSubmit =
    !busy &&
    !branchesBusy &&
    project !== null &&
    title.trim() !== '' &&
    baseBranch !== '' &&
    branch !== '' &&
    worktreePath !== '';

  // --- submit -------------------------------------------------------------

  const submit = useCallback(
    async (useExistingBranch: boolean) => {
      if (busy || !project) return;
      setBusy(true);
      setError(null);
      const created = {
        repoPath: project.repoPath,
        baseBranch,
        branch,
        path: worktreePath,
        useExistingBranch,
      };
      try {
        await createWorktree(created);
      } catch (e) {
        const kind = e instanceof GitError ? e.kind : 'unknown';
        setError({ text: messageOf(e), kind });
        setBusy(false);
        return;
      }
      let task: Task;
      try {
        // Only once the worktree exists on disk does a task row make sense:
        // a task whose worktree is missing is worse than no task at all.
        task = await createTask({
          title: title.trim(),
          projectId: project.id,
          repoPath: project.repoPath,
          baseBranch,
          branch,
          worktreePath,
          // Albedo just cut this worktree, so it is Albedo's to remove on
          // archive. A resumed session, which runs in a directory the user
          // already had, sets this false and is never offered removal.
          ownsWorktree: true,
          // `-b` cut it unless the user chose a branch they already had.
          createdBranch: !useExistingBranch,
        });
      } catch (e) {
        // The worktree exists but no task names it, so a retry would fail on
        // `path-exists`. Undo it -- unforced, and the branch only if `-b` cut
        // it just now -- or say exactly what was left behind.
        const leftover = await undoCreateWorktree(created);
        setError({
          text:
            `The worktree was created but the task could not be saved:\n${messageOf(e)}\n\n` +
            (leftover ?? 'The worktree has been removed again, so you can retry.'),
          kind: 'task-save',
        });
        setBusy(false);
        return;
      }
      // Outside the try on purpose: from here the row exists, so nothing that
      // fails below may undo the worktree it names.
      setBusy(false);
      writeLastProjectId(project.id);
      // Before onCreated: that is what mounts the terminal, which reads it.
      setTaskModel(task.id, model || null);
      onCreated(task);
    },
    [busy, project, baseBranch, branch, worktreePath, title, model, onCreated],
  );

  if (!open) return null;

  const noProjects = !projectsLoading && projects.length === 0;

  return (
    <>
      <div
        className="wt-overlay"
        role="presentation"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget && !busy) onClose();
        }}
      >
        <div
          className="wt-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="wt-newtask-title"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="wt-modal-head">
            <h2 className="wt-modal-title" id="wt-newtask-title">
              New task
            </h2>
            <span className="wt-modal-sub">
              {project ? `a worktree under ${project.worktreeRoot}` : 'in a project'}
            </span>
          </div>

          <div className="wt-modal-body">
            {projectsError && (
              <div className="wt-error">
                <div className="wt-error-head">Could not load projects</div>
                <pre className="wt-error-body">{projectsError}</pre>
              </div>
            )}

            {/* No dead end: offer the way through to creating one. */}
            {noProjects ? (
              <div className="wt-empty">
                <strong>No projects yet.</strong>
                A project names a repository and decides where its worktrees live. Add one and this
                dialog will be ready to use.
                <div className="wt-confirm-actions" style={{ justifyContent: 'center' }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => setProjectsOpen(true)}
                  >
                    Add a project…
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="wt-field">
                  <label className="wt-label" htmlFor="wt-project">
                    Project
                  </label>
                  <div className="wt-row">
                    <select
                      id="wt-project"
                      className="wt-select"
                      value={projectId ?? ''}
                      disabled={busy || projectsLoading}
                      onChange={(e) => {
                        setProjectId(Number(e.target.value));
                        setError(null);
                      }}
                    >
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => setProjectsOpen(true)}
                    >
                      Manage…
                    </button>
                  </div>
                  {project && (
                    <div className="wt-hint">
                      <span className="wt-mono">{project.repoPath}</span>
                      <br />
                      worktrees in <span className="wt-mono">{project.worktreeRoot}</span>
                    </div>
                  )}
                </div>

                <div className="wt-field">
                  <label className="wt-label" htmlFor="wt-title">
                    Title
                  </label>
                  <input
                    id="wt-title"
                    ref={titleRef}
                    className="wt-input"
                    type="text"
                    value={title}
                    placeholder="Fix the login redirect loop"
                    spellCheck={false}
                    disabled={busy}
                    onChange={(e) => {
                      setTitle(e.target.value);
                      setError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && canSubmit) void submit(false);
                    }}
                  />
                </div>

                <div className="wt-field">
                  <label className="wt-label" htmlFor="wt-base">
                    Base branch
                  </label>
                  <select
                    id="wt-base"
                    className="wt-select"
                    value={baseBranch}
                    disabled={busy || branchesBusy || branches.length === 0}
                    onChange={(e) => {
                      setBaseBranch(e.target.value);
                      setError(null);
                    }}
                  >
                    {branches.length === 0 && <option value="">—</option>}
                    {branches.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                  {branchesBusy && <div className="wt-hint">Reading branches…</div>}
                  {project?.defaultBaseBranch && baseBranch === project.defaultBaseBranch && (
                    <div className="wt-hint">The project&rsquo;s default.</div>
                  )}
                  {branchesError && (
                    <div className="wt-error">
                      <div className="wt-error-head">git could not read that repository</div>
                      <pre className="wt-error-body">{branchesError}</pre>
                    </div>
                  )}
                </div>

                <div className="wt-field">
                  <label className="wt-label" htmlFor="wt-model">
                    Model
                  </label>
                  <select
                    id="wt-model"
                    className="wt-select"
                    value={model}
                    disabled={busy}
                    onChange={(e) => setModel(e.target.value)}
                  >
                    <option value="">
                      {defaultModel ? `Default (${defaultModel})` : 'Default (Claude Code’s)'}
                    </option>
                    {modelChoices.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                  <div className="wt-hint">
                    {model === ''
                      ? 'Your Claude Code default, as /model saved it.'
                      : 'This task keeps this model, including when it is resumed.'}
                  </div>
                </div>

                {/* --- derived preview ------------------------------------- */}
                <div className="wt-derived">
                  {naming?.key && (
                    <div className="wt-derived-row">
                      <span className="wt-derived-key">Issue</span>
                      <span className="wt-derived-val">
                        <span className="wt-chip" data-tone="issue">
                          {naming.key}
                        </span>{' '}
                        <span className="wt-modal-sub">
                          drives the branch and folder below. Claude Code looks the issue up
                          itself — Albedo only names it.
                        </span>
                      </span>
                    </div>
                  )}
                  <div className="wt-derived-row">
                    <span className="wt-derived-key">Branch</span>
                    <span className="wt-derived-val" data-pending={branch === ''}>
                      {branch || 'from the title'}
                    </span>
                  </div>
                  <div className="wt-derived-row">
                    <span className="wt-derived-key">Worktree</span>
                    <span className="wt-derived-val" data-pending={worktreePath === ''}>
                      {worktreePath ||
                        (project ? `${project.worktreeRoot}/<slug>` : 'choose a project')}
                    </span>
                  </div>
                  <div className="wt-derived-row">
                    <span className="wt-derived-key">Command</span>
                    <span className="wt-derived-val" data-pending={!canSubmit}>
                      {canSubmit
                        ? `git worktree add -b ${branch} -- ${worktreePath} ${baseBranch}`
                        : 'git worktree add …'}
                    </span>
                  </div>
                </div>

                {error && (
                  <div className="wt-error">
                    <div className="wt-error-head">
                      {error.kind === 'branch-exists'
                        ? `The branch ${branch} already exists`
                        : error.kind === 'path-exists'
                          ? 'That worktree path is taken'
                          : error.kind === 'task-save'
                            ? 'The task could not be saved'
                            : 'git refused'}
                    </div>
                    <pre className="wt-error-body">{error.text}</pre>
                    {error.kind === 'branch-exists' && (
                      <div className="wt-error-actions">
                        <button
                          type="button"
                          className="btn"
                          disabled={busy}
                          onClick={() => void submit(true)}
                        >
                          Check out the existing branch
                        </button>
                        <span className="wt-modal-sub">
                          runs{' '}
                          <code className="wt-mono">
                            git worktree add -- {worktreePath} {branch}
                          </code>
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="wt-modal-foot">
            <span className="wt-modal-sub">
              The worktree is independent — uncommitted work in{' '}
              {project?.name ?? 'the repo'} stays put.
            </span>
            <span className="wt-foot-spacer" />
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canSubmit}
              onClick={() => void submit(false)}
            >
              {busy ? 'Creating…' : 'Create worktree'}
            </button>
          </div>
        </div>
      </div>

      <ProjectsDialog
        open={projectsOpen}
        onClose={() => setProjectsOpen(false)}
        onChanged={(created) => void loadProjects(created?.id)}
        onCreateTaskIn={(p) => {
          // Land back here with the new project selected and the cursor in the
          // field the user has to fill in next. Closing the projects dialog is
          // the confirmation that the round trip finished.
          setProjects((prev) => (prev.some((x) => x.id === p.id) ? prev : [...prev, p]));
          setProjectId(p.id);
          setProjectsOpen(false);
          setError(null);
          window.setTimeout(() => titleRef.current?.focus(), 0);
        }}
      />
    </>
  );
}

export default NewTaskDialog;
