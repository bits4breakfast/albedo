/**
 * The top of the files pane: which branch this is, where it stands, and the
 * one thing it needs next.
 *
 * One main button, not a row of them. It offers the next step in the order a
 * branch goes through them -- push what is outstanding, open a PR, then the PR
 * itself -- and everything else waits in the `⋯` menu. A row of four equal
 * buttons asked the reader to work out which one applied; this works it out.
 *
 * It sits on the right of the list's first section heading ("Uncommitted"),
 * beside the files it acts on, so it costs no row of its own. Only when no
 * plain heading exists -- commit view with nothing uncommitted, where every
 * heading is a fold button -- does it fall back to a line under the list. The
 * view switch and refresh live in the `⋯` menu in the pane head.
 *
 * Nothing here runs git or gh. Push and Create PR send Claude a prompt (see
 * gitPrompts.ts and sendPrompt.ts) and so carry no ellipsis: the click is the
 * whole action. Squash & rebase opens its confirm dialog first, and keeps one.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '../types';
import type { UnmergedCommits } from '../git/worktree';
import { getPrStatus, usePrStatus } from '../gh/prStore';
import { prLookupBranch } from '../gh/gh';
import MoreGlyph from './MoreGlyph';
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
  /** Send a prompt to the task's session (see sendPrompt.ts). */
  onAsk: (text: string) => void;
  onSquash: () => void;
  /** How the list below groups its files. */
  mode: 'branch' | 'commit';
  onMode: (mode: 'branch' | 'commit') => void;
  /**
   * Where the head controls go -- the group-by toggle, and ⋯ when it holds an
   * action: the Files pane's head row. Without one (not mounted yet) they
   * stay in the bar.
   */
  menuSlot?: HTMLElement | null;
  /** Where the main action goes: the first section heading's right end. */
  actionSlot?: HTMLElement | null;
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
  menuSlot = null,
  actionSlot = null,
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
  // On no branch there is nothing to push or open a PR from -- and "Push
  // branch X" from a stale detached copy could overwrite X with old commits.
  const detached = remote?.detached === true;
  const step = detached ? 'none' : nextStep({ dirty, unpushed, commits, hasPr: pr !== null, prable });
  // An existing PR is not this bar's to show: the task bar carries the branch
  // and its PR badge, the one place git and GitHub state appears. This bar
  // keeps only the actions that act on the files above it.
  const main = (step === 'create-pr' && !prKnown) || step === 'open-pr' ? 'none' : step;

  const push = () => onAsk(pushPrompt(task));
  const createPr = () => onAsk(createPrPrompt(task));

  const items: MenuItem[] = [];
  if (!detached && main !== 'push' && (dirty > 0 || unpushed > 0)) {
    items.push({ key: 'push', label: 'Push', hint: 'Commit what is outstanding and push', run: push });
  }
  // Uncommitted work is enough: the prompt asks whether it belongs in the PR,
  // then commits and pushes. Waiting for a commit hid it on a branch Claude
  // had only edited -- which is most of them.
  if (!detached && main !== 'create-pr' && prKnown && pr === null && prable && (commits > 0 || dirty > 0)) {
    items.push({ key: 'pr', label: 'Create PR', hint: `Open a pull request into ${task.baseBranch}`, run: createPr });
  }
  if (!detached && canSquashRebase(task) && commits > 0) {
    items.push({
      key: 'squash',
      label: 'Squash & Rebase…',
      hint: `One commit, on the latest ${task.baseBranch}`,
      run: onSquash,
    });
  }
  // The head holds the view toggle, and ⋯ only when there is an action for
  // it: a menu of view options alone was a click to reach one of two states.
  // This bar appears only when there is a main action (Push, Create PR).
  const menu = (
    <>
      <GroupToggle mode={mode} onMode={onMode} />
      {items.length > 0 ? <MoreMenu items={items} drop={menuSlot ? 'down' : 'up'} /> : null}
    </>
  );
  const placed = menuSlot ? createPortal(menu, menuSlot) : null;
  if (main !== 'push' && main !== 'create-pr' && menuSlot) return placed;

  const action =
        main === 'push' ? (
          <button
            type="button"
            className="tf-btn tf-btn-primary"
            onClick={push}
            title={
              (unpushed > 0 ? `${unpushed} commit(s) not on the remote. ` : '') +
              'Ask Claude to commit what is outstanding and push (⇧⌘P). Sent at once (queued if Claude is working); while it waits on a permission prompt, it waits in the message box.'
            }
          >
            {/* The count rides on the action: how much is waiting is the
                reason to press it, and it needs no line of its own. */}
            Push{unpushed > 0 ? ` ↑${unpushed}` : ''}
          </button>
        ) : main === 'create-pr' ? (
          <button
            type="button"
            className="tf-btn tf-btn-primary"
            onClick={createPr}
            title={`Ask Claude to open a pull request into ${task.baseBranch}. Sent at once (queued if Claude is working); while it waits on a permission prompt, it waits in the message box.`}
          >
            Create PR
          </button>
        ) : null;

  if (actionSlot && menuSlot) {
    return (
      <>
        {placed}
        {createPortal(action, actionSlot)}
      </>
    );
  }

  return (
    <>
    {placed}
    <div className="tf-git">
      <div className="tf-git-actions">
        {action}
        {menuSlot ? null : menu}
      </div>
    </div>
    </>
  );
}

