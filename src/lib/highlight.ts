/**
 * Shiki wrapper, shared by the transcript pane and the editor.
 *
 * One highlighter instance for the whole app, created lazily on first use, with
 * a bounded set of grammars loaded on demand. Grammars are `import()`ed one by
 * one so the bundler code-splits them -- pulling in Shiki's full bundle would
 * add megabytes of TextMate JSON to the initial load for no benefit.
 *
 * ## Theming
 *
 * Code is tokenized for BOTH themes at once -- one grammar pass, see "One
 * grammar pass for both themes" below -- and every token carries two
 * colours as CSS custom properties (`--shiki-light` / `--shiki-dark`); a CSS
 * rule picks which one applies. Switching theme is then a pure CSS repaint:
 * nothing re-tokenizes, nothing re-renders, there is no flash of unstyled code,
 * and the token cache below stays theme-agnostic -- which is the point, because
 * that cache is what lets a re-render paint highlighted on its first frame.
 *
 * Every entry point is failure-tolerant: an unknown language, a grammar that
 * fails to fetch or a tokenizer that throws all degrade to plain unstyled
 * tokens. Syntax colour is a nicety; the transcript must render regardless.
 */

import { applyColorReplacements, createHighlighterCore, splitLines } from 'shiki/core';
// Shiki 3 took the engines out of `shiki/core`; each has its own entry point.
// Oniguruma (WASM) is the engine the grammars are written for, and the one
// Albedo has always used, so tokens stay what they were.
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import { EncodedTokenMetadata, INITIAL, Theme } from 'shiki/textmate';
import type { HighlighterCore, TokenStyles } from 'shiki/core';
import type { StateStack } from 'shiki/textmate';

/**
 * The two themes, tokenized together. Consumers that need a theme id (the
 * editor's CodeMirror bridge) should read these rather than hardcode.
 */
export const THEMES = { light: 'github-light-default', dark: 'github-dark-default' } as const;

/**
 * A token carrying the styling for both themes at once.
 *
 * `style` is ready to spread onto a React element: the two custom properties
 * plus any shared font styling. Consumers never look at a theme -- CSS does.
 */
export interface DualToken {
  content: string;
  offset: number;
  style: Record<string, string>;
}

/**
 * The grammars we are willing to pay for. Anything outside this list renders as
 * plain text -- deliberately, so the set stays auditable.
 */
const LANGS: Record<string, () => Promise<unknown>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  less: () => import('shiki/langs/less.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  docker: () => import('shiki/langs/docker.mjs'),
  makefile: () => import('shiki/langs/make.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  proto: () => import('shiki/langs/proto.mjs'),
  elixir: () => import('shiki/langs/elixir.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  r: () => import('shiki/langs/r.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
};

/** The bounded set, for tests: every name here must load a grammar. */
export const SUPPORTED_LANGS: readonly string[] = Object.keys(LANGS);

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loaded = new Set<string>();
const loading = new Map<string, Promise<boolean>>();

export function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [
        import('shiki/themes/github-light-default.mjs'),
        import('shiki/themes/github-dark-default.mjs'),
      ],
      langs: [],
      engine: createOnigurumaEngine(import('shiki/wasm')),
    }).catch((err) => {
      // Allow a later retry rather than wedging the pane permanently.
      highlighterPromise = null;
      throw err;
    });
  }
  return highlighterPromise;
}

export async function ensureLang(lang: string): Promise<boolean> {
  if (loaded.has(lang)) return true;
  const loader = LANGS[lang];
  if (!loader) return false;
  const inflight = loading.get(lang);
  if (inflight) return inflight;

  const p = (async () => {
    try {
      const hl = await getHighlighter();
      const mod = (await loader()) as { default?: unknown };
      await hl.loadLanguage(mod.default as never);
      loaded.add(lang);
      return true;
    } catch {
      return false;
    } finally {
      loading.delete(lang);
    }
  })();
  loading.set(lang, p);
  return p;
}

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------

