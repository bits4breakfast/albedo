/**
 * The built-in file viewer/editor.
 *
 * Spec, in full: "Viewer is CodeMirror with Shiki. Light edits allowed, Cmd+S
 * saves straight to the worktree. No autocomplete, no linting, no LSP."
 *
 * Three things here are deliberate and worth not undoing:
 *
 * 1. **Colour comes from Shiki, not from CodeMirror.** The `@codemirror/lang-*`
 *    packages are loaded for *editing behaviour only* -- indentation, comment
 *    toggling, bracket matching -- and no `HighlightStyle` is installed, so
 *    they contribute no colour at all. Tokens come from the same
 *    `src/lib/highlight.ts` singleton the diff view uses, which is what makes
 *    a file look identical whether you are reading it in a diff or editing it.
 * 2. **Path resolution goes through `resolveInWorktree` and nothing else.**
 *    This component never joins a path itself.
 * 3. **The agent is editing these files at the same time you are.** Saving
 *    re-reads the file and refuses to overwrite a version that moved under us.
 */

import { createPortal } from 'react-dom';
import { copyText } from '../../lib/clipboard';
import OverflowMenu, { type OverflowItem } from '../OverflowMenu';
import { editorKeyOf, isImplementationKey } from './editorKeys';
import { neighbour, onTouchedOrderChange, touchedOrder } from '../touchedOrder';
import { useOpenFile } from './openFile';
import { formatBytes, imageTypeForPath } from './preview';
import { looksBinary } from '../../git/fileDiff';
import FileDiffView from './FileDiffView';
import SymbolResults, { type SymbolResultsState } from './SymbolResults';
import { navigate, type NavAction } from './symbolNav';
import {
  dismissPhpantomFailure,
  isPhpPath,
  phpantomFailure,
  subscribePhpantomFailure,
  warmPhpantom,
} from '../../lsp/phpantom';
import {
  addComment,
  deleteComment,
  editComment,
  listComments,
  moveComment,
  onCommentsChanged,
  relocate,
  resolveComment,
  type ReviewComment,
} from '../../db/comments';
import {
  commentsExtension,
  linesOfSelection,
  commentsField,
  setDraft,
  setPlacedComments,
  type CommentActions,
  type PlacedComment,
} from './comments';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  Compartment,
  EditorState,
  Prec,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentUnit } from '@codemirror/language';
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { php } from '@codemirror/lang-php';
import { javascript } from '@codemirror/lang-javascript';
import type { Extension } from '@codemirror/state';
import type { DualToken } from '../../lib/highlight';

import type { OpenFileRequest, Task } from '../../types';
import type { ResolvedPath } from '../../lib/paths';
import { resolveInWorktree } from '../../lib/paths';
import { highlightToTokens, peekTokens, styleToCss } from '../../lib/highlight';
import { langForPath } from '../../lib/diff';
import { markHandEdited } from '../../lib/handEdited';
import { onThemeChange, resolvedTheme } from '../theme';
import type { ResolvedTheme } from '../theme';
import { notePty } from '../Terminal';
import { editorMayTakeFocus, onFocusEditor } from './editorFocus';
import './editor.css';
import './comments.css';

/** Files past this size are edited without colour. Tokenising them janks. */
const MAX_HIGHLIGHT_CHARS = 300_000;

/** Re-tokenise this long after the last keystroke, not on every one. */
const HIGHLIGHT_DEBOUNCE_MS = 160;

/** How long the jumped-to line stays marked. */
const FLASH_MS = 1600;

// ---------------------------------------------------------------------------
// Shiki -> CodeMirror decorations
// ---------------------------------------------------------------------------

const setTokenDecorations = StateEffect.define<DecorationSet>();

/**
 * Holds the Shiki colouring. Mapped through document changes so the colours
 * stay roughly in place while you type and the async re-tokenise catches up.
 */
const shikiField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setTokenDecorations)) return effect.value;
    }
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** One `Decoration.mark` per distinct inline style, reused across lines. */
const markCache = new Map<string, Decoration>();

/**
 * A token's mark.
 *
 * The style carries `--shiki-light` and `--shiki-dark` rather than a resolved
 * colour, and the `ed-tok` class is what lets CSS pick between them (see
 * editor.css). Serialisation goes through `styleToCss` from highlight.ts so the
 * editor and the transcript cannot drift on custom-property spelling.
 */
function markFor(token: DualToken): Decoration | null {
  const css = styleToCss(token.style);
  if (css === '') return null;
  let mark = markCache.get(css);
  if (!mark) {
    mark = Decoration.mark({ class: 'ed-tok', attributes: { style: css } });
    markCache.set(css, mark);
  }
  return mark;
}

/**
 * Turn Shiki's per-line tokens into a decoration set.
 *
 * Positions are accumulated from token *lengths* rather than read from
 * `token.offset`: `highlight.ts`'s plain-text fallback fills `offset` with the
 * line index, so trusting it would scramble an unhighlightable file. Lengths
 * are correct in both cases because the tokens of a line always concatenate
 * back to the line.
 */
function decorationsFor(state: EditorState, tokens: DualToken[][]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const count = Math.min(tokens.length, state.doc.lines);
  for (let i = 0; i < count; i += 1) {
    const line = state.doc.line(i + 1);
    let pos = line.from;
    for (const token of tokens[i] ?? []) {
      if (pos >= line.to) break;
      const to = Math.min(pos + token.content.length, line.to);
      if (to <= pos) continue;
      const mark = markFor(token);
      if (mark) builder.add(pos, to, mark);
      pos = to;
    }
  }
  return builder.finish();
}

/**
 * Keeps the Shiki decorations in sync with the document.
 *
 * `highlightToTokens` never throws and caches, so a re-render after an undo is
 * free; a genuinely new document costs one tokenise.
 *
 * **Nothing here reacts to the theme, deliberately.** Tokens are styled for
 * both themes at once (`--shiki-light` / `--shiki-dark`) and CSS picks, so a
 * theme switch is a repaint of decorations that are already correct. Re-running
 * the tokeniser on a flip would rebuild an identical decoration set and would
 * be a second theming mechanism sitting next to the real one. The only staleness
 * left to guard is therefore the document's, which is one counter: a result
 * carrying an old number, or built against a doc that has since moved, is
 * dropped.
 */
