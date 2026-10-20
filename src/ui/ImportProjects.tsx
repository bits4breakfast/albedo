/**
 * ImportProjects — turn captured history into projects, by choice.
 *
 * Owner: shell workstream (M2).
 *
 * ## Why a picker and not auto-create
 *
 * The governing rule is resolve-and-link automatically, NEVER create. Linking
 * is provable — git states which repository a directory belongs to — but
 * creating a project is a decision: a name, a worktree root, a base branch, a
 * prompt template. Inventing rows from directory paths is what produced
 * `acme-ACME-2368` beside the real `acme`.
 *
 * Auto-create-with-a-confirmation is not a middle ground. It still creates the
 * row when the user is not looking, and it teaches them to dismiss the prompt.
 *
 * ## Why this cannot recreate the original bug
 *
 * Every candidate is keyed on `repoRoot` as git reports it, never on a raw
 * directory. A worktree-keyed project is therefore not representable here:
 * `~/www/acme-ACME-2368` cannot be offered, because it resolves to
 * `~/www/acme` and it is the root that is offered. Steering the user
 * away from the broken configuration beats correcting it on every launch.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Project } from '../types';
import type { UnclaimedRepo } from '../db/projects';
import { createProject, deriveProjectDefaults } from '../db/projects';
import { relativeTime } from './TaskList';

export interface ImportProjectsProps {
  open: boolean;
  repos: UnclaimedRepo[];
  onClose: () => void;
  onImported: (created: Project[]) => void;
}

interface Draft {
  selected: boolean;
  name: string;
  worktreeRoot: string;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function homeRelative(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~');
}

export default function ImportProjects({ open, repos, onClose, onImported }: ImportProjectsProps) {
  const [drafts, setDrafts] = useState<Map<string, Draft>>(() => new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Seed a draft per candidate whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setNow(Date.now());
    setDrafts(
      new Map(
        repos.map((repo) => {
          const defaults = deriveProjectDefaults(repo.repoRoot);
          return [
            repo.repoRoot,
            // Pre-selected: the user opened this to import something, and every
            // candidate is a repository they demonstrably worked in. They can
            // still uncheck — nothing is created until they press the button.
            { selected: true, name: repo.suggestedName || defaults.name, worktreeRoot: defaults.worktreeRoot },
          ] as const;
        }),
      ),
    );
  }, [open, repos]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  const patch = useCallback((root: string, next: Partial<Draft>) => {
    setDrafts((prev) => {
      const current = prev.get(root);
      if (!current) return prev;
      const merged = new Map(prev);
      merged.set(root, { ...current, ...next });
      return merged;
    });
  }, []);

  const chosen = useMemo(
    () => repos.filter((r) => drafts.get(r.repoRoot)?.selected && drafts.get(r.repoRoot)?.name.trim()),
    [repos, drafts],
  );

  const importChosen = useCallback(async () => {
    setBusy(true);
    setError(null);
    const created: Project[] = [];
    try {
      for (const repo of chosen) {
        const draft = drafts.get(repo.repoRoot);
        if (!draft) continue;
        created.push(
          await createProject({
            name: draft.name.trim(),
            // The RESOLVED root, always. This is what makes a worktree-keyed
            // project impossible to create from here.
            repoPath: repo.repoRoot,
            worktreeRoot: draft.worktreeRoot.trim() || `~/agents/${draft.name.trim()}`,
            defaultBaseBranch: null,
            taskPromptTemplate: null,
          }),
        );
      }
      onImported(created);
      onClose();
    } catch (err) {
      setError(messageOf(err));
      // Whatever succeeded is real; tell the caller so the list is not stale.
      if (created.length > 0) onImported(created);
    } finally {
      setBusy(false);
    }
  }, [chosen, drafts, onImported, onClose]);

  if (!open) return null;

  return (
    <div className="sb-overlay" onPointerDown={() => !busy && onClose()}>
      <div
        className="sb-dialog ip-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Import Projects from History"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="sb-head">
          <span className="sb-title">Import from History</span>
          <span className="ip-lede">
            Repositories you have worked in that no project claims. Nothing is created until you
            import.
          </span>
          <button className="btn btn-ghost" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        {error && <div className="banner sb-banner">{error}</div>}

        <div className="sb-list">
          {repos.length === 0 && <div className="sb-empty">Every repository in your history already has a project.</div>}
          {repos.map((repo) => {
            const draft = drafts.get(repo.repoRoot);
            if (!draft) return null;
            return (
              <div className="ip-row" key={repo.repoRoot} data-selected={draft.selected}>
                <label className="ip-check">
                  <input
                    type="checkbox"
                    checked={draft.selected}
                    onChange={(e) => patch(repo.repoRoot, { selected: e.target.checked })}
                  />
                </label>

                <div className="ip-fields">
                  <input
                    className="sb-search ip-name"
                    value={draft.name}
                    placeholder="Project name"
                    spellCheck={false}
                    onChange={(e) => patch(repo.repoRoot, { name: e.target.value })}
                  />
                  <input
                    className="sb-search ip-root"
                    value={draft.worktreeRoot}
                    placeholder="~/agents/<name>"
                    spellCheck={false}
                    onChange={(e) => patch(repo.repoRoot, { worktreeRoot: e.target.value })}
                    title="Where this project's worktrees will be created"
                  />
                </div>

                <div className="ip-meta">
                  <span className="sb-row-cwd">{homeRelative(repo.repoRoot)}</span>
                  <span className="ip-stats">
                    {repo.sessionCount} session{repo.sessionCount === 1 ? '' : 's'}
                    {/* Says WHY this is being offered, rather than asking the
                        user to trust a bare path. */}
                    {repo.directories.length > 1 && ` across ${repo.directories.length} directories`}
                    {repo.taskCount > 0 && ` · ${repo.taskCount} task${repo.taskCount === 1 ? '' : 's'}`}
                    {repo.lastActivityAt !== null && ` · last ${relativeTime(repo.lastActivityAt, now)}`}
                  </span>
                  {repo.directories.length > 1 && (
                    <span className="ip-dirs" title={repo.directories.join('\n')}>
                      {repo.directories.map((d) => homeRelative(d)).join(' · ')}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="sb-detail">
          <div className="sb-actions">
            <span className="sb-note">
              Worktrees are resolved to their repository, so importing never creates a project for
              a worktree folder.
            </span>
            <button className="btn" onClick={onClose} disabled={busy}>
              Not Now
            </button>
            <button
              className="btn btn-primary"
              onClick={() => void importChosen()}
              disabled={busy || chosen.length === 0}
            >
              Import {chosen.length > 0 ? chosen.length : ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
