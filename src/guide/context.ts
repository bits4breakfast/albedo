/**
 * The Review Guide's Context step (#444): per project, the user's own
 * instructions for pulling background -- the ticket a branch is for, the
 * support conversations behind it -- from their own MCP tools, before the
 * guide is written.
 *
 * A channel widening recorded in CLAUDE.md (owner decision 2026-11-18): a
 * second one-shot run, fixed in src-tauri/src/oneshot.rs
 * (`claude_context_oneshot`), that loads the user's MCP servers and may call
 * only the tools listed here. The page chooses the model (from
 * {@link CONTEXT_MODELS}), the tool names, the time limit (at most 5 min) and
 * the words; Rust checks all of it again. What the run answers is
 * writer.ts's business (`writeContext`); what is kept of it, validate.ts's
 * (`cleanContext`).
 *
 * This file holds:
 *  - the settings, one small JSON file per project under
 *    `~/.albedo/guide-context/` (no table, no contract change; user content,
 *    so not the per-machine view prefs of persisted.ts), cached in memory;
 *  - the fixed part of the prompt, shown read-only in the sheet;
 *  - the input: the task's title, branch, PR title and description and its
 *    commit subjects. Never code.
 *
 * Empty instructions mean off: the guide is written exactly as before.
 */

import { useSyncExternalStore } from 'react';
import type { Task } from '../types';
import { gh } from '../gh/gh';
import { getPrStatus } from '../gh/prStore';
import { gitOk, taskBase } from '../git/worktree';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type ContextModel = 'sonnet' | 'haiku' | 'opus';
/** Sonnet first: Haiku is weak at choosing tools (#444). */
export const CONTEXT_MODELS: ReadonlyArray<{ id: ContextModel; label: string }> = [
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
  { id: 'opus', label: 'Opus' },
];
export const CONTEXT_TIMEOUTS: ReadonlyArray<{ ms: number; label: string }> = [
  { ms: 120_000, label: '2 min' },
  { ms: 300_000, label: '5 min' },
];
/** Rust's own limits (oneshot.rs): checked here only to say so before a run. */
export const CONTEXT_MAX_TOOLS = 32;
export const CONTEXT_INSTRUCTIONS_MAX_CHARS = 4000;

export interface ContextSettings {
  /** "Also look up", as written. Empty means off. */
  instructions: string;
  /** MCP tool or server names, `mcp__server` or `mcp__server__tool`. */
  tools: string[];
  model: ContextModel;
  timeoutMs: number;
}

export const DEFAULT_CONTEXT: ContextSettings = { instructions: '', tools: [], model: 'sonnet', timeoutMs: 120_000 };

/** oneshot.rs's `valid_tool_name`, the same pattern: an MCP server or one of its tools. */
const TOOL_NAME = /^mcp__[A-Za-z0-9_-]+(__[A-Za-z0-9_-]+)?$/;

export function validToolName(name: string): boolean {
  return TOOL_NAME.test(name);
}

/** On: instructions to follow and a tool to follow them with. */
export function contextActive(s: ContextSettings | null | undefined): s is ContextSettings {
  return !!s && s.instructions.trim() !== '' && s.tools.length > 0;
}

/**
 * What a Context result was written from. A guide's Context is reused by
 * Rewrite while this is the same; a change to the instructions, the tools or
 * the model runs it again. The time limit is not part of it.
 */
export function contextKey(s: ContextSettings): string {
  return JSON.stringify([s.instructions.trim(), [...s.tools].sort(), s.model]);
}

/** A stored or typed settings object, made safe; null when it is not one. */
export function asContextSettings(v: unknown): ContextSettings | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const instructions = typeof o.instructions === 'string' ? o.instructions.slice(0, CONTEXT_INSTRUCTIONS_MAX_CHARS) : '';
  const tools = Array.isArray(o.tools)
    ? [...new Set(o.tools.filter((t): t is string => typeof t === 'string' && validToolName(t)))].slice(0, CONTEXT_MAX_TOOLS)
    : [];
  const model = CONTEXT_MODELS.some((m) => m.id === o.model) ? (o.model as ContextModel) : DEFAULT_CONTEXT.model;
  const timeoutMs = CONTEXT_TIMEOUTS.some((t) => t.ms === o.timeoutMs) ? (o.timeoutMs as number) : DEFAULT_CONTEXT.timeoutMs;
  return { instructions, tools, model, timeoutMs };
}

/** Where the settings live, and how they are read and written. A seam for tests. */
export interface ContextFiles {
  read: (projectId: number) => Promise<string | null>;
  write: (projectId: number, json: string) => Promise<void>;
}

async function settingsDir(): Promise<string> {
  const { homeDir } = await import('@tauri-apps/api/path');
  return `${(await homeDir()).replace(/\/+$/, '')}/.albedo/guide-context`;
}

let files: ContextFiles = {
  read: async (projectId) => {
    const fs = await import('@tauri-apps/plugin-fs');
    const path = `${await settingsDir()}/project-${projectId}.json`;
    if (!(await fs.exists(path))) return null;
    return fs.readTextFile(path);
  },
  write: async (projectId, json) => {
    const fs = await import('@tauri-apps/plugin-fs');
    const dir = await settingsDir();
    // The plugin makes no folder on its own (REGRESSIONS: a stand-in kinder than the real thing).
    await fs.mkdir(dir, { recursive: true });
    // Yours alone: 0600 when the file is made.
    await fs.writeTextFile(`${dir}/project-${projectId}.json`, json, { mode: 0o600 });
  },
};

export function setContextFiles(next: ContextFiles): ContextFiles {
  const prev = files;
  files = next;
  return prev;
}

