import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { spawnPty, writePty, resizePty, killPty } from '../lib/pty';
import { openExternal } from '../lib/openUrl';
import { endTaskEvents, hookSettingsArg, onSessionStart, resetTaskEvents, startHookEvents } from '../capture/hookEvents';
import { folderTrusted, isTrustWaiting, onTrustWaiting, setTrustWaiting } from '../capture/workspaceTrust';
import { lastModelOf, linkTaskSession, newSessionId, sessionTranscriptExists } from '../capture/sessionLink';
import { getTaskModel } from './taskModel';
import { isResumePlan, planSpawn, withMcpConfig } from './sessionSpawn';
import { mcpServerPath } from '../capture/inbox';
import { displayName } from './text';
import { submitDelayFor, pasteSegments, SUBMIT_DELAY_IMAGE_MS, type PasteSegment } from '../lib/ptyInput';
import { markerSpans } from './transcript/albedoMarkers';
import type { Task } from '../types';
import { onThemeChange, resolvedTheme } from './theme';
import { TASK_TERMINAL_ATTR, taskTerminalTakesKey } from './shortcuts';
import { focusOnItsOwn } from './focusAreas';
import './terminal.css';

/**
 * The embedded pty.
 *
 * Two rules this component exists to hold:
 *
 * 1. Output bytes go to xterm **as bytes**. Never decode to a string first —
 *    a chunk boundary in the middle of a UTF-8 sequence (or an escape) shreds
 *    Claude Code's TUI.
 * 2. Resize is debounced and deduplicated. `fit()` runs on a trailing 100ms
 *    timer and `resizePty` is only called when cols/rows actually changed.
 *    Resizing a pty on every frame of a splitter drag is the documented way to
 *    wedge a TUI.
 *
 * Lifetime: one instance per task, mounted for as long as the task is open.
 * The parent hides inactive terminals rather than unmounting them, so a running
 * session survives tab switching. Cleanup (unsubscribe, kill, dispose) happens
 * only on real unmount — archive or close.
 */

const RESIZE_DEBOUNCE_MS = 100;

// ---------------------------------------------------------------------------
// Live pty registry
//
// One entry per task that currently has a spawned, un-exited pty. Kept at
// module scope so `notePty` can reach a terminal without the caller holding a
// ref to the component -- the editor workstream calls it from a save handler.
// ---------------------------------------------------------------------------

const livePtys = new Map<number, string>();
/** When each live pty was spawned, ms. A new `claude` process starts with an empty input queue. */
const liveSince = new Map<number, number>();

/**
 * Per-task "start a session here". Registered by each mounted Terminal, which
 * is the only thing that can actually spawn — see {@link startPty}.
 */
const starters = new Map<number, () => boolean>();

/** Give a task's terminal keyboard focus. Registered while its Terminal is mounted. */
const focusers = new Map<number, () => void>();

/**
 * Tasks whose next start would RESUME their conversation rather than begin a
 * new one. Per-task and module-level so callers outside the component can ask
 * — the fact was already tracked inside Terminal, it just had no accessor.
 */
const resumable = new Set<number>();

/** Notified whenever a task gains or loses a live pty. */
const presenceListeners = new Set<(taskId: number, live: boolean) => void>();

function notifyPresence(taskId: number, live: boolean): void {
  for (const cb of [...presenceListeners]) {
    try {
      cb(taskId, live);
    } catch {
      /* one listener failing must not stop the rest */
    }
  }
}

function registerPty(taskId: number, ptyId: string): void {
  livePtys.set(taskId, ptyId);
  liveSince.set(taskId, Date.now());
  notifyPresence(taskId, true);
}

function unregisterPty(taskId: number, ptyId: string): void {
  if (livePtys.get(taskId) !== ptyId) return;
  livePtys.delete(taskId);
  liveSince.delete(taskId);
  notifyPresence(taskId, false);
}

