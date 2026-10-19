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

import { copyText } from '../../lib/clipboard';
import { neighbour, onTouchedOrderChange, touchedOrder } from '../touchedOrder';
import { useOpenFile } from './openFile';
import FileDiffView from './FileDiffView';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { isHandEdited, markHandEdited, onHandEditedChange } from '../../lib/handEdited';
import { onThemeChange, resolvedTheme } from '../theme';
import type { ResolvedTheme } from '../theme';
import { notePty } from '../Terminal';
import './editor.css';

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
  | { kind: 'ready' };

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
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function FileEditor({ task, request, onClose, readOnly = false }: FileEditorProps) {
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

  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [resolved, setResolved] = useState<ResolvedPath | null>(null);
  const [doc, setDoc] = useState<{ text: string; key: number } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [handEdited, setHandEdited] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  /*
   * File | Diff. Component state, NOT reset when the request changes: stepping
   * to the next changed file is a new request, and walking the change set as
   * diffs is the point. Reset on close, so the next file opened from scratch
   * opens as a file. The CodeMirror view stays alive (hidden) in Diff mode, so
   * unsaved edits, undo history and scroll survive a look at the diff.
   */
  const [mode, setMode] = useState<'file' | 'diff'>('file');
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
      setHandEdited(isHandEdited(task.id, target.relative));

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
      baselineRef.current = text;
      setDoc({ text, key: Date.now() });
      setPhase({ kind: 'ready' });
    })();

    return () => {
      cancelled = true;
    };
  }, [task.id, task.worktreePath, requestPath]);

  // --- hand-edited badge stays live ---------------------------------------
  useEffect(() => {
    if (!resolved) return;
    const sync = () => setHandEdited(isHandEdited(task.id, resolved.relative));
    sync();
    return onHandEditedChange(sync);
  }, [task.id, resolved]);

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
    setHandEdited(true);

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
          ]),
        ),

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
    view.focus();

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

  // --- File | Diff: Shift-Command-D -----------------------------------------
  // Not PhpStorm's Command-D: CodeMirror binds Mod-d to "select next
  // occurrence", and an editor where that key stopped working would be worse
  // than a different chord. Shift-Command-D is bound by neither CodeMirror,
  // the default macOS menu, nor the app keymap. Command only, matched on the
  // physical key (Shift makes `key` "D"), and Control is left alone: it would
  // reach the terminal as Ctrl-D, which is EOF. Capture phase, so it works
  // with the cursor inside the editor -- same as the stepping keys.
  // A main checkout has no task base to diff against.
  const canDiff = !readOnly && resolved !== null && phase.kind === 'ready';
  const toggleMode = useCallback(() => {
    if (!canDiff) return;
    setMode((m) => (m === 'file' ? 'diff' : 'file'));
  }, [canDiff]);
  useEffect(() => {
    if (request === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || !e.shiftKey || e.altKey || e.ctrlKey || e.code !== 'KeyD') return;
      e.preventDefault();
      e.stopPropagation();
      toggleMode();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [request, toggleMode]);

  // --- close ---------------------------------------------------------------
  const requestClose = useCallback(() => {
    if (dirty) {
      setConfirmClose(true);
      return;
    }
    onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        requestClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestClose]);

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
      if (next !== null) openFile({ path: next });
    },
    [dirty, current, order, openFile],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || !e.altKey || e.ctrlKey) return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      e.stopPropagation();
      step(e.key === 'ArrowDown' ? 1 : -1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [step]);

  if (request === null) return null;

  const title = resolved?.relative ?? request.path;

  return (
    <div className="ed-root" role="dialog" aria-label={`Editing ${title}`}>
      <div className="ed-bar">
        <span className="ed-path" title={resolved?.absolute ?? request.path}>
          {title}
        </span>
        <CopyPathButton path={title} absolute={resolved?.absolute ?? null} />
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
        {requestLine !== null && <span className="ed-line">:{requestLine}</span>}
        {handEdited && (
          <span className="ed-badge" title="You saved this file by hand in this session">
            hand-edited
          </span>
        )}
        {dirty && <span className="ed-dot" title="Unsaved changes" />}

        <span className="ed-spacer" />

        {readOnly ? (
          <span className="ed-badge" title="Opened with no task selected: this is the project's own folder, so it is shown and never saved">
            read-only · main checkout
          </span>
        ) : (
          <>
            <span className="ed-mode" role="group" aria-label="Show">
              <button
                type="button"
                className="ed-mode-btn"
                aria-pressed={mode === 'file'}
                onClick={() => setMode('file')}
                title="The file as it is now (⇧⌘D toggles)"
              >
                File
              </button>
              <button
                type="button"
                className="ed-mode-btn"
                aria-pressed={mode === 'diff'}
                aria-keyshortcuts="Shift+Meta+D"
                onClick={() => canDiff && setMode('diff')}
                disabled={!canDiff}
                title="This task's change to the file: the branch's base against the working tree, committed and uncommitted together (⇧⌘D)"
              >
                Diff
              </button>
            </span>

            <SaveIndicator state={saveState} />

            <button
              type="button"
              className="ed-btn"
              onClick={() => saveRef.current()}
              disabled={phase.kind !== 'ready' || saveState.kind === 'saving'}
              title="Save to the worktree (⌘S)"
            >
              Save
            </button>
          </>
        )}
        <button
          type="button"
          className="ed-btn"
          onClick={() => {
            const view = viewRef.current;
            if (view) openSearchPanel(view);
          }}
          disabled={phase.kind !== 'ready' || mode === 'diff'}
          title="Find (⌘F)"
        >
          Find
        </button>
        <button type="button" className="ed-btn ed-close" onClick={requestClose} title="Close (Esc)">
          ✕
        </button>
      </div>

      {saveState.kind === 'conflict' && (
        <div className="ed-notice" data-tone="warn">
          <span>{saveState.message}</span>
          <button
            type="button"
            className="ed-btn"
            onClick={() => void reloadFromDisk()}
            title="Throw away your edits and load what is on disk"
          >
            Reload from disk
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
            Overwrite anyway
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
            Keep editing
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

      <div className="ed-body">
        {phase.kind === 'loading' && <div className="ed-message">opening {request.path}…</div>}
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
        {mode === 'diff' && resolved !== null && phase.kind === 'ready' ? (
          <FileDiffView task={task} target={resolved} reloadKey={savedKey} unsaved={dirty} />
        ) : null}
        <div className="ed-surface" ref={hostRef} hidden={phase.kind !== 'ready' || mode === 'diff'} />
      </div>
    </div>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  switch (state.kind) {
    case 'saving':
      return <span className="ed-status" data-tone="muted">saving…</span>;
    case 'saved':
      return (
        <span className="ed-status" data-tone="ok">
          {state.noted ? 'saved · note in terminal' : 'saved'}
        </span>
      );
    case 'failed':
      return <span className="ed-status" data-tone="error">not saved</span>;
    case 'conflict':
      return <span className="ed-status" data-tone="warn">changed on disk</span>;
    default:
      return null;
  }
}

/**
 * Copy the path shown above the editor. A click copies it as shown (relative
 * to the worktree, which is what you paste into a prompt or a command run
 * there); Option-click copies the absolute path. "copied" confirms it for a
 * moment rather than leaving you to wonder whether it worked.
 */
function CopyPathButton({ path, absolute }: { path: string; absolute: string | null }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 1400);
    return () => clearTimeout(t);
  }, [state]);

  const copy = useCallback(
    (wantAbsolute: boolean) => {
      const text = wantAbsolute && absolute ? absolute : path;
      void copyText(text).then((ok) => setState(ok ? 'copied' : 'failed'));
    },
    [path, absolute],
  );

  // Option-Command-C, Finder's "Copy as Pathname" (VS Code agrees); with Shift,
  // the absolute path. Matched on `code`, because Option turns `key` into "ç".
  // Capture phase, so it works with the cursor inside the editor too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || !e.altKey || e.ctrlKey || e.code !== 'KeyC') return;
      e.preventDefault();
      e.stopPropagation();
      copy(e.shiftKey);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [copy]);

  return (
    <button
      type="button"
      className="ed-copy"
      data-state={state}
      onClick={(e) => copy(e.altKey)}
      title={absolute ? 'Copy path (⌥⌘C) · absolute path: ⌥-click or ⇧⌥⌘C' : 'Copy path (⌥⌘C)'}
      aria-label="Copy path"
      aria-keyshortcuts="Alt+Meta+C"
    >
      {state === 'copied' ? 'copied' : state === 'failed' ? 'copy failed' : (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M3.5 10.5h-1a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v1" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      )}
    </button>
  );
}