/**
 * Group the list by where each file stands, or by commit. One button with two
 * states: the glyph shows the grouping in effect, the label what a click does.
 */
function GroupToggle({
  mode,
  onMode,
}: {
  mode: 'branch' | 'commit';
  onMode: (mode: 'branch' | 'commit') => void;
}): ReactNode {
  const byCommit = mode === 'commit';
  const label = byCommit ? 'Group by Branch' : 'Group by Commit';
  return (
    <button
      type="button"
      className="icon-btn"
      aria-pressed={byCommit}
      aria-label={label}
      title={
        byCommit
          ? 'Grouped by commit. Click to list every changed file once, by where it stands'
          : 'Grouped by where each file stands. Click to group by commit'
      }
      onClick={() => onMode(byCommit ? 'branch' : 'commit')}
    >
      <svg className="more-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
        {byCommit ? (
          // Commits on a line.
          <>
            <path d="M8 1.5v3M8 6.5v3M8 11.5v3" />
            <circle cx="8" cy="5.5" r="1.4" fill="currentColor" />
            <circle cx="8" cy="10.5" r="1.4" fill="currentColor" />
          </>
        ) : (
          // A flat list.
          <path d="M3 4h10M3 8h10M3 12h10" />
        )}
      </svg>
    </button>
  );
}

/** Gap kept between the menu and the window edge. */
const MENU_EDGE = 8;

/** The `⋯` button and its menu. Same mechanics as the closed-projects menu. */
function MoreMenu({ items, drop }: { items: MenuItem[]; drop: 'up' | 'down' }): ReactNode {
  const [at, setAt] = useState<{ right: number; top?: number; bottom?: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const open = at !== null;
  const anyCheck = items.some((i) => i.checked !== undefined);

  const toggle = () => {
    if (open) {
      setAt(null);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Right edges aligned, whatever the menu's width: the ⋯ ends its row, so
    // the menu opens back toward the pane. Placing it by its LEFT edge
    // assumed the minimum width, and a wider menu ran off the window.
    const right = Math.max(MENU_EDGE, window.innerWidth - rect.right);
    // Upward from the bar at the foot of the pane; downward from the head.
    setAt(drop === 'up' ? { right, bottom: window.innerHeight - rect.top + 2 } : { right, top: rect.bottom + 2 });
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
        className="icon-btn"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        title="More actions and view options"
      >
        <MoreGlyph />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="row-menu"
            role="menu"
            aria-label="Git actions"
            style={{ right: at.right, top: at.top, bottom: at.bottom }}
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
                data-check-col={anyCheck || undefined}
                disabled={item.disabled}
                onClick={() => {
                  setAt(null);
                  item.run();
                }}
              >
                {/* One column for the tick, kept on every row once any row
                    can have one: labels and hints share one left edge. */}
                {anyCheck ? (
                  <span className="row-menu-check" aria-hidden="true">
                    {item.checked ? '✓' : ''}
                  </span>
                ) : null}
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
