/**
 * Triggers (#448): per project, what Albedo puts in front of you when
 * something happens to a task's PR. Personal settings, kept on this Mac.
 *
 * One small JSON file per project under `~/.albedo/triggers/`, mode 0600,
 * written as `.part` and renamed -- the way the Review Guide's Context keeps
 * its settings (`guide/context.ts`, #444). Never in the repo, never in the
 * database: a shared CLAUDE.md or a table would impose one workflow on
 * everyone who opens the project.
 *
 * Every event is Off until it is turned on. A response is one of:
 *   - **Draft:** a message to the task's session, from the template here plus
 *     the event's facts. Nothing is sent until you press Send on its card.
 *   - **Suggest:** a button for the next action. Nothing happens until it is
 *     clicked. Only the approval offers one (Squash and Merge…): merging is
 *     only ever a suggestion.
 */

import { useSyncExternalStore } from 'react';

export type TriggerEvent = 'merged' | 'ciFailed' | 'review' | 'approved';
export type TriggerMode = 'off' | 'draft' | 'suggest';

export interface TriggerRule {
  mode: TriggerMode;
  /** Draft's message, before the facts. Empty: the facts alone. */
  template: string;
}

export type TriggerSettings = Record<TriggerEvent, TriggerRule>;

export const TRIGGER_TEMPLATE_MAX_CHARS = 4000;

/** The events, in the order the sheet lists them, and the responses each can have. */
export const TRIGGER_EVENTS: ReadonlyArray<{ id: TriggerEvent; label: string; modes: readonly TriggerMode[] }> = [
  { id: 'merged', label: 'Your PR is merged', modes: ['off', 'draft'] },
  { id: 'ciFailed', label: 'CI failed on your PR', modes: ['off', 'draft'] },
  { id: 'review', label: 'A reviewer requests changes or comments', modes: ['off', 'draft'] },
  { id: 'approved', label: 'Your PR is approved and checks are green', modes: ['off', 'draft', 'suggest'] },
];

const OFF: TriggerRule = { mode: 'off', template: '' };

export const DEFAULT_TRIGGERS: TriggerSettings = { merged: OFF, ciFailed: OFF, review: OFF, approved: OFF };

/** Whether `mode` is one `event` can have. */
export function modeAllowed(event: TriggerEvent, mode: TriggerMode): boolean {
  return TRIGGER_EVENTS.some((e) => e.id === event && e.modes.includes(mode));
}

/** Any event on. */
export function anyTriggerOn(s: TriggerSettings | null | undefined): boolean {
  return !!s && TRIGGER_EVENTS.some((e) => s[e.id].mode !== 'off');
}

function asRule(event: TriggerEvent, v: unknown): TriggerRule {
  if (typeof v !== 'object' || v === null) return OFF;
  const o = v as Record<string, unknown>;
  const mode = o.mode === 'draft' || o.mode === 'suggest' ? o.mode : 'off';
  const template = typeof o.template === 'string' ? o.template.slice(0, TRIGGER_TEMPLATE_MAX_CHARS) : '';
  // A response the event cannot have (a hand-edited file) is Off: never a guess at one.
  return { mode: modeAllowed(event, mode) ? mode : 'off', template };
}

/** A stored or typed settings object, made safe; null when it is not one. */
export function asTriggerSettings(v: unknown): TriggerSettings | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  return {
    merged: asRule('merged', o.merged),
    ciFailed: asRule('ciFailed', o.ciFailed),
    review: asRule('review', o.review),
    approved: asRule('approved', o.approved),
  };
}

// ---------------------------------------------------------------------------
// The files
// ---------------------------------------------------------------------------

/** Whether a project has a settings file could not even be told. */
export class UncheckedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UncheckedError';
  }
}

/** Where the settings live, and how they are read and written. A seam for tests. */
export interface TriggerFiles {
  read: (projectId: number) => Promise<string | null>;
  write: (projectId: number, json: string) => Promise<void>;
}

async function settingsDir(): Promise<string> {
  const { homeDir } = await import('@tauri-apps/api/path');
  return `${(await homeDir()).replace(/\/+$/, '')}/.albedo/triggers`;
}

/**
 * The real write: into `<file>.part`, then renamed over the file, so a read
 * never meets half of one. The plugin makes no folder on its own (REGRESSIONS:
 * a stand-in kinder than the real thing), and 0600, yours alone, applies when
 * the file is made.
 */
export async function writeTriggerFile(projectId: number, json: string): Promise<void> {
  const fs = await import('@tauri-apps/plugin-fs');
  const dir = await settingsDir();
  const path = `${dir}/project-${projectId}.json`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeTextFile(`${path}.part`, json, { mode: 0o600 });
  await fs.rename(`${path}.part`, path);
}