/** project id -> its settings (null: none saved); absent until read. */
const cache = new Map<number, ContextSettings | null>();
const reading = new Map<number, Promise<ContextSettings | null>>();
const listeners = new Set<() => void>();
let version = 0;
function changed(): void {
  version++;
  for (const l of listeners) l();
}

/** The project's settings, read once and then from memory. Null when none, or unreadable. */
export function loadContextSettings(projectId: number): Promise<ContextSettings | null> {
  if (cache.has(projectId)) return Promise.resolve(cache.get(projectId) ?? null);
  const pending = reading.get(projectId);
  if (pending) return pending;
  const p = files
    .read(projectId)
    .then((raw) => (raw ? asContextSettings(JSON.parse(raw)) : null))
    .catch((err: unknown) => {
      console.warn('[guide] could not read the Context settings', projectId, err);
      return null;
    })
    .then((s) => {
      reading.delete(projectId);
      cache.set(projectId, s);
      changed();
      return s;
    });
  reading.set(projectId, p);
  return p;
}

/** Save a project's settings. Throws when the file could not be written. */
export async function saveContextSettings(projectId: number, s: ContextSettings): Promise<void> {
  const clean = asContextSettings(s) ?? DEFAULT_CONTEXT;
  await files.write(projectId, `${JSON.stringify({ version: 1, ...clean }, null, 2)}\n`);
  cache.set(projectId, clean);
  changed();
}

/**
 * The project's settings for a render: undefined while being read, null when
 * there are none. Starts the read.
 */
export function useContextSettings(projectId: number | null): ContextSettings | null | undefined {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  if (projectId === null) return null;
  if (!cache.has(projectId)) {
    void loadContextSettings(projectId);
    return undefined;
  }
  return cache.get(projectId) ?? null;
}

/** Tests only. */
export function resetContextSettingsForTests(): void {
  cache.clear();
  reading.clear();
  changed();
}

// ---------------------------------------------------------------------------
// The fixed part of the prompt
// ---------------------------------------------------------------------------

/** The frame around the user's words. Shown, read-only, in the sheet. */
export const CONTEXT_FRAME =
  'You gather background for someone about to review a code change. Follow the user’s instructions below, using only the tools allowed. Report only what the sources say, with each source’s name and link. Under 200 words. If you find nothing, say so; do not guess.';

/** What the step is given, in the sheet's words. */
export const CONTEXT_GIVEN = 'the task title, the branch, the PR title and description, the commit subjects. Not the code.';

/** The system prompt: the frame, then the user's instructions as written. */
export function contextSystem(instructions: string): string {
  return `${CONTEXT_FRAME}\n\nYour instructions follow, as written.\n\n${instructions.trim()}`;
}

export const CONTEXT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, url: { type: 'string' } },
        required: ['name'],
      },
    },
  },
  required: ['summary', 'sources'],
};

// ---------------------------------------------------------------------------
// The input
// ---------------------------------------------------------------------------

export interface ContextInput {
  title: string;
  branch: string;
  pr: { title: string; body: string } | null;
  commits: string[];
}

export const CONTEXT_BODY_MAX_CHARS = 4000;
export const CONTEXT_MAX_COMMITS = 50;

/** The prompt sent on stdin. Pure. */
export function contextPrompt(input: ContextInput): string {
  const body = input.pr?.body.trim() ?? '';
  const cutBody = body.length > CONTEXT_BODY_MAX_CHARS ? `${body.slice(0, CONTEXT_BODY_MAX_CHARS)}…` : body;
  const commits = input.commits.slice(0, CONTEXT_MAX_COMMITS);
  return [
    `Task title: ${input.title.trim() || '(none)'}`,
    `Branch: ${input.branch.trim() || '(none)'}`,
    input.pr ? `Pull request title: ${input.pr.title.trim()}` : 'Pull request: none yet',
    input.pr ? `Pull request description:\n${cutBody || '(empty)'}` : null,
    `Commit subjects on the branch (${input.commits.length}, newest first):`,
    commits.length > 0 ? commits.map((s) => `- ${s}`).join('\n') : '(none)',
    input.commits.length > commits.length ? `… and ${input.commits.length - commits.length} older.` : null,
  ]
    .filter((x) => x !== null)
    .join('\n');
}

export type ContextTask = Pick<Task, 'id' | 'title' | 'branch' | 'worktreePath' | 'reviewUrl'>;

/**
 * Read the input for `task`: its PR's title and description through gh, the
 * commit subjects since `base` through git. Whatever cannot be read is left
 * out; this never throws.
 */
export async function gatherContextInput(task: ContextTask, base: string): Promise<ContextInput> {
  const prUrl = task.reviewUrl || getPrStatus(task.id)?.url || '';
  const pr = prUrl
    ? await gh(['pr', 'view', prUrl, '--json', 'title,body'], task.worktreePath)
        .then((r) => {
          if (!r || r.code !== 0) return null;
          const v = JSON.parse(r.stdout) as { title?: unknown; body?: unknown };
          return { title: typeof v.title === 'string' ? v.title : '', body: typeof v.body === 'string' ? v.body : '' };
        })
        .catch(() => null)
    : null;
  const commits = await (async () => {
    const from = base ? await taskBase(task.worktreePath, base) : null;
    if (!from) return [];
    const out = await gitOk(['log', '--no-color', '--format=%s', `${from}..HEAD`], task.worktreePath);
    return out.split('\n').filter((l) => l.trim() !== '');
  })().catch(() => []);
  return { title: task.title, branch: task.branch, pr, commits };
}
