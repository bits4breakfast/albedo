/**
 * Mermaid diagrams in the transcript (#289).
 *
 * A reply's ```` ```mermaid ```` fence is text the transcript message already
 * holds; nothing here reads the pty, and the adapter does not change. The text
 * is the model's and may quote a PR, so it is untrusted:
 *
 * - `securityLevel: 'strict'` and no HTML labels: no click handlers, no HTML
 *   inside the drawing.
 * - The keys a `%%{init}%%` directive or front matter could use to restyle or
 *   loosen the drawing (theme, CSS, fonts, labels) are added to mermaid's
 *   `secure` list, so only Albedo sets them.
 * - The SVG is shown as an `<img>` from a data URI, never inserted into the
 *   page: an image runs no script, loads nothing and cannot style the app.
 *
 * Mermaid is large. It is imported the first time a transcript draws a fence
 * (`import('mermaid')`), never at startup. Its theme is built from Albedo's
 * tokens for the theme in use; mermaid's own palettes are never used. The
 * text pairs below are measured in mermaidContrast.test.ts.
 */

import type { ResolvedTheme } from '../theme';

/** Which Albedo token each mermaid theme variable takes. */
export const THEME_TOKENS = {
  background: '--panel-inset',
  // Boxes: flowchart nodes, states, classes, entities.
  primaryColor: '--panel-raised',
  mainBkg: '--panel-raised',
  primaryBorderColor: '--border-strong',
  nodeBorder: '--border-strong',
  primaryTextColor: '--text',
  nodeTextColor: '--text',
  textColor: '--text',
  titleColor: '--text-strong',
  secondaryColor: '--panel-chrome',
  secondaryBorderColor: '--border-strong',
  secondaryTextColor: '--text',
  tertiaryColor: '--panel-chrome',
  tertiaryBorderColor: '--border-mid',
  tertiaryTextColor: '--text',
  // Groups (subgraphs, composite states): a step off the well, a quiet edge.
  clusterBkg: '--panel-chrome',
  clusterBorder: '--border-mid',
  // Edges and their labels.
  lineColor: '--muted',
  defaultLinkColor: '--muted',
  edgeLabelBackground: '--panel-inset',
  // Notes.
  noteBkgColor: '--accent-soft',
  noteBorderColor: '--accent-line',
  noteTextColor: '--text',
  // Sequence diagrams.
  actorBkg: '--panel-raised',
  actorBorder: '--border-strong',
  actorTextColor: '--text',
  actorLineColor: '--border-mid',
  signalColor: '--muted',
  signalTextColor: '--text',
  labelBoxBkgColor: '--panel-raised',
  labelBoxBorderColor: '--border-strong',
  labelTextColor: '--text',
  loopTextColor: '--text',
  activationBkgColor: '--panel-hover',
  activationBorderColor: '--border-strong',
  // The number sits in a disc drawn in signalColor.
  sequenceNumberColor: '--panel-inset',
  // Errors mermaid draws inside a diagram.
  errorBkgColor: '--del-soft',
  errorTextColor: '--del',
} as const;

export type ThemeVariable = keyof typeof THEME_TOKENS;

/**
 * Text and the ground it is drawn on: each pair clears 4.5:1 in both themes
 * (mermaidContrast.test.ts). Lines and edges are in LINE_PAIRS, at 3:1.
 */
export const TEXT_PAIRS: readonly (readonly [ThemeVariable, ThemeVariable])[] = [
  ['primaryTextColor', 'primaryColor'],
  ['textColor', 'background'],
  ['titleColor', 'background'],
  ['secondaryTextColor', 'secondaryColor'],
  ['tertiaryTextColor', 'tertiaryColor'],
  ['textColor', 'clusterBkg'],
  ['textColor', 'edgeLabelBackground'],
  ['noteTextColor', 'noteBkgColor'],
  ['actorTextColor', 'actorBkg'],
  ['signalTextColor', 'background'],
  ['labelTextColor', 'labelBoxBkgColor'],
  ['loopTextColor', 'background'],
  ['sequenceNumberColor', 'signalColor'],
  ['errorTextColor', 'errorBkgColor'],
];

/** Lines a reader follows (arrows, box edges): 3:1, as for any UI part. */
export const LINE_PAIRS: readonly (readonly [ThemeVariable, ThemeVariable])[] = [
  ['lineColor', 'background'],
  ['signalColor', 'background'],
  ['primaryBorderColor', 'background'],
  ['actorBorder', 'background'],
];

/** The theme variables, from a token reader (`--text` → `#1b1c20`). */
export function themeVariables(token: (name: string) => string): Record<ThemeVariable, string> {
  const out = {} as Record<ThemeVariable, string>;
  for (const [key, name] of Object.entries(THEME_TOKENS) as [ThemeVariable, string][]) {
    out[key] = token(name);
  }
  return out;
}

/** Keys only Albedo may set: a directive in the diagram's text cannot. */
export const SECURE_KEYS = [
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'suppressErrorRendering',
  'maxEdges',
  'theme',
  'themeVariables',
  'themeCSS',
  'darkMode',
  'fontFamily',
  'altFontFamily',
  'fontSize',
  'htmlLabels',
  'flowchart',
  'look',
] as const;

