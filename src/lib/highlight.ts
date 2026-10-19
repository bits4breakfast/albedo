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
 * Code is tokenized against BOTH themes at once and every token carries two
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

import { createHighlighterCore, createOnigurumaEngine } from 'shiki/core';
import type { HighlighterCore, ThemedTokenWithVariants, TokenStyles } from 'shiki/core';

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

/** True when `lang` has a grammar we can load. */
export function isSupportedLang(lang: string): boolean {
  return Object.prototype.hasOwnProperty.call(LANGS, lang);
}

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

function toDual(lines: ThemedTokenWithVariants[][]): DualToken[][] {
  return lines.map((line) =>
    line.map((t) => ({
      content: t.content,
      offset: t.offset,
      // Variants are keyed by the names in the `themes` record passed to
      // codeToTokensWithThemes ('light' / 'dark'), NOT by the theme ids. Looking
      // them up by id found nothing, and every token rendered uncoloured.
      style: dualStyle(t.variants['light'], t.variants['dark']),
    })),
  );
}

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
      tokens = toDual(hl.codeToTokensWithThemes(code, { lang, themes: THEMES }));
    }
  } catch {
    tokens = plainTokens(code);
  }
  cachePut(key, tokens);
  return tokens;
}
