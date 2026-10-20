/**
 * How a task's `claude` is started: which session, and with which flags.
 *
 * Albedo always knows the session id before `claude` runs. A new session is
 * started with an id Albedo chose (`--session-id`); a resume and a fork name
 * theirs too. That id is recorded on the task first (sessionLink.ts), so a
 * restart resumes exactly that session rather than whichever transcript
 * capture last read in the same folder.
 *
 * Pure, so every case is a test; Terminal.tsx does the I/O around it.
 */

export type SpawnMode =
  /** A new session under a new id. */
  | 'new'
  /**
   * The task has an id but Claude Code never wrote a transcript for it (it
   * was closed before anyone typed). `--resume` would be rejected; starting
   * fresh under the same id loses nothing and keeps the task's record true.
   */
  | 'reuse'
  /** Pick the task's own session back up. */
  | 'resume'
  /** History: continue a past session as this task. */
  | 'continue'
  /** History: a copy of a past session, under an id chosen here. */
  | 'fork';

export interface SpawnPlan {
  /** Flags for `claude`, before any `--name` or prompt. */
  args: string[];
  /** The session the task is on once this runs. */
  sessionId: string;
  mode: SpawnMode;
  /** The session whose last model a resume should keep, or null. */
  modelFrom: string | null;
}

export interface SpawnInput {
  /** The task's session now, or null if it never had one. */
  sessionId: string | null;
  /** History's argv for this task's first spawn (`--resume <id>` [`--fork-session`]). */
  pending?: readonly string[];
  /** The user asked for a fresh session ("Start a fresh session"). */
  fresh?: boolean;
  /** Whether `sessionId` has a transcript: true, false, or null for unknown. */
  transcriptExists: boolean | null;
  newId: () => string;
}

function valueAfter(args: readonly string[], flag: string): string | null {
  const i = args.indexOf(flag);
  const v = i >= 0 ? args[i + 1] : undefined;
  return v && !v.startsWith('-') ? v : null;
}

export function planSpawn(o: SpawnInput): SpawnPlan {
  const fresh = (): SpawnPlan => {
    const id = o.newId();
    return { args: ['--session-id', id], sessionId: id, mode: 'new', modelFrom: null };
  };
  if (o.fresh) return fresh();

  const source = o.pending ? valueAfter(o.pending, '--resume') : null;
  if (source) {
    if (o.pending!.includes('--fork-session')) {
      const id = valueAfter(o.pending!, '--session-id') ?? o.newId();
      return {
        args: ['--resume', source, '--fork-session', '--session-id', id],
        sessionId: id,
        mode: 'fork',
        modelFrom: source,
      };
    }
    return { args: ['--resume', source], sessionId: source, mode: 'continue', modelFrom: source };
  }

  if (o.sessionId === null) return fresh();
  // Unknown counts as present: the cost of a wrong resume is one rejected
  // spawn and the fresh-session offer, the cost of a wrong reuse is Claude
  // Code refusing an id that is already taken.
  if (o.transcriptExists === false) {
    return { args: ['--session-id', o.sessionId], sessionId: o.sessionId, mode: 'reuse', modelFrom: null };
  }
  return { args: ['--resume', o.sessionId], sessionId: o.sessionId, mode: 'resume', modelFrom: o.sessionId };
}

/** Whether a plan picks up an existing conversation (and so can be rejected). */
export function isResumePlan(plan: SpawnPlan): boolean {
  return plan.mode === 'resume' || plan.mode === 'continue' || plan.mode === 'fork';
}
