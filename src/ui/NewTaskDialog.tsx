/**
 * NewTaskDialog — create a task, which means creating a git worktree, or
 * switching the main checkout when the user would rather work there.
 *
 * First, what kind of task: work on a branch, or a chat (#49). A chat is a
 * conversation about the code: `claude` runs in the project's main checkout
 * exactly as it is -- any branch, clean or dirty -- and nothing is created,
 * switched or checked out. Every spawn tells Claude not to change the folder
 * (CHAT_SYSTEM_PROMPT); the dialog says plainly that it is the real folder.
 *
 * Work then has two independent choices: a NEW branch cut from a base, or an
 * EXISTING one (a colleague's remote branch, to review), and a new worktree or
 * the main checkout. The main checkout is the user's own folder, so it is
 * offered only while it has no uncommitted changes, and a task there never
 * owns it.
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
import type { Project, Task, TaskKind } from '../types';
import { createTask, findTaskByWorktreePath } from '../db';
import { listProjects } from '../db/projects';
import { nameTask } from '../git/slug';
import {
  GitError,
  baseFreshness,
  composeWorktreePath,
  createWorktree,
  defaultBranchOf,
  fetchAll,
  guessBaseBranch,
  cutPoint,
  type BaseFreshness,
  listBranches,
  localCheckoutFor,
  probeMainCheckout,
  switchCleanCheckout,
  undoCreateWorktree,
  type BranchList,
  type MainCheckout,
} from '../git/worktree';
import { fetchPrBase } from '../gh/gh';
import ProjectsDialog from './ProjectsDialog';
import { readLastProjectId, writeLastProjectId } from './projectPrefs';
import { loadDefaultModel, loadModelChoices, type ModelChoice } from '../capture/modelCatalog';
import { setTaskModel } from './taskModel';
import { saveDraft } from './transcript/drafts';
import { nameFollowUp, type NewTaskPrefill } from './followUp';
import { BranchPicker } from './BranchPicker';
import { orderBranches } from './branchPickerModel';
import './worktree.css';

export interface NewTaskDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * `initialPrompt` is set only when the dialog showed a prompt field (a
   * follow-up): it replaces the project's template for this task, and an
   * empty string means the user cleared it and wants no prompt at all.
   */
  onCreated: (t: Task, initialPrompt?: string) => void;
  /**
   * Opens the dialog filled in -- "Follow-up…" uses it. Everything stays
   * editable; nothing is created until the user presses Create. A new object
   * while open (the PR lookup finishing) replaces the prompt only if the user
   * has not touched it.
   */
  prefill?: NewTaskPrefill | null;
  /**
   * The project the task list is showing. Wins over the remembered last
   * project: a "New task" pressed under the albedo tab means albedo.
   */
  defaultProjectId?: number | null;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type Source = 'new' | 'existing';
type Place = 'worktree' | 'main';

const NO_BRANCHES: BranchList = { current: '', all: [], locals: [], recentLocals: [], remoteRefs: [], remotes: [] };