/**
 * The cache is bounded by TOKENS, not by entries. An entry is a whole file --
 * the editor re-highlights the buffer after an edit and the Diff mode both
 * sides of every file it shows -- so an entry count let a few hundred large
 * files hold on to a gigabyte. Measured: ~1.1 MB per 1,100-line file before
 * styles were shared. The budget keeps several dozen such files warm.
 */
let TOKEN_BUDGET = 250_000;
const CACHE_MAX = 400;
const cache = new Map<string, DualToken[][]>();
const cacheTokens = new Map<string, number>();
let cachedTokens = 0;

function tokenCount(lines: DualToken[][]): number {
  let n = 0;
  for (const l of lines) n += l.length;
  return n;
}

function cacheKey(code: string, lang: string): string {
  // No theme in the key: tokens carry both themes, so one entry serves either.
  return `${lang}\u0000${code}`;
}

function cacheDrop(key: string): void {
  if (!cache.delete(key)) return;
  cachedTokens -= cacheTokens.get(key) ?? 0;
  cacheTokens.delete(key);
}

function cachePut(key: string, value: DualToken[][]): void {
  cacheDrop(key);
  const size = tokenCount(value);
  cache.set(key, value);
  cacheTokens.set(key, size);
  cachedTokens += size;
  // Oldest first, but never the entry just added: a file bigger than the
  // whole budget is still served from cache until the next one arrives.
  for (const oldest of cache.keys()) {
    if ((cachedTokens <= TOKEN_BUDGET && cache.size <= CACHE_MAX) || oldest === key) break;
    cacheDrop(oldest);
  }
}

/** For tests: a small budget, so eviction can be exercised with small files. */
export function setTokenBudgetForTests(tokens: number): void {
  TOKEN_BUDGET = tokens;
}

/** For tests: how much the cache holds. */
export function cacheStats(): { entries: number; tokens: number } {
  return { entries: cache.size, tokens: cachedTokens };
}

/**
 * Tokens for `code` if they were already computed. Lets a component render the
 * highlighted form on its first paint after the async work has completed once,
 * instead of flashing plain text on every re-render.
 */
export function peekTokens(code: string, lang: string): DualToken[][] | undefined {
  return cache.get(cacheKey(code, lang));
}

/** One unstyled token per line -- the shape callers get when highlighting is unavailable. */
export function plainTokens(code: string): DualToken[][] {
  return code.split('\n').map((line, i) => [{ content: line, offset: i, style: {} }]);
}

// ---------------------------------------------------------------------------
// Token styling
// ---------------------------------------------------------------------------

/** Shiki's FontStyle bit flags. */
const ITALIC = 1;
const BOLD = 2;
const UNDERLINE = 4;

/**
 * Fold the two theme variants of one token into a single inline style.
 *
 * Colour is emitted as two custom properties and resolved in CSS. Font styling
 * is shared rather than per-theme: across the 85 scopes the github-light /
 * github-dark pair defines, 14 carry a font style and none of them disagree
 * (checked, not assumed), so two more custom properties per token would buy a
 * difference that does not exist. If a future theme pair disagrees, this is the
 * one place to split it.
 */
function dualStyle(light: TokenStyles | undefined, dark: TokenStyles | undefined): Record<string, string> {
  const fs = dark?.fontStyle ?? light?.fontStyle ?? 0;
  const key = `${light?.color ?? ''}|${dark?.color ?? ''}|${fs}`;
  const shared = styles.get(key);
  if (shared) return shared;
  const style: Record<string, string> = {};
  if (light?.color) style['--shiki-light'] = light.color;
  if (dark?.color) style['--shiki-dark'] = dark.color;
  if (fs > 0) {
    if (fs & ITALIC) style.fontStyle = 'italic';
    if (fs & BOLD) style.fontWeight = 'bold';
    if (fs & UNDERLINE) style.textDecoration = 'underline';
  }
  styles.set(key, Object.freeze(style) as Record<string, string>);
  return style;
}

