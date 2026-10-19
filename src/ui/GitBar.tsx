/**
 * The top of the files pane: which branch this is, where it stands, and the
 * one thing it needs next.
 *
 * One main button, not a row of them. It offers the next step in the order a
 * branch goes through them -- push what is outstanding, open a PR, then the PR
 * itself -- and everything else waits in the `⋯` menu. A row of four equal
 * buttons asked the reader to work out which one applied; this works it out.
 *
 * It sits under the list, the way a commit window does -- read the change set,
 * then act on it -- and it is one line, because every row it takes is a file
 * the list cannot show: the list's view switch and refresh live in the `⋯`
 * menu too, and the section headers carry the file counts.
 *
 * Nothing here runs git or gh. Push and Create PR put a prompt in the message
 * box (see gitPrompts.ts); Squash & rebase opens its confirm dialog first.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '../types';
import type { UnmergedCommits } from '../git/worktree';
import { getPrStatus, usePrStatus } from '../gh/prStore';
import { prLabel, prTooltip } from '../gh/prStatus';
import { prLookupBranch } from '../gh/gh';
import { openExternal } from '../lib/openUrl';
import { menuPosition } from './ClosedProjectsMenu';
import { canSquashRebase, createPrPrompt, nextStep, pushPrompt } from './gitPrompts';
import './pr.css';

export interface GitBarProps {
  task: Task;
  /** Commits on the branch against its base. */
  commits: number;
  /** Uncommitted files. */
  dirty: number;
  /** Against the upstream; null when git could not say. */
  remote: UnmergedCommits | null;
  /** Put a prompt in the task's message box. */
  onAsk: (text: string) => void;
  onSquash: () => void;
  /** How the list below groups its files. */
  mode: 'branch' | 'commit';
  onMode: (mode: 'branch' | 'commit') => void;
  onRefresh: () => void;
  refreshing: boolean;
}

interface MenuItem {
  key: string;
  label: string;
  hint?: string;
  run: () => void;
  /** Ticked: a view option that is in effect. */
  checked?: boolean;
  /** Starts a new group: a rule above it. */
  group?: boolean;
  disabled?: boolean;
}

export default function GitBar({
  task,
  commits,
  dirty,
  remote,
  onAsk,
  onSquash,
  mode,
  onMode,
  onRefresh,
  refreshing,
}: GitBarProps): ReactNode {
  const pr = usePrStatus(task);
  // `undefined` is "not asked yet": no Create PR until gh has had its say,
  // or the button would offer one for a branch that already has it.
  const prKnown = getPrStatus(task.id) !== undefined;
  const prable = prLookupBranch(task) !== null;

  /*
   * Unknown remote state (git failed) falls back to "is there anything at
   * all": a Push that is offered and finds nothing is cheaper than one that is
   * withheld when there was something.
   */
  const unpushed = remote === null || remote.upstream === null ? commits : remote.ahead;
  const step = nextStep({ dirty, unpushed, commits, hasPr: pr !== null, prable });
  const main = step === 'create-pr' && !prKnown ? 'none' : step;

  const push = () => onAsk(pushPrompt(task));
  const createPr = () => onAsk(createPrPrompt(task));
  const openPr = () => {
    if (pr) void openExternal(pr.url);
  };

  const items: MenuItem[] = [];
  if (main !== 'push' && (dirty > 0 || unpushed > 0)) {
    items.push({ key: 'push', label: 'Push…', hint: 'Commit what is outstanding and push', run: push });
  }
  if (main !== 'create-pr' && prKnown && pr === null && prable && commits > 0) {
    items.push({ key: 'pr', label: 'Create PR…', hint: `Open a pull request into ${task.baseBranch}`, run: createPr });
  }
  if (main !== 'open-pr' && pr) {
    items.push({ key: 'open', label: `Open #${pr.number} on GitHub`, hint: pr.title, run: openPr });
  }
  if (canSquashRebase(task) && commits > 0) {
    items.push({
      key: 'squash',
      label: 'Squash & rebase…',
      hint: `One commit, on the latest ${task.baseBranch}`,
      run: onSquash,
    });
  }
  items.push(
    {
      key: 'by-branch',
      label: 'Group by branch',
      hint: 'Every changed file once, by where it stands',
      run: () => onMode('branch'),
      checked: mode === 'branch',
      group: items.length > 0,
    },
    {
      key: 'by-commit',
      label: 'Group by commit',
      hint: 'Each commit with the files it changed',
      run: () => onMode('commit'),
      checked: mode === 'commit',
    },
    {
      key: 'refresh',
      label: refreshing ? 'Reading…' : 'Refresh',
      hint: 'Re-read the transcript and git status',
      run: onRefresh,
      group: true,
      disabled: refreshing,
    },
  );

  return (
    <div className="tf-git">
      <div className="tf-git-id">
        <span className="tf-git-branch" title={`${task.branch}, off ${task.baseBranch}`}>
          {task.branch}
        </span>
        <span>{commits === 0 ? 'no commits' : `${commits} commit${commits === 1 ? '' : 's'}`}</span>
        {dirty > 0 ? <span>{dirty} uncommitted</span> : null}
        {remote === null || commits === 0 ? null : remote.upstream === null ? (
          <span data-tone="warn" title="This branch has no upstream: nothing on it is on the remote">
            not on remote
          </span>
        ) : remote.ahead > 0 ? (
          <span data-tone="warn" title={`Ahead of ${remote.upstream}`}>
            {remote.ahead} unpushed
          </span>
        ) : (
          <span title={`Up to date with ${remote.upstream}`}>pushed</span>
        )}
      </div>

      <div className="tf-git-actions">
        {main === 'push' ? (
          <button
            type="button"
            className="tf-btn tf-btn-primary"
            onClick={push}
            title="Ask Claude to commit what is outstanding and push. The prompt goes in the message box, to read and send."
          >
            Push…
          </button>
        ) : main === 'create-pr' ? (
          <button
            type="button"
            className="tf-btn tf-btn-primary"
            onClick={createPr}
            title={`Ask Claude to open a pull request into ${task.baseBranch}. The prompt goes in the message box, to read and send.`}
          >
            Create PR…
          </button>
        ) : main === 'open-pr' && pr ? (
          <PrButton pr={pr} onOpen={openPr} />
        ) : null}
        <MoreMenu items={items} />
      </div>
    </div>
  );
}