let files: TriggerFiles = {
  read: async (projectId) => {
    let path: string;
    let fs: typeof import('@tauri-apps/plugin-fs');
    try {
      fs = await import('@tauri-apps/plugin-fs');
      path = `${await settingsDir()}/project-${projectId}.json`;
      if (!(await fs.exists(path))) return null;
    } catch (err) {
      throw new UncheckedError(err instanceof Error ? err.message : String(err));
    }
    return fs.readTextFile(path);
  },
  write: (projectId, json) => writeTriggerFile(projectId, json),
};

/** Test seam: swap the files; returns the previous ones. Clears what was read. */
export function setTriggerFiles(next: TriggerFiles): TriggerFiles {
  const prev = files;
  files = next;
  cache.clear();
  unchecked.clear();
  reading.clear();
  saves.clear();
  changed();
  return prev;
}

/**
 * A project's settings as read: none saved, saved, a file that is there but
 * cannot be used (read as all Off, and the sheet says so), or whether there is
 * one could not even be told -- then nothing is decided for that project
 * until a read succeeds (`triggerSettingsFor`).
 */
export type TriggerLoad =
  | { kind: 'none' }
  | { kind: 'saved'; settings: TriggerSettings }
  | { kind: 'unreadable'; message: string }
  | { kind: 'unchecked'; message: string };

const cache = new Map<number, TriggerLoad>();
/** project id -> the last read that could not tell, and when: asked again at most every {@link RETRY_UNCHECKED_MS}. */
const unchecked = new Map<number, { load: TriggerLoad; at: number }>();
const RETRY_UNCHECKED_MS = 60_000;
const reading = new Map<number, Promise<TriggerLoad>>();
const saves = new Map<number, number>();
const listeners = new Set<() => void>();
let version = 0;
function changed(): void {
  version++;
  for (const l of [...listeners]) l();
}

/** Hear a project's settings arrive or change. */
export function onTriggerSettingsChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function parseSettings(raw: string): TriggerLoad {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'unreadable', message: 'The file is not valid JSON.' };
  }
  const settings = asTriggerSettings(parsed);
  return settings ? { kind: 'saved', settings } : { kind: 'unreadable', message: 'The file does not hold trigger settings.' };
}

/** The project's settings, read once and then from memory. Never throws. */
export function loadTriggerSettings(projectId: number): Promise<TriggerLoad> {
  const hit = cache.get(projectId);
  if (hit) return Promise.resolve(hit);
  const pending = reading.get(projectId);
  if (pending) return pending;
  const savesBefore = saves.get(projectId) ?? 0;
  const p = files
    .read(projectId)
    .then((raw): TriggerLoad => (raw === null ? { kind: 'none' } : parseSettings(raw)))
    .catch((err: unknown): TriggerLoad => {
      console.warn('[triggers] could not read the settings', projectId, err);
      const message = err instanceof Error ? err.message : String(err);
      return err instanceof UncheckedError ? { kind: 'unchecked', message } : { kind: 'unreadable', message };
    })
    .then((load) => {
      reading.delete(projectId);
      if (load.kind === 'unchecked') {
        unchecked.set(projectId, { load, at: Date.now() });
        changed();
        return load;
      }
      unchecked.delete(projectId);
      if ((saves.get(projectId) ?? 0) !== savesBefore) return cache.get(projectId) ?? load;
      cache.set(projectId, load);
      changed();
      return load;
    });
  reading.set(projectId, p);
  return p;
}

/** Save a project's settings. Throws when the file could not be written. */
export async function saveTriggerSettings(projectId: number, s: TriggerSettings): Promise<void> {
  const clean = asTriggerSettings(s) ?? DEFAULT_TRIGGERS;
  await files.write(projectId, `${JSON.stringify({ version: 1, ...clean }, null, 2)}\n`);
  saves.set(projectId, (saves.get(projectId) ?? 0) + 1);
  cache.set(projectId, { kind: 'saved', settings: clean });
  changed();
}

/**
 * What a project's triggers are, for deciding whether an event fires: its
 * settings, all Off for none or an unreadable file, or undefined while not
 * known (not read yet, or it could not be told) -- and then the read is
 * started, and nothing about that project is decided until it lands.
 */
export function triggerSettingsFor(projectId: number | null): TriggerSettings | undefined {
  if (projectId === null) return DEFAULT_TRIGGERS;
  const hit = cache.get(projectId);
  if (!hit) {
    const miss = unchecked.get(projectId);
    if (!miss || Date.now() - miss.at >= RETRY_UNCHECKED_MS) void loadTriggerSettings(projectId);
    return undefined;
  }
  return hit.kind === 'saved' ? hit.settings : DEFAULT_TRIGGERS;
}

/** The project's settings for a render: undefined while being read. Starts the read. */
export function useTriggerLoad(projectId: number | null): TriggerLoad | undefined {
  useSyncExternalStore(onTriggerSettingsChange, () => version);
  if (projectId === null) return undefined;
  const hit = cache.get(projectId);
  if (hit) return hit;
  const miss = unchecked.get(projectId);
  // One that could not tell is shown as such, and read again only when asked
  // (the sheet's Try Again): never a read per render.
  if (miss) return miss.load;
  void loadTriggerSettings(projectId);
  return undefined;
}