/**
 * One style object per distinct style, shared by every token that has it. A
 * 1,100-line file is ~5,800 tokens in only ~9 styles; an object per token was
 * most of what each cached file cost. Frozen, because it is shared: nothing
 * may write to a token's style.
 */
const styles = new Map<string, Record<string, string>>();

/**
 * Serialise a token style for contexts that need a CSS text string rather than
 * a React style object -- CodeMirror's `Decoration.mark` attributes, notably.
 * Shared so the two consumers cannot drift on custom-property spelling.
 */
export function styleToCss(style: Record<string, string>): string {
  return Object.entries(style)
    .map(([k, v]) => `${k.startsWith('--') ? k : k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${v}`)
    .join(';');
}

// ---------------------------------------------------------------------------
// One grammar pass for both themes (#418)
// ---------------------------------------------------------------------------

/*
 * Shiki's `codeToTokensWithThemes` runs the grammar once per theme and then
 * aligns the two token lists. The grammar's regexes are most of the cost, and
 * they do not depend on the theme: only the style a theme gives each scope
 * does. So the grammar runs once here, against a theme that stands for BOTH --
 * `BothThemes` below -- and each token's style ids name the pair of styles the
 * two real themes give it.
 *
 * That is exactly the old output, token for token:
 *
 * - vscode-textmate gives a token the style of its scope stack, each scope
 *   overriding its parent's font style, foreground and background field by
 *   field where its best-matching rule sets them. `BothThemes` resolves that
 *   per theme, with each theme's own `match`, and hands the grammar the pair.
 * - The grammar merges adjacent pieces of a line whose style ids are equal.
 *   With one theme, two pieces merge when that theme styles them alike; with
 *   the pair, when both do. Shiki's alignment cut each theme's tokens wherever
 *   the other's ended -- the same boundaries.
 * - Empty lines, over-long lines, offsets, colour replacements and the
 *   500 ms per-line limit are Shiki's `_tokenizeWithTheme`, as it does them.
 *
 * `highlight.dual.test.ts` compares this with `codeToTokensWithThemes` over
 * whole files in several languages. The seam is vscode-textmate's own: the
 * registry every grammar asks for its theme (`grammar.themeProvider`) takes
 * any object with `match` and `getDefaults`, and gets its own theme back the
 * moment the pass ends, so Shiki's own calls see nothing changed. That getter
 * and the registry's `_theme` are not Shiki's public API: they are what Shiki
 * 4.5.0 ships, and the comparison tests are what would catch an upgrade that
 * moves them (every token would differ, or be plain).
 */

type ScopePath = NonNullable<Parameters<Theme['match']>[0]>;

/** A style as vscode-textmate's theme gives it: ids into a colour map. */
interface StyleIds {
  fontStyle: number;
  foregroundId: number;
  backgroundId: number;
}

/** The fields' widths in a token's metadata; 0 (-1 for font style) means "not set". */
const FOREGROUNDS = 511;
const BACKGROUNDS = 255;
const FONT_STYLES = 16;

interface ThemeSide {
  theme: Theme;
  colors: string[];
  replacements: Record<string, string>;
}

/**
 * One theme's resolved style -- font style, foreground id, background id --
 * packed in one number (4 + 9 + 8 bits), so a pair of them is a cheap map key:
 * this runs for every scope the grammar pushes.
 */
type Resolved = number;
const pack = (fontStyle: number, fg: number, bg: number): Resolved => fontStyle | (fg << 4) | (bg << 13);
const fontStyleOf = (r: Resolved) => r & 15;
const foregroundOf = (r: Resolved) => (r >>> 4) & 511;
const backgroundOf = (r: Resolved) => r >>> 13;

/** `mergeAttributes`' rule: a field the rule sets replaces the parent's. */
function inherit(parent: Resolved, own: StyleIds | null): Resolved {
  if (!own) return parent;
  return pack(
    own.fontStyle !== -1 ? own.fontStyle : fontStyleOf(parent),
    own.foregroundId !== 0 ? own.foregroundId : foregroundOf(parent),
    own.backgroundId !== 0 ? own.backgroundId : backgroundOf(parent),
  );
}