function shikiHighlighting(lang: string): Extension {
  return ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null;
      /** Bumped by every event that invalidates an in-flight tokenise. */
      private seq = 0;

      constructor(private readonly view: EditorView) {
        this.run(0);
      }

      update(update: ViewUpdate) {
        if (update.docChanged) this.run(HIGHLIGHT_DEBOUNCE_MS);
      }

      destroy() {
        this.seq += 1;
        if (this.timer) clearTimeout(this.timer);
      }

      private run(delay: number) {
        this.seq += 1;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.tokenize(this.seq);
        }, delay);
      }

      private async tokenize(mine: number) {
        const { view } = this;
        const doc = view.state.doc;
        if (doc.length > MAX_HIGHLIGHT_CHARS) return;
        const code = doc.toString();
        const tokens = peekTokens(code, lang) ?? (await highlightToTokens(code, lang));
        if (mine !== this.seq) return;
        if (!view.state.doc.eq(doc)) return;
        view.dispatch({ effects: setTokenDecorations.of(decorationsFor(view.state, tokens)) });
      }
    },
  );
}

// ---------------------------------------------------------------------------
// "you asked for line N" flash
// ---------------------------------------------------------------------------

const setFlashLine = StateEffect.define<number | null>();

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setFlashLine)) {
        return effect.value === null
          ? Decoration.none
          : Decoration.set([Decoration.line({ class: 'ed-flash' }).range(effect.value)]);
      }
    }
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// ---------------------------------------------------------------------------
// Editing behaviour only -- these packages contribute no colour
// ---------------------------------------------------------------------------

/**
 * A `LanguageSupport` gives us indentation, comment toggling and syntax-aware
 * bracket matching. Colour would only appear if a `HighlightStyle` were
 * installed via `syntaxHighlighting()`, and we deliberately install none --
 * that is Shiki's job. Anything not listed here is edited as plain text and
 * still gets Shiki colour, because the two are independent.
 */
function editingLanguage(relPath: string): Extension | null {
  const ext = relPath.includes('.') ? (relPath.split('.').pop() ?? '').toLowerCase() : '';
  switch (ext) {
    case 'php':
      return php();
    case 'ts':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ typescript: true, jsx: true });
    case 'jsx':
      return javascript({ jsx: true });
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascript();
    default:
      return null;
  }
}

/**
 * Every colour here is a token, so the rules themselves are theme-independent.
 * The one thing that is not is CodeMirror's own `dark` flag: it drives the
 * base theme's chrome (selection layer, panel chrome, tooltip, the
 * `.cm-editor.cm-focused` treatment) and was pinned to `true`. Two instances of
 * the same spec, swapped through a compartment, is all it takes to make that
 * follow -- without rebuilding the view and losing the undo history and
 * scroll position.
 */
const THEME_SPEC = {
  '&': {
    height: '100%',
    backgroundColor: 'var(--panel-inset)',
    color: 'var(--text)',
    fontSize: 'var(--fs-md)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.5',
    overflow: 'auto',
  },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--accent-soft)',
  },
  // Line numbers sit on the two lower text tiers rather than on `--faint`,
  // which is the disabled tier and does not clear 3.0:1 against the well in
  // either theme. The active/inactive distinction is kept, one tier up.
  '.cm-gutters': {
    backgroundColor: 'var(--panel-inset)',
    color: 'var(--muted)',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
  // The four overlays below wash over the code rather than replacing it, so
  // they are alpha veils and cannot be shell tokens. See editor.css.
  '.cm-activeLine': { backgroundColor: 'var(--ed-line-active)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--accent-soft)',
    outline: '1px solid var(--accent-line)',
  },
  // `--del-soft` alone is a 10% wash; on the light well that is #fbeceb, which
  // is not enough to notice. The outline is what carries the signal.
  '.cm-nonmatchingBracket': {
    backgroundColor: 'var(--del-soft)',
    outline: '1px solid var(--del)',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--ed-match)' },
  '.cm-panels': {
    backgroundColor: 'var(--panel)',
    color: 'var(--text)',
    borderBottom: '1px solid var(--border)',
  },
  '.cm-panel input, .cm-panel button': {
    fontFamily: 'var(--font-ui)',
    fontSize: 'var(--fs-sm)',
    backgroundColor: 'var(--panel-raised)',
    color: 'var(--text)',
    border: '1px solid var(--border-strong)',
    borderRadius: 'var(--radius)',
  },
  // Same fill for every hit; the current one gets an outline rather than a
  // darker wash, so the code under the match you are reading stays legible.
  '.cm-searchMatch': { backgroundColor: 'var(--ed-search)' },
  '.cm-searchMatch-selected': {
    backgroundColor: 'var(--ed-search)',
    outline: '1px solid var(--warn)',
  },
};

/** Same rules, two values of CodeMirror's own `dark` flag. */
const themeDark = EditorView.theme(THEME_SPEC, { dark: true });
const themeLight = EditorView.theme(THEME_SPEC, { dark: false });

const themeCompartment = new Compartment();

function themeExtension(theme: ResolvedTheme): Extension {
  return theme === 'dark' ? themeDark : themeLight;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'outside'; path: string }
  | { kind: 'error'; message: string }
  | { kind: 'ready' }
  /** Not text: shown as a picture or described, never put in the editor. */
  | { kind: 'image'; url: string; bytes: number }
  | { kind: 'binary'; bytes: number | null };

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number; noted: boolean }
  | { kind: 'failed'; message: string }
  | { kind: 'conflict'; message: string };

