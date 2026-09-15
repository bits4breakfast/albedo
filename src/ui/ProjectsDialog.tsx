/**
 * ProjectsDialog — name a repository once, and say where its worktrees live.
 *
 * The worktree root is the reason this exists. It used to be hardcoded to
 * `~/agents/<repo>/<slug>`, which made an existing layout (the user's own
 * `~/www/worktrees`) invisible to the app. Here the user chooses, and that
 * choice is what the reconcile view treats as Albedo's territory.
 *
 * The root is validated on **save**, not on use: a bad root does not otherwise
 * fail until a task is created, which is the worst possible moment — the user
 * has named the work and committed to starting it. Every rejection names its
 * reason; see `validateWorktreeRoot`.
 *
 * Owner: worktree workstream (M3).
 */

import { useCallback, useEffect, useState } from 'react';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import type { Project } from '../types';
import {
  ProjectExistsError,
  archiveProject,
  createProject,
  listProjects,
  updateProject,
} from '../db/projects';
import { checkWorktreeRoot, expandTilde, validateWorktreeRoot } from '../git/reconcile';
import { basename, defaultWorktreeRoot, listBranches, repoRootFor } from '../git/worktree';
import { PROMPT_PLACEHOLDERS, fillPromptTemplate } from '../lib/issueKey';
import { nameTask } from '../git/slug';
import { readHiddenProjectIds, unhideProjectId, writeLastProjectId } from './projectPrefs';
import './worktree.css';

export interface ProjectsDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * Fired after any create/edit/archive so a caller can refresh. Carries the
   * new project on a create, so the caller can select it rather than guess.
   */
  onChanged?: (created?: Project) => void;
  /**
   * Tell the shell a project is no longer hidden. The shell holds the hidden
   * set in React state, so writing localStorage alone would not bring the tab
   * back until a restart. Without this prop, unhiding still persists — it just
   * does not take effect immediately.
   */
  onUnhideProject?: (projectId: number) => void;
  /**
   * Take the user straight into creating a task in the project they just made.
   * Creating a project is never the goal -- it is the prerequisite for cutting
   * a worktree -- so the user who just finished step one is exactly the user
   * who wants step two.
   *
   * Supplied by NewTaskDialog when it opens this dialog from its "no projects
   * yet" state. **A caller that opens this dialog on its own (the header's
   * Projects control) should supply it too**, otherwise the onward step falls
   * back to remembering the project and closing -- correct, but one press
   * further away than it needs to be.
   */
  onCreateTaskIn?: (project: Project) => void;
}

/** The form, shared by "add" and "edit". */
interface Draft {
  /** null = adding a new project. */
  id: number | null;
  name: string;
  repoPath: string;
  worktreeRoot: string;
  defaultBaseBranch: string;
  /** Initial prompt sent to `claude` as argv on a task's first spawn. */
  taskPromptTemplate: string;
  /** Whether the user has hand-edited the root, so we stop re-deriving it. */
  rootTouched: boolean;
}

/**
 * Offered, never applied on its own. Silently prompting an agent the user has
 * just launched is a side effect they did not ask for, so this is one click
 * away rather than pre-filled.
 */
const SUGGESTED_PROMPT = 'Pick up {key}. Read the issue, plan the change, then implement it.';

/**
 * The title the preview is rendered against. A worked example rather than a
 * live task, because the placeholders ARE the interface here -- a user cannot
 * tell what `{rest}` means from its name, but they can read it off a sentence.
 */