/**
 * A theme, as the grammar sees one, that stands for the light and dark theme
 * together. Every distinct pair of resolved styles gets an id, written into
 * the three style fields of a token's metadata -- always set, so the grammar
 * never inherits a field itself: the pair is resolved here, per theme.
 */
class BothThemes {
  /** Pair key (light * 2^21 + dark) to pair id. */
  private readonly ids = new Map<number, number>();
  private readonly lights: Resolved[] = [];
  private readonly darks: Resolved[] = [];
  private readonly encoded: StyleIds[] = [];
  private readonly styles: Array<Record<string, string>> = [];
  /** Scope paths are shared and immutable: a path's pair never changes. */
  private readonly resolved = new WeakMap<ScopePath, number>();
  private readonly defaults: number;

  constructor(
    private readonly light: ThemeSide,
    private readonly dark: ThemeSide,
  ) {
    this.defaults = this.intern(inherit(0, light.theme.getDefaults()), inherit(0, dark.theme.getDefaults()));
  }

  getDefaults(): StyleIds {
    return this.encoded[this.defaults]!;
  }

  getColorMap(): string[] {
    return [];
  }

  match(path: ScopePath | null): StyleIds {
    return this.encoded[path ? this.resolve(path) : this.defaults]!;
  }

  /** The token style for a token's metadata, as `dualStyle` gives it. */
  styleOf(metadata: number): Record<string, string> {
    const fs = EncodedTokenMetadata.getFontStyle(metadata);
    const fg = EncodedTokenMetadata.getForeground(metadata);
    const bg = EncodedTokenMetadata.getBackground(metadata);
    const style = this.styles[(fs * BACKGROUNDS + (bg - 1)) * FOREGROUNDS + (fg - 1)];
    if (!style) throw new Error('a token style that was never handed out');
    return style;
  }

  private resolve(path: ScopePath): number {
    const known = this.resolved.get(path);
    if (known !== undefined) return known;
    const parent = path.parent ? this.resolve(path.parent) : this.defaults;
    const id = this.intern(
      inherit(this.lights[parent]!, this.light.theme.match(path)),
      inherit(this.darks[parent]!, this.dark.theme.match(path)),
    );
    this.resolved.set(path, id);
    return id;
  }

  private intern(light: Resolved, dark: Resolved): number {
    const key = light * 2 ** 21 + dark;
    const known = this.ids.get(key);
    if (known !== undefined) return known;
    const id = this.lights.length;
    if (id >= FOREGROUNDS * BACKGROUNDS * FONT_STYLES) throw new Error('too many style pairs');
    this.ids.set(key, id);
    this.lights.push(light);
    this.darks.push(dark);
    this.encoded.push({
      fontStyle: Math.floor(id / (FOREGROUNDS * BACKGROUNDS)),
      foregroundId: (id % FOREGROUNDS) + 1,
      backgroundId: (Math.floor(id / FOREGROUNDS) % BACKGROUNDS) + 1,
    });
    this.styles.push(dualStyle(this.side(this.light, light), this.side(this.dark, dark)));
    return id;
  }

  /** One theme's half of a pair, as Shiki's tokenizer reports it. */
  private side(side: ThemeSide, r: Resolved): TokenStyles {
    return { color: applyColorReplacements(side.colors[foregroundOf(r)], side.replacements), fontStyle: fontStyleOf(r) };
  }
}

/** Per highlighter: the themes are its own. */
const bothThemes = new WeakMap<HighlighterCore, BothThemes>();

function bothThemesFor(hl: HighlighterCore): BothThemes {
  let both = bothThemes.get(hl);
  if (!both) {
    const side = (name: string): ThemeSide => {
      const raw = hl.getTheme(name);
      // What Shiki's registry builds for the same theme, so the ids match.
      const theme = Theme.createFromRawTheme(raw as never);
      return { theme, colors: theme.getColorMap(), replacements: { ...raw.colorReplacements } };
    };
    both = new BothThemes(side(THEMES.light), side(THEMES.dark));
    bothThemes.set(hl, both);
  }
  return both;
}

