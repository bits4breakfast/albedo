/**
 * A pull request's checks in detail, opened from the PR badge: each check,
 * each Actions job's steps, and -- for a failing one -- the failed step's log
 * and annotations, with *Ask Claude to Fix* to hand that to the session.
 *
 * Find in Files' dialog (quickopen.css, findinfiles.css): same overlay,
 * dialog, head and footer, so no new surface. Escape or a click outside
 * closes it.
 *
 * Fetched only while open, and only what is open: the check list on open and
 * every {@link POLL_PENDING_MS} while something runs; a job's steps when its
 * row is expanded; a finished job's log and annotations once per job, ever --
 * a finished job never changes, and a rerun is a new job.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { OpenFileRequest, Task } from '../types';
import { openExternal } from '../lib/openUrl';
import { fetchAnnotations, fetchJob, fetchJobLog, fetchPrChecks } from '../gh/gh';
import { POLL_PENDING_MS } from '../gh/prStore';
import type { PrStatus } from '../gh/prStatus';
import {
  annotationPlace,
  checksFromLines,
  failedStep,
  failureLines,
  fixPrompt,
  tailLines,
  timeLabel,
  VIEW_TAIL_LINES,
  type Annotation,
  type CheckSource,
  type CheckState,
  type JobDetail,
  type JobStep,
  type PrCheck,
  type StepState,
} from '../gh/checks';
import { insertIntoComposer } from './transcript/composerBridge';
import { Disclosure } from './transcript/Diff';
import './quickopen.css';
import './findinfiles.css';
import './checks.css';

type JobRef = Extract<CheckSource, { kind: 'actions' }>;

const JOB_LINK = 'Open Job on GitHub';

// --- once per finished job, for the life of the app ------------------------

const logs = new Map<string, Promise<string[] | null>>();
const notes = new Map<string, Promise<Annotation[]>>();

/** A finished job's failure lines. A failed fetch is forgotten, so reopening asks again. */
function failureLog(ref: JobRef, job: JobDetail): Promise<string[] | null> {
  let p = logs.get(ref.jobId);
  if (!p) {
    p = fetchJobLog(ref).then((log) => (log === null ? null : failureLines(log, job)));
    logs.set(ref.jobId, p);
    void p.then((v) => v === null && logs.delete(ref.jobId));
  }
  return p;
}

function annotationsOf(ref: { host: string; repo: string; id: string }): Promise<Annotation[]> {
  let p = notes.get(ref.id);
  if (!p) {
    p = fetchAnnotations(ref);
    notes.set(ref.id, p);
  }
  return p;
}

/** Test seam: forget every cached log and annotation. */
export function clearCheckCachesForTests(): void {
  logs.clear();
  notes.clear();
}

// --- words and glyphs --------------------------------------------------------

/** Glyph AND word everywhere a state shows (HIG: never colour alone). */
const GLYPH: Record<CheckState | StepState, string> = {
  pass: '✓',
  fail: '✗',
  pending: '●',
  running: '●',
  skipped: '–',
  cancelled: '×',
};
const WORD: Record<CheckState | StepState, string> = {
  pass: 'Passed',
  fail: 'Failed',
  pending: 'Pending',
  running: 'Running',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
};

function summary(checks: PrCheck[]): string {
  const n = (s: CheckState) => checks.filter((c) => c.state === s).length;
  const parts: string[] = [];
  if (n('fail')) parts.push(`${n('fail')} failing`);
  if (n('pending')) parts.push(`${n('pending')} running`);
  if (n('cancelled')) parts.push(`${n('cancelled')} cancelled`);
  if (n('pass')) parts.push(`${n('pass')} passing`);
  if (n('skipped')) parts.push(`${n('skipped')} skipped`);
  return parts.join(', ') || 'No checks';
}

// --- the dialog --------------------------------------------------------------

export interface ChecksDialogProps {
  task: Pick<Task, 'id' | 'worktreePath' | 'repoPath'>;
  pr: PrStatus;
  onClose: () => void;
  /** Opens an annotation's file at its line, in the task's editor. */
  onOpenFile?: (request: OpenFileRequest) => void;
}

