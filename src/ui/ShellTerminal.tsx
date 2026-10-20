import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { spawnPty, writePty, resizePty, killPty } from '../lib/pty';
import { cssVar, terminalTheme } from './Terminal';
import { onThemeChange } from './theme';

/**
 * A plain login shell in a project's main checkout -- the shell drawer.
 *
 * Not a task and not a Claude session: no hooks, no transcript, no task id, so
 * nothing here touches capture or the live-pty registry Terminal keeps. It is
 * the same pty bridge with an empty command, which pty.rs reads as "exec the
 * login shell" after the same cd and the same ANTHROPIC_* unset, so a `claude`
 * typed into it still bills the subscription.
 *
 * Output is written to xterm as bytes and never looked at, exactly as in
 * Terminal. Lifetime: one per project, mounted from first open until the app
 * goes; the drawer hides it rather than unmounting it, so a running command
 * survives closing the drawer and switching project tabs.
 */

const RESIZE_DEBOUNCE_MS = 100;

type Phase = 'starting' | 'live' | 'exited' | 'failed';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function ShellTerminal({ cwd, active }: { cwd: string; active: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitNowRef = useRef<(() => void) | null>(null);
  const restartRef = useRef<(() => void) | null>(null);
  const [phase, setPhase] = useState<Phase>('starting');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let ptyId: string | null = null;
    let dead = false;
    let detach: (() => void) | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const pending: string[] = [];
    const lastSize = { cols: 0, rows: 0 };

    const term = new XTerm({
      fontFamily: cssVar('--font-mono', 'ui-monospace, Menlo, monospace'),
      fontSize: 14,
      lineHeight: 1.3,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 5000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: terminalTheme(),
    });
    termRef.current = term;
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    try {
      term.loadAddon(new WebLinksAddon());
    } catch {
      /* links are a nicety */
    }
    term.open(host);

    const offTheme = onThemeChange(() => {
      try {
        term.options.theme = terminalTheme();
      } catch {
        /* disposed */
      }
    });

    const applyFit = () => {
      if (disposed || host.offsetWidth === 0 || host.offsetHeight === 0) return;
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      const { cols, rows } = term;
      if (!cols || !rows || (cols === lastSize.cols && rows === lastSize.rows)) return;
      lastSize.cols = cols;
      lastSize.rows = rows;
      if (ptyId && !dead) void resizePty(ptyId, cols, rows).catch(() => {});
    };
    fitNowRef.current = applyFit;
    const scheduleFit = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(applyFit, RESIZE_DEBOUNCE_MS);
    };
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(host);

    try {
      if (host.offsetWidth > 0 && host.offsetHeight > 0) fitAddon.fit();
    } catch {
      /* xterm's default 80x24 */
    }
    lastSize.cols = term.cols;
    lastSize.rows = term.rows;

    const dataSub = term.onData((data) => {
      if (!ptyId) {
        pending.push(data);
        return;
      }
      if (!dead) void writePty(ptyId, data).catch((err) => setFailure(message(err)));
    });

    const spawn = async () => {
      detach?.();
      detach = null;
      ptyId = null;
      dead = false;
      setExitCode(null);
      setFailure(null);
      setPhase('starting');
      try {
        const handle = await spawnPty(
          { cwd, command: '', args: [], cols: term.cols, rows: term.rows },
          {
            onOutput: (bytes) => {
              try {
                term.write(bytes);
              } catch {
                /* after dispose */
              }
            },
            onExit: (code) => {
              dead = true;
              setExitCode(code);
              setPhase('exited');
            },
          },
        );
        if (disposed) {
          handle.detach();
          void killPty(handle.id).catch(() => {});
          return;
        }
        detach = handle.detach;
        ptyId = handle.id;
        setPhase((p) => (p === 'exited' ? p : 'live'));
        for (const chunk of pending.splice(0)) void writePty(handle.id, chunk).catch(() => {});
        applyFit();
      } catch (err) {
        if (disposed) return;
        setFailure(message(err));
        setPhase('failed');
      }
    };
    restartRef.current = () => {
      term.write('\r\n\x1b[90m--- new shell ---\x1b[0m\r\n');
      void spawn();
    };
    void spawn();

    return () => {
      disposed = true;
      fitNowRef.current = null;
      restartRef.current = null;
      if (resizeTimer) clearTimeout(resizeTimer);
      observer.disconnect();
      offTheme();
      dataSub.dispose();
      detach?.();
      if (ptyId) void killPty(ptyId).catch(() => {});
      termRef.current = null;
      try {
        term.dispose();
      } catch {
        /* ignore */
      }
    };
    // Mount-once: the parent keys by project, and re-running would respawn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Becoming visible: remeasure (a hidden xterm measures 0x0) and take focus.
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

  const dead = phase === 'exited' || phase === 'failed';
  return (
    <div className="term" hidden={!active} aria-hidden={!active}>
      <div className="term-surface" ref={hostRef} />
      {dead && (
        <div className="term-status" data-tone={phase === 'failed' ? 'error' : 'exited'}>
          <span className="term-status-text">
            {phase === 'failed'
              ? `Could not start a shell: ${failure ?? 'unknown error'}`
              : `Shell exited${exitCode === null ? '' : ` (exit ${exitCode})`} — scrollback kept`}
          </span>
          <button className="btn" onClick={() => restartRef.current?.()}>
            New Shell
          </button>
        </div>
      )}
    </div>
  );
}