/**
 * Place text in the task's pty input WITHOUT submitting it.
 *
 * The agent may be mid-turn, so sending stays manual: this writes the text and
 * leaves the cursor after it. Newlines and carriage returns are collapsed to
 * spaces before writing -- a stray \n here would submit the line to a running
 * agent, which is exactly what the spec forbids.
 *
 * SEE {@link submitPty}, which does the opposite on purpose. These two look
 * mergeable and are not: this one fires unprompted, after a file save, when
 * the user has not asked to send anything; that one fires because the user
 * pressed send. Unifying them would mean one of those behaviours is wrong.
 *
 * Returns false when the task has no live pty (never started, or exited).
 */
export async function notePty(taskId: number, text: string): Promise<boolean> {
  const ptyId = livePtys.get(taskId);
  if (!ptyId) return false;
  const payload = text.replace(/[\r\n]+/g, ' ').trim();
  if (!payload) return false;
  try {
    await writePty(ptyId, payload);
    return true;
  } catch {
    return false;
  }
}

/**
 * Send text to the task's pty AND submit it.
 *
 * The counterpart to {@link notePty}: same registry, opposite intent. This one
 * exists so a composer at the foot of the read pane can send a message without
 * the user switching panes. The architecture is unchanged -- the pty still
 * executes, this is only a better input affordance.
 *
 * ## Bracketed paste, always
 *
 * The body is wrapped in `ESC[200~` / `ESC[201~` and then submitted with a
 * single `\r`. Without the wrapper the TUI treats every embedded newline as its
 * own submission, so a three-line message becomes three turns and the agent
 * starts answering line one before it has seen lines two and three.
 *
 * Applied UNIFORMLY, single-line included: one code path is worth more than
 * the handful of bytes saved, and a conditional wrapper is the kind of thing
 * that gets tested only on the easy case. Callers must NOT wrap again.
 *
 * The submitting `\r` is a separate write after a pause -- see the body.
 *
 * Returns false when the task has no live pty, so the caller can offer to
 * start the session rather than silently dropping what the user typed.
 */
export async function submitPty(taskId: number, text: string): Promise<boolean> {
  const ptyId = livePtys.get(taskId);
  if (!ptyId) return false;
  // Normalise line endings first: a stray CR inside the paste would submit
  // early, which is the exact failure the bracketing exists to prevent.
  const body = text.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  if (body.length === 0) return false;
  try {
    // The paste and the Enter go as TWO writes, with a pause between. Sent in
    // one write, Claude Code dropped the Enter that arrived on the heels of
    // the paste: the message sat unsent in its input box, the composer had
    // already cleared, and the next message was appended to it and sent
    // both. An image path takes longer still, because Claude Code reads the
    // file to turn it into an attachment before it will take Enter. Nothing
    // here can observe readiness -- that would mean reading terminal output --
    // so the pause is a fixed, generous one.
    // One paste per image path, or Claude Code takes the path as text and the
    // picture never reaches the model (see pasteSegments).
    // A paste from the message box goes whole, path or not (albedoMarkers.ts).
    const segments = pasteSegments(body, markerSpans(body));
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i] as PasteSegment;
      await writePty(ptyId, `\x1b[200~${seg.text}\x1b[201~`);
      // It reads the file before it takes the next keystroke.
      if (seg.image && i < segments.length - 1) await sleep(SUBMIT_DELAY_IMAGE_MS);
      if (livePtys.get(taskId) !== ptyId) return false;
    }
    await sleep(submitDelayFor(body));
    if (livePtys.get(taskId) !== ptyId) return false; // exited in the pause
    await writePty(ptyId, '\r');
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Move keyboard focus into the task's terminal. False when none is mounted. */
export function focusPty(taskId: number): boolean {
  const focus = focusers.get(taskId);
  if (!focus) return false;
  focus();
  return true;
}

/** True when the task has a spawned, un-exited pty. */
export function hasLivePty(taskId: number): boolean {
  return livePtys.has(taskId);
}

/**
 * When the task's live pty was spawned, or null with none. Claude Code's
 * input queue lives in its process, so nothing queued before this moment is
 * still waiting in it.
 */
export function ptyLiveSince(taskId: number): number | null {
  return liveSince.get(taskId) ?? null;
}