export interface FileEditorProps {
  task: Task;
  request: OpenFileRequest | null;
  onClose: () => void;
  /**
   * Browse only: no edits, no save, no Diff. Set when `task` stands for a
   * project's main checkout (no task selected) -- that folder is the user's
   * real repo, not a throwaway worktree, so nothing typed here may reach it.
   */
  readOnly?: boolean;
  /**
   * The tab on screen. Several editors stay mounted, one per open tab, so
   * each keeps its buffer, undo history and scroll; only the active one may
   * answer the window-level keys (Esc, ⇧⌘D, ⌥⌘↑↓, ⇧⌘C, ⌥⇧⌘C) and draw its
   * controls. Default true.
   */
  active?: boolean;
  /**
   * Where the active editor draws its controls: the ‹ › arrows, Save and ⋯,
   * at the end of the tab row (EditorTabs). Null draws none.
   */
  controlsSlot?: HTMLElement | null;
  /** Told when unsaved edits appear or go, for the tab's dot. */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * The ‹ › arrows walk the change set in place: given, a step replaces this
   * tab's file instead of opening another tab.
   */
  onStep?: (path: string) => void;
  /** Bumped to ask this editor to close, through its unsaved-edits prompt. */
  closeSignal?: number;
  /** File or Diff to start in: the tabs carry the last choice to a new tab. */
  initialMode?: 'file' | 'diff';
  /** The person picked File or Diff (⋯ or ⇧⌘D), not a line jump. */
  onModeChosen?: (mode: 'file' | 'diff') => void;
  /** Told whenever File or Diff changes, for the tab's Diff marker. */
  onModeChange?: (mode: 'file' | 'diff') => void;
}

