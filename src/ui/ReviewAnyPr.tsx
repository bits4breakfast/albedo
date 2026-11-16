/**
 * "Review a PR…" (#386): the Reviewing tab's one action. A button that opens
 * a dropdown of the repo's open PRs -- the 10 most recently updated, without
 * your own -- with a search field over all of them, by number or title.
 *
 * Choosing a PR hands it to the tab (`onChoose`), which opens it exactly as a
 * row does: an existing review task is selected, otherwise the PR is checked
 * out as one. Nothing is sent to GitHub; you are not added as a reviewer.
 *
 * GitHub is asked once when the dropdown opens, and again while typing,
 * debounced ({@link SEARCH_DEBOUNCE_MS}); never polled. Loading and failure
 * each say so on the dropdown's status line, never as an empty list.
 *
 * The WAI-ARIA combobox pattern, as the branch picker and Quick Open: focus
 * stays in the field, ↑/↓ move the highlight, Return opens, Esc closes.
 * Escape is marked handled here, so it never takes the window out of full
 * screen (escapeKeepsFullscreen.ts) and closes only the dropdown.
 *
 * The dropdown is portalled to `document.body` (ClosedProjectsMenu.tsx says
 * why): it is wider than the sidebar's minimum, and the list scrolls.
 */

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Project, Task } from '../types';
import {
  parsePrQuery,
  searchOpenPrs,
  titleHas,
  titleHits,
  type OpenPr,
  type PrQuery,
  type PrSearchAnswer,
} from '../gh/openPrs';
import { reviewTaskFor } from './openReview';
import { Highlighted } from './Highlighted';

/** Typing pauses this long before GitHub is asked. */
export const SEARCH_DEBOUNCE_MS = 300;

/** The dropdown's preferred width; the sidebar may be narrower. */
const WIDTH = 420;
const GAP = 4;
const EDGE = 8;
/** Below this much room under the button, the list is capped and scrolls anyway. */
const MIN_HEIGHT = 160;