/** A two-way choice. On is carried by ground, edge and weight, not colour alone. */
function Segmented<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string; disabled?: boolean; title?: string }>;
  disabled?: boolean;
  onChange: (v: T) => void;
}) {
  return (
    <div className="wt-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          className="wt-seg-option"
          aria-checked={value === o.value}
          disabled={disabled || o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function NewTaskDialog({
  open,
  onClose,
  onCreated,
  prefill = null,
  defaultProjectId = null,
}: NewTaskDialogProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [projectsOpen, setProjectsOpen] = useState(false);

  const [title, setTitle] = useState('');
  /** Shown, and sent, only when a prefill brought one. */
  const [prompt, setPrompt] = useState('');
  /**
   * A session's request (#157): send the prompt when the session starts,
   * rather than leaving it as the new task's unsent draft. Off by default.
   */
  const [sendNow, setSendNow] = useState(false);
  /** The prompt last put there by a prefill, to tell it from the user's edit. */
  const appliedPrompt = useRef<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  /** '' means the user's Claude Code default; anything else is passed as --model. */
  const [model, setModel] = useState('');
  const [modelChoices, setModelChoices] = useState<ModelChoice[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [baseBranch, setBaseBranch] = useState('');
  const [kind, setKind] = useState<TaskKind>('work');
  const [source, setSource] = useState<Source>('new');
  const [place, setPlace] = useState<Place>('worktree');
  /** The branch to check out, as picked: local, or `<remote>/<branch>`. */
  const [existingRef, setExistingRef] = useState('');
  const [branchList, setBranchList] = useState<BranchList>(NO_BRANCHES);
  const branches = branchList.all;
  /** Bumped after a fetch, to read the branches again. */
  const [branchesRev, setBranchesRev] = useState(0);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  /** The project fetched for since the dialog opened: one automatic fetch each. */
  const fetchedFor = useRef<number | null>(null);
  const [mainCheckout, setMainCheckout] = useState<MainCheckout | null>(null);
  /** A live task already running in the main checkout, which a switch moves too. */
  const [mainTask, setMainTask] = useState<string | null>(null);
  /** Where an existing branch's base came from, once worked out. */
  const [baseFrom, setBaseFrom] = useState<
    { kind: 'pr'; number: number; title: string } | { kind: 'guess'; ahead: number } | null
  >(null);
  const [baseBusy, setBaseBusy] = useState(false);
  /** The user picked the base by hand: nothing worked out may replace it. */
  const baseTouched = useRef(false);
  const [branchesBusy, setBranchesBusy] = useState(false);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  // How the base stands against its remote. The promise is kept so submit can
  // wait for a fetch still in flight rather than cut from a stale base.
  const freshProbe = useRef<{ key: string; result: Promise<BaseFreshness | null> } | null>(null);
  const [fresh, setFresh] = useState<{ key: string; value: BaseFreshness | null; pending: boolean } | null>(null);
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
    void loadProjects(prefill?.projectId ?? defaultProjectId ?? undefined);
    void (async () => {
      try {
        const { homeDir } = await import('@tauri-apps/api/path');
        setHome(await homeDir());
      } catch {
        setHome('');
      }
    })();
    // Keyed on `open` only: a prefill update must not re-pick the project
    // under a user who has already changed it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loadProjects]);

  useEffect(() => {
    if (open) return;
    setTitle('');
    setPrompt('');
    setSendNow(false);
    appliedPrompt.current = null;
    setError(null);
    setBusy(false);
    setKind('work');
    setSource('new');
    setPlace('worktree');
    setExistingRef('');
    setFetchError(null);
    fetchedFor.current = null;
    baseTouched.current = false;
  }, [open]);

  // The title arrives once per open; the prompt again whenever the prefill
  // changes, unless the user has started writing in it.
  useEffect(() => {
    if (!open || !prefill) return;
    // Read now: the updater runs after the ref below has moved on.
    const applied = appliedPrompt.current;
    if (applied === null) setTitle(prefill.title);
    setPrompt((current) => (applied === null || current === applied ? prefill.prompt : current));
    appliedPrompt.current = prefill.prompt;
  }, [open, prefill]);

  // A follow-up's title is already right; what only the user knows is the
  // bug, and the prompt ends on the empty line it goes in.
  const focusPrompt = prefill !== null;
  // The fields mount only once projects have loaded, so that is the moment.
  const formShown = projects.length > 0;
  useEffect(() => {
    if (!open) return;
    if (!focusPrompt) {
      titleRef.current?.focus();
      return;
    }
    const el = promptRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [open, focusPrompt, formShown]);

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
      setBranchList(NO_BRANCHES);
      setBaseBranch('');
      return;
    }
    const seq = ++probeSeq.current;
    setBranchesBusy(true);
    setBranchesError(null);
    void (async () => {
      try {
        const bs = await listBranches(project.repoPath);
        if (seq !== probeSeq.current) return;
        setBranchList(bs);
        // The project's default wins when it is set and still exists; the
        // repo's current branch is the fallback.
        const preferred =
          project.defaultBaseBranch && bs.all.includes(project.defaultBaseBranch)
            ? project.defaultBaseBranch
            : bs.all.includes(bs.current)
              ? bs.current
              : (bs.all[0] ?? '');
        // A re-read after a fetch keeps what the user already chose.
        setBaseBranch((b) => (b && bs.all.includes(b) ? b : preferred));
      } catch (e) {
        if (seq !== probeSeq.current) return;
        setBranchesError(messageOf(e));
      } finally {
        if (seq === probeSeq.current) setBranchesBusy(false);
      }
    })();
  }, [open, project, branchesRev]);

  // The main checkout: where it is, what it is on, whether it may be switched.
  useEffect(() => {
    setMainCheckout(null);
    setMainTask(null);
    if (!open || !project) return;
    let live = true;
    void (async () => {
      const main = await probeMainCheckout(project.repoPath);
      if (!live) return;
      setMainCheckout(main);
      if (!main) return;
      const task = await findTaskByWorktreePath(main.path, { liveOnly: true }).catch(() => null);
      if (live) setMainTask(task?.title ?? null);
    })();
    return () => {
      live = false;
    };
  }, [open, project, branchesRev]);

  const fetchBranches = useCallback(async () => {
    if (!project || fetching) return;
    fetchedFor.current = project.id;
    setFetching(true);
    setFetchError(null);
    try {
      await fetchAll(project.repoPath);
    } catch (e) {
      setFetchError(messageOf(e));
    } finally {
      setFetching(false);
      setBranchesRev((n) => n + 1);
    }
  }, [project, fetching]);

  // A colleague's branch is only listed once fetched: fetch on first asking.
  useEffect(() => {
    if (open && source === 'existing' && project && fetchedFor.current !== project.id) {
      void fetchBranches();
    }
  }, [open, source, project, fetchBranches]);

  // --- is the base up to date with its remote? ----------------------------

  const freshKey = project && baseBranch ? `${project.repoPath}\0${baseBranch}` : '';

  useEffect(() => {
    if (!open || !project || !baseBranch) {
      freshProbe.current = null;
      setFresh(null);
      return;
    }
    const key = `${project.repoPath}\0${baseBranch}`;
    const result = baseFreshness(project.repoPath, baseBranch).catch(() => null);
    freshProbe.current = { key, result };
    setFresh({ key, value: null, pending: true });
    void result.then((value) => {
      if (freshProbe.current?.key === key) setFresh({ key, value, pending: false });
    });
  }, [open, project, baseBranch]);

  const shownFresh = fresh?.key === freshKey ? fresh : null;
  const startPoint = cutPoint(baseBranch, shownFresh?.value ?? null);

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
  // A follow-up takes its branch as its folder, so it never lands on the
  // shipped task's bare-key folder (see `nameFollowUp`).
  const isFollowUp = prefill !== null;
  const naming = useMemo(
    () => (title.trim() ? (isFollowUp ? nameFollowUp(title) : nameTask(title)) : null),
    [title, isFollowUp],
  );

  // What to check out when the branch exists. Only a listed ref counts: a
  // half-typed name must not become a branch.
  const checkout = useMemo(
    () => (branches.includes(existingRef) ? localCheckoutFor(existingRef, branchList) : null),
    [existingRef, branches, branchList],
  );
  /** Remote refs a local branch of the same name already stands for are noise. */
  const pickable = useMemo(
    () => [
      ...branchList.locals,
      ...branchList.remoteRefs.filter(
        (r) => !branchList.locals.includes(localCheckoutFor(r, branchList).branch),
      ),
    ],
    [branchList],
  );
  // Both pickers list in one order: the project's default, the checked-out
  // branch, main, recent locals, then remotes. The first two say why.
  const projectDefault = project?.defaultBaseBranch ?? null;
  const baseChoices = useMemo(
    () => orderBranches(branches, branchList, projectDefault),
    [branches, branchList, projectDefault],
  );
  const checkoutChoices = useMemo(
    () => orderBranches(pickable, branchList, projectDefault),
    [pickable, branchList, projectDefault],
  );
  const branchNotes = useMemo(() => {
    const notes = new Map<string, string>();
    if (branchList.current) notes.set(branchList.current, 'Checked out');
    if (projectDefault) notes.set(projectDefault, 'Project default');
    return notes;
  }, [branchList, projectDefault]);

  const branch = source === 'new' ? (naming?.branch ?? '') : (checkout?.branch ?? '');

  /*
   * An existing branch's base is worked out, not asked for: what its pull
   * request merges into, and failing that the usual base it is fewest commits
   * ahead of. The field stays editable, and a hand-picked base wins.
   */
  const checkoutBranch = checkout?.branch ?? null;
  useEffect(() => {
    setBaseFrom(null);
    setBaseBusy(false);
    if (!open || !project || source !== 'existing' || !checkoutBranch) return;
    baseTouched.current = false;
    let live = true;
    setBaseBusy(true);
    // A name GitHub or git gives, as the picker lists it: local, else remote.
    const listed = (b: string) =>
      branches.includes(b)
        ? b
        : (branchList.remotes.map((r) => `${r}/${b}`).find((x) => branches.includes(x)) ?? null);
    void (async () => {
      try {
        const pr = await fetchPrBase(checkoutBranch, project.repoPath);
        const fromPr = pr ? listed(pr.base) : null;
        if (!live) return;
        if (pr && fromPr && fromPr !== existingRef) {
          if (!baseTouched.current) setBaseBranch(fromPr);
          setBaseFrom({ kind: 'pr', number: pr.number, title: pr.title });
          return;
        }
        const repoDefault = await defaultBranchOf(project.repoPath).catch(() => null);
        const candidates = [project.defaultBaseBranch, repoDefault, 'main', 'master', 'develop']
          .filter((b): b is string => !!b)
          .map(listed)
          .filter((b): b is string => b !== null && b !== existingRef && b !== checkoutBranch);
        const guess = await guessBaseBranch(project.repoPath, existingRef, candidates);
        if (!live || !guess) return;
        if (!baseTouched.current) setBaseBranch(guess.base);
        setBaseFrom({ kind: 'guess', ahead: guess.ahead });
      } finally {
        if (live) setBaseBusy(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [open, project, source, checkoutBranch, existingRef, branches, branchList]);
  /** Existing branches name their folder after the branch, not the title. */
  const dirName = source === 'new' ? (naming?.dirName ?? '') : branch ? nameTask(branch).dirName : '';
  const mainOk = mainCheckout !== null && mainCheckout.dirty === 0;
  /** The existing branch is what the main checkout is on: nothing to switch. */
  const mainHasBranch = source === 'existing' && branch !== '' && mainCheckout?.current === branch;
  const mainUsable = mainOk || mainHasBranch;
  // A follow-up is work on the shipped branch's base; it is never a chat.
  const isChat = kind === 'chat' && !isFollowUp;
  const onMain = place === 'main' || isChat;
  const alreadyThere = onMain && mainHasBranch;
  const worktreePath = useMemo(() => {
    if (onMain) return mainCheckout?.path ?? '';
    return project && dirName ? composeWorktreePath(project.worktreeRoot, dirName, home) : '';
  }, [onMain, mainCheckout, project, dirName, home]);
  const prTitle = baseFrom?.kind === 'pr' && baseFrom.title ? `#${baseFrom.number} ${baseFrom.title}` : '';
  const taskTitle = title.trim() || (source === 'existing' ? prTitle || branch : '');

  const command = useMemo(() => {
    if (!branch || !worktreePath) return null;
    if (source === 'new') {
      return onMain
        ? `git switch --no-track -c ${branch} ${startPoint}`
        : `git worktree add --no-track -b ${branch} -- ${worktreePath} ${startPoint}`;
    }
    const track = checkout?.track ?? null;
    if (onMain) {
      if (alreadyThere) return `nothing to run: already on ${branch}`;
      return track ? `git switch --track -c ${branch} ${track}` : `git switch ${branch}`;
    }
    return track
      ? `git worktree add --track -b ${branch} -- ${worktreePath} ${track}`
      : `git worktree add -- ${worktreePath} ${branch}`;
  }, [source, onMain, branch, startPoint, worktreePath, checkout, alreadyThere]);

  const canSubmit = isChat
    ? !busy && project !== null && title.trim() !== '' && worktreePath !== ''
    : !busy &&
    !branchesBusy &&
    !fetching &&
    !(source === 'existing' && baseBusy) &&
    project !== null &&
    taskTitle !== '' &&
    baseBranch !== '' &&
    branch !== '' &&
    worktreePath !== '' &&
    (!onMain || mainUsable);

  // --- submit -------------------------------------------------------------

  /** One calm sentence: where a chat runs, and that it is the real folder. */
  const chatNote = !mainCheckout
    ? 'This repository has no main checkout to chat in.'
    : `Claude works in your real folder, ${mainCheckout.path}, on ${mainCheckout.current ?? 'a detached HEAD'} as it is; nothing is switched, and it is asked not to change files.`;

  const mainNote = !mainCheckout
    ? 'This repository has no main checkout to switch.'
    : mainCheckout.dirty === null
      ? `Could not read ${mainCheckout.path}, so it will not be switched.`
      : mainCheckout.dirty > 0 && !mainHasBranch
        ? `${mainCheckout.path} has ${mainCheckout.dirty} uncommitted change(s): commit or stash them to work there.`
        : `${mainCheckout.path}, on ${mainCheckout.current ?? 'a detached HEAD'}.`;

  /**
   * A request's prompt (#157), at creation: the opening prompt when the user
   * chose to send it, otherwise kept as the task's unsent draft -- saved
   * before onCreated mounts the composer that reads it -- and no prompt.
   */
  const requestPrompt = useCallback(
    (taskId: number): string => {
      const text = prompt.trim();
      if (sendNow) return text;
      saveDraft(taskId, text, new Map());
      return '';
    },
    [prompt, sendNow],
  );

  /** `useExistingBranch`: the retry after git said a new branch already exists. */
  const submit = useCallback(
    async (useExistingBranch: boolean) => {
      if (busy || !project) return;
      setBusy(true);
      setError(null);
      if (isChat) {
        // Nothing to run in git: the main checkout is used exactly as it is.
        let task: Task;
        try {
          task = await createTask({
            title: title.trim(),
            projectId: project.id,
            repoPath: project.repoPath,
            // No branch, no base: a chat measures nothing and pushes nothing.
            baseBranch: '',
            branch: '',
            worktreePath,
            // The user's own folder, never Albedo's to remove.
            ownsWorktree: false,
            createdBranch: false,
            kind: 'chat',
          });
        } catch (e) {
          setError({
            text: `${messageOf(e)}\n\nNothing was changed in the main checkout.`,
            kind: 'task-save',
          });
          setBusy(false);
          return;
        }
        setBusy(false);
        writeLastProjectId(project.id);
        setTaskModel(task.id, model || null);
        onCreated(task);
        return;
      }
      const existing = source === 'existing' || useExistingBranch;
      const track = source === 'existing' ? (checkout?.track ?? null) : null;
      // A NEW branch starts from the base's upstream when the local base is
      // behind it (cutPoint), waiting for a fetch still in flight. A branch
      // being checked out is what it is.
      const probe = freshProbe.current;
      const from = existing
        ? baseBranch
        : cutPoint(
            baseBranch,
            probe && probe.key === `${project.repoPath}\0${baseBranch}` ? await probe.result : null,
          );
      const created = {
        repoPath: project.repoPath,
        baseBranch: track ?? baseBranch,
        startPoint: existing || from === baseBranch ? undefined : from,
        branch,
        path: worktreePath,
        useExistingBranch: existing && track === null,
        track: track !== null,
      };
      try {
        if (!onMain) {
          await createWorktree(created);
        } else if (!alreadyThere) {
          await switchCleanCheckout(
            existing && track === null
              ? { path: worktreePath, branch }
              : { path: worktreePath, branch, from: track ?? from, track: track !== null },
          );
        }
      } catch (e) {
        const kind = e instanceof GitError ? e.kind : 'unknown';
        setError({ text: messageOf(e), kind });
        setBusy(false);
        return;
      }
      let task: Task;
      try {
        // Only once the checkout exists on disk does a task row make sense:
        // a task whose worktree is missing is worse than no task at all.
        task = await createTask({
          title: taskTitle,
          projectId: project.id,
          repoPath: project.repoPath,
          // What the work is measured against, also for a checked-out branch.
          baseBranch,
          branch,
          worktreePath,
          // Albedo just cut this worktree, so it is Albedo's to remove on
          // archive. The main checkout is the user's own and never is.
          ownsWorktree: !onMain,
          // Only a branch `-b`/`-c` cut from a base is Albedo's to delete. A
          // local copy of a colleague's branch is theirs, even though cut now.
          createdBranch: !existing,
          kind: 'work',
        });
      } catch (e) {
        // The worktree exists but no task names it, so a retry would fail on
        // `path-exists`. Undo it -- unforced, and the branch only if `-b` cut
        // it just now -- or say exactly what was left behind. A switched main
        // checkout is not switched back: what it was on is the user's to say.
        const leftover = onMain
          ? alreadyThere
            ? 'Nothing was changed in the main checkout.'
            : `The main checkout ${worktreePath} was switched to ${branch} and stays there.`
          : await undoCreateWorktree(created);
        setError({
          text:
            `The checkout was made but the task could not be saved:\n${messageOf(e)}\n\n` +
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
      onCreated(task, prefill?.request ? requestPrompt(task.id) : prefill ? prompt.trim() : undefined);
    },
    [
      busy, project, source, checkout, baseBranch, branch, worktreePath, onMain, alreadyThere,
      taskTitle, model, onCreated, prefill, prompt, isChat, title, requestPrompt,
    ],
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
          onKeyDown={(e) => {
            // ⌘↩ creates from any field -- the prompt box included, where a
            // plain Enter is a newline. Not while an IME is composing.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (canSubmit) void submit(false);
            }
          }}
        >
          <div className="wt-modal-head">
            <h2 className="wt-modal-title" id="wt-newtask-title">
              {prefill?.request ? 'New Task from Request' : prefill ? 'New Follow-Up Task' : 'New Task'}
            </h2>
            <span className="wt-modal-sub">
              {!project
                ? 'in a project'
                : isChat
                  ? 'a chat in the main checkout, as it is'
                  : onMain
                  ? 'in the main checkout'
                  : `a worktree under ${project.worktreeRoot}`}
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
                    Add a Project…
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

                {/* The first choice: work on a branch, or a chat about the code.
                    The same segmented control as Branch and Location, so a chat
                    reads as one of the dialog's choices. A follow-up is always
                    work, so it is not asked there. */}
                {!isFollowUp && (
                  <div className="wt-field">
                    <span className="wt-label">Kind</span>
                    <Segmented<TaskKind>
                      label="Kind"
                      value={kind}
                      disabled={busy}
                      options={[
                        { value: 'work', label: 'Work on a Branch' },
                        {
                          value: 'chat',
                          label: 'Chat — No Branch',
                          disabled: !mainCheckout,
                          title: mainCheckout ? 'A conversation about the code, in the main checkout as it is' : chatNote,
                        },
                      ]}
                      onChange={(v) => {
                        setKind(v);
                        setError(null);
                      }}
                    />
                    {isChat && <div className="wt-hint">{chatNote}</div>}
                  </div>
                )}

                {!isChat && (
                <>
                {/* Two independent choices, side by side: what to work on, and
                    where. The branch picker, when needed, gets the full width. */}
                <div className="wt-pair">
                  <div className="wt-field">
                    <span className="wt-label">Branch</span>
                    <Segmented<Source>
                      label="Branch"
                      value={source}
                      disabled={busy}
                      options={[
                        { value: 'new', label: 'New' },
                        { value: 'existing', label: 'Existing' },
                      ]}
                      onChange={(v) => {
                        setSource(v);
                        setError(null);
                      }}
                    />
                  </div>
                  <div className="wt-field">
                    <span className="wt-label">Location</span>
                    <Segmented<Place>
                      label="Location"
                      value={place}
                      disabled={busy}
                      options={[
                        { value: 'worktree', label: 'New Worktree' },
                        {
                          value: 'main',
                          label: 'Main Checkout',
                          disabled: !mainUsable,
                          title: mainUsable ? undefined : mainNote,
                        },
                      ]}
                      onChange={(v) => {
                        setPlace(v);
                        setError(null);
                      }}
                    />
                    <div className="wt-hint">
                      {onMain || !mainUsable
                        ? mainNote
                        : `Its own folder; ${project?.name ?? 'the repo'}'s main checkout stays as it is.`}
                    </div>
                    {onMain && !alreadyThere && mainTask && (
                      <div className="wt-hint">
                        &ldquo;{mainTask}&rdquo; also runs there, and moves to {branch || 'this branch'} with it.
                      </div>
                    )}
                  </div>
                </div>
                {source === 'existing' && (
                  <div className="wt-field">
                    <label className="wt-label" htmlFor="wt-existing">
                      Branch to Check Out
                    </label>
                    <div className="wt-row">
                      <BranchPicker
                        id="wt-existing"
                        freeText
                        value={existingRef}
                        branches={checkoutChoices}
                        notes={branchNotes}
                        placeholder={fetching ? 'Fetching…' : 'origin/their-branch'}
                        disabled={busy}
                        onChange={(b) => {
                          setExistingRef(b);
                          setError(null);
                        }}
                        onEnter={() => {
                          if (canSubmit) void submit(false);
                        }}
                      />
                      <button
                        type="button"
                        className="btn"
                        disabled={busy || fetching || !project}
                        onClick={() => void fetchBranches()}
                        title="git fetch --all --prune"
                      >
                        {fetching ? 'Fetching…' : 'Fetch'}
                      </button>
                    </div>
                    <div className="wt-hint">
                      {checkout
                        ? checkout.track
                          ? `A new local ${checkout.branch}, tracking ${checkout.track}.`
                          : `Your local ${checkout.branch}, as it is.`
                        : existingRef
                          ? 'Not a branch git knows: pick one from the list, or fetch.'
                          : `${pickable.length} branches, remote ones included.`}
                    </div>
                    {fetchError && (
                      <div className="wt-error">
                        <div className="wt-error-head">git fetch failed</div>
                        <pre className="wt-error-body">{fetchError}</pre>
                      </div>
                    )}
                  </div>
                )}
                </>
                )}

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
                    placeholder={
                      isChat
                        ? 'How does the session restart work?'
                        : source === 'existing'
                        ? prTitle || branch || 'Defaults to the pull request or branch name'
                        : 'Fix the login redirect loop'
                    }
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

                {!isChat && (
                <div className="wt-field">
                  <label className="wt-label" htmlFor="wt-base">
                    Base Branch
                  </label>
                  <BranchPicker
                    id="wt-base"
                    value={baseBranch}
                    branches={baseChoices}
                    notes={branchNotes}
                    placeholder="—"
                    disabled={busy || branchesBusy || branches.length === 0}
                    onChange={(b) => {
                      baseTouched.current = true;
                      setBaseBranch(b);
                      setError(null);
                    }}
                  />
                  {branchesBusy && <div className="wt-hint">Reading branches…</div>}
                  {source === 'existing' ? (
                    <div className="wt-hint">
                      {baseBusy
                        ? 'Looking for its pull request…'
                        : baseTouched.current || !baseFrom
                          ? 'What its changes are measured against.'
                          : baseFrom.kind === 'pr'
                            ? `What pull request #${baseFrom.number} merges into.`
                            : `No pull request found: the usual base it is fewest commits ahead of (${baseFrom.ahead}).`}
                    </div>
                  ) : (
                    <>
                      {!branchesBusy && shownFresh && (
                        <FreshnessHint base={baseBranch} pending={shownFresh.pending} f={shownFresh.value} />
                      )}
                      {project?.defaultBaseBranch && baseBranch === project.defaultBaseBranch && (
                        <div className="wt-hint">The project&rsquo;s default.</div>
                      )}
                    </>
                  )}
                  {branchesError && (
                    <div className="wt-error">
                      <div className="wt-error-head">git could not read that repository</div>
                      <pre className="wt-error-body">{branchesError}</pre>
                    </div>
                  )}
                </div>
                )}

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

                {prefill && (
                  <div className="wt-field">
                    <label className="wt-label" htmlFor="wt-prompt">
                      Initial Prompt
                    </label>
                    <textarea
                      id="wt-prompt"
                      ref={promptRef}
                      className="wt-input wt-textarea"
                      value={prompt}
                      rows={8}
                      spellCheck
                      disabled={busy}
                      onChange={(e) => setPrompt(e.target.value)}
                    />
                    {prefill.request ? (
                      <>
                        <label className="wt-check">
                          <input
                            type="checkbox"
                            checked={sendNow}
                            disabled={busy}
                            onChange={(e) => setSendNow(e.target.checked)}
                          />
                          Send it when the session starts
                        </label>
                        <div className="wt-hint">
                          {sendNow
                            ? 'Sent once, when the session starts.'
                            : 'Left unsent in the new task’s message box, for you to edit and send.'}
                        </div>
                      </>
                    ) : (
                      <div className="wt-hint">
                        {prefill.pending
                          ? 'Looking up the pull request…'
                          : 'Sent once, when the session starts. Describe the bug under “What is wrong”.'}
                      </div>
                    )}
                  </div>
                )}

                {/* --- derived preview ------------------------------------- */}
                <div className="wt-derived">
                  {!isChat && naming?.key && (
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
                  {!isChat && (
                  <div className="wt-derived-row">
                    <span className="wt-derived-key">Branch</span>
                    <span className="wt-derived-val" data-pending={branch === ''}>
                      {branch || (source === 'new' ? 'from the title' : 'pick a branch')}
                    </span>
                  </div>
                  )}
                  <div className="wt-derived-row">
                    <span className="wt-derived-key">{onMain ? 'Folder' : 'Worktree'}</span>
                    <span className="wt-derived-val" data-pending={worktreePath === ''}>
                      {worktreePath ||
                        (onMain
                          ? 'no main checkout'
                          : project
                            ? `${project.worktreeRoot}/<slug>`
                            : 'choose a project')}
                    </span>
                  </div>
                  {!isChat && (
                  <div className="wt-derived-row">
                    <span className="wt-derived-key">Command</span>
                    <span className="wt-derived-val" data-pending={!canSubmit}>
                      {canSubmit && command
                        ? command
                        : onMain
                          ? 'git switch …'
                          : 'git worktree add …'}
                    </span>
                  </div>
                  )}
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
                    {error.kind === 'branch-exists' && source === 'new' && (
                      <div className="wt-error-actions">
                        <button
                          type="button"
                          className="btn"
                          disabled={busy}
                          onClick={() => void submit(true)}
                        >
                          Check Out the Existing Branch
                        </button>
                        <span className="wt-modal-sub">
                          runs{' '}
                          <code className="wt-mono">
                            {onMain
                              ? `git switch ${branch}`
                              : `git worktree add -- ${worktreePath} ${branch}`}
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
              {isChat
                ? 'Nothing is created or switched; no git command runs.'
                : onMain
                ? 'Switches the main checkout itself, which must have no uncommitted changes.'
                : <>The worktree is independent — uncommitted work in{' '}
                  {project?.name ?? 'the repo'} stays put.</>}
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
              title="⌘↩"
            >
              {busy
                ? 'Creating…'
                : isChat
                  ? 'Start Chat'
                  : !onMain
                  ? 'Create Worktree'
                  : alreadyThere
                    ? 'Create Task'
                    : 'Switch Main Checkout'}
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

/**
 * One line under Base Branch, only when there is something to say: an
 * up-to-date base needs no comment.
 */
function FreshnessHint({ base, pending, f }: { base: string; pending: boolean; f: BaseFreshness | null }) {
  if (pending) return <div className="wt-hint">Checking {base} against its remote…</div>;
  if (!f || (f.ahead === 0 && f.behind === 0)) {
    return f && !f.fetched ? <div className="wt-hint">Could not reach the remote; using local {base}.</div> : null;
  }
  const n = (k: number) => `${k} commit${k === 1 ? '' : 's'}`;
  const stale = f.fetched ? '' : ' (as of the last fetch; the remote did not answer)';
  const text =
    f.ahead === 0
      ? `${base} is ${n(f.behind)} behind ${f.upstream}, so the task starts from ${f.upstream}${stale}.`
      : f.behind === 0
        ? `${base} has ${n(f.ahead)} not on ${f.upstream}; starting from local ${base} to keep them.`
        : `${base} has diverged from ${f.upstream} (${f.ahead} ahead, ${f.behind} behind); starting from local ${base} to keep its commits.`;
  return <div className="wt-hint">{text}</div>;
}
