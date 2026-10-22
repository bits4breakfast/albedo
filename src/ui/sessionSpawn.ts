/**
 * How a task's `claude` is started: which session, and with which flags.
 *
 * Albedo always knows the session id before `claude` runs. A new session is
 * started with an id Albedo chose (`--session-id`); a resume and a fork name
 * theirs too. That id is recorded on the task first (sessionLink.ts), so a
 * restart resumes exactly that session rather than whichever transcript
 * capture last read in the same folder.
 *
 * A chat task (issue #49) carries one more flag on every spawn, whatever the
 * mode: `--append-system-prompt` with {@link CHAT_SYSTEM_PROMPT}. Not a first
 * user message -- that is lost to `/clear`, and a resumed session would never
 * see it again -- and not a permission mode: the owner chose an instruction.
 *
 * Pure, so every case is a test; Terminal.tsx does the I/O around it.
 */

import type { TaskKind } from '../types';

/**
 * What a chat task's `claude` is told on every start. The one place the text
 * lives, so it can be tuned without hunting for copies.
 */
export const CHAT_SYSTEM_PROMPT =
  'This is a conversation about the code, not a change to it. Do not create, edit, move or delete files in this folder, and do not run commands that change them (no git commits, checkouts, installs or formatters). Read whatever you need. Making changes elsewhere through other tools is fine, for example tickets, documents or pages via MCP, when the user asks for it.';

/** The flags a task's kind adds to every spawn: none for work. */
export function kindFlags(kind: TaskKind): string[] {
  return kind === 'chat' ? ['--append-system-prompt', CHAT_SYSTEM_PROMPT] : [];
}

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
  /** The task's kind: a chat adds {@link kindFlags} to whatever the mode is. */
  kind: TaskKind;
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
  const plan = planSession(o);
  const extra = kindFlags(o.kind);
  return extra.length === 0 ? plan : { ...plan, args: [...plan.args, ...extra] };
}

/** Which session, and the flags that pick it. */
function planSession(o: SpawnInput): SpawnPlan {
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