/** The results dialog's title while a lookup runs, and when it finds nothing. */
const NAV_TITLES: Record<NavAction, string> = {
  declaration: 'Go to Declaration',
  usages: 'Find Usages',
  implementations: 'Go to Implementation',
};

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function FileEditor({
  task,
  request,
  onClose,
  readOnly = false,
  active = true,
  onDirtyChange,
  onStep,
  closeSignal = 0,
  initialMode = 'file',
  onModeChosen,
  onModeChange,
  controlsSlot = null,
}: FileEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** Content as it was last known to be on disk. The overwrite guard's baseline. */
  const baselineRef = useRef<string>('');
  /** Did the file exist when we opened it? A deletion is a conflict too. */
  const existedRef = useRef(false);
  const resolvedRef = useRef<ResolvedPath | null>(null);
  /** Armed by the conflict bar's "overwrite" button, for one save only. */
  const overwriteRef = useRef(false);
  /** The live save handler, so the Cmd+S keymap never closes over stale state. */
  const saveRef = useRef<() => void>(() => {});
  /** The live ⌘B / ⌥F7 / ⌥⌘B handler, read by the keymap for the same reason. */
  const navRef = useRef<(action: NavAction) => void>(() => {});
  /** Review-comment callbacks, read by the CodeMirror extension; null when comments are off. */
  const commentActionsRef = useRef<CommentActions | null>(null);
  /** ⌥⌘M: start a comment on the selected lines. */
  const startCommentRef = useRef<() => void>(() => {});

  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [resolved, setResolved] = useState<ResolvedPath | null>(null);
  const [doc, setDoc] = useState<{ text: string; key: number } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [confirmClose, setConfirmClose] = useState(false);

  /*
   * File | Diff. Component state, NOT reset when the request changes: stepping
   * to the next changed file is a new request, and walking the change set as
   * diffs is the point. A new tab starts in the last mode chosen (see
   * EditorTabs). The CodeMirror view stays alive (hidden) in Diff mode, so
   * unsaved edits, undo history and scroll survive a look at the diff.
   */
  const [mode, setMode] = useState<'file' | 'diff'>(() => (initialMode === 'diff' && !readOnly ? 'diff' : 'file'));
  const modeRef = useRef(mode);
  modeRef.current = mode;
  /** A line asked for while in Diff mode, revealed once the file is showing. */
  const pendingLineRef = useRef<number | null>(null);
  /** Bumped on save so an open diff re-reads the file it describes. */
  const [savedKey, setSavedKey] = useState(0);

  const requestPath = request?.path ?? null;
  const requestLine = request?.line ?? null;

  /** The request path the current view was built for. */
  const viewPathRef = useRef<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Reveal a line, clamped -- a stale trace can name line 900 of a file that
      is now 40 lines long -- and flash it. */
  const revealLine = (view: EditorView, requested: number) => {
    const lineNo = Math.min(Math.max(1, Math.trunc(requested)), view.state.doc.lines);
    const line = view.state.doc.line(lineNo);
    view.dispatch({
      selection: { anchor: line.from },
      effects: [EditorView.scrollIntoView(line.from, { y: 'center' }), setFlashLine.of(line.from)],
    });
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => {
      flashTimer.current = null;
      if (viewRef.current === view) view.dispatch({ effects: setFlashLine.of(null) });
    }, FLASH_MS);
  };

  // --- resolve + read ------------------------------------------------------
  useEffect(() => {
    resolvedRef.current = null;
    overwriteRef.current = false;
    setResolved(null);
    setDoc(null);
    setDirty(false);
    setSaveState({ kind: 'idle' });
    setConfirmClose(false);

    if (requestPath === null) {
      setPhase({ kind: 'idle' });
      setMode('file');
      return;
    }

    let cancelled = false;
    /** The picture's object URL, released when this file is left. */
    let imageUrl: string | null = null;
    setPhase({ kind: 'loading' });

    void (async () => {
      const target = await resolveInWorktree(task.worktreePath, requestPath);
      if (cancelled) return;
      if (!target) {
        // Not an error dialog: a transcript can legitimately mention a path
        // that has nothing to do with this checkout.
        setPhase({ kind: 'outside', path: requestPath });
        return;
      }
      resolvedRef.current = target;
      setResolved(target);

      const imageType = imageTypeForPath(target.relative);
      if (imageType) {
        try {
          const { readFile } = await import('@tauri-apps/plugin-fs');
          const bytes = await readFile(target.absolute);
          if (cancelled) return;
          imageUrl = URL.createObjectURL(new Blob([bytes], { type: imageType }));
          setPhase({ kind: 'image', url: imageUrl, bytes: bytes.length });
        } catch (err) {
          if (!cancelled) setPhase({ kind: 'error', message: message(err) });
        }
        return;
      }

      const { readTextFile } = await import('@tauri-apps/plugin-fs');
      let text: string;
      try {
        text = await readTextFile(target.absolute);
        existedRef.current = true;
      } catch (err) {
        // A path the agent named before creating it opens as an empty buffer;
        // anything else is a real read failure.
        const { exists } = await import('@tauri-apps/plugin-fs');
        const present = await exists(target.absolute).catch(() => true);
        if (cancelled) return;
        if (present) {
          setPhase({ kind: 'error', message: message(err) });
          return;
        }
        text = '';
        existedRef.current = false;
      }
      if (cancelled) return;
      // git's test: a NUL near the start. Decoded as UTF-8 it is noise, and
      // saving that noise back would destroy the file.
      if (looksBinary(text)) {
        const { stat } = await import('@tauri-apps/plugin-fs');
        const size = await stat(target.absolute).then((s) => s.size, () => null);
        if (!cancelled) setPhase({ kind: 'binary', bytes: size });
        return;
      }
      baselineRef.current = text;
      setDoc({ text, key: Date.now() });
      setPhase({ kind: 'ready' });
    })();

    return () => {
      cancelled = true;
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [task.id, task.worktreePath, requestPath]);

  // --- save ----------------------------------------------------------------
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const save = useCallback(async () => {
    // Belt and braces: the view is not editable and the button is not shown,
    // but a stray Cmd+S must still never write to a main checkout.
    if (readOnlyRef.current) return;
    const view = viewRef.current;
    const target = resolvedRef.current;
    if (!view || !target) return;

    const text = view.state.doc.toString();
    setSaveState({ kind: 'saving' });

    const fs = await import('@tauri-apps/plugin-fs');

    // --- the race -------------------------------------------------------
    // The agent is working in this worktree right now. Between opening the
    // file and hitting Cmd+S it may have rewritten it. Re-read and compare
    // against what we opened; if it moved, refuse and let the user choose.
    if (!overwriteRef.current) {
      let onDisk: string | null = null;
      let readFailed = false;
      try {
        onDisk = await fs.readTextFile(target.absolute);
      } catch {
        readFailed = true;
      }
      if (readFailed && existedRef.current) {
        setSaveState({
          kind: 'conflict',
          message: `${target.relative} is no longer readable on disk — it may have been deleted or moved.`,
        });
        return;
      }
      if (onDisk !== null && onDisk !== baselineRef.current) {
        setSaveState({
          kind: 'conflict',
          message: `${target.relative} changed on disk since you opened it.`,
        });
        return;
      }
    }

    try {
      await fs.writeTextFile(target.absolute, text);
    } catch (err) {
      // A failed write must never read as a success.
      setSaveState({ kind: 'failed', message: message(err) });
      return;
    }

    baselineRef.current = text;
    existedRef.current = true;
    overwriteRef.current = false;
    setDirty(false);
    setSavedKey((k) => k + 1);

    // Order matters and is fixed by the spec: write, mark, then note.
    markHandEdited(task.id, target.relative);

    // One line, no newline. `notePty` places it in the input unsent, because
    // the agent may be mid-turn and sending has to stay a human decision.
    const noted = await notePty(
      task.id,
      `Heads up: I hand-edited ${target.relative} in the editor — re-read it before you continue.`,
    ).catch(() => false);

    setSaveState({ kind: 'saved', at: Date.now(), noted });
  }, [task.id]);

  saveRef.current = () => {
    void save();
  };

  const reloadFromDisk = useCallback(async () => {
    const target = resolvedRef.current;
    if (!target) return;
    try {
      const { readTextFile } = await import('@tauri-apps/plugin-fs');
      const text = await readTextFile(target.absolute);
      baselineRef.current = text;
      existedRef.current = true;
      overwriteRef.current = false;
      setDirty(false);
      setSaveState({ kind: 'idle' });
      setDoc({ text, key: Date.now() });
    } catch (err) {
      setSaveState({ kind: 'failed', message: message(err) });
    }
  }, []);

  // --- the CodeMirror instance --------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !doc || !resolved) return;

    const language = editingLanguage(resolved.relative);

    const state = EditorState.create({
      doc: doc.text,
      extensions: [
        // Cmd+S / Ctrl+S ahead of everything, so nothing can swallow it.
        Prec.highest(
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => (saveRef.current(), true) },
            { key: 'Ctrl-s', preventDefault: true, run: () => (saveRef.current(), true) },
            // PhpStorm's Go to Declaration and Find Usages. Navigation, not
            // code intelligence: git grep and the file's imports, no LSP.
            { key: 'Mod-b', preventDefault: true, run: () => (navRef.current('declaration'), true) },
            { key: 'Alt-F7', preventDefault: true, run: () => (navRef.current('usages'), true) },
            // A review comment on the selected lines (or the cursor's line).
            // ⌥⌘M: free in CodeMirror, the app and macOS text fields. With
            // Option, `key` is "µ"; CodeMirror then matches on `keyCode`.
            { key: 'Mod-Alt-m', preventDefault: true, run: () => (startCommentRef.current(), true) },
          ]),
        ),
        // ⌘-click is Go to Declaration, as in PhpStorm, so adding a cursor
        // moves to ⌥-click.
        EditorView.clickAddsSelectionRange.of((e) => e.altKey),
        EditorView.domEventHandlers({
          // ⌥⌘B, PhpStorm's Go to Implementation. Read from `code`, not
          // through the keymap: Option turns `key` into "∫" on macOS.
          keydown: (e) => {
            if (!isImplementationKey(e)) return false;
            e.preventDefault();
            navRef.current('implementations');
            return true;
          },
          mousedown: (e, view) => {
            if (!e.metaKey || e.altKey || e.ctrlKey || e.shiftKey || e.button !== 0) return false;
            const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
            if (pos === null) return false;
            e.preventDefault();
            view.dispatch({ selection: { anchor: pos } });
            navRef.current('declaration');
            return true;
          },
        }),

        // --- the whole extension list. Nothing else belongs here. ---------
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        bracketMatching(),
        history(),
        search({ top: true }),
        highlightSelectionMatches(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        indentUnit.of('  '),
        EditorState.allowMultipleSelections.of(true),
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        // No autocompletion, no linting, no LSP -- per spec. If you are about
        // to add `@codemirror/autocomplete` here, that is the line it breaks.

        // Colour: Shiki only. `language` below is editing behaviour.
        shikiField,
        shikiHighlighting(langForPath(resolved.relative)),
        flashField,
        // Review comments: not on a main checkout, which has no task to send them to.
        ...(readOnly ? [] : [commentsExtension(() => commentActionsRef.current)]),
        ...(language ? [language] : []),
        themeCompartment.of(themeExtension(resolvedTheme())),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            setDirty(update.state.doc.toString() !== baselineRef.current);
            setSaveState((prev) => (prev.kind === 'saved' ? { kind: 'idle' } : prev));
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    // Not from under a Files row the arrows are walking (editorFocus.ts).
    if (editorMayTakeFocus()) view.focus();

    // CodeMirror's own chrome follows the theme through a compartment, so the
    // switch keeps the undo history, the selection and the scroll position.
    // (Shiki's colours are the plugin's business, and it subscribes itself.)
    const offTheme = onThemeChange((theme) => {
      view.dispatch({ effects: themeCompartment.reconfigure(themeExtension(theme)) });
    });

    viewPathRef.current = requestPath;
    if (requestLine !== null && requestLine > 0) revealLine(view, requestLine);

    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
      offTheme();
      viewRef.current = null;
      view.destroy();
    };
    // `doc.key` changes on open and on reload-from-disk; both want a fresh view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.key, resolved, readOnly]);

  // --- a new line in the file already open ----------------------------------
  // The view is rebuilt only when the PATH changes, so a second request for
  // the same file -- Go to Symbol on a method in the open file -- would land
  // nowhere. Keyed on the request object, so asking for the same line twice
  // still jumps. A request for another path is the effect above's business:
  // the view here is still the old file's.
  //
  // A line is a place in the FILE, so a request carrying one leaves Diff mode
  // -- which is what a click on a diff line number is. The reveal waits for
  // the surface to be visible (below); a hidden CodeMirror cannot measure.
  // A request for another path is revealed by the view built for it.
  useEffect(() => {
    if (request === null || request.line == null || request.line < 1) return;
    if (modeRef.current === 'diff') {
      pendingLineRef.current = request.path === viewPathRef.current ? request.line : null;
      setMode('file');
      return;
    }
    const view = viewRef.current;
    if (!view || request.path !== viewPathRef.current) return;
    revealLine(view, request.line);
    view.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  // --- back from Diff mode ---------------------------------------------------
  useEffect(() => {
    const view = viewRef.current;
    if (mode !== 'file' || !view) return;
    const line = pendingLineRef.current;
    pendingLineRef.current = null;
    // The surface was display:none while the diff showed.
    view.requestMeasure();
    if (line !== null) revealLine(view, line);
    view.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // --- File | Diff, and copying the path -----------------------------------
  // ⇧⌘D, ⇧⌘C and ⌥⇧⌘C; see editorKeys.ts for the choice of keys. Capture
  // phase, so they work with the cursor inside the editor -- same as the
  // stepping keys. Only while this editor is on screen: an editor kept
  // mounted behind the Transcript tab must not take a key it cannot show the
  // result of, nor overwrite the clipboard with a path nobody is looking at.
  // A main checkout has no task base to diff against.
  const canDiff = !readOnly && resolved !== null && phase.kind === 'ready';
  /** A choice the person made, which the tabs remember for the next file. */
  const chooseMode = useCallback(
    (next: 'file' | 'diff') => {
      if (next === 'diff' && !canDiff) return;
      setMode(next);
      onModeChosen?.(next);
    },
    [canDiff, onModeChosen],
  );
  const toggleMode = useCallback(() => {
    chooseMode(modeRef.current === 'file' ? 'diff' : 'file');
  }, [chooseMode]);
  useEffect(() => {
    onModeChange?.(mode);
  }, [mode, onModeChange]);

  const title = resolved?.relative ?? request?.path ?? '';
  const absolute = resolved?.absolute ?? null;
  /** "Copied" for a moment, so a keystroke with nothing else to show says it worked. */
  const [copied, setCopied] = useState<'path' | 'full' | 'failed' | null>(null);
  useEffect(() => {
    if (copied === null) return;
    const t = setTimeout(() => setCopied(null), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  const copyPath = useCallback(
    (full: boolean) => {
      // Relative to the worktree is what you paste into a prompt or a command
      // run there; the full path is for anything outside it.
      const text = full && absolute ? absolute : title;
      void copyText(text).then((ok) => setCopied(ok ? (full ? 'full' : 'path') : 'failed'));
    },
    [title, absolute],
  );

  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (request === null || !active) return;
    const onKey = (e: KeyboardEvent) => {
      const hit = editorKeyOf(e);
      const root = rootRef.current;
      if (hit === null || root === null || root.closest('[hidden]') !== null) return;
      e.preventDefault();
      e.stopPropagation();
      if (hit === 'toggle-diff') toggleMode();
      else copyPath(hit === 'copy-full-path');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [request, toggleMode, copyPath, active]);

  // --- close ---------------------------------------------------------------
  const requestClose = useCallback(() => {
    if (dirty) {
      setConfirmClose(true);
      return;
    }
    onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        requestClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestClose, active]);

  // The tab's × and ⌘W ask through here, so they get the same prompt.
  const closeSignalSeen = useRef(closeSignal);
  useEffect(() => {
    if (closeSignal === closeSignalSeen.current) return;
    closeSignalSeen.current = closeSignal;
    requestClose();
  }, [closeSignal, requestClose]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // Shown again: a hidden CodeMirror cannot measure, and the keys go here now.
  useEffect(() => {
    if (!active) return;
    const view = viewRef.current;
    if (!view) return;
    view.requestMeasure();
    if (editorMayTakeFocus()) view.focus();
  }, [active]);
  // Enter on a Files row hands the keyboard here.
  useEffect(() => (active ? onFocusEditor(() => viewRef.current?.focus()) : undefined), [active]);

  // --- stepping through the change set --------------------------------------
  // The touched-files list publishes its order; the editor walks it. Blocked
  // while there are unsaved edits, so a keystroke can never discard work.
  const openFile = useOpenFile();
  const [order, setOrder] = useState<readonly string[]>(() => touchedOrder(task.id));
  useEffect(() => {
    setOrder(touchedOrder(task.id));
    return onTouchedOrderChange(() => setOrder(touchedOrder(task.id)));
  }, [task.id]);
  const current = resolved?.relative ?? null;
  const position = current === null ? -1 : order.indexOf(current);
  const step = useCallback(
    (dir: 1 | -1) => {
      if (dirty || current === null) return;
      const next = neighbour(order, current, dir);
      if (next === null) return;
      if (onStep) onStep(next);
      else openFile({ path: next });
    },
    [dirty, current, order, openFile, onStep],
  );
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || !e.altKey || e.ctrlKey) return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      e.stopPropagation();
      step(e.key === 'ArrowDown' ? 1 : -1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [step, active]);

  // --- Go to Declaration / Find Usages / Go to Implementation -------------
  // A PHP file opened is the one signal that starts PHPantom, ahead of the
  // first ⌘B so its ~1s of indexing overlaps the reading. Any other file
  // type never starts it. A no-op when it is not installed or already up.
  const worktree = task.worktreePath;
  useEffect(() => {
    if (current !== null && isPhpPath(current)) warmPhpantom(worktree);
  }, [current, worktree]);
  // When it could not start, lookups quietly answer by text search instead.
  // Said on a PHP file, the only place it matters, and once per run.
  const phpantomDown = useSyncExternalStore(subscribePhpantomFailure, phpantomFailure);
  const showPhpantomDown = phpantomDown !== null && current !== null && isPhpPath(current);

  // Like stepping, a jump to another file is blocked while there are unsaved
  // edits; a jump within this file is not, since nothing is reloaded.
  const [nav, setNav] = useState<SymbolResultsState | null>(null);
  /** Bumped per lookup; a slower, superseded answer is dropped. */
  const navSeq = useRef(0);
  const closeNav = useCallback(() => {
    navSeq.current++;
    setNav(null);
    viewRef.current?.focus();
  }, []);
  const jump = useCallback(
    (path: string, line: number) => {
      if (dirty && path !== current) {
        setNav({ kind: 'message', title: 'Unsaved Edits', message: 'Save or discard your edits first' });
        return false;
      }
      setNav(null);
      openFile({ path, line });
      return true;
    },
    [dirty, current, openFile],
  );
  navRef.current = (action: NavAction) => {
    const view = viewRef.current;
    if (!view || current === null) return;
    const mine = ++navSeq.current;
    const title = NAV_TITLES[action];
    setNav({ kind: 'loading', title });
    navigate(
      { root: task.worktreePath, path: current, text: view.state.doc.toString(), offset: view.state.selection.main.head },
      action,
    )
      .then((out) => {
        if (navSeq.current !== mine) return;
        if (out.kind === 'open') jump(out.path, out.line);
        else if (out.kind === 'list') setNav({ kind: 'list', title: out.title, result: out.result, note: out.note });
        else setNav({ kind: 'message', title, message: out.message, note: out.note });
      })
      .catch((err: unknown) => {
        if (navSeq.current === mine) setNav({ kind: 'message', title, message: `Search failed: ${message(err)}` });
      });
  };

  // --- review comments ----------------------------------------------------
  // Stored in SQLite (src/db/comments.ts). Placed by the code they were left
  // on, so they follow it when the agent moves it; a comment whose code is
  // gone is listed as outdated rather than pinned to the wrong lines.
  const commentsOn = !readOnly;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const [fileComments, setFileComments] = useState<ReviewComment[]>([]);
  const [outdated, setOutdated] = useState<ReviewComment[]>([]);
  const [commentNotice, setCommentNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!commentsOn || current === null) {
      setFileComments([]);
      return;
    }
    let live = true;
    const load = () =>
      void listComments(task.id).then(
        (all) => {
          if (live) setFileComments(all.filter((c) => c.path === current));
        },
        // Comments are a layer on the file: failing to read them must not
        // break the editor. The file shows without them, and says so.
        (err: unknown) => {
          if (live) setCommentNotice(`Could not read this file’s comments: ${message(err)}`);
        },
      );
    load();
    const off = onCommentsChanged((id) => {
      if (id === task.id) load();
    });
    return () => {
      live = false;
      off();
    };
  }, [commentsOn, task.id, current]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || phase.kind !== 'ready') return;
    const text = view.state.doc.toString();
    const placed: PlacedComment[] = [];
    const lost: ReviewComment[] = [];
    for (const c of fileComments) {
      const at = relocate(c, text);
      if (at.state === 'outdated') {
        lost.push(c);
        continue;
      }
      placed.push({ comment: c, from: view.state.doc.line(at.lineStart).from, to: view.state.doc.line(at.lineEnd).to });
      // Moved in the file on disk: remember where. Not while the buffer holds
      // unsaved typing, which is not the file the comment refers to.
      if (!dirtyRef.current && (at.lineStart !== c.lineStart || at.lineEnd !== c.lineEnd)) {
        // Best effort: if it fails, the comment is simply found again next time.
        moveComment(task.id, c.id, at.lineStart, at.lineEnd).catch((err: unknown) =>
          console.warn('[comments] could not record the new position', err),
        );
      }
    }
    view.dispatch({ effects: setPlacedComments.of(placed) });
    setOutdated(lost);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileComments, phase.kind, doc?.key]);

  /** A comment write that failed says so, rather than leaving the list quietly wrong. */
  const reportFailure = (write: Promise<unknown>, what: string) => {
    write.catch((err: unknown) => setCommentNotice(`Could not ${what}: ${message(err)}`));
  };

  commentActionsRef.current =
    commentsOn && current !== null
      ? {
          save: (draft, text, state) => {
            const view = viewRef.current;
            if (!view) return;
            let write: Promise<unknown>;
            if (draft.editing) {
              write = editComment(task.id, draft.editing.id, text);
            } else {
              // The comment quotes the file as Claude Code will read it, so
              // it is refused while the buffer differs from what is on disk.
              if (dirtyRef.current) {
                setCommentNotice('Save your edits first: a comment refers to the file as it is on disk.');
                return;
              }
              const a = state.doc.lineAt(draft.from);
              const b = state.doc.lineAt(draft.to);
              write = addComment({
                taskId: task.id,
                path: current,
                lineStart: a.number,
                lineEnd: b.number,
                anchorText: state.doc.sliceString(a.from, b.to),
                body: text,
              });
            }
            // The box closes only once the comment is stored: until then the
            // text lives nowhere else, and a failed write must not lose it.
            write.then(
              () => {
                setCommentNotice(null);
                view.dispatch({ effects: setDraft.of(null) });
                view.focus();
              },
              (err: unknown) => setCommentNotice(`Could not save the comment, which is still in its box: ${message(err)}`),
            );
          },
          edit: (c) => {
            const view = viewRef.current;
            const at = view?.state.field(commentsField).placed.find((p) => p.comment.id === c.id);
            if (view && at) view.dispatch({ effects: setDraft.of({ from: at.from, to: at.to, editing: c }) });
          },
          resolve: (c) => reportFailure(resolveComment(task.id, c.id), 'resolve the comment'),
          remove: (c) => reportFailure(deleteComment(task.id, c.id), 'delete the comment'),
        }
      : null;
  startCommentRef.current = () => {
    const view = viewRef.current;
    if (!view || !commentsOn || mode !== 'file') return;
    view.dispatch({ effects: setDraft.of({ ...linesOfSelection(view.state), editing: null }) });
  };

  if (request === null) return null;

  const fileName = title.slice(title.lastIndexOf('/') + 1);

  const menu: OverflowItem[] = [
    ...(readOnly
      ? []
      : [
          {
            id: 'diff',
            label: 'Diff',
            checked: mode === 'diff',
            aside: '⇧⌘D',
            disabled: !canDiff,
            title: "This task's change to the file: the branch's base against the working tree, committed and uncommitted together",
            onSelect: toggleMode,
          },
        ]),
    {
      id: 'find',
      label: 'Find',
      aside: '⌘F',
      disabled: phase.kind !== 'ready' || mode === 'diff',
      onSelect: () => {
        const view = viewRef.current;
        if (view) openSearchPanel(view);
      },
    },
    { id: 'copy-path', label: 'Copy Path', aside: '⌥⇧⌘C', title, group: true, onSelect: () => copyPath(false) },
    {
      id: 'copy-full-path',
      label: 'Copy Full Path',
      aside: '⇧⌘C',
      title: absolute ?? undefined,
      disabled: absolute === null,
      onSelect: () => copyPath(true),
    },
  ];

  // Status first, so the arrows stay put when it comes and goes. It is the
  // first thing to give way in a narrow column (editortabs.css), so ⋯ repeats
  // it as its heading.
  const status: Status | null =
    copied !== null
      ? copied === 'failed'
        ? { tone: 'error', text: 'Copy Failed' }
        : { tone: 'ok', text: copied === 'full' ? 'Full Path Copied' : 'Path Copied' }
      : saveStatus(saveState);

  // Drawn at the end of the tab row, which already names the file: the tab
  // carries the name, the unsaved dot and the Diff marker, and its tooltip the
  // path. Outside this component's dialog in the page, so the group names the
  // file itself.
  const controls = (
    <div className="ed-controls" role="toolbar" aria-label={`${fileName} Actions`} data-dirty={dirty || undefined}>
      {status && (
        <span className="ed-status" data-tone={status.tone} title={status.text}>
          {status.text}
        </span>
      )}
      {position >= 0 && order.length > 1 ? (
        <span className="ed-nav" aria-label="Changed files">
          <button
            type="button"
            className="ed-nav-btn"
            onClick={() => step(-1)}
            disabled={dirty}
            title={dirty ? 'Save or discard your edits first' : 'Previous changed file (⌥⌘↑)'}
            aria-label="Previous changed file"
          >
            ‹
          </button>
          {/* Hidden first when the column narrows; see editortabs.css. */}
          <span className="ed-nav-pos">
            {position + 1} / {order.length}
          </span>
          <button
            type="button"
            className="ed-nav-btn"
            onClick={() => step(1)}
            disabled={dirty}
            title={dirty ? 'Save or discard your edits first' : 'Next changed file (⌥⌘↓)'}
            aria-label="Next changed file"
          >
            ›
          </button>
        </span>
      ) : null}
      {readOnly ? (
        // A lock alone in a narrow column; the words stay for a screen reader.
        <span
          className="ed-badge ed-readonly"
          title="Read-only, main checkout: opened with no task selected, this is the project's own folder, so it is shown and never saved"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <rect x="3" y="7" width="10" height="7.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          <span className="ed-readonly-text">Read-Only · Main Checkout</span>
        </span>
      ) : dirty ? (
        // The one main action, and only while there is something to save.
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => saveRef.current()}
          disabled={saveState.kind === 'saving'}
          title="Save to the worktree (⌘S)"
        >
          Save
        </button>
      ) : null}
      <OverflowMenu label="File Actions" items={menu} heading={status?.text} />
    </div>
  );

  return (
    <div ref={rootRef} className="ed-root" role="dialog" aria-label={`Editing ${title}`}>
      {active && controlsSlot ? createPortal(controls, controlsSlot) : null}

      {saveState.kind === 'conflict' && (
        <div className="ed-notice" data-tone="warn">
          <span>{saveState.message}</span>
          <button
            type="button"
            className="ed-btn"
            onClick={() => void reloadFromDisk()}
            title="Throw away your edits and load what is on disk"
          >
            Reload from Disk
          </button>
          <button
            type="button"
            className="ed-btn ed-danger"
            onClick={() => {
              overwriteRef.current = true;
              saveRef.current();
            }}
            title="Write your version over the one on disk"
          >
            Overwrite Anyway
          </button>
        </div>
      )}

      {saveState.kind === 'failed' && (
        <div className="ed-notice" data-tone="error">
          <span>Not saved: {saveState.message}</span>
        </div>
      )}

      {saveState.kind === 'saved' && !saveState.noted && (
        <div className="ed-notice" data-tone="muted">
          <span>Saved. No live session for this task, so no note was placed in the terminal.</span>
        </div>
      )}

      {confirmClose && (
        <div className="ed-notice" data-tone="warn">
          <span>Unsaved changes.</span>
          <button type="button" className="ed-btn" onClick={() => setConfirmClose(false)}>
            Keep Editing
          </button>
          <button
            type="button"
            className="ed-btn"
            onClick={() => {
              setConfirmClose(false);
              saveRef.current();
            }}
          >
            Save
          </button>
          <button type="button" className="ed-btn ed-danger" onClick={onClose}>
            Discard
          </button>
        </div>
      )}

      {showPhpantomDown && (
        <div className="ed-notice" data-tone="muted">
          <span title={phpantomDown}>PHP navigation is using text search: PHPantom couldn’t start.</span>
          <button type="button" className="ed-btn" onClick={dismissPhpantomFailure}>
            OK
          </button>
        </div>
      )}

      {commentNotice && (
        <div className="ed-notice" data-tone="warn">
          <span>{commentNotice}</span>
          <button type="button" className="ed-btn" onClick={() => setCommentNotice(null)}>
            OK
          </button>
        </div>
      )}

      {/* A comment whose code is no longer in the file: shown, never pinned to
          whatever now sits at its old lines. */}
      {outdated.length > 0 && (
        <div className="ed-notice ed-cmt-outdated" data-tone="muted">
          <span>
            {outdated.length === 1 ? 'A comment' : `${outdated.length} comments`} on this file no longer match its
            code:
          </span>
          {outdated.map((c) => (
            <span key={c.id} className="ed-cmt-outdated-item" title={c.anchorText}>
              <span className="ed-cmt-outdated-body">
                Lines {c.lineStart}–{c.lineEnd}: {c.body.split('\n')[0]}
              </span>
              <button type="button" className="ed-btn" onClick={() => reportFailure(resolveComment(task.id, c.id), 'resolve the comment')}>
                Resolve
              </button>
              <button
                type="button"
                className="ed-btn ed-danger"
                onClick={() => reportFailure(deleteComment(task.id, c.id), 'delete the comment')}
              >
                Delete
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="ed-body">
        {phase.kind === 'loading' && <div className="ed-message">Opening {request.path}…</div>}
        {phase.kind === 'outside' && (
          <div className="ed-message">
            <strong>{phase.path}</strong> is outside this worktree.
            <div className="ed-message-sub">
              Albedo only opens files inside <code>{task.worktreePath}</code>. A path in the
              transcript that points elsewhere is shown, never opened.
            </div>
          </div>
        )}
        {phase.kind === 'error' && (
          <div className="ed-message" data-tone="error">
            Could not read {request.path}
            <div className="ed-message-sub">{phase.message}</div>
          </div>
        )}
        {phase.kind === 'image' && <ImagePreview url={phase.url} bytes={phase.bytes} name={fileName} />}
        {phase.kind === 'binary' && (
          <div className="ed-message">
            <strong>{fileName}</strong> is a binary file{phase.bytes !== null && ` · ${formatBytes(phase.bytes)}`}.
            <div className="ed-message-sub">It is not text, so it is not shown here and cannot be edited.</div>
          </div>
        )}
        {mode === 'diff' && resolved !== null && phase.kind === 'ready' ? (
          <FileDiffView task={task} target={resolved} reloadKey={savedKey} unsaved={dirty} />
        ) : null}
        <div className="ed-surface" ref={hostRef} hidden={phase.kind !== 'ready' || mode === 'diff'} />
      </div>
      <SymbolResults state={nav} onClose={closeNav} onOpen={(m) => jump(m.path, m.line)} />
    </div>
  );
}

/**
 * A picture, fitted to the pane; a click shows it at its own size (and back),
 * as Preview and PhpStorm's image viewer do. The checkerboard is there so
 * transparency reads as transparency, not as the pane's colour.
 */
function ImagePreview({ url, bytes, name }: { url: string; bytes: number; name: string }) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [actual, setActual] = useState(false);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setSize(null);
    setActual(false);
    setBroken(false);
  }, [url]);

  if (broken) {
    return (
      <div className="ed-message">
        <strong>{name}</strong> could not be shown · {formatBytes(bytes)}.
        <div className="ed-message-sub">The file is not an image this app can render, or it is damaged.</div>
      </div>
    );
  }

  return (
    <div className="ed-image">
      <div className="ed-image-stage" data-actual={actual}>
        <img
          src={url}
          alt={name}
          onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onError={() => setBroken(true)}
          onClick={() => setActual((a) => !a)}
          title={actual ? 'Fit to the pane' : 'Show at actual size'}
        />
      </div>
      <div className="ed-image-meta">
        {size && (
          <span>
            {size.w} × {size.h}
          </span>
        )}
        <span>{formatBytes(bytes)}</span>
        <span className="ed-spacer" />
        <button type="button" className="ed-btn" onClick={() => setActual((a) => !a)}>
          {actual ? 'Fit' : 'Actual Size'}
        </button>
      </div>
    </div>
  );
}

interface Status {
  tone: 'muted' | 'ok' | 'warn' | 'error';
  text: string;
}

function saveStatus(state: SaveState): Status | null {
  switch (state.kind) {
    case 'saving':
      return { tone: 'muted', text: 'Saving…' };
    case 'saved':
      return { tone: 'ok', text: state.noted ? 'Saved · Note in Terminal' : 'Saved' };
    case 'failed':
      return { tone: 'error', text: 'Not Saved' };
    case 'conflict':
      return { tone: 'warn', text: 'Changed on Disk' };
    default:
      return null;
  }
}