interface Place {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

/** The dropdown's place under `anchor`, kept inside the window. Pure. */
export function dropdownPlace(
  anchor: { left: number; bottom: number; width: number },
  viewport: { width: number; height: number },
): Place {
  const width = Math.min(Math.max(anchor.width, WIDTH), viewport.width - 2 * EDGE);
  const left = Math.max(EDGE, Math.min(anchor.left, viewport.width - EDGE - width));
  const top = anchor.bottom + GAP;
  return { left, top, width, maxHeight: Math.max(MIN_HEIGHT, viewport.height - top - EDGE) };
}

/** Nothing has focus: the element that had it went away or was disabled. */
function focusIsLost(): boolean {
  const el = document.activeElement;
  return el === null || el === document.body || (el instanceof HTMLButtonElement && el.disabled);
}

/** A question's identity: two typings that ask the same thing share one answer. */
function keyOf(q: PrQuery): string {
  if (q.kind === 'number') return `#${q.number}`;
  if (q.kind === 'title') return `t:${q.terms.map((t) => t.toLowerCase()).join(' ')}`;
  return 'recent';
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export interface ReviewAnyPrProps {
  project: Project;
  /** The project's live review tasks: a PR with one is marked, and choosing it selects it. */
  reviewTasks: readonly Task[];
  /** A PR is being checked out: the button waits. */
  busy: boolean;
  /** Settles once the choice is open (a checkout can take a while). */
  onChoose: (pr: OpenPr) => void | Promise<unknown>;
  /** The dropdown opened: a new search, so the last choice's leftovers can go. */
  onOpen?: () => void;
  age: (ts: number) => string;
}

export default function ReviewAnyPr({ project, reviewTasks, busy, onChoose, onOpen, age }: ReviewAnyPrProps) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  /** The last answer, and the question it answers. */
  const [answer, setAnswer] = useState<{ key: string; answer: PrSearchAnswer } | null>(null);
  /** The recent list from this opening: a title search also shows its partial-word matches. */
  const [recent, setRecent] = useState<readonly OpenPr[]>([]);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<Place | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** Bumped per question and on close: an answer to anything older is dropped. */
  const asked = useRef(0);
  /** Bumped on close: nothing asked while it was open applies to the next opening. */
  const generation = useRef(0);
  /** The next question is the opening one, asked at once. */
  const first = useRef(true);
  /** The repo the dropdown was opened on: a project switch asks nothing of the next one. */
  const openedOn = useRef<string | null>(null);
  /** A choice's checkout ended while the button was still disabled: focus it once it is not. */
  const refocusAfter = useRef(false);
  const busyNow = useRef(busy);
  busyNow.current = busy;
  const listId = useId();

  const query = useMemo(() => parsePrQuery(typed), [typed]);
  const key = keyOf(query);
  const ready = answer !== null && answer.key === key;

  const close = (refocus: boolean) => {
    asked.current += 1;
    generation.current += 1;
    first.current = true;
    openedOn.current = null;
    setOpen(false);
    setTyped('');
    setAnswer(null);
    setRecent([]);
    setActive(0);
    if (refocus) buttonRef.current?.focus();
  };

  // Another project is another repo: nothing open carries over.
  useEffect(() => {
    if (open) close(false);
    // Only on a change of project: `open` and `close` are read, not watched.
  }, [project.repoPath]);

  // Ask GitHub: at once for the opening question, debounced while typing.
  useEffect(() => {
    if (!open || openedOn.current !== project.repoPath) return;
    const n = ++asked.current;
    const g = generation.current;
    const ask = () => {
      void searchOpenPrs(project.repoPath, query).then((a) => {
        // The recent list stays useful for partial words even when the
        // question has moved on; anything else answers only its own.
        if (query.kind === 'recent' && a.kind === 'list' && generation.current === g) {
          setRecent(a.prs);
        }
        if (asked.current !== n) return;
        setAnswer({ key, answer: a });
        setActive(0);
      });
    };
    if (first.current) {
      first.current = false;
      ask();
      return;
    }
    const t = window.setTimeout(ask, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
    // `query` follows `key`: one question, asked once.
  }, [open, key, project.repoPath]);

  // Fixed under the button, and placed again when the window resizes. When
  // something holding the button scrolls (the task list), the dropdown
  // closes, as the row menu does: following it would drag the list over the
  // tab header. Scrolls anywhere else -- the dropdown's own list, the
  // transcript -- are not its business.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const r = buttonRef.current?.getBoundingClientRect();
      if (r) setPlace(dropdownPlace(r, { width: window.innerWidth, height: window.innerHeight }));
    };
    const onScroll = (e: Event) => {
      const t = e.target;
      const button = buttonRef.current;
      if (!button) return;
      if (t === document || (t instanceof Node && t.contains(button))) close(false);
    };
    measure();
    inputRef.current?.focus();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  // A press anywhere else closes it. Capture, so it is seen first; a press on
  // the button is the button's own toggle.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target;
      if (t instanceof Node && (popRef.current?.contains(t) || buttonRef.current?.contains(t))) return;
      close(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  // Checking out began elsewhere (a row): nothing may be chosen meanwhile.
  // Once the checkout of a choice made here has ended and the button is
  // enabled again, focus that nothing else took comes back to it.
  useEffect(() => {
    if (busy && open) close(false);
    if (!busy && refocusAfter.current) {
      refocusAfter.current = false;
      if (focusIsLost()) buttonRef.current?.focus();
    }
  }, [busy]);

  /** The rows, and how many of them came from the recent list alone (part of a word). */
  const { rows, partial } = useMemo((): { rows: OpenPr[]; partial: number } => {
    const a = answer?.answer;
    if (!a) return { rows: [], partial: 0 };
    if (a.kind === 'number') return { rows: a.pr ? [a.pr] : [], partial: 0 };
    if (a.kind !== 'list') return { rows: [], partial: 0 };
    if (query.kind !== 'title') return { rows: a.prs, partial: 0 };
    const terms = query.terms;
    // GitHub matches whole words only; the recent list also answers a word
    // still being typed ("time" finds "timezone" there).
    const seen = new Set(a.prs.map((p) => p.url));
    const more = recent.filter((p) => !seen.has(p.url) && titleHas(p.title, terms));
    return { rows: [...a.prs, ...more].sort((x, y) => y.updatedAt - x.updatedAt), partial: more.length };
  }, [answer, recent, query]);

  // Keep the highlighted row in view while arrowing.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active, open]);

  const choose = (pr: OpenPr | undefined) => {
    if (!pr) return;
    // Back on the button, where the dropdown came from: the field is about
    // to go. Selecting the task may move focus on from there, as it likes.
    close(true);
    void Promise.resolve(onChoose(pr)).finally(() => {
      // The button was disabled while the PR was checked out, and focus left
      // it. If nothing has taken focus since, it goes back there.
      if (busyNow.current) refocusAfter.current = true;
      else if (focusIsLost()) buttonRef.current?.focus();
    });
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const last = rows.length - 1;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((a) => (a >= last ? 0 : a + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((a) => (a <= 0 ? Math.max(last, 0) : a - 1));
        break;
      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        // Only an answer to what is typed now: Return right after typing
        // "412" must not open whatever the previous list had first.
        if (ready) choose(rows[active]);
        break;
      case 'Escape':
        // Handled here, so it closes the dropdown and nothing else, and the
        // window stays in full screen.
        e.preventDefault();
        e.stopPropagation();
        close(true);
        break;
      default:
        break;
    }
  };

  const terms = query.kind === 'title' ? query.terms : [];
  let status: string;
  const a = ready ? answer.answer : null;
  if (!a) status = 'Asking GitHub…';
  else if (a.kind === 'failed') status = `Couldn't ask GitHub: ${a.message}`;
  else if (a.kind === 'number') {
    status = {
      open: `Open PR #${a.number}`,
      closed: `#${a.number} is closed.`,
      merged: `#${a.number} is merged.`,
      missing: `No pull request #${a.number} in ${project.name}.`,
      yours: `#${a.number} is yours: GitHub doesn't let you review your own PRs.`,
    }[a.why];
  } else if (query.kind === 'title') {
    // GitHub's count and the recent list's part-word matches, each said for
    // what it is: never added into one number that neither of them gave.
    const typedWords = `“${terms.join(' ')}”`;
    const github = a.prs.length;
    const parts: string[] = [];
    if (a.total > 0) {
      parts.push(
        `${plural(a.total, 'open PR matches', 'open PRs match')}${a.total > github ? `, the ${github} most recent shown` : ''}`,
      );
    }
    if (partial > 0) {
      parts.push(
        `${a.total > 0 ? `${partial} more recent` : plural(partial, 'recent PR', 'recent PRs')} ${partial === 1 ? 'has' : 'have'} ${typedWords} in a word`,
      );
    }
    status = parts.length > 0 ? parts.join(' · ') : `No open PR title has ${typedWords}. GitHub matches whole words.`;
  } else {
    status = rows.length === 0 ? `No open PRs by others in ${project.name}.` : 'Recently updated · open';
  }

  return (
    <div className="review-any">
      <button
        ref={buttonRef}
        type="button"
        className="btn review-any-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={busy}
        title="Check out any open pull request as a review task. Nothing is sent to GitHub."
        onClick={() => {
          if (open) return close(false);
          openedOn.current = project.repoPath;
          onOpen?.();
          setOpen(true);
        }}
      >
        Review a PR…
        <span className="review-any-chevron" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 6l4 4 4-4" />
          </svg>
        </span>
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="review-any-pop"
            style={place ?? undefined}
            // Keep focus in the field: a click on a row must not blur it first.
            onMouseDown={(e) => {
              if (e.target !== inputRef.current) e.preventDefault();
            }}
          >
            <input
              ref={inputRef}
              className="review-any-search"
              type="text"
              role="combobox"
              aria-label="Search open pull requests by number or title"
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={rows[active] ? `${listId}-${active}` : undefined}
              placeholder="Search by number or title"
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={onKeyDown}
              onBlur={(e) => {
                // Tab, or focus moved on by the app: the dropdown goes with it.
                const to = e.relatedTarget;
                if (to instanceof Node && !popRef.current?.contains(to)) close(false);
              }}
            />
            <div className="review-any-status" role="status" data-failed={a?.kind === 'failed' || undefined}>
              {status}
            </div>
            <div className="review-any-list" id={listId} role="listbox" aria-label="Open pull requests" ref={listRef}>
              {rows.map((pr, i) => {
                const task = reviewTaskFor(reviewTasks, pr.url);
                return (
                  <div
                    key={pr.url}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === active}
                    data-index={i}
                    className="review-any-row"
                    title={`#${pr.number} ${pr.title}${task ? '\nOpen its review task' : '\nCheck out and review in Albedo'}`}
                    // Move, not enter: a list scrolling under a resting
                    // pointer must not drag the highlight with it.
                    onMouseMove={() => i !== active && setActive(i)}
                    onClick={() => choose(pr)}
                  >
                    <span className="review-any-num">#{pr.number}</span>
                    <span className="review-any-title">
                      <Highlighted text={pr.title} hits={titleHits(pr.title, terms)} className="review-any-hit" />
                    </span>
                    <span className="review-any-end">
                      {task && <span className="review-any-has">Review task</span>}
                      {task && ' · '}
                      {age(pr.updatedAt)}
                    </span>
                    <span className="review-any-by">
                      {[pr.author, pr.isDraft ? 'Draft' : null].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="review-any-foot">
              {typed.trim() === ''
                ? '↑↓ to move · Return opens as a review task · Esc closes'
                : 'Typing a number (412 or #412) finds that PR, even past the first 10'}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
