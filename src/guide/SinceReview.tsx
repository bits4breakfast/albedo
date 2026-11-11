/**
 * "Since your review" (#352): at the top of the Guide after Update Copy, what
 * changed between the copy you had and the one you have now.
 *
 *   header       Since your review   a1b2c3d → 9f8e7d6 · 3 commits · 4 files   [Hide]
 *   explanation  two to four sentences, written once right after the update
 *                (copyUpdate.ts), with Rewrite; a placeholder while it is
 *                written, a short line if it could not be
 *   commits      `prev..next`: short sha, subject, age; "force-pushed" when
 *                the old head is not in the new one
 *   files        `git diff --numstat prev next`; each opens that file's diff,
 *                old copy -> new, in the one diff component, under the lists
 *
 * Hide puts it away until the next update. A rewritten guide keeps it.
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Task } from '../types';
import { composeFileDiff, readAtRev, type FileDiffResult } from '../git/fileDiff';
import type { SinceChanges, SinceFile } from '../git/reviewUpdate';
import { Diff } from '../ui/transcript/Diff';
import { relativeTime } from '../ui/TaskList';
import {
  explainStateOf,
  hideSince,
  startExplanation,
  useSinceReviewVersion,
  type ChangesLoad,
  type UpdateRecord,
} from './copyUpdate';

const short = (sha: string) => sha.slice(0, 7);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export interface SinceReviewProps {
  task: Pick<Task, 'id' | 'worktreePath'>;
  record: UpdateRecord;
  changes: ChangesLoad;
  /** Now, ms; a test seam. */
  now?: number;
}