/** {@link ptyLiveSince} for a component, kept current by presence events. */
export function usePtyLiveSince(taskId: number | null): number | null {
  const read = () => (taskId === null ? null : ptyLiveSince(taskId));
  const [since, setSince] = useState(read);
  useEffect(() => {
    if (taskId === null) {
      setSince(null);
      return;
    }
    setSince(ptyLiveSince(taskId));
    return onPtyPresenceChange((id) => {
      if (id === taskId) setSince(ptyLiveSince(taskId));
    });
  }, [taskId]);
  return since;
}

/**
 * True when restarting this task would pick its conversation back up.
 *
 * False in two cases, which look the same to a caller and are not worth
 * separating: the task has never established a session, or a `--resume` for it
 * was already rejected by the CLI (a pruned transcript). Either way a fresh
 * session is all that is available, and a caller promising to reopen the
 * conversation would be over-promising.
 *
 * The conversation itself is on disk regardless — this is about whether the
 * CLI can pick it up again, not whether it still exists.
 */
export function canResume(taskId: number): boolean {
  return resumable.has(taskId);
}

/**
 * Subscribe to liveness changing for any task.
 *
 * {@link hasLivePty} answers "right now", which is enough to warn someone
 * BEFORE they type, but it goes stale the moment a session exits under an open
 * composer. Telling somebody their session is gone after they have written
 * three paragraphs is the bad version of this warning, so liveness is
 * observable rather than only pollable.
 */
export function onPtyPresenceChange(
  cb: (taskId: number, live: boolean) => void,
): () => void {
  presenceListeners.add(cb);
  return () => {
    presenceListeners.delete(cb);
  };
}

/**
 * Start a session for a task that has none, in place.
 *
 * Exists so a composer outside the terminal can OFFER to start rather than
 * instructing the user to go and do it. Deliberately does NOT switch panes or
 * move focus: starting is the thing that was actually wanted, and a caller that
 * sends its message afterwards has no reason to drag the user to another pane.
 *
 * Returns true when a session is live or on its way, false only when there is
 * no mounted Terminal for the task at all — i.e. the task is not open, which
 * the caller cannot fix and should report rather than retry.
 *
 * Idempotent: safe to call when one is already live, and safe to call twice
 * while a spawn is in flight.
 */
export function startPty(taskId: number): boolean {
  if (livePtys.has(taskId)) return true;
  const start = starters.get(taskId);
  if (!start) return false;
  return start();
}

type Phase = 'starting' | 'live' | 'exited' | 'failed';

export interface TerminalProps {
  task: Task;
  /** False keeps the instance alive but hidden. */
  active?: boolean;
  /**
   * Passed to `claude` as a positional argv prompt on spawn. The caller is
   * responsible for only supplying it on a task's FIRST spawn — see the ref
   * snapshot below for why this component pins it at mount regardless.
   */
  initialPrompt?: string;
  /**
   * Full argv for `claude`, e.g. `['--resume', '<id>']`. Takes precedence over
   * `initialPrompt` — a resumed session already has its context and must not
   * also be handed the project's opening prompt.
   */
  spawnArgs?: string[];
  /**
   * Called when the user abandons a failed resume and starts fresh, so the
   * caller can drop any stale resume args it is holding — otherwise a retry
   * would re-attempt the same dead session id.
   */
  onFreshStart?: () => void;
  /**
   * Becomes `--name <sessionName>`, which sets the session's display name in
   * Claude Code's own prompt box, /resume picker and terminal title. Supplied
   * only when we are CREATING a session — never on a plain re-open, because
   * renaming someone's session out from under them is exactly the quiet
   * mutation this app should not do.
   */
  sessionName?: string;
  onExit?: (code: number | null) => void;
  onError?: (message: string) => void;
}