/** The registry a grammar asks for its theme (vscode-textmate's SyncRegistry). */
interface ThemeRegistry {
  setTheme(theme: unknown): void;
  _theme: unknown;
}

/** Shiki's default per-line limit; a line that hits it carries on from where it stopped. */
const LINE_TIME_LIMIT_MS = 500;

/**
 * Tokenize `code` as `lang` (a loaded grammar) for both themes in one grammar
 * pass, starting from `state` (undefined: the top of a file). Returns the
 * lines and the grammar state after the last of them, to carry on from.
 * Throws when the grammar does; callers fall back to plain tokens.
 */
function tokenizeBoth(
  hl: HighlighterCore,
  code: string,
  lang: string,
  maxLineLength = 0,
  state?: unknown,
): { lines: DualToken[][]; state: StateStack } {
  const grammar = hl.getLanguage(lang);
  const both = bothThemesFor(hl);
  const registry = (grammar as unknown as { themeProvider: ThemeRegistry }).themeProvider;
  const own = registry._theme;
  registry.setTheme(both);
  try {
    let stack = (state as StateStack | undefined) ?? INITIAL;
    const out: DualToken[][] = [];
    for (const [line, lineOffset] of splitLines(code)) {
      if (line === '') {
        out.push([]);
        continue;
      }
      if (maxLineLength > 0 && line.length >= maxLineLength) {
        out.push([{ content: line, offset: lineOffset, style: PLAIN }]);
        continue;
      }
      const result = grammar.tokenizeLine2(line, stack, LINE_TIME_LIMIT_MS);
      const raw = result.tokens;
      const count = raw.length / 2;
      const tokens: DualToken[] = [];
      for (let j = 0; j < count; j++) {
        const start = raw[2 * j]!;
        const next = j + 1 < count ? raw[2 * j + 2]! : line.length;
        if (start === next) continue;
        tokens.push({
          content: line.substring(start, next),
          offset: lineOffset + start,
          style: both.styleOf(raw[2 * j + 1]!),
        });
      }
      out.push(tokens);
      stack = result.ruleStack;
    }
    return { lines: out, state: stack };
  } finally {
    registry.setTheme(own);
  }
}

/** An uncoloured token's style, as Shiki's over-long lines get it. */
const PLAIN = dualStyle({ color: '', fontStyle: 0 }, { color: '', fontStyle: 0 });

/**
 * Tokenize `code` as `lang`, one array of tokens per line, styled for both
 * themes at once.
 *
 * Returns plain tokens (never throws, never rejects) when the language is not
 * in the bounded set, when its grammar fails to load, or when tokenization
 * itself fails. The caller renders tokens into its own DOM structure, which is
 * what makes per-line gutters and word-level change spans possible.
 */