export function mermaidConfig(theme: ResolvedTheme, token: (name: string) => string): Record<string, unknown> {
  const fontFamily = token('--font-ui') || 'system-ui, sans-serif';
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    suppressErrorRendering: true,
    secure: [...SECURE_KEYS],
    theme: 'base',
    darkMode: theme === 'dark',
    fontFamily,
    themeVariables: { ...themeVariables(token), darkMode: theme === 'dark', fontFamily, fontSize: '14px' },
  };
}

/** A token off the root, as the theme in use resolves it. */
function cssToken(name: string): string {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch {
    return '';
  }
}

/** The kind of diagram, for its label ("Sequence"). */
export function diagramKind(type: string): string {
  const t = type.toLowerCase();
  if (t.startsWith('flowchart') || t === 'graph') return 'Flowchart';
  if (t.startsWith('sequence')) return 'Sequence';
  if (t.startsWith('state')) return 'State';
  if (t.startsWith('class')) return 'Class';
  if (t === 'er') return 'Entity Relationship';
  if (t === 'gantt') return 'Gantt';
  if (t === 'pie') return 'Pie';
  if (t === 'gitgraph') return 'Git Graph';
  if (t === 'mindmap') return 'Mind Map';
  if (t === 'timeline') return 'Timeline';
  if (t === 'journey') return 'Journey';
  return 'Diagram';
}

export interface DiagramImage {
  /** `data:image/svg+xml,...`: shown in an <img>, never inserted as markup. */
  src: string;
  /** Natural size, from the SVG's viewBox. */
  width: number;
  height: number;
}

/**
 * Mermaid's SVG as an image: sized from its viewBox (it is drawn
 * `width="100%"` with a max-width style, which an image has no use for).
 * Null when it is not an SVG with a usable viewBox.
 */
export function svgToImage(svg: string): DiagramImage | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  } catch {
    return null;
  }
  const root = doc.documentElement;
  if (root.nodeName.toLowerCase() !== 'svg' || doc.getElementsByTagName('parsererror').length > 0) return null;
  const box = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const width = Math.ceil(box[2] ?? NaN);
  const height = Math.ceil(box[3] ?? NaN);
  if (!(width > 0) || !(height > 0)) return null;
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  root.removeAttribute('style');
  if (!root.getAttribute('xmlns')) root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const text = new XMLSerializer().serializeToString(root);
  return { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`, width, height };
}

export type DrawResult = { ok: true; image: DiagramImage; kind: string } | { ok: false; error: string };

type MermaidApi = typeof import('mermaid').default;

let loading: Promise<MermaidApi> | null = null;

/** The one import of mermaid, made on first use. */
function loadMermaid(): Promise<MermaidApi> {
  loading ??= import('mermaid').then((m) => m.default);
  // A failed import may be retried on the next diagram.
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

const CACHE_MAX = 64;
const cache = new Map<string, DrawResult>();
let queue: Promise<unknown> = Promise.resolve();
let seq = 0;

/** A finished drawing of this text in this theme, if there is one. */
export function peekDiagram(code: string, theme: ResolvedTheme): DrawResult | undefined {
  return cache.get(`${theme}\n${code}`);
}

function remember(key: string, result: DrawResult): DrawResult {
  cache.set(key, result);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return result;
}

/** The first lines of an error, as mermaid words it. */
function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : 'Unknown error';
  return raw.trim().split('\n').slice(0, 6).join('\n');
}

/**
 * Draw one diagram. Runs one at a time: mermaid's configuration is global, so
 * each drawing sets its theme and draws before the next one starts.
 */
export function drawDiagram(code: string, theme: ResolvedTheme): Promise<DrawResult> {
  const key = `${theme}\n${code}`;
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const job = queue.then(async (): Promise<DrawResult> => {
    const again = cache.get(key);
    if (again) return again;
    let mermaid: MermaidApi;
    try {
      mermaid = await loadMermaid();
    } catch (e) {
      // Not the diagram's fault: said, and not remembered.
      console.warn('[mermaid] could not load the renderer', e);
      return { ok: false, error: 'Couldn’t load the diagram renderer.' };
    }
    const id = `albedo-mermaid-${++seq}`;
    try {
      mermaid.initialize(mermaidConfig(theme, cssToken) as Parameters<MermaidApi['initialize']>[0]);
      const { svg, diagramType } = await mermaid.render(id, code);
      const image = svgToImage(svg);
      if (!image) return remember(key, { ok: false, error: 'The diagram came out empty.' });
      return remember(key, { ok: true, image, kind: diagramKind(diagramType) });
    } catch (e) {
      return remember(key, { ok: false, error: errorText(e) });
    } finally {
      // Mermaid draws in a scratch element on the body; never leave one behind.
      document.getElementById(`d${id}`)?.remove();
      document.getElementById(id)?.remove();
    }
  });
  queue = job.catch(() => undefined);
  return job;
}

/** Tests only. */
export function __resetMermaid(): void {
  cache.clear();
  loading = null;
  queue = Promise.resolve();
}