const PREVIEW_TITLE = 'ACME-2398 fix the login redirect loop';

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function ProjectsDialog({
  open,
  onClose,
  onChanged,
  onCreateTaskIn,
  onUnhideProject,
}: ProjectsDialogProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [home, setHome] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState<number | null>(null);
  /** The project just created, so the dialog can visibly land on it. */
  const [justCreated, setJustCreated] = useState<Project | null>(null);
  /** Project tabs the user has closed. View state, owned by the shell. */
  const [hiddenIds, setHiddenIds] = useState<number[]>([]);
  /** Set when a create collided with an existing project, to offer "edit it". */
  const [clash, setClash] = useState<Project | null>(null);

  // --- load ---------------------------------------------------------------

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setProjects(await listProjects());
    } catch (e) {
      setLoadError(messageOf(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      setDraft(null);
      setSaveError(null);
      setConfirmArchive(null);
      setJustCreated(null);
      setClash(null);
      return;
    }
    setHiddenIds(readHiddenProjectIds());
    void reload();
    void (async () => {
      try {
        const { homeDir } = await import('@tauri-apps/api/path');
        setHome(await homeDir());
      } catch {
        setHome('');
      }
    })();
  }, [open, reload]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || busy) return;
      e.stopPropagation();
      if (confirmArchive !== null) setConfirmArchive(null);
      else if (draft) setDraft(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, draft, confirmArchive, onClose]);

  // --- editing ------------------------------------------------------------

  const loadBranches = useCallback(async (repoPath: string) => {
    setBranches([]);
    try {
      const bs = await listBranches(repoPath);
      setBranches(bs.all);
    } catch {
      // Not fatal: the default base branch is optional.
    }
  }, []);

  /**
   * The suggested root, already expanded when we know the home directory.
   * Showing `~/agents/<name>` and then storing `/Users/x/agents/<name>` tells
   * the user one thing and does another, which is its own "did that work?".
   */
  const suggestRoot = useCallback(
    (name: string) => {
      const suggestion = defaultWorktreeRoot(name);
      return home ? expandTilde(suggestion, home) : suggestion;
    },
    [home],
  );

  const startAdd = useCallback(async () => {
    setSaveError(null);
    setClash(null);
    try {
      const picked = await openFileDialog({
        directory: true,
        multiple: false,
        title: 'Choose the project repository',
      });
      // Cancelling the picker must not also clear the confirmation of what the
      // user just did -- that would look like the app forgetting.
      if (typeof picked !== 'string') return;
      setJustCreated(null);

      // Resolve to the REPOSITORY, not the working tree. Picking a worktree
      // folder here used to store the worktree as the project's repo_path,
      // which then matched nothing else in that repository -- tasks in sibling
      // worktrees got no project and landed in the "Other" tab. repoRootFor
      // answers the same from the main checkout, a linked worktree, or any
      // subdirectory of either, which is what makes repo_path a usable key.
      let repoPath = picked;
      try {
        repoPath = await repoRootFor(picked);
      } catch (e) {
        setSaveError(messageOf(e));
        return;
      }

      const name = basename(repoPath);
      setDraft({
        id: null,
        name,
        repoPath,
        worktreeRoot: suggestRoot(name),
        defaultBaseBranch: '',
        taskPromptTemplate: '',
        rootTouched: false,
      });
      void loadBranches(repoPath);
    } catch (e) {
      setSaveError(messageOf(e));
    }
  }, [loadBranches, suggestRoot]);

  const startEdit = useCallback(
    (p: Project) => {
      setSaveError(null);
      setClash(null);
      setJustCreated(null);
      setDraft({
        id: p.id,
        name: p.name,
        repoPath: p.repoPath,
        worktreeRoot: p.worktreeRoot,
        defaultBaseBranch: p.defaultBaseBranch ?? '',
        taskPromptTemplate: p.taskPromptTemplate ?? '',
        rootTouched: true,
      });
      void loadBranches(p.repoPath);
    },
    [loadBranches],
  );

  const browseRoot = useCallback(async () => {
    if (!draft) return;
    try {
      const picked = await openFileDialog({
        directory: true,
        multiple: false,
        title: 'Choose where this project’s worktrees go',
      });
      if (typeof picked === 'string') {
        setDraft({ ...draft, worktreeRoot: picked, rootTouched: true });
      }
    } catch (e) {
      setSaveError(messageOf(e));
    }
  }, [draft]);

  const setName = useCallback(
    (name: string) => {
      if (!draft) return;
      setDraft({
        ...draft,
        name,
        // Keep the suggested root in step with the name until the user takes
        // it over; after that it is theirs and we never overwrite it.
        worktreeRoot: draft.rootTouched ? draft.worktreeRoot : suggestRoot(name),
      });
    },
    [draft, suggestRoot],
  );

  // Live validation of the pure rules, so the reason appears as you type.
  const liveCheck =
    draft && draft.worktreeRoot.trim()
      ? validateWorktreeRoot(draft.worktreeRoot, { repoPath: draft.repoPath, home })
      : null;

  // Rendered through the same expander the shell uses at spawn, so the preview
  // cannot drift from what the agent is actually told.
  const promptPreview = draft
    ? fillPromptTemplate(draft.taskPromptTemplate, {
        title: PREVIEW_TITLE,
        branch: nameTask(PREVIEW_TITLE).branch,
      })
    : null;

  const save = useCallback(async () => {
    if (!draft || busy) return;
    setBusy(true);
    setSaveError(null);
    try {
      const name = draft.name.trim();
      if (!name) {
        setSaveError('Give the project a name.');
        return;
      }
      // The filesystem rule (parent must exist) runs here, on save, not when a
      // task is created.
      const check = await checkWorktreeRoot(draft.worktreeRoot, {
        repoPath: draft.repoPath,
        home,
      });
      if (!check.ok) {
        setSaveError(check.reason);
        return;
      }

      const patch = {
        name,
        repoPath: draft.repoPath,
        // Store the resolved, normalised form rather than whatever was typed.
        worktreeRoot: check.path,
        defaultBaseBranch: draft.defaultBaseBranch.trim() || null,
        // '' and null both mean "no prompt"; the db layer collapses them, and
        // sending one representation keeps that true from this end too.
        taskPromptTemplate: draft.taskPromptTemplate.trim() || null,
      };

      if (draft.id === null) {
        const created = await createProject(patch);
        setDraft(null);
        await reload();
        // Land on it: the list is not enough on its own, because returning to
        // a window that looks unchanged is exactly what read as "nothing
        // happened". The strip above the list says what was made and offers
        // the step the user is actually here for.
        setJustCreated(created);
        onChanged?.(created);
      } else {
        await updateProject(draft.id, patch);
        setDraft(null);
        await reload();
        onChanged?.();
      }
    } catch (e) {
      // createProject rejects a duplicate repo_path. Say which project already
      // owns it and offer to edit that one, rather than leaving the user to
      // work out why an apparently valid folder was refused.
      if (e instanceof ProjectExistsError) setClash(e.existing);
      setSaveError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }, [draft, busy, home, reload, onChanged]);

  const doArchive = useCallback(
    async (id: number) => {
      setBusy(true);
      setJustCreated(null);
      try {
        await archiveProject(id);
        setConfirmArchive(null);
        await reload();
        onChanged?.();
      } catch (e) {
        setLoadError(messageOf(e));
      } finally {
        setBusy(false);
      }
    },
    [reload, onChanged],
  );

  if (!open) return null;

  return (
    <div
      className="wt-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="wt-modal"
        data-wide="true"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wt-projects-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="wt-modal-head">
          <h2 className="wt-modal-title" id="wt-projects-title">
            Projects
          </h2>
          <span className="wt-modal-sub">
            {draft
              ? draft.id === null
                ? 'new project'
                : 'editing'
              : `${projects.length} project${projects.length === 1 ? '' : 's'}`}
          </span>
        </div>

        <div className="wt-modal-body">
          {loadError && (
            <div className="wt-error">
              <div className="wt-error-head">Could not load projects</div>
              <pre className="wt-error-body">{loadError}</pre>
            </div>
          )}

          {/* --- the form ---------------------------------------------------- */}
          {draft && (
            <>
              <div className="wt-field">
                <span className="wt-label">Repository</span>
                <div className="wt-repo-path" title={draft.repoPath}>
                  {`‎${draft.repoPath}`}
                </div>
              </div>

              <div className="wt-field">
                <label className="wt-label" htmlFor="wt-proj-name">
                  Name
                </label>
                <input
                  id="wt-proj-name"
                  className="wt-input"
                  type="text"
                  value={draft.name}
                  spellCheck={false}
                  disabled={busy}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="wt-field">
                <label className="wt-label" htmlFor="wt-proj-root">
                  Worktree root
                </label>
                <div className="wt-row">
                  <input
                    id="wt-proj-root"
                    className="wt-input"
                    type="text"
                    value={draft.worktreeRoot}
                    spellCheck={false}
                    placeholder="~/agents/my-project"
                    disabled={busy}
                    onChange={(e) =>
                      setDraft({ ...draft, worktreeRoot: e.target.value, rootTouched: true })
                    }
                  />
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => void browseRoot()}
                  >
                    Browse…
                  </button>
                </div>
                <div className="wt-hint">
                  Worktrees are created as{' '}
                  <span className="wt-mono">
                    {(liveCheck?.ok ? liveCheck.path : draft.worktreeRoot) || '<root>'}/&lt;slug&gt;
                  </span>
                  . The folder is created on demand.
                </div>
                {liveCheck && !liveCheck.ok && (
                  <div className="wt-notice" data-tone="error">
                    {liveCheck.reason}
                  </div>
                )}
                {liveCheck?.ok && liveCheck.warning && (
                  <div className="wt-notice">{liveCheck.warning}</div>
                )}
              </div>

              <div className="wt-field">
                <label className="wt-label" htmlFor="wt-proj-prompt">
                  Initial prompt <span className="wt-label-optional">optional</span>
                </label>
                <textarea
                  id="wt-proj-prompt"
                  className="wt-input wt-textarea"
                  rows={2}
                  value={draft.taskPromptTemplate}
                  spellCheck={false}
                  placeholder="Left empty, the session starts with nothing typed."
                  disabled={busy}
                  onChange={(e) => setDraft({ ...draft, taskPromptTemplate: e.target.value })}
                />
                <div className="wt-hint">
                  Passed to <span className="wt-mono">claude</span> as its prompt argument the
                  first time a task in this project starts — never on a restart. Replaced:{' '}
                  {PROMPT_PLACEHOLDERS.map((ph, i) => (
                    <span key={ph}>
                      {i > 0 && ', '}
                      <span className="wt-mono">{ph}</span>
                    </span>
                  ))}
                  . Albedo does not read the issue itself — Claude Code looks it up.
                </div>

                {promptPreview !== null ? (
                  <div className="wt-preview">
                    <div className="wt-preview-label">
                      For a task called <span className="wt-mono">{PREVIEW_TITLE}</span>, the
                      session would start with:
                    </div>
                    <div className="wt-preview-body">{promptPreview}</div>
                  </div>
                ) : (
                  <div className="wt-confirm-actions">
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => setDraft({ ...draft, taskPromptTemplate: SUGGESTED_PROMPT })}
                    >
                      Use the suggested prompt
                    </button>
                    <span className="wt-modal-sub wt-mono">{SUGGESTED_PROMPT}</span>
                  </div>
                )}
              </div>

              <div className="wt-field">
                <label className="wt-label" htmlFor="wt-proj-base">
                  Default base branch
                </label>
                <select
                  id="wt-proj-base"
                  className="wt-select"
                  value={draft.defaultBaseBranch}
                  disabled={busy}
                  onChange={(e) => setDraft({ ...draft, defaultBaseBranch: e.target.value })}
                >
                  <option value="">Use the repository&rsquo;s current branch</option>
                  {branches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </div>

              {saveError && (
                <div className="wt-error">
                  <div className="wt-error-head">Could not save this project</div>
                  <pre className="wt-error-body">{saveError}</pre>
                </div>
              )}
            </>
          )}

          {/* --- the list ---------------------------------------------------- */}
          {!draft && (
            <>
              {saveError && (
                <div className="wt-error">
                  <div className="wt-error-head">
                    {clash ? `${clash.name} already uses that repository` : 'Could not open that folder'}
                  </div>
                  <pre className="wt-error-body">{saveError}</pre>
                  {clash && (
                    <div className="wt-error-actions">
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => {
                          setSaveError(null);
                          startEdit(clash);
                        }}
                      >
                        Edit {clash.name} instead
                      </button>
                    </div>
                  )}
                </div>
              )}

              {justCreated && (
                <div className="wt-landed">
                  <div className="wt-landed-head">
                    Added <strong>{justCreated.name}</strong>
                  </div>
                  <div className="wt-landed-detail">
                    Worktrees for this project will be created in{' '}
                    <span className="wt-mono">{justCreated.worktreeRoot}</span>. Nothing has been
                    written to disk yet — that happens when you create a task.
                    {!onCreateTaskIn && ' New tasks will start in this project.'}
                  </div>
                  <div className="wt-confirm-actions">
                    {/* Always offered, however this dialog was opened. With a
                        handler we go straight into the task; without one we
                        make the project the default and get out of the way,
                        which is the most an isolated dialog can honestly do. */}
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => {
                        writeLastProjectId(justCreated.id);
                        if (onCreateTaskIn) onCreateTaskIn(justCreated);
                        else onClose();
                      }}
                    >
                      Create a task in {justCreated.name}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => void startAdd()}
                    >
                      Add another project
                    </button>
                  </div>
                </div>
              )}

              {hiddenIds.length > 0 && (
                <div className="wt-hint" style={{ marginBottom: 8 }}>
                  <strong>Hidden</strong> means its tab is closed — the project, its tasks and its
                  worktrees are untouched and it is still listed here.{' '}
                  <strong>Archived</strong> takes a project out of the active list.{' '}
                  <strong>Deleting</strong> a task is separate again, and lives on the task.
                </div>
              )}

              {!loading && projects.length === 0 && (
                <div className="wt-empty">
                  <strong>No projects yet.</strong>
                  A project names the repository you work in and decides where its worktrees are
                  created. Adding one takes about fifteen seconds.
                  <div className="wt-confirm-actions" style={{ justifyContent: 'center' }}>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => void startAdd()}
                    >
                      Choose a repository…
                    </button>
                  </div>
                </div>
              )}

              {projects.map((p) => (
                <div
                  key={p.id}
                  className="wt-item"
                  data-new={justCreated?.id === p.id}
                  data-hidden={hiddenIds.includes(p.id)}
                  data-confirming={confirmArchive === p.id}
                  // Double-click is "click plus the obvious button", matching
                  // the session browser. Edit is the only non-destructive row
                  // action here, and it consults the same `busy` predicate the
                  // Edit button does rather than keeping its own copy -- a
                  // shortcut that stays live while its button is disabled is
                  // how an accelerator becomes a bug.
                  //
                  // The session browser's "re-click must not discard an
                  // in-progress edit" hazard cannot arise here: the list and
                  // the form are mutually exclusive branches, so there is never
                  // a draft open behind a visible row.
                  onDoubleClick={() => {
                    if (busy) return;
                    startEdit(p);
                  }}
                >
                  <div className="wt-item-top">
                    <span className="wt-item-path" title={p.repoPath}>
                      {p.name}
                    </span>
                    {justCreated?.id === p.id && <span className="wt-chip" data-tone="new">new</span>}
                    {hiddenIds.includes(p.id) && (
                      <span className="wt-chip" title="Its tab is closed. Nothing on disk changed.">
                        hidden
                      </span>
                    )}
                    {hiddenIds.includes(p.id) && (
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => {
                          setHiddenIds(unhideProjectId(p.id));
                          onUnhideProject?.(p.id);
                        }}
                      >
                        Show tab
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => startEdit(p)}
                    >
                      Edit
                    </button>
                    {confirmArchive !== p.id && (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={busy}
                        onClick={() => setConfirmArchive(p.id)}
                      >
                        Archive
                      </button>
                    )}
                  </div>
                  <div className="wt-item-meta">
                    <span className="wt-chip">{p.repoPath}</span>
                  </div>
                  <div className="wt-item-meta">
                    <span className="wt-chip">worktrees: {p.worktreeRoot}</span>
                    {p.defaultBaseBranch && (
                      <span className="wt-chip">base: {p.defaultBaseBranch}</span>
                    )}
                  </div>

                  {confirmArchive === p.id && (
                    <div className="wt-confirm">
                      <div className="wt-confirm-title">
                        Archive {p.name}? It stops being offered for new tasks.
                      </div>
                      <div className="wt-item-reason">
                        Nothing on disk changes — no worktree is removed and the repository is left
                        alone. Existing tasks keep working.
                      </div>
                      <div className="wt-confirm-actions">
                        <button
                          type="button"
                          className="btn"
                          disabled={busy}
                          onClick={() => void doArchive(p.id)}
                        >
                          Archive project
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          disabled={busy}
                          onClick={() => setConfirmArchive(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </>
          )}
        </div>

        <div className="wt-modal-foot">
          <span className="wt-modal-sub">
            {draft
              ? 'The worktree root is checked now, so task creation cannot fail on it later.'
              : 'A project names a repository and decides where its worktrees live.'}
          </span>
          <span className="wt-foot-spacer" />
          {draft ? (
            <>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => setDraft(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !draft.name.trim() || liveCheck?.ok === false}
                onClick={() => void save()}
              >
                {busy ? 'Saving…' : draft.id === null ? 'Add project' : 'Save'}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => void startAdd()}>
                Add project…
              </button>
              <button type="button" className="btn btn-primary" onClick={onClose}>
                Done
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default ProjectsDialog;