export async function highlightToTokens(code: string, lang: string): Promise<DualToken[][]> {
  const key = cacheKey(code, lang);
  const hit = cache.get(key);
  if (hit) {
    // Used again: to the back of the eviction queue.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  let tokens: DualToken[][];
  try {
    const ok = await ensureLang(lang);
    if (!ok) {
      tokens = plainTokens(code);
    } else {
      const hl = await getHighlighter();
      tokens = tokenizeBoth(hl, code, lang).lines;
    }
  } catch {
    tokens = plainTokens(code);
  }
  cachePut(key, tokens);
  return tokens;
}

// ---------------------------------------------------------------------------
// Whole texts, a slice at a time (#412)
// ---------------------------------------------------------------------------

/**
 * A diff that has both whole files colours every row from its own line in
 * them, so no grammar state runs across the lines it hides. Tokenizing a
 * whole file in one call blocks the main thread for as long as it takes
 * (measured: ~6 lines/ms for PHP when each theme took its own grammar pass,
 * about twice that since #418), so it goes a slice at a time,
 * carrying Shiki's grammar state from one slice to the next and yielding to
 * the browser between them. A slice is at most this many lines...
 */
const SLICE_LINES = 100;
/**
 * ...or this many characters, whichever comes first. Measured on a 1,370-line
 * PHP file, warm: 200 lines / 12,000 characters took up to 56 ms a slice,
 * 80 / 4,000 up to 19 ms. This keeps a slice well under the 50 ms of a long
 * task. (A grammar's very first use also compiles its patterns, once.)
 */
const SLICE_CHARS = 6_000;
/**
 * A line this long is left plain rather than tokenized: one minified line can
 * otherwise cost a second on its own, and a slice cannot split a line.
 * Measured (TSX, a grammar pass per theme, before #418 halved it): a
 * 4,900-character line took 1.5 s, and lines
 * of 2,000 characters at most 284 ms. Shiki's `tokenizeTimeLimit` was not
 * used instead: it cuts a line off mid-way and carries on from a guessed
 * state, which colours what follows wrongly.
 */
export const MAX_TOKENIZED_LINE = 2_000;

interface Progress {
  lines: readonly string[];
  tokens: DualToken[][];
  state: unknown;
  running: Promise<void> | null;
  /**
   * Callers still waiting for this text. A run stops at the next slice once
   * there are none -- a diff that unmounted, a Guide file stepped past -- so
   * it does not hold up the colours of the one now on screen. What it got
   * through is kept, and the next ask carries on from there.
   */
  subscribers: number;
}

/** Texts tokenized part of the way. Finished ones move to the token cache. */
const progress = new Map<string, Progress>();
const PROGRESS_MAX = 8;

/** For tests: the slice limits. */
let sliceLines = SLICE_LINES;
let sliceChars = SLICE_CHARS;
export function setSliceForTests(lines: number, chars = SLICE_CHARS): void {
  sliceLines = lines;
  sliceChars = chars;
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The tokens already known for the leading lines of `code` (split on `\n`;
 * pass text with no `\r`): all of them from the token cache, or as far as
 * {@link highlightLines} has got. Undefined when none are.
 */
export function peekLineTokens(code: string, lang: string): DualToken[][] | undefined {
  const key = cacheKey(code, lang);
  const hit = cache.get(key);
  if (hit) return hit;
  const p = progress.get(key);
  return p && p.tokens.length > 0 ? p.tokens.slice() : undefined;
}

/**
 * Tokenize `code` as `lang` up to line `upTo` (or all of it), a slice at a
 * time, yielding between slices; a later call with a larger `upTo` carries on
 * from where this one stopped. The same tokens as `highlightToTokens` for the
 * lines it covers, except that a line of {@link MAX_TOKENIZED_LINE} or more
 * characters is plain. Never rejects: a language that does not load, or a
 * slice that throws, leaves the rest plain.
 */
export async function highlightLines(
  code: string,
  lang: string,
  upTo = Infinity,
  signal?: AbortSignal,
): Promise<DualToken[][]> {
  const key = cacheKey(code, lang);
  const hit = cache.get(key);
  if (hit) return hit;

  let p = progress.get(key);
  if (!p) {
    p = { lines: code.split('\n'), tokens: [], state: undefined, running: null, subscribers: 0 };
    progress.set(key, p);
    // Never one somebody is still waiting for: it would be tokenized again.
    for (const [oldest, entry] of [...progress]) {
      if (progress.size <= PROGRESS_MAX) break;
      if (oldest !== key && entry.subscribers === 0) progress.delete(oldest);
    }
  } else {
    // Used again: to the back of the eviction queue.
    progress.delete(key);
    progress.set(key, p);
  }
  const entry = p;
  const target = Math.min(upTo, entry.lines.length);

  if (signal?.aborted) return entry.tokens.slice();
  entry.subscribers++;
  let subscribed = true;
  const leave = () => {
    if (!subscribed) return;
    subscribed = false;
    entry.subscribers--;
  };
  signal?.addEventListener('abort', leave, { once: true });
  try {
    while (entry.running) await entry.running;
    if (subscribed && entry.tokens.length < target) {
      const mine = run(entry, lang, target);
      entry.running = mine;
      try {
        await mine;
      } finally {
        if (entry.running === mine) entry.running = null;
      }
    }
  } finally {
    signal?.removeEventListener('abort', leave);
    leave();
  }
  if (entry.tokens.length >= entry.lines.length) {
    progress.delete(key);
    cachePut(key, entry.tokens);
  }
  return entry.tokens.slice();
}

async function run(entry: Progress, lang: string, target: number): Promise<void> {
  const plainRest = () => {
    for (let i = entry.tokens.length; i < target; i++) {
      entry.tokens.push([{ content: entry.lines[i] ?? '', offset: 0, style: {} }]);
    }
  };
  let hl: HighlighterCore;
  try {
    if (!(await ensureLang(lang))) return plainRest();
    hl = await getHighlighter();
  } catch {
    return plainRest();
  }
  // Even the first slice waits for its own task: a diff starts both sides
  // at once, and two first slices back to back are one long block.
  await yieldToBrowser();
  while (entry.tokens.length < target) {
    if (entry.subscribers <= 0) return;
    const start = entry.tokens.length;
    let end = start;
    let chars = 0;
    while (end < target && end - start < sliceLines && (end === start || chars < sliceChars)) {
      chars += (entry.lines[end]?.length ?? 0) + 1;
      end++;
    }
    const slice = entry.lines.slice(start, end);
    try {
      const { lines: dual, state } = tokenizeBoth(hl, slice.join('\n'), lang, MAX_TOKENIZED_LINE, entry.state);
      entry.state = state;
      for (let i = 0; i < slice.length; i++) {
        entry.tokens.push(dual[i] ?? [{ content: slice[i] ?? '', offset: 0, style: {} }]);
      }
    } catch {
      return plainRest();
    }
    if (entry.tokens.length < target) await yieldToBrowser();
  }
}

/**
 * Tokenize each block on its own -- no grammar state crosses from one to the
 * next -- and cache the lot as ONE entry, so a diff of many hunks does not
 * push the editor's files out of the cache. Lines come back flat, block
 * after block; `blockLineCount` says how many each block has.
 */
export async function highlightBlocks(blocks: readonly string[], lang: string): Promise<DualToken[][]> {
  const key = blocksKey(blocks, lang);
  const hit = cache.get(key);
  if (hit) return hit;
  const out: DualToken[][] = [];
  let hl: HighlighterCore | null = null;
  try {
    if (await ensureLang(lang)) hl = await getHighlighter();
  } catch {
    hl = null;
  }
  // A slice's worth of characters, then the browser gets a turn (#412): a
  // diff of hundreds of hunks must not block for longer than one blob did.
  let chars = 0;
  for (const block of blocks) {
    if (chars >= sliceChars) {
      chars = 0;
      await yieldToBrowser();
    }
    chars += block.length + 1;
    const n = blockLineCount(block);
    let lines: DualToken[][];
    try {
      lines = hl && block !== '' ? tokenizeBoth(hl, block, lang).lines : plainTokens(block);
    } catch {
      lines = plainTokens(block);
    }
    const plain = block.split('\n');
    for (let i = 0; i < n; i++) out.push(lines[i] ?? [{ content: plain[i] ?? '', offset: 0, style: {} }]);
  }
  cachePut(key, out);
  return out;
}

/** {@link highlightBlocks}' tokens, when already cached. */
export function peekBlocks(blocks: readonly string[], lang: string): DualToken[][] | undefined {
  return cache.get(blocksKey(blocks, lang));
}

/** Lines in one block, as {@link highlightBlocks} lays them out. */
export function blockLineCount(block: string): number {
  let n = 1;
  for (let i = 0; i < block.length; i++) if (block.charCodeAt(i) === 10) n++;
  return n;
}

function blocksKey(blocks: readonly string[], lang: string): string {
  // \u0001 cannot start a plain text's key in practice, and \u0000 cannot
  // appear in a block, so the two kinds of entry never collide.
  return cacheKey(`\u0001${blocks.join('\u0000')}`, lang);
}