export default function SinceReview({ task, record, changes, now }: SinceReviewProps): ReactNode {
  useSinceReviewVersion();
  const [open, setOpen] = useState<string | null>(null);
  const ready = changes.kind === 'ready' ? changes.changes : null;
  const forced = ready?.forced ?? record.forced;
  const facts = [
    `${short(record.prev)} → ${short(record.next)}`,
    ready ? plural(ready.commits.length, 'commit', 'commits') : null,
    ready ? plural(ready.files.length, 'file', 'files') : null,
    forced ? 'force-pushed' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const t = now ?? Date.now();
  return (
    <section className="gd-since" aria-label="Since your review">
      <div className="gd-since-head">
        <b className="gd-since-title">Since your review</b>
        <span className="gd-since-facts" title={`${record.prev} → ${record.next}\nUpdated ${new Date(record.at).toLocaleString()}`}>
          {facts}
        </span>
        <span className="gd-since-gap" />
        <button type="button" className="gd-btn" onClick={() => hideSince(task.id)} title="Hide until the next update">
          Hide
        </button>
      </div>
      {record.kept && (
        <p className="gd-since-note">
          Your previous copy is kept on the branch <code>{record.kept}</code>, with any commits you made in it.
        </p>
      )}
      <Explanation task={task} record={record} />
      {changes.kind === 'loading' ? (
        <p className="gd-since-note">Reading the changes…</p>
      ) : changes.kind === 'error' ? (
        <p className="gd-since-note" data-tone="error">
          Couldn’t read the changes: {changes.message}
        </p>
      ) : (
        <>
          <div className="gd-since-lists">
            <div>
              <h3 className="gd-since-label">{forced ? 'Commits, force-pushed' : 'Commits'}</h3>
              {changes.changes.commits.length === 0 ? (
                <p className="gd-since-note">No new commits: only the history changed.</p>
              ) : (
                <ul className="gd-since-commits">
                  {changes.changes.commits.map((c) => (
                    <li key={c.sha} className="gd-since-commit" title={`${c.sha}\n${new Date(c.at).toLocaleString()}`}>
                      <span className="gd-since-sha">{short(c.sha)}</span>
                      <span className="gd-since-subject">{c.subject}</span>
                      <span className="gd-since-age">{relativeTime(c.at, t)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="gd-since-label">Files, against your copy</h3>
              <ul className="gd-since-files">
                {changes.changes.files.map((f) => (
                  <li key={f.path}>
                    <button
                      type="button"
                      className="gd-since-file"
                      aria-expanded={open === f.path}
                      onClick={() => setOpen((o) => (o === f.path ? null : f.path))}
                      title={`${f.path}\nShow its diff from your old copy to the new one`}
                    >
                      <span className="gd-since-path">{f.path}</span>
                      <FileCounts file={f} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          {open !== null ? <SinceFileDiff task={task} record={record} path={open} changes={changes.changes} /> : null}
        </>
      )}
    </section>
  );
}

function FileCounts({ file }: { file: SinceFile }): ReactNode {
  if (file.added === null || file.deleted === null) return <span className="gd-counts">Binary</span>;
  return (
    <span className="gd-counts">
      <span className="gd-add">+{file.added}</span>
      <span className="gd-del">−{file.deleted}</span>
    </span>
  );
}

function Explanation({ task, record }: { task: Pick<Task, 'id' | 'worktreePath'>; record: UpdateRecord }): ReactNode {
  const state = explainStateOf(task.id);
  const rewrite = () => void startExplanation(task.id, task.worktreePath);
  const writing = state?.kind === 'writing';
  const link = (
    <button type="button" className="gd-link" onClick={rewrite} disabled={writing}>
      {record.explanation ? 'Rewrite' : 'Write'}
    </button>
  );
  if (writing) {
    return (
      <div className="gd-since-what" role="status" aria-live="polite">
        <p className="gd-since-text gd-since-pending">Writing what changed…</p>
      </div>
    );
  }
  if (state?.kind === 'failed') {
    return (
      <div className="gd-since-what">
        <p className="gd-since-note" data-tone="error" role="alert">
          Couldn’t write what changed: {state.message}
        </p>
        <span className="gd-since-by">{link}</span>
      </div>
    );
  }
  if (!record.explanation) {
    return (
      <div className="gd-since-what">
        <p className="gd-since-note">What changed hasn’t been written.</p>
        <span className="gd-since-by">{link}</span>
      </div>
    );
  }
  return (
    <div className="gd-since-what">
      <p className="gd-since-text">{record.explanation.text}</p>
      <span className="gd-since-by">
        Written from the changes since your copy{record.explanation.cut ? ', with the diff cut to fit' : ''} · {link}
      </span>
    </div>
  );
}

type FileLoad = { kind: 'loading' } | { kind: 'ready'; result: FileDiffResult } | { kind: 'error'; message: string };

/** One file, old copy -> new, in the one diff component. */
function SinceFileDiff({
  task,
  record,
  path,
  changes,
}: {
  task: Pick<Task, 'worktreePath'>;
  record: UpdateRecord;
  path: string;
  changes: SinceChanges;
}): ReactNode {
  const [load, setLoad] = useState<FileLoad>({ kind: 'loading' });
  useEffect(() => {
    let live = true;
    setLoad({ kind: 'loading' });
    Promise.all([readAtRev(task.worktreePath, record.prev, path), readAtRev(task.worktreePath, record.next, path)])
      .then(([a, b]) => live && setLoad({ kind: 'ready', result: composeFileDiff(a, b, path) }))
      .catch((err: unknown) => live && setLoad({ kind: 'error', message: err instanceof Error ? err.message : String(err) }));
    return () => {
      live = false;
    };
  }, [task.worktreePath, record.prev, record.next, path]);
  const known = changes.files.some((f) => f.path === path);
  let body: ReactNode;
  if (!known) body = null;
  else if (load.kind === 'loading') body = <p className="gd-since-note">Reading the file…</p>;
  else if (load.kind === 'error') body = <p className="gd-since-note" data-tone="error">{load.message}</p>;
  else if (load.result.kind === 'binary') body = <p className="gd-since-note">Binary file. No text diff to show.</p>;
  else if (load.result.kind === 'too-large') body = <p className="gd-since-note">Too large to diff here.</p>;
  else if (load.result.kind !== 'diff') body = <p className="gd-since-note">Nothing to show for this file.</p>;
  else {
    const r = load.result;
    body = (
      <Diff
        diff={r.diff}
        expand={{ oldText: r.oldText, newText: r.newText }}
        contextPath={null}
        showPath
      />
    );
  }
  return (
    <div className="gd-since-diff" aria-label={`${path}, your old copy to the new one`} role="region">
      {body}
    </div>
  );
}
