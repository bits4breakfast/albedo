/**
 * Context window sizes, read from the model catalog Claude Code itself caches.
 *
 * ## FORMAT KNOWLEDGE
 *
 * `~/.claude/cache/model-catalog/<id>-cc.json` is what Claude Code fetches from
 * Anthropic and uses to know each model's limits:
 *
 *   { catalog: { config: { models: [ { id, runtime: { max_input_tokens } } ] } } }
 *
 * This replaces guessing the window from the session's peak usage, and replaces
 * a hand-kept table: the file is refreshed by Claude Code, so a new model shows
 * up here without anyone editing Albedo. If the shape changes, this file is the
 * one-file fix.
 *
 * It is the model's maximum. A session can still be configured below it, and
 * the transcript does not record that, so callers should treat the result as
 * the best available answer rather than a measurement.
 *
 * Every failure (no file, unreadable, unexpected shape) yields an empty map,
 * and the caller falls back to inferring.
 */

import { homeDir } from '@tauri-apps/api/path';
import { exists, readDir, readTextFile, stat } from '@tauri-apps/plugin-fs';

const CATALOG_DIR = '.claude/cache/model-catalog';
const CATALOG_FILE = /-cc\.json$/;

/** Pure: catalog JSON text -> model id -> max input tokens. */
export function parseModelCatalog(text: string): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const models = (JSON.parse(text) as { catalog?: { config?: { models?: unknown } } }).catalog
      ?.config?.models;
    if (!Array.isArray(models)) return out;
    for (const m of models as Array<{ id?: unknown; runtime?: { max_input_tokens?: unknown } }>) {
      const max = m?.runtime?.max_input_tokens;
      if (typeof m?.id === 'string' && typeof max === 'number' && Number.isFinite(max) && max > 0) {
        out.set(m.id, max);
      }
    }
  } catch {
    /* unreadable catalog: behave as if there were none */
  }
  return out;
}

/**
 * Window for a transcript model id, or null when the catalog does not know it.
 *
 * A `[1m]`-style suffix is dropped before lookup: the transcript id can carry
 * it while the catalog lists the bare id.
 */
export function windowFor(model: string | null, catalog: ReadonlyMap<string, number>): number | null {
  if (!model || catalog.size === 0) return null;
  return catalog.get(model) ?? catalog.get(model.replace(/\[[^\]]*\]$/, '')) ?? null;
}

/** A model offered for picking: catalog id, and the name people know it by. */
export interface ModelChoice {
  id: string;
  name: string;
}

/**
 * Pure: the models Claude Code itself puts in its picker -- the catalog's
 * `main` section (`quick_select`), in catalog order. Older models sit in an
 * `overflow` section and are left out, as Claude Code's own picker does.
 */
export function parseModelChoices(text: string): ModelChoice[] {
  try {
    const models = (JSON.parse(text) as { catalog?: { config?: { models?: unknown } } }).catalog
      ?.config?.models;
    if (!Array.isArray(models)) return [];
    return (models as Array<Record<string, unknown>>).flatMap((m) =>
      typeof m['id'] === 'string' && (m['section'] === 'main' || m['quick_select'] === true)
        ? [{ id: m['id'], name: typeof m['name'] === 'string' ? m['name'] : m['id'] }]
        : [],
    );
  } catch {
    return [];
  }
}

/** Pure: the `model` key of a Claude Code settings.json, or null. */
export function parseSettingsModel(text: string): string | null {
  try {
    const m = (JSON.parse(text) as Record<string, unknown>)['model'];
    return typeof m === 'string' && m.trim().length > 0 ? m.trim() : null;
  } catch {
    return null;
  }
}

const TTL_MS = 5 * 60_000;
let cached: { at: number; map: Map<string, number> } | null = null;
let catalogText: { at: number; text: string | null } | null = null;

/** The newest catalog file's text, cached like the window map. Never throws. */
async function readCatalogText(): Promise<string | null> {
  if (catalogText && Date.now() - catalogText.at < TTL_MS) return catalogText.text;
  let text: string | null = null;
  try {
    const dir = `${(await homeDir()).replace(/\/+$/, '')}/${CATALOG_DIR}`;
    if (await exists(dir)) {
      let best: { path: string; mtime: number } | null = null;
      for (const e of await readDir(dir)) {
        if (!e.isFile || !CATALOG_FILE.test(e.name)) continue;
        const path = `${dir}/${e.name}`;
        const mtime = (await stat(path)).mtime?.getTime() ?? 0;
        if (!best || mtime > best.mtime) best = { path, mtime };
      }
      if (best) text = await readTextFile(best.path);
    }
  } catch (err) {
    console.warn('[models] catalog unavailable', err);
  }
  catalogText = { at: Date.now(), text };
  return text;
}

/** Models to offer in a picker. Empty when the catalog cannot be read. */
export async function loadModelChoices(): Promise<ModelChoice[]> {
  const text = await readCatalogText();
  return text === null ? [] : parseModelChoices(text);
}

/**
 * The model a plain `claude` starts with: the `model` key of the user's
 * ~/.claude/settings.json (what `/model` saves), e.g. `opus`. Null when unset
 * or unreadable, which means Claude Code's own default for the account.
 */
export async function loadDefaultModel(): Promise<string | null> {
  try {
    const path = `${(await homeDir()).replace(/\/+$/, '')}/.claude/settings.json`;
    if (!(await exists(path))) return null;
    return parseSettingsModel(await readTextFile(path));
  } catch {
    return null;
  }
}

/** The catalog, re-read at most every few minutes. Never throws. */
export async function loadModelWindows(): Promise<Map<string, number>> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.map;
  const text = await readCatalogText();
  const map = text === null ? new Map<string, number>() : parseModelCatalog(text);
  cached = { at: Date.now(), map };
  return map;
}
