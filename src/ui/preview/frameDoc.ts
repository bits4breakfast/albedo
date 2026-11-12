/**
 * The document a preview's iframe shows (#348): the session's page, as it was
 * copied, with three things put in front of it.
 *
 * The page is written by the model and runs inside Albedo's webview, so it is
 * held at arm's length three ways (the iframe's attributes are PreviewFrame's):
 *
 *   1. `sandbox="allow-scripts"` and never `allow-same-origin`: the page runs
 *      in an opaque origin. It cannot read the app's window, its storage, or
 *      the Tauri invoke key; Tauri injects its IPC scripts into the main frame
 *      only, and refuses any IPC call without that key.
 *   2. `srcdoc` from the stored copy, never a URL: nothing is fetched to show
 *      it, and the session's file is never read again.
 *   3. The CSP below, first in the document: no network of any kind (no
 *      fetch, no images or fonts from anywhere, no form posts, no frames).
 *      A page's own CSP can only narrow it further.
 *
 * Then three small scripts of Albedo's, all in the page's own sandbox:
 *
 *   - Light / Dark: the page's `prefers-color-scheme` rules and matchMedia
 *     calls are made to answer the scheme picked, without touching the app's.
 *   - Where the page is scrolled to, posted to the parent as plain numbers,
 *     so a pin can say where on the PAGE it sits (PreviewFrame takes only
 *     numbers, and only from its own frame).
 *   - Esc pressed inside the page, posted as a bare tag (#356): with focus in
 *     the frame, the key never reaches the app, and the viewer's Esc would do
 *     nothing. A page could post the tag itself; all it can do is close the
 *     viewer it is shown in.
 */

export type PreviewScheme = 'light' | 'dark';

/** The policy the page runs under. No network, inline code only, data: media. */
export const PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; frame-src 'none'; base-uri 'none'";

/** Tags the geometry messages, so nothing else posted is mistaken for one. */
export const GEOMETRY_TAG = 'albedo-preview-geometry';

/** Tags the Esc message: the only other thing taken from the page. */
export const ESCAPE_TAG = 'albedo-preview-escape';

/** True for the page's Esc message, and nothing else. Never throws. */
export function isEscape(data: unknown): boolean {
  return typeof data === 'object' && data !== null && (data as Record<string, unknown>).tag === ESCAPE_TAG;
}

/** Where the page is: scroll offset, full size, and the frame's own size. */
export interface Geometry {
  x: number;
  y: number;
  /** The page's full width and height (at least the frame's). */
  w: number;
  h: number;
  /** The frame's viewport. */
  vw: number;
  vh: number;
}

function finite(v: unknown, min: number, max: number): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;
}

/** A geometry message from the page, or null for anything else. Never throws. */
export function parseGeometry(data: unknown): Geometry | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.tag !== GEOMETRY_TAG) return null;
  const LIMIT = 1_000_000;
  const x = finite(d.x, 0, LIMIT);
  const y = finite(d.y, 0, LIMIT);
  const w = finite(d.w, 1, LIMIT);
  const h = finite(d.h, 1, LIMIT);
  const vw = finite(d.vw, 1, LIMIT);
  const vh = finite(d.vh, 1, LIMIT);
  if (x === null || y === null || w === null || h === null || vw === null || vh === null) return null;
  return { x, y, w, h, vw, vh };
}

/**
 * The scheme script: rewrites the page's `(prefers-color-scheme: …)` media
 * conditions to always-true or always-false ones, wraps `matchMedia` the same
 * way, and sets `color-scheme` and a `data-theme` on the root (pages with
 * their own theme switch often key on it). Media rules are rewritten once the
 * page's styles are parsed; scripts that ask matchMedia early get the answer
 * at once.
 */
function schemeScript(scheme: PreviewScheme): string {
  const dark = scheme === 'dark';
  return `(function(){
var dark=${dark ? 'true' : 'false'};
var YES='(min-width: 0px)', NO='(max-width: 0px) and (min-width: 1px)';
function swap(t){return String(t).replace(/\\(\\s*prefers-color-scheme\\s*:\\s*(dark|light)\\s*\\)/gi,function(_,s){return (s.toLowerCase()==='dark')===dark?YES:NO;});}
try{var mm=window.matchMedia;window.matchMedia=function(q){return mm.call(window,swap(q));};}catch(e){}
function walk(rules){for(var i=0;i<rules.length;i++){var r=rules[i];try{if(r.media&&/prefers-color-scheme/i.test(r.media.mediaText)){r.media.mediaText=swap(r.media.mediaText);}if(r.cssRules){walk(r.cssRules);}}catch(e){}}}
function fix(){try{var d=document.documentElement;d.style.colorScheme='${scheme}';d.setAttribute('data-theme','${scheme}');for(var i=0;i<document.styleSheets.length;i++){try{walk(document.styleSheets[i].cssRules);}catch(e){}}}catch(e){}}
document.addEventListener('DOMContentLoaded',fix);window.addEventListener('load',fix);
})();`;
}

/** The geometry script: posts where the page is scrolled to, and how big it is. */
function geometryScript(): string {
  return `(function(){
function g(){try{var d=document.documentElement,b=document.body;
var w=Math.max(d.scrollWidth,b?b.scrollWidth:0,innerWidth),h=Math.max(d.scrollHeight,b?b.scrollHeight:0,innerHeight);
parent.postMessage({tag:'${GEOMETRY_TAG}',x:scrollX,y:scrollY,w:w,h:h,vw:innerWidth,vh:innerHeight},'*');}catch(e){}}
addEventListener('scroll',g,{passive:true});addEventListener('resize',g);addEventListener('load',g);document.addEventListener('DOMContentLoaded',g);
})();`;
}

/**
 * The Esc script: tells the parent, and lets the page have the key too.
 *
 * It also marks Escape handled, as keepEscapeFromLeavingFullscreen does for
 * the app's own window (#267): a keydown inside this frame never reaches that
 * guard, and an Escape nothing handled goes back to AppKit, which takes the
 * window out of full screen (#376). Marked only from a one-shot bubble
 * listener added during the dispatch, so the mockup's own listeners run first
 * and still see the key as unhandled.
 */
function escapeScript(): string {
  return `(function(){
addEventListener('keydown',function(e){if(e.key!=='Escape')return;try{parent.postMessage({tag:'${ESCAPE_TAG}'},'*');}catch(x){}
if(e.isComposing||e.keyCode===229)return;addEventListener('keydown',function(l){if(l===e)e.preventDefault();},{once:true});},true);
})();`;
}

const DOCTYPE = /^(﻿?\s*(?:<!--[\s\S]*?-->\s*)*<!doctype[^>]*>)/i;

/**
 * The iframe's `srcdoc`: the page with the CSP and Albedo's two scripts in
 * front. They go after a leading `<!doctype>` -- anything before it would put
 * the page in quirks mode -- and before everything else, so the policy is in
 * force before the page's first tag is parsed.
 */
export function previewSrcdoc(html: string, scheme: PreviewScheme): string {
  const head =
    `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">` +
    `<meta name="color-scheme" content="${scheme}">` +
    `<script>${schemeScript(scheme)}</script>` +
    `<script>${geometryScript()}</script>` +
    `<script>${escapeScript()}</script>`;
  const m = DOCTYPE.exec(html);
  return m ? `${m[1]}${head}${html.slice(m[1]!.length)}` : `${head}${html}`;
}

/** The iframe's sandbox: scripts may run, and nothing else is granted. */
export const PREVIEW_SANDBOX = 'allow-scripts';