export default function ChecksDialog({ task, pr, onClose, onOpenFile }: ChecksDialogProps) {
  // The badge's lines at once; gh's answer, with times, replaces them.
  const [checks, setChecks] = useState<PrCheck[]>(() => checksFromLines(pr.lines));
  const [answered, setAnswered] = useState(false);
  const [open, setOpen] = useState<Set<string>>(() => {
    // The first failure, opened: it is why the dialog was opened. One, not
    // all: each open job is a gh call, and the rest are a click away.
    const first = checksFromLines(pr.lines).find((c) => c.state === 'fail' && c.source.kind !== 'external');
    return new Set(first ? [first.name] : []);
  });
  const [notice, setNotice] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const pending = checks.some((c) => c.state === 'pending');
  /** Bumped by each poll: open jobs that are still running ask for their steps again. */
  const [tick, setTick] = useState(0);
  useEffect(() => {
    void fetchPrChecks(pr.number, task).then((next) => {
      if (!live.current) return;
      setAnswered(true);
      if (next) setChecks(next);
    });
  }, [pr.number, task.id, tick]);
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), POLL_PENDING_MS);
    return () => window.clearInterval(timer);
  }, [pending]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const now = useClock(pending);

  const toggle = (name: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const askFix = (text: string) => {
    if (insertIntoComposer({ taskId: task.id, text })) onClose();
    else setNotice('Open the task’s transcript to get its message box, then try again.');
  };

  // On the body: the badge sits in a pane head, whose clipping and stacking
  // must not reach an overlay. React events still bubble to the badge's
  // ancestors through a portal, so a click stops here.
  return createPortal(
    <div
      className="qo-overlay"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        ref={dialogRef}
        className="qo-dialog ff-dialog ck-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Checks for pull request ${pr.number}`}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }}
      >
        <div className="ff-head ck-head">
          <span className="ff-title">Checks</span>
          <span className="ck-pr" title={pr.title}>
            #{pr.number} {pr.title}
          </span>
          <button type="button" className="btn btn-ghost ck-head-link" onClick={() => void openExternal(pr.url)}>
            Open PR on GitHub
          </button>
        </div>
        {notice && (
          <div className="qo-scope ck-notice" role="alert">
            {notice}
          </div>
        )}
        <div className="qo-list ck-list">
          {checks.map((c) => (
            <CheckRow
              key={c.name}
              check={c}
              prNumber={pr.number}
              open={open.has(c.name)}
              now={now}
              pollKey={tick}
              onToggle={() => toggle(c.name)}
              onAskFix={askFix}
              onOpenFile={
                onOpenFile
                  ? (req) => {
                      onOpenFile(req);
                      onClose();
                    }
                  : undefined
              }
            />
          ))}
        </div>
        <div className="qo-foot">
          <span className="qo-status" role="status" aria-live="polite">
            {answered ? summary(checks) : `${summary(checks)} · Updating…`}
          </span>
          <span className="qo-hint">Esc Close</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Now, ticking each second while something runs: elapsed times stay true. */
function useClock(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  return ticking ? now : Date.now();
}

// --- one check ---------------------------------------------------------------

interface CheckRowProps {
  check: PrCheck;
  prNumber: number;
  open: boolean;
  now: number;
  /** Changes on every poll: a running job's steps are asked for again. */
  pollKey: number;
  onToggle: () => void;
  onAskFix: (text: string) => void;
  onOpenFile?: (request: OpenFileRequest) => void;
}

function CheckRow({ check, prNumber, open, now, pollKey, onToggle, onAskFix, onOpenFile }: CheckRowProps) {
  const { source } = check;
  const head = (
    <>
      <span className="ck-glyph" data-state={check.state} aria-hidden="true">
        {GLYPH[check.state]}
      </span>
      <span className="ck-name" title={check.description || check.name}>
        {check.name}
      </span>
      <span className="ck-time">
        <span className="sr-only">{WORD[check.state]} </span>
        {timeLabel(check, now)}
      </span>
    </>
  );

  // Another host's check: its state, and a way there. No caret, no empty
  // panel -- there is nothing here to expand into.
  if (source.kind === 'external') {
    const { host } = source;
    return (
      <div className="ck-check">
        <div className="ck-row" data-state={check.state}>
          <span className="ck-caret-space" aria-hidden="true" />
          {head}
          {check.link && (
            <button
              type="button"
              className="btn btn-ghost ck-out"
              title={check.link}
              onClick={() => void openExternal(check.link!)}
            >
              {host ? `Logs on ${host}` : 'Details'}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="ck-check">
      <button type="button" className="ck-row" data-state={check.state} aria-expanded={open} onClick={onToggle}>
        <Disclosure open={open} />
        {head}
      </button>
      {open &&
        (source.kind === 'actions' ? (
          <JobBody
            // A rerun is a new job: start it from nothing.
            key={source.jobId}
            check={check}
            source={source}
            prNumber={prNumber}
            now={now}
            pollKey={pollKey}
            onAskFix={onAskFix}
            onOpenFile={onOpenFile}
          />
        ) : (
          <CheckRunBody check={check} source={source} prNumber={prNumber} onAskFix={onAskFix} onOpenFile={onOpenFile} />
        ))}
    </div>
  );
}

// --- an Actions job ----------------------------------------------------------

function JobBody({
  check,
  source,
  prNumber,
  now,
  pollKey,
  onAskFix,
  onOpenFile,
}: {
  check: PrCheck;
  source: JobRef;
  prNumber: number;
  now: number;
  pollKey: number;
  onAskFix: (text: string) => void;
  onOpenFile?: (request: OpenFileRequest) => void;
}) {
  const [job, setJob] = useState<JobDetail | null | undefined>(undefined);
  const [log, setLog] = useState<string[] | null | undefined>(undefined);
  const [annotations, setAnnotations] = useState<Annotation[] | undefined>(undefined);
  const done = job?.completed === true;

  // Steps: on open, and again on each poll until the job is over.
  useEffect(() => {
    if (done) return;
    let live = true;
    void fetchJob(source).then((j) => {
      if (live) setJob((prev) => j ?? (prev === undefined ? null : prev));
    });
    return () => {
      live = false;
    };
  }, [source.jobId, pollKey, done]);

  const failed = job && done && job.state === 'fail' ? job : null;
  useEffect(() => {
    if (!failed) return;
    let live = true;
    void failureLog(source, failed).then((l) => live && setLog(l));
    void annotationsOf({ ...source, id: source.jobId }).then((a) => live && setAnnotations(a));
    return () => {
      live = false;
    };
  }, [failed?.id]);

  if (job === undefined) return <div className="ck-body ck-quiet">Loading steps…</div>;
  if (job === null) {
    return (
      <div className="ck-body">
        <div className="ck-quiet">GitHub did not give this job’s steps.</div>
        <BodyActions link={check.link} label={JOB_LINK} />
      </div>
    );
  }

  const stepFailed = failedStep(job);
  const failure = failed ? (
    <Failure
      log={log}
      annotations={annotations ?? []}
      onOpenFile={onOpenFile}
      onAskFix={() =>
        onAskFix(
          fixPrompt({
            prNumber,
            check: check.name,
            step: stepFailed?.name ?? null,
            url: job.url ?? check.link,
            log: log ?? null,
            annotations: annotations ?? [],
          }),
        )
      }
      // The prompt carries both: it waits for both.
      askReady={log !== undefined && annotations !== undefined}
      link={job.url ?? check.link}
      linkLabel={JOB_LINK}
    />
  ) : null;

  return (
    <div className="ck-body">
      {job.steps.length === 0 && <div className="ck-quiet">No steps have started yet.</div>}
      <ol className="ck-steps" aria-label={`Steps of ${check.name}`}>
        {job.steps.map((s) => (
          <StepRow key={s.number} step={s} now={now}>
            {s === stepFailed ? failure : null}
          </StepRow>
        ))}
      </ol>
      {/* A failure no step owns (setup, a cancelled runner): under the list. */}
      {!stepFailed && failure}
      {!failure && <BodyActions link={job.url ?? check.link} label={JOB_LINK} />}
    </div>
  );
}

function StepRow({ step, now, children }: { step: JobStep; now: number; children: ReactNode }) {
  return (
    <li className="ck-step" data-state={step.state}>
      <div className="ck-step-row">
        <span className="ck-glyph" data-state={step.state} aria-hidden="true">
          {GLYPH[step.state]}
        </span>
        <span className="ck-step-name">{step.name}</span>
        <span className="ck-time">
          <span className="sr-only">{WORD[step.state]} </span>
          {timeLabel(step, now)}
        </span>
      </div>
      {children}
    </li>
  );
}

// --- another app's check run on GitHub: annotations only ---------------------

function CheckRunBody({
  check,
  source,
  prNumber,
  onAskFix,
  onOpenFile,
}: {
  check: PrCheck;
  source: Extract<CheckSource, { kind: 'check-run' }>;
  prNumber: number;
  onAskFix: (text: string) => void;
  onOpenFile?: (request: OpenFileRequest) => void;
}) {
  const [annotations, setAnnotations] = useState<Annotation[] | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void annotationsOf(source).then((a) => live && setAnnotations(a));
    return () => {
      live = false;
    };
  }, [source.id]);

  if (annotations === undefined) return <div className="ck-body ck-quiet">Loading annotations…</div>;
  if (check.state === 'fail') {
    return (
      <div className="ck-body">
        <Failure
          log={null}
          annotations={annotations}
          onOpenFile={onOpenFile}
          askReady
          onAskFix={() =>
            onAskFix(fixPrompt({ prNumber, check: check.name, step: null, url: check.link, log: null, annotations }))
          }
          link={check.link}
          linkLabel="Open on GitHub"
          noLog="This check has no log Albedo can read; GitHub has its details."
        />
      </div>
    );
  }
  return (
    <div className="ck-body">
      {annotations.length > 0 ? (
        <Annotations list={annotations} onOpenFile={onOpenFile} />
      ) : (
        <div className="ck-quiet">No annotations.</div>
      )}
      <BodyActions link={check.link} label="Open on GitHub" />
    </div>
  );
}

// --- the failure -------------------------------------------------------------

function Failure({
  log,
  annotations,
  askReady,
  link,
  linkLabel,
  noLog,
  onAskFix,
  onOpenFile,
}: {
  /** undefined while it loads, null when it could not be read. */
  log: string[] | null | undefined;
  annotations: Annotation[];
  askReady: boolean;
  link: string | null;
  linkLabel: string;
  noLog?: string;
  onAskFix: () => void;
  onOpenFile?: (request: OpenFileRequest) => void;
}) {
  const view = useMemo(() => (log ? tailLines(log, VIEW_TAIL_LINES) : null), [log]);
  return (
    <div className="ck-failure">
      {log === undefined ? (
        <div className="ck-quiet">Loading the log…</div>
      ) : view && view.lines.length > 0 ? (
        <>
          {view.cut && <div className="ck-quiet">Last {view.lines.length} lines</div>}
          <pre className="tx-pre ck-log">{view.lines.join('\n')}</pre>
        </>
      ) : (
        <div className="ck-quiet">{noLog ?? 'The log could not be read; GitHub has it.'}</div>
      )}
      {annotations.length > 0 && <Annotations list={annotations} onOpenFile={onOpenFile} />}
      <div className="ck-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!askReady}
          title="Put the check, the step, the run link and the log in the message box, to read and send"
          onClick={onAskFix}
        >
          Ask Claude to Fix…
        </button>
        {link && (
          <button type="button" className="btn btn-ghost" onClick={() => void openExternal(link)}>
            {linkLabel}
          </button>
        )}
      </div>
    </div>
  );
}

function Annotations({ list, onOpenFile }: { list: Annotation[]; onOpenFile?: (request: OpenFileRequest) => void }) {
  return (
    <ul className="ck-notes" aria-label="Annotations">
      {list.map((a, i) => (
        <li key={i} className="ck-note" data-level={a.level}>
          {onOpenFile ? (
            <button
              type="button"
              className="ck-place"
              title={`Open ${annotationPlace(a)}`}
              onClick={() => onOpenFile({ path: a.path, line: a.line })}
            >
              {annotationPlace(a)}
            </button>
          ) : (
            <span className="ck-place">{annotationPlace(a)}</span>
          )}
          <span className="ck-note-text">{a.message}</span>
        </li>
      ))}
    </ul>
  );
}

function BodyActions({ link, label }: { link: string | null; label: string }) {
  if (!link) return null;
  return (
    <div className="ck-actions">
      <button type="button" className="btn btn-ghost" onClick={() => void openExternal(link)}>
        {label}
      </button>
    </div>
  );
}
