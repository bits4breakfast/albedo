/**
 * The Write Guide screen's options (#295): what this guide sets aside and
 * what it marks "review carefully", prefilled from the task's project.
 *
 * Changing them here applies to this guide only; Save as Project Defaults is
 * the one, explicit way to keep them for the project. The fields are the
 * Projects dialog's own (.wt-field, .wt-label, .wt-input.wt-textarea,
 * .wt-hint), so the two places read as one setting.
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Project } from '../types';
import { getProject, onProjectsChanged, updateProject } from '../db/projects';
import type { BranchDiff } from './blocks';
import { firstMatch, formatPatterns, isSetAside, parsePatterns, sameFocus, type GuideFocus } from './focus';
import { focusDraftOf, setFocusDraft, type FocusDraft } from './store';

/** The task's project, read again whenever projects change; null without one. */
export function useTaskProject(projectId: number | null): Project | null {
  const [project, setProject] = useState<Project | null>(null);
  useEffect(() => {
    if (projectId === null) {
      setProject(null);
      return;
    }
    let live = true;
    const read = async () => {
      try {
        const p = await getProject(projectId);
        if (live) setProject(p);
      } catch (err) {
        // The guide still works on Albedo's defaults; say why in the console.
        console.warn('[guide] could not read the project', err);
        if (live) setProject(null);
      }
    };
    void read();
    const off = onProjectsChanged(() => void read());
    return () => {
      live = false;
      off();
    };
  }, [projectId]);
  return project;
}

export function draftOf(focus: GuideFocus): FocusDraft {
  return { setAside: formatPatterns(focus.setAside), careful: formatPatterns(focus.careful) };
}

export function focusFromDraft(d: FocusDraft): GuideFocus {
  return { setAside: parsePatterns(d.setAside), careful: parsePatterns(d.careful) };
}

/** The focus a write uses: what was typed, else `fallback`. */
export function chosenFocus(taskId: number, fallback: GuideFocus): GuideFocus {
  const d = focusDraftOf(taskId);
  return d ? focusFromDraft(d) : fallback;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** "5 files here: a.ts, b.ts, c.ts, and 2 more" over this change's files. Pure. */
export function matchedHere(paths: readonly string[]): string {
  if (paths.length === 0) return 'No file in this change matches.';
  const names = paths.slice(0, 3).map(baseName).join(', ');
  const more = paths.length > 3 ? `, and ${paths.length - 3} more` : '';
  return `${paths.length} ${paths.length === 1 ? 'file' : 'files'} here: ${names}${more}`;
}

export function GuideOptions({
  taskId,
  diff,
  start,
  project,
  defaults,
}: {
  taskId: number;
  diff: BranchDiff;
  /** What the lists show untouched: the project's defaults, or a guide's own lists. */
  start: GuideFocus;
  project: Project | null;
  /** The project's defaults (Albedo's without a project): what Save and Reset compare with. */
  defaults: GuideFocus;
}): ReactNode {
  const draft = focusDraftOf(taskId) ?? draftOf(start);
  const focus = focusFromDraft(draft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const edit = (patch: Partial<FocusDraft>) => setFocusDraft(taskId, { ...draft, ...patch });
  const paths = diff.files.map((f) => f.path);
  const asideHere = paths.filter((p) => isSetAside(focus, p));
  const carefulHere = paths.filter((p) => firstMatch(focus.careful, p) !== null);
  const same = sameFocus(focus, defaults);

  const save = async () => {
    if (!project) return;
    setSaving(true);
    setError(null);
    try {
      await updateProject(project.id, { guideSetAside: focus.setAside, guideCareful: focus.careful });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="wt-field">
        <label className="wt-label" htmlFor={`gd-aside-${taskId}`}>
          Set Aside <span className="wt-label-optional">Grouped last, not sent to Claude</span>
        </label>
        <textarea
          id={`gd-aside-${taskId}`}
          className="wt-input wt-textarea wt-mono"
          value={draft.setAside}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => edit({ setAside: e.target.value })}
        />
        <div className="wt-hint">{matchedHere(asideHere)}</div>
      </div>
      <div className="wt-field">
        <label className="wt-label" htmlFor={`gd-careful-${taskId}`}>
          Review Carefully <span className="wt-label-optional">Marked, with why; Claude may add up to 5</span>
        </label>
        <textarea
          id={`gd-careful-${taskId}`}
          className="wt-input wt-textarea wt-mono"
          value={draft.careful}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => edit({ careful: e.target.value })}
        />
        <div className="wt-hint">{matchedHere(carefulHere)}</div>
      </div>
      <div className="gd-options-foot">
        {same ? (
          <span>
            {project ? (
              <>
                The defaults of project <strong className="gd-options-name">{project.name}</strong>.
              </>
            ) : (
              'Albedo’s defaults.'
            )}{' '}
            Changes here apply to this guide only.
          </span>
        ) : (
          <>
            <span>Changed for this guide only.</span>
            {project ? (
              <button type="button" className="gd-btn" onClick={() => void save()} disabled={saving}>
                {saving ? 'Saving…' : 'Save as Project Defaults'}
              </button>
            ) : null}
            <button type="button" className="gd-link" onClick={() => setFocusDraft(taskId, draftOf(defaults))}>
              Reset
            </button>
          </>
        )}
        {error ? (
          <span className="gd-options-error" role="alert">
            Could not save: {error}
          </span>
        ) : null}
      </div>
    </>
  );
}
