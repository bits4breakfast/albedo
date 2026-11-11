/**
 * A kept version, opened read only from its transcript chip (#348): the page
 * full height over the reading pane, the other versions of the same title a
 * click away, and what was answered. Nothing here answers anything.
 *
 * The chip sits deep in a message row; the viewer belongs to the pane. A
 * one-slot store joins them: the chip opens, the pane's host draws.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { Preview } from '../../types';
import { resolvedTheme } from '../theme';
import { PreviewBar, outcomeText } from './PreviewCard';
import { PreviewFrame } from './PreviewFrame';
import type { PreviewScheme } from './frameDoc';
import { usePreviewVersions } from './usePreviews';
import './preview.css';

let open: Preview | null = null;
const subscribers = new Set<() => void>();

function set(p: Preview | null): void {
  open = p;
  for (const cb of [...subscribers]) cb();
}

export function openPreviewViewer(p: Preview): void {
  set(p);
}

export function closePreviewViewer(): void {
  set(null);
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** The pane's host: draws the version opened, if it belongs to this task. */
export function PreviewViewerHost({ taskId }: { taskId: number | null }): ReactNode {
  const p = useSyncExternalStore(
    subscribe,
    () => open,
    () => open,
  );
  // Another task's version does not follow you to this one.
  useEffect(() => {
    if (open !== null && open.taskId !== taskId) closePreviewViewer();
  }, [taskId]);
  if (p === null || p.taskId !== taskId) return null;
  return <PreviewViewer key={p.id} first={p} onClose={closePreviewViewer} />;
}

function PreviewViewer({ first, onClose }: { first: Preview; onClose: () => void }): ReactNode {
  const stored = usePreviewVersions(first.taskId, first.title);
  const versions = useMemo(() => (stored && stored.length > 0 ? stored : [first]), [stored, first]);
  const [shownVersion, setShownVersion] = useState(first.version);
  const shown = versions.find((v) => v.version === shownVersion) ?? first;
  const [scheme, setScheme] = useState<PreviewScheme>(() => resolvedTheme());

  return (
    <div
      className="pv-viewer"
      role="dialog"
      aria-label={`Preview: ${first.title}, v${shown.version}, read only`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="pv-viewer-head">
        <span className="pv-viewer-title">
          Preview: <b>{first.title}</b>, v{shown.version}
        </span>
        <span className="pv-viewer-outcome" data-outcome={shown.outcome}>
          {outcomeText(shown.outcome)}
        </span>
        <button type="button" className="btn pv-viewer-close" aria-label="Close" onClick={onClose} autoFocus>
          <span className="pv-viewer-close-x" aria-hidden="true">
            ✕
          </span>
          Close
          <span className="kbd" aria-hidden="true">
            Esc
          </span>
        </button>
      </div>
      {shown.question ? <div className="pv-viewer-q">{shown.question}</div> : null}
      <PreviewBar versions={versions} shown={shown} onShow={setShownVersion} scheme={scheme} onScheme={setScheme} extra={null} />
      <PreviewFrame
        html={shown.html}
        title={`${shown.title}, v${shown.version}`}
        scheme={scheme}
        large
        commentMode={false}
        pins={[]}
        onPlace={() => {}}
        // Esc pressed with focus inside the page reaches the page, not here.
        onEscape={onClose}
      />
      {shown.answer ? (
        <div className="pv-viewer-answer">
          <span className="pv-viewer-answer-k">You answered</span>
          <span className="pv-viewer-answer-text">{shown.answer}</span>
        </div>
      ) : null}
    </div>
  );
}