function PrButton({ pr, onOpen }: { pr: NonNullable<ReturnType<typeof usePrStatus>>; onOpen: () => void }): ReactNode {
  const label = prLabel(pr);
  return (
    <button
      type="button"
      className="pr-badge"
      data-tone={label.tone}
      title={prTooltip(pr, { clickable: true })}
      aria-label={`Pull request ${pr.number}, ${label.text}. Open on GitHub`}
      onClick={onOpen}
    >
      <span className="pr-num">#{pr.number}</span>
      {label.glyph && (
        <span className="pr-glyph" aria-hidden="true">
          {label.glyph}
        </span>
      )}
      <span>{label.text}</span>
    </button>
  );
}

/** The `⋯` button and its menu. Same mechanics as the closed-projects menu. */
function MoreMenu({ items }: { items: MenuItem[] }): ReactNode {
  const [at, setAt] = useState<{ left: number; bottom: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const open = at !== null;

  const toggle = () => {
    if (open) {
      setAt(null);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    // Upward: the bar is at the bottom of the pane, often of the window.
    if (rect) setAt({ left: menuPosition(rect, window.innerWidth).left, bottom: window.innerHeight - rect.top + 2 });
  };

  useEffect(() => {
    if (!open) return;
    const close = () => setAt(null);
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return close();
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close();
      buttonRef.current?.focus();
    };
    // Positioned once from the button; a scroll or resize would strand it.
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus();
  }, [open]);

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const els = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
    if (els.length === 0) return;
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    els[(i + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length]?.focus();
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="tf-btn tf-git-more"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        title="More actions and view options"
      >
        ⋯
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="row-menu"
            role="menu"
            aria-label="Git actions"
            style={{ left: at.left, bottom: at.bottom }}
            onKeyDown={onMenuKey}
          >
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                className="row-menu-item"
                role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
                aria-checked={item.checked}
                data-group={item.group ? 'true' : undefined}
                disabled={item.disabled}
                onClick={() => {
                  setAt(null);
                  item.run();
                }}
              >
                {item.checked === undefined ? null : (
                  <span className="row-menu-check" aria-hidden="true">
                    {item.checked ? '✓' : ''}
                  </span>
                )}
                {item.label}
                {item.hint ? <span className="row-menu-hint">{item.hint}</span> : null}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