export function cssVar(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

/**
 * The 16 ANSI slots cannot come from the shell tokens -- there are sixteen of
 * them and they are the TUI's own vocabulary, not the app's. They do have to
 * be per-theme though: ANSI `white` at #ccd3de is *invisible* on a white
 * background, so a light terminal has to map white/brightWhite to dark values.
 * That is standard for light terminal themes, and it is the difference between
 * a readable Claude Code session and a blank pane.
 */
const ANSI_DARK = {
  black: '#0b0d10',
  red: '#e35b56',
  green: '#4cbf72',
  yellow: '#f0a33a',
  blue: '#4d9fff',
  magenta: '#b98ce8',
  cyan: '#3fb9c4',
  white: '#ccd3de',
  brightBlack: '#6d7684',
  brightRed: '#ff7b74',
  brightGreen: '#6fdd92',
  brightYellow: '#ffc164',
  brightBlue: '#79b9ff',
  brightMagenta: '#d0abff',
  brightCyan: '#5fd8e2',
  brightWhite: '#f1f4f9',
} as const;

const ANSI_LIGHT = {
  black: '#1e242c',
  red: '#b32d27',
  green: '#116b33',
  yellow: '#7d520a',
  blue: '#0b57bd',
  magenta: '#8a3fa8',
  cyan: '#0f6d78',
  white: '#4a525e',
  brightBlack: '#6b7380',
  brightRed: '#d1443d',
  brightGreen: '#1a8442',
  brightYellow: '#9a6610',
  brightBlue: '#1a6fd6',
  brightMagenta: '#a052c0',
  brightCyan: '#14828f',
  brightWhite: '#0b0f14',
} as const;

/** Palette derived from the shell tokens in styles.css. */
export function terminalTheme(): ITheme {
  return {
    background: cssVar('--panel-inset', '#090b0e'),
    foreground: cssVar('--text', '#ccd3de'),
    cursor: cssVar('--accent', '#4d9fff'),
    cursorAccent: cssVar('--panel-inset', '#090b0e'),
    selectionBackground: cssVar('--term-selection', 'rgba(77, 159, 255, 0.28)'),
    ...(resolvedTheme() === 'dark' ? ANSI_DARK : ANSI_LIGHT),
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `claude [options] [prompt]`. Each element stays a separate argv entry so it
 * goes through the pty layer's own shell-quoting — nothing here builds a
 * command string, and a task title is arbitrary user-typed text.
 */
function composeArgs(opts: { name?: string; flags: string[]; prompt?: string }): string[] {
  const out: string[] = [];
  if (opts.name) out.push('--name', opts.name);
  out.push(...opts.flags);
  if (opts.prompt) out.push(opts.prompt);
  return out;
}

export default function Terminal({
  task,
  active = true,
  initialPrompt,
  spawnArgs,
  onFreshStart,
  sessionName,
  onExit,
  onError,
}: TerminalProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  /** Keystrokes typed before the spawn resolved. */
  const pendingRef = useRef<string[]>([]);
  /** Imperative "fit now", installed by the mount effect. */
  const fitNowRef = useRef<(() => void) | null>(null);
  const deadRef = useRef(false);

  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  /**
   * Pinned at mount, deliberately.
   *
   * The caller computes this from `task.sessionId === null`, and that flips to
   * non-null the moment capture adopts the session — very likely before this
   * component ever re-renders. Reading the live prop inside the spawn effect
   * would make the prompt depend on a race. A ref initialised once is the
   * mount-time value, full stop.
   */
  const initialPromptRef = useRef(initialPrompt);
  const spawnArgsRef = useRef(spawnArgs);
  const sessionNameRef = useRef(sessionName);
  /** Did anything at all come back before it died? See the note in spawn(). */
  const sawOutputRef = useRef(false);
  const usedResumeRef = useRef(false);
  const restartRef = useRef<((fresh: boolean) => void) | null>(null);
  /** A spawn is in flight; a second start would orphan the first pty. */
  const spawningRef = useRef(false);
  /** Last attempt was a `--resume` the CLI rejected; retrying it would fail again. */
  const resumeRejectedRef = useRef(false);
  const onFreshStartRef = useRef(onFreshStart);
  onFreshStartRef.current = onFreshStart;
  /** Live task, for decisions that must use current state, not mount state. */
  const taskRef = useRef(task);
  taskRef.current = task;

  const [phase, setPhase] = useState<Phase>('starting');
  const [trustWaiting, setTrustWaitingState] = useState(() => isTrustWaiting(task.id));
  useEffect(() => {
    setTrustWaitingState(isTrustWaiting(task.id));
    return onTrustWaiting((id, waiting) => {
      if (id === task.id) setTrustWaitingState(waiting);
    });
  }, [task.id]);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // --- mount: xterm + pty. Runs exactly once per task instance. -------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    const unsubs: Array<() => void> = [];
    let ptyUnsubs: Array<() => void> = [];
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const lastSize = { cols: 0, rows: 0 };

    const term = new XTerm({
      fontFamily: cssVar('--font-mono', 'ui-monospace, Menlo, monospace'),
      fontSize: 14,
      lineHeight: 1.3,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'block',
      // ~12 bytes a cell: 20k lines at 200 columns was ~48 MB per terminal, and
      // every task's terminal stays mounted. The transcript is the real history.
      scrollback: 5000,
      allowProposedApi: true,
      convertEol: false,
      macOptionIsMeta: true,
      theme: terminalTheme(),
    });
    termRef.current = term;
    // App shortcuts on Option (the project jump) must not reach the pty too,
    // nor ⇧F6 / F2, Rename, which this terminal gives up (shortcuts.ts).
    term.attachCustomKeyEventHandler(taskTerminalTakesKey);

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    try {
      // The addon's default, `window.open`, does nothing in the app's webview:
      // a web link goes to the browser, like every other link in Albedo.
      term.loadAddon(new WebLinksAddon((_event, uri) => void openExternal(uri)));
    } catch {
      /* links are a nicety, not a requirement */
    }
    term.open(host);
    // The Tab cycle's stop in the terminal, and Tab stays here (focusAreas.ts).
    term.textarea?.setAttribute('data-focus-default', '');
    term.textarea?.setAttribute('data-focus-keeps-tab', '');
    // Rename's keys work here and not in the shell drawer (shortcuts.ts).
    term.textarea?.setAttribute(TASK_TERMINAL_ATTR, '');

    // Re-theme in place. Assigning `options.theme` repaints the screen and the
    // scrollback from the existing buffer -- it does not touch the pty, so a
    // running Claude Code session survives a theme flip exactly as it survives
    // a task switch.
    unsubs.push(
      onThemeChange(() => {
        try {
          term.options.theme = terminalTheme();
        } catch {
          /* disposed between the notify and the frame */
        }
      }),
    );

    /** Fit + tell the pty, but only when the size really moved. */
    const applyFit = () => {
      if (disposed) return;
      // Hidden terminals measure 0x0; fitting then would compute nonsense.
      if (host.offsetWidth === 0 || host.offsetHeight === 0) return;
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      const { cols, rows } = term;
      if (!cols || !rows) return;
      if (cols === lastSize.cols && rows === lastSize.rows) return;
      lastSize.cols = cols;
      lastSize.rows = rows;
      const id = ptyIdRef.current;
      if (id && !deadRef.current) void resizePty(id, cols, rows).catch(() => {});
    };
    fitNowRef.current = applyFit;

    const scheduleFit = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(applyFit, RESIZE_DEBOUNCE_MS);
    };

    const observer = new ResizeObserver(scheduleFit);
    observer.observe(host);
    window.addEventListener('resize', scheduleFit);

    // First measurement before spawning, so the pty is born the right size.
    try {
      if (host.offsetWidth > 0 && host.offsetHeight > 0) fitAddon.fit();
    } catch {
      /* fall back to xterm's default 80x24 */
    }
    lastSize.cols = term.cols;
    lastSize.rows = term.rows;

    // Buffer input until the pty id arrives.
    const dataSub = term.onData((data) => {
      const id = ptyIdRef.current;
      if (!id) {
        pendingRef.current.push(data);
        return;
      }
      if (deadRef.current) return;
      void writePty(id, data).catch((err) => {
        setFailure(message(err));
      });
    });
    unsubs.push(() => dataSub.dispose());

    /**
     * Start (or restart) `claude`. Extracted so the failure path can run it a
     * second time without re-creating the xterm or losing the scrollback.
     */
    const spawn = async (fresh: boolean) => {
      // Detach the previous pty's listeners before attaching new ones.
      for (const off of ptyUnsubs) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
      ptyUnsubs = [];

      deadRef.current = false;
      sawOutputRef.current = false;
      setExitCode(null);
      setFailure(null);
      setPhase('starting');
      spawningRef.current = true;

      // Which session, decided before `claude` runs and recorded on the task,
      // so the first transcript line already finds its task and a restart
      // resumes exactly this one (see sessionSpawn.ts and sessionLink.ts).
      const live = taskRef.current;
      const neverStarted = live.sessionId === null;
      const pending = spawnArgsRef.current;
      // History's args are for the first spawn only: a later restart of a
      // fork must resume the fork, not fork the original again.
      spawnArgsRef.current = undefined;
      const known =
        !fresh && !pending && live.sessionId !== null ? await sessionTranscriptExists(live.sessionId) : null;
      // A chat's instruction rides on every spawn, in the plan's flags.
      const plan = planSpawn({
        kind: live.kind,
        sessionId: live.sessionId,
        pending,
        fresh,
        transcriptExists: known,
        newId: newSessionId,
      });
      try {
        await linkTaskSession(task.id, plan.sessionId, `spawn:${plan.mode}`);
      } catch (err) {
        // The hook will report the id once `claude` starts; spawn regardless.
        console.warn('[terminal] could not record the session id', err);
      }
      if (disposed) return;
      usedResumeRef.current = isResumePlan(plan);

      // `--name` only where a session is being created; a resumed one keeps
      // whatever name its owner gave it. The opening prompt only for a task
      // that never had a session: the agent has already been told otherwise.
      const title = displayName(live.title);
      const creating = plan.mode === 'new' || plan.mode === 'reuse' || plan.mode === 'fork';
      const name = fresh ? title : creating ? (sessionNameRef.current ?? title) : undefined;
      const prompt = plan.mode === 'new' && neverStarted ? initialPromptRef.current?.trim() : undefined;
      const args = composeArgs({ name, flags: plan.args, prompt });

      // The task's chosen model, on every spawn: a resume after restart would
      // otherwise fall back to the user's default and quietly switch models.
      // With no choice stored (a `/model` typed in the terminal), the model
      // the session last answered with.
      const model = getTaskModel(task.id) ?? (plan.modelFrom ? await lastModelOf(plan.modelFrom) : null);
      if (disposed) return;
      let spawnArgs = model ? ['--model', model, ...args] : args;

      // Hooks tell Albedo when the session is waiting on the user, which the
      // transcript cannot (see capture/hookEvents.ts). Never allowed to stop a
      // session starting: without them the task simply reads as it did before.
      try {
        const script = await startHookEvents();
        await resetTaskEvents(task.id);
        spawnArgs = ['--settings', hookSettingsArg(task.id, script), ...spawnArgs];
      } catch (err) {
        console.warn('[terminal] hooks unavailable, starting without them', err);
      }

      // Albedo's MCP server (#157): how the session asks for a reminder, a new
      // session or the user's attention. Optional like the hooks: without the
      // binary (a dev build before `npm run build:mcp`) it starts as before.
      const server = await mcpServerPath();
      if (disposed) return;
      if (server) spawnArgs = withMcpConfig(spawnArgs, task.id, server);

      // A folder Claude Code has never trusted opens on its trust dialog, before
      // any hook runs and before there is a transcript, so neither channel can
      // say the task is waiting. Asked beforehand of Claude Code's own record
      // instead (capture/workspaceTrust.ts); unknown counts as trusted.
      const untrusted = (await folderTrusted(live.worktreePath)) === false;
      if (disposed) return;
      setTrustWaiting(task.id, untrusted);

      // Assigned the moment spawnPty resolves. The bridge never calls a
      // handler before then, so both handlers below always see it set.
      let id = '';

      const onOutput = (bytes: Uint8Array) => {
        // Counting that bytes arrived is not reading them. Nothing here
        // interprets the stream -- it only distinguishes "died before it
        // produced anything", which is what a rejected --resume looks like.
        sawOutputRef.current = true;
        try {
          term.write(bytes);
        } catch {
          /* a write after dispose is harmless */
        }
      };

      const onExit = (code: number | null) => {
        deadRef.current = true;
        // A resume that died without producing a byte is a rejected
        // session id. Recorded here so a later start does not retry the
        // same dead id forever.
        resumeRejectedRef.current =
          usedResumeRef.current && !sawOutputRef.current && code !== 0;
        // Synchronously, and BEFORE unregisterPty: presence listeners
        // re-render immediately on that call, and would otherwise read a
        // stale `canResume` on the very render that reports the exit.
        if (resumeRejectedRef.current) resumable.delete(task.id);
        unregisterPty(task.id, id);
        // Whatever it was waiting on died with it (no SessionEnd on a crash).
        void endTaskEvents(task.id);
        setTrustWaiting(task.id, false);
        setExitCode(code);
        setPhase('exited');
        // Leave the scrollback intact and readable.
        onExitRef.current?.(code);
      };

      try {
        const handle = await spawnPty(
          {
            cwd: task.worktreePath,
            command: 'claude',
            args: spawnArgs,
            cols: term.cols,
            rows: term.rows,
          },
          { onOutput, onExit },
        );
        id = handle.id;
        if (disposed) {
          handle.detach();
          void killPty(id).catch(() => {});
          return;
        }
        ptyUnsubs.push(handle.detach);
        ptyIdRef.current = id;
        spawningRef.current = false;
        registerPty(task.id, id);
        setPhase('live');

        const queued = pendingRef.current;
        pendingRef.current = [];
        for (const chunk of queued) void writePty(id, chunk).catch(() => {});

        applyFit();
        // The dialog is answered here and nowhere else: give it the keyboard,
        // if this terminal is on screen.
        if (untrusted && host.offsetWidth > 0) term.focus();
      } catch (err) {
        if (disposed) return;
        const msg = message(err);
        spawningRef.current = false;
        setFailure(msg);
        setPhase('failed');
        onErrorRef.current?.(msg);
        try {
          term.write(`\r\n\x1b[31mFailed to start \`claude\` in ${task.worktreePath}\x1b[0m\r\n`);
          term.write(`\x1b[90m${msg}\x1b[0m\r\n`);
        } catch {
          /* ignore */
        }
      }
    };

    /*
     * Reachable from `startPty` so a composer elsewhere can start a session.
     * Guarded twice: once on a pty already being live, once on a spawn already
     * in flight — without the second, a click during the async spawn would
     * produce a second pty for the same task and orphan the first.
     */
    focusers.set(task.id, () => termRef.current?.focus());
    starters.set(task.id, () => {
      if (livePtys.has(task.id)) return true;
      if (spawningRef.current) return true;
      // RESUME rather than start fresh: someone starting a session from a
      // composer is reading that conversation and wants to continue it, which
      // is also what mounting would have done. The exception is a resume the
      // CLI already rejected -- retrying that just fails again, so only then
      // does this fall back to a fresh session.
      restartRef.current?.(resumeRejectedRef.current);
      return true;
    });

    // Exposed so the "start a fresh session" affordance can reach it. Not
    // fresh means "pick this task's session back up": the LIVE session id, so
    // a `/clear` since mount is what gets resumed, not the mount-time one.
    // The prompt goes in as argv, never as a pty write. Writing it would mean
    // knowing when Claude Code has finished booting, and the only way to know
    // that is to read terminal output -- the one thing this app never does.
    restartRef.current = (fresh: boolean) => {
      if (fresh) {
        term.write('\r\n\x1b[90m--- starting a fresh session ---\x1b[0m\r\n');
        onFreshStartRef.current?.();
      }
      void spawn(fresh);
    };

    // `/clear` and `/resume` inside Claude Code move this terminal to another
    // session; the SessionStart hook says which, and the task follows it.
    unsubs.push(
      onSessionStart((taskId, sessionId, source) => {
        // Hooks run only in a trusted folder: a session starting is the answer.
        if (taskId === task.id) setTrustWaiting(task.id, false);
        if (taskId !== task.id || sessionId === taskRef.current.sessionId) return;
        void linkTaskSession(task.id, sessionId, `hook:${source}`).catch((err) =>
          console.warn('[terminal] could not follow the session', err),
        );
      }),
    );

    void spawn(false);

    return () => {
      disposed = true;
      fitNowRef.current = null;
      if (resizeTimer) clearTimeout(resizeTimer);
      observer.disconnect();
      window.removeEventListener('resize', scheduleFit);
      restartRef.current = null;
      setTrustWaiting(task.id, false);
      spawningRef.current = false;
      starters.delete(task.id);
      focusers.delete(task.id);
      for (const off of [...unsubs, ...ptyUnsubs]) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
      const id = ptyIdRef.current;
      ptyIdRef.current = null;
      if (id) {
        unregisterPty(task.id, id);
        void killPty(id).catch(() => {});
      }
      termRef.current = null;
      try {
        term.dispose();
      } catch {
        /* ignore */
      }
    };
    // Mount-once: the task identity is the instance identity (parent keys by
    // task.id). Re-running this effect would respawn a live Claude session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * A task becomes resumable the moment capture adopts a session id for it, and
   * stops being so if a resume is rejected. `phase` is in the deps so this
   * re-evaluates after an exit rather than only when the task object changes.
   */
  useEffect(() => {
    const id = task.id;
    if (task.sessionId !== null && !resumeRejectedRef.current) resumable.add(id);
    else resumable.delete(id);
    return () => {
      resumable.delete(id);
    };
  }, [task.id, task.sessionId, phase]);

  // --- becoming visible: remeasure, repaint, take focus --------------------
  useEffect(() => {
    if (!active) return;
    const id = window.requestAnimationFrame(() => {
      fitNowRef.current?.();
      const term = termRef.current;
      if (!term) return;
      try {
        term.refresh(0, term.rows - 1);
        // Focus for typing, marked so the first Tab still reaches the
        // message box (focusAreas.ts).
        focusOnItsOwn(term.textarea);
      } catch {
        /* ignore */
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [active]);

  const tone = phase === 'failed' ? 'error' : phase === 'exited' ? 'exited' : 'live';
  const dead = phase === 'exited' || phase === 'failed';

  /**
   * A resume that died before producing a single byte is a rejected session
   * id — a stale one, or a transcript Claude Code has pruned. The exit code
   * and "did anything arrive" are enough to tell; nothing reads the stream.
   */
  const resumeRejected = phase === 'exited' && resumeRejectedRef.current;

  return (
    <div className="term" hidden={!active} aria-hidden={!active}>
      {/* Above the terminal, not over it: the dialog it explains stays whole. */}
      {trustWaiting && phase === 'live' ? (
        <div className="term-trust" role="status">
          Claude Code is asking whether to trust this folder. To go on, choose <b>Yes, I trust this folder</b> below
          (↓, then Enter): Enter alone picks the highlighted <b>No, exit</b>.
        </div>
      ) : null}
      <div className="term-surface" ref={hostRef} />
      {phase === 'starting' && <div className="term-starting">Starting claude in {task.worktreePath}…</div>}

      {/* Never a dead end. A task whose transcript aged out must not become
          permanently unopenable, so every terminated pane offers a way back. */}
      {dead && (
        <div className="term-status" data-tone={resumeRejected ? 'error' : tone}>
          <span className="term-status-text">
            {resumeRejected ? (
              <>
                Could not resume the previous conversation — it may have been pruned.{' '}
                <span className="term-status-calm">Your files and worktree are untouched.</span>
              </>
            ) : phase === 'failed' ? (
              `Could not start: ${failure ?? 'unknown error'}`
            ) : (
              `Session ended${exitCode === null ? '' : ` (exit ${exitCode})`} — scrollback kept`
            )}
          </span>
          <button
            className="btn"
            onClick={() => restartRef.current?.(true)}
            title="Start a new claude session in this directory"
          >
            Start a Fresh Session
          </button>
        </div>
      )}
    </div>
  );
}
