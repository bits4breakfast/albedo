import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { spawnPty, writePty, resizePty, killPty, onPtyOutput, onPtyExit } from '../lib/pty';
import type { Task } from '../types';
import { onThemeChange, resolvedTheme } from './theme';

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

function registerPty(taskId: number, ptyId: string): void {
  livePtys.set(taskId, ptyId);
}

function unregisterPty(taskId: number, ptyId: string): void {
  if (livePtys.get(taskId) === ptyId) livePtys.delete(taskId);
}

/**
 * Place text in the task's pty input WITHOUT submitting it.
 *
 * The agent may be mid-turn, so sending stays manual: this writes the text and
 * leaves the cursor after it. Newlines and carriage returns are collapsed to
 * spaces before writing -- a stray \n here would submit the line to a running
 * agent, which is exactly what the spec forbids.
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

/** True when the task has a spawned, un-exited pty. */
export function hasLivePty(taskId: number): boolean {
  return livePtys.has(taskId);
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

function cssVar(name: string, fallback: string): string {
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
function terminalTheme(): ITheme {
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

function isResumeArgs(args: string[]): boolean {
  return args.includes('--resume');
}

/**
 * `claude [options] [prompt]`. Each element stays a separate argv entry so it
 * goes through the pty layer's own shell-quoting — nothing here builds a
 * command string, and a task title is arbitrary user-typed text.
 */
function composeArgs(opts: { name?: string; resume?: string[]; prompt?: string }): string[] {
  const out: string[] = [];
  if (opts.name) out.push('--name', opts.name);
  if (opts.resume && opts.resume.length > 0) out.push(...opts.resume);
  else if (opts.prompt) out.push(opts.prompt);
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
  const onFreshStartRef = useRef(onFreshStart);
  onFreshStartRef.current = onFreshStart;
  /** Live task, for decisions that must use current state, not mount state. */
  const taskRef = useRef(task);
  taskRef.current = task;

  const [phase, setPhase] = useState<Phase>('starting');
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
      fontSize: 13,
      lineHeight: 1.3,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 20000,
      allowProposedApi: true,
      convertEol: false,
      macOptionIsMeta: true,
      theme: terminalTheme(),
    });
    termRef.current = term;

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    try {
      term.loadAddon(new WebLinksAddon());
    } catch {
      /* links are a nicety, not a requirement */
    }
    term.open(host);

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
    const spawn = async (args: string[], isResume: boolean) => {
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
      usedResumeRef.current = isResume;
      setExitCode(null);
      setFailure(null);
      setPhase('starting');

      try {
        const id = await spawnPty({
          cwd: task.worktreePath,
          command: 'claude',
          args,
          cols: term.cols,
          rows: term.rows,
        });
        if (disposed) {
          void killPty(id).catch(() => {});
          return;
        }
        ptyIdRef.current = id;
        registerPty(task.id, id);
        setPhase('live');

        ptyUnsubs.push(
          onPtyOutput(id, (bytes) => {
            // Counting that bytes arrived is not reading them. Nothing here
            // interprets the stream -- it only distinguishes "died before it
            // produced anything", which is what a rejected --resume looks like.
            sawOutputRef.current = true;
            try {
              term.write(bytes);
            } catch {
              /* a write after dispose is harmless */
            }
          }),
        );
        ptyUnsubs.push(
          onPtyExit(id, (code) => {
            deadRef.current = true;
            unregisterPty(task.id, id);
            setExitCode(code);
            setPhase('exited');
            // Leave the scrollback intact and readable.
            onExitRef.current?.(code);
          }),
        );

        const queued = pendingRef.current;
        pendingRef.current = [];
        for (const chunk of queued) void writePty(id, chunk).catch(() => {});

        applyFit();
      } catch (err) {
        if (disposed) return;
        const msg = message(err);
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

    // Exposed so the "start a fresh session" affordance can reach it.
    restartRef.current = (fresh: boolean) => {
      if (fresh) {
        term.write('\r\n\x1b[90m--- starting a fresh session ---\x1b[0m\r\n');
        onFreshStartRef.current?.();
      }
      // The opening prompt goes to a genuinely fresh session only. If this
      // task ever established a session, the agent has already been told --
      // re-sending would make it start the work over, and that reads as the
      // agent behaving bizarrely rather than as a spawn bug. Deliberately the
      // LIVE sessionId, not the mount-time one: the whole point is what has
      // happened since.
      const neverStarted = taskRef.current.sessionId === null;
      const prompt = neverStarted ? initialPromptRef.current?.trim() : undefined;
      if (!fresh) {
        const again = buildArgs();
        void spawn(again, isResumeArgs(again));
        return;
      }
      // A fresh session is a NEW session, so naming it renames nothing.
      void spawn(composeArgs({ name: taskRef.current.title, prompt }), false);
    };

    function buildArgs(): string[] {
      // The prompt goes in as argv, never as a pty write. Writing it would mean
      // knowing when Claude Code has finished booting, and the only way to know
      // that is to read terminal output -- the one thing this app never does.
      return composeArgs({
        name: sessionNameRef.current,
        resume: spawnArgsRef.current,
        prompt: initialPromptRef.current?.trim(),
      });
    }

    const first = buildArgs();
    void spawn(first, isResumeArgs(first));

    return () => {
      disposed = true;
      fitNowRef.current = null;
      if (resizeTimer) clearTimeout(resizeTimer);
      observer.disconnect();
      window.removeEventListener('resize', scheduleFit);
      restartRef.current = null;
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

  // --- becoming visible: remeasure, repaint, take focus --------------------
  useEffect(() => {
    if (!active) return;
    const id = window.requestAnimationFrame(() => {
      fitNowRef.current?.();
      const term = termRef.current;
      if (!term) return;
      try {
        term.refresh(0, term.rows - 1);
        term.focus();
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
  const resumeRejected =
    phase === 'exited' && usedResumeRef.current && !sawOutputRef.current && exitCode !== 0;

  return (
    <div className="term" hidden={!active} aria-hidden={!active}>
      <div className="term-surface" ref={hostRef} />
      {phase === 'starting' && <div className="term-starting">starting claude in {task.worktreePath}…</div>}

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
              `could not start: ${failure ?? 'unknown error'}`
            ) : (
              `session ended${exitCode === null ? '' : ` (exit ${exitCode})`} — scrollback kept`
            )}
          </span>
          <button
            className="btn"
            onClick={() => restartRef.current?.(true)}
            title="Start a new claude session in this directory"
          >
            Start a fresh session
          </button>
        </div>
      )}
    </div>
  );
}
