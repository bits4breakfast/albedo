/**
 * Claude Code hook events: the one way Albedo learns a session is waiting on
 * the user BEFORE the transcript says so.
 *
 * ## Why this exists
 *
 * Claude Code writes an assistant turn to the transcript only once the turn is
 * complete. A turn that ends in an approval question or a permission prompt is
 * therefore not on disk while it waits for the user, and the terminal is the
 * only place it exists -- which Albedo never reads. Hooks are Claude Code's own
 * structured way out of that: it runs a command, with a JSON payload on stdin,
 * when it needs the user.
 *
 * ## Third channel, by decision
 *
 * CLAUDE.md names two channels (pty, transcript). This is a third, read-only
 * and structured, added with the owner's explicit agreement. It is never
 * terminal bytes: a hook command writes a JSON line to a file, and this module
 * reads the file. It is the one place that knows the hook payload shape.
 *
 * ## Shape of the pipe
 *
 *   spawn `claude --settings <json>`      (hookSettingsArg)
 *     hooks run ~/.albedo/hook.sh <taskId>  (HOOK_SCRIPT)
 *       append one line to ~/.albedo/events/task-<taskId>.jsonl
 *         this module watches the file and derives the pending prompt
 *
 * Only Albedo-spawned tasks get hooks. The `--settings` block is additive: it
 * does not replace the user's own hooks.
 */

import { homeDir } from '@tauri-apps/api/path';
import { exists, mkdir, readTextFile, watch, writeTextFile, type UnwatchFn } from '@tauri-apps/plugin-fs';

// ---------------------------------------------------------------------------
// What a prompt is
// ---------------------------------------------------------------------------

export interface PromptOption {
  label: string;
  description: string | null;
}

export type PendingPrompt =
  | {
      kind: 'question';
      toolUseId: string | null;
      /** One entry per question Claude asked; usually one. */
      questions: Array<{ header: string | null; question: string; multiSelect: boolean; options: PromptOption[] }>;
      at: number;
    }
  | {
      kind: 'permission';
      toolUseId: string | null;
      toolName: string;
      /** A one-line description of what the tool wants to do. */
      summary: string;
      at: number;
    }
  /**
   * Claude Code said it needs the user but no detailed event arrived. A
   * fallback from the `Notification` hook, so a prompt the other events miss
   * still turns the task blocked rather than reading as running.
   */
  | { kind: 'notice'; toolUseId: null; message: string; at: number };

/** One parsed hook line. Everything optional: a hook line must never throw. */
export interface HookEvent {
  event: string;
  toolName: string | null;
  toolUseId: string | null;
  toolInput: Record<string, unknown> | null;
  /** `Notification` only. */
  message: string | null;
  notificationType: string | null;
  at: number;
}

// ---------------------------------------------------------------------------
// Parsing -- FORMAT KNOWLEDGE lives here and in HOOK_SCRIPT
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function parseHookLines(text: string, fallbackAt = Date.now()): HookEvent[] {
  const out: HookEvent[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const d = JSON.parse(line) as Record<string, unknown>;
      const event = str(d['hook_event_name']);
      if (event === null) continue;
      const input = d['tool_input'];
      out.push({
        event,
        toolName: str(d['tool_name']),
        toolUseId: str(d['tool_use_id']),
        toolInput: input && typeof input === 'object' ? (input as Record<string, unknown>) : null,
        message: str(d['message']),
        notificationType: str(d['notification_type']),
        // Hook payloads carry no timestamp; the script stamps one (`albedo_at`).
        at: typeof d['albedo_at'] === 'number' ? (d['albedo_at'] as number) : fallbackAt,
      });
    } catch {
      /* a torn or foreign line is skipped, never fatal */
    }
  }
  return out;
}

const ASK_TOOL = 'AskUserQuestion';

function questionsOf(input: Record<string, unknown> | null): Extract<PendingPrompt, { kind: 'question' }>['questions'] {
  const raw = input?.['questions'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((q) => {
    if (!q || typeof q !== 'object') return [];
    const o = q as Record<string, unknown>;
    const question = str(o['question']);
    if (question === null) return [];
    const options = Array.isArray(o['options'])
      ? (o['options'] as unknown[]).flatMap((x): PromptOption[] => {
          if (!x || typeof x !== 'object') return [];
          const label = str((x as Record<string, unknown>)['label']);
          return label === null ? [] : [{ label, description: str((x as Record<string, unknown>)['description']) }];
        })
      : [];
    return [{ header: str(o['header']), question, multiSelect: o['multiSelect'] === true, options }];
  });
}

/** One line saying what a tool wants: its command, file or url, else its name. */
function summarize(toolName: string, input: Record<string, unknown> | null): string {
  const pick = (k: string) => str(input?.[k]);
  const detail =
    pick('command') ?? pick('file_path') ?? pick('path') ?? pick('url') ?? pick('pattern') ?? pick('description');
  const text = detail ? `${toolName}: ${detail}` : toolName;
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 240 ? `${oneLine.slice(0, 239)}…` : oneLine;
}

/**
 * The prompt a session is waiting on right now, or null.
 *
 * Replays events in order. A prompt is raised by `PermissionRequest` (a
 * permission dialog) or by `PreToolUse` of AskUserQuestion, and cleared by
 * anything that proves Claude moved on: the tool finishing, the turn stopping,
 * a new user prompt, or a different tool starting.
 *
 * `Notification` is only a fallback (see the `notice` kind): it fires for idle
 * reminders as well as prompts, and the events above carry the detail.
 */
export function derivePending(events: readonly HookEvent[]): PendingPrompt | null {
  let pending: PendingPrompt | null = null;
  for (const e of events) {
    switch (e.event) {
      case 'PermissionRequest':
        pending = {
          kind: 'permission',
          toolUseId: e.toolUseId,
          toolName: e.toolName ?? 'a tool',
          summary: summarize(e.toolName ?? 'a tool', e.toolInput),
          at: e.at,
        };
        break;
      case 'PreToolUse':
        if (e.toolName === ASK_TOOL) {
          pending = { kind: 'question', toolUseId: e.toolUseId, questions: questionsOf(e.toolInput), at: e.at };
        } else if (pending && e.toolUseId !== pending.toolUseId) {
          pending = null;
        }
        break;
      case 'Notification':
        // Only the types that mean "needs you", and only when nothing more
        // detailed is already showing. Idle reminders are not prompts.
        if (
          pending === null &&
          (e.notificationType === 'permission_prompt' || e.notificationType === 'elicitation_dialog')
        ) {
          pending = { kind: 'notice', toolUseId: null, message: e.message ?? 'Claude needs your input', at: e.at };
        }
        break;
      case 'PostToolUse':
      case 'PostToolUseFailure':
        if (pending && (e.toolUseId === null || pending.toolUseId === null || e.toolUseId === pending.toolUseId)) {
          pending = null;
        }
        break;
      case 'Stop':
      case 'UserPromptSubmit':
      case 'SessionEnd':
      case 'SessionStart':
        pending = null;
        break;
      default:
        break;
    }
  }
  return pending;
}

// ---------------------------------------------------------------------------
// The hook command
// ---------------------------------------------------------------------------

/** Directory under $HOME holding the script and the event files. */
export const ALBEDO_DIR = '.albedo';

/**
 * POSIX sh, no dependencies (no jq, no python: macOS may not have them).
 *
 * Reads one payload, stamps it with a time, and appends ONE line. Detail is
 * kept only for the events that raise a prompt; everything else is reduced to
 * its name and tool_use_id, because a PostToolUse payload carries the whole
 * tool_response and can be megabytes. Always exits 0 and prints nothing, so it
 * can never block or alter Claude Code.
 */
export const HOOK_SCRIPT = `#!/bin/sh
# Written by Albedo. Appends Claude Code hook events to a per-task file.
dir="$HOME/${ALBEDO_DIR}/events"
mkdir -p "$dir" 2>/dev/null
f="$dir/task-$1.jsonl"
payload=$(cat)
now=$(date +%s)000
ev=$(printf '%s' "$payload" | sed -n 's/.*"hook_event_name" *: *"\\([^"]*\\)".*/\\1/p')
case "$ev" in
  PermissionRequest|PreToolUse|Notification)
    body=$(printf '%s' "$payload" | tr -d '\\n')
    printf '%s,"albedo_at":%s}\\n' "\${body%\\}}" "$now" >> "$f" ;;
  *)
    id=$(printf '%s' "$payload" | sed -n 's/.*"tool_use_id" *: *"\\([^"]*\\)".*/\\1/p')
    printf '{"hook_event_name":"%s","tool_use_id":"%s","albedo_at":%s}\\n' "$ev" "$id" "$now" >> "$f" ;;
esac
exit 0
`;

/**
 * The `--settings` value for one task: JSON, passed as a single argv entry.
 *
 * PreToolUse is limited to AskUserQuestion by matcher so ordinary tool calls
 * do not run the script twice. The others run for every tool. Per the hooks
 * reference, `--settings` keys override same-named keys for the session while
 * hook entries from the user's own settings still run alongside these.
 *
 * `PermissionRequest` payloads carry no `tool_use_id` (documented), so a
 * permission prompt is cleared by the next PostToolUse of any tool, or by Stop.
 */
export function hookSettingsArg(taskId: number, scriptPath: string): string {
  const command = `sh ${JSON.stringify(scriptPath)} ${taskId}`;
  const hook = [{ type: 'command', command }];
  return JSON.stringify({
    hooks: {
      PermissionRequest: [{ hooks: hook }],
      Notification: [{ hooks: hook }],
      PreToolUse: [{ matcher: ASK_TOOL, hooks: hook }],
      PostToolUse: [{ hooks: hook }],
      PostToolUseFailure: [{ hooks: hook }],
      Stop: [{ hooks: hook }],
      UserPromptSubmit: [{ hooks: hook }],
    },
  });
}

// ---------------------------------------------------------------------------
// Runtime: install, watch, publish
// ---------------------------------------------------------------------------

type Listener = (taskId: number, prompt: PendingPrompt | null) => void;

const listeners = new Set<Listener>();
const pending = new Map<number, PendingPrompt>();
const fileTasks = new Set<number>();
let started: Promise<void> | null = null;
let unwatch: UnwatchFn | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let cachedHome: string | null = null;

async function home(): Promise<string> {
  if (cachedHome === null) cachedHome = (await homeDir()).replace(/\/+$/, '');
  return cachedHome;
}

/** The task's prompt, or null. Synchronous: it reads what the watcher last saw. */
export function pendingPrompt(taskId: number): PendingPrompt | null {
  return pending.get(taskId) ?? null;
}

export function onPromptChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function publish(taskId: number, next: PendingPrompt | null): void {
  const prev = pending.get(taskId) ?? null;
  const same = prev === null ? next === null : next !== null && prev.at === next.at && prev.kind === next.kind;
  if (same) return;
  if (next === null) pending.delete(taskId);
  else pending.set(taskId, next);
  for (const cb of [...listeners]) {
    try {
      cb(taskId, next);
    } catch {
      /* a broken subscriber must not stall the others */
    }
  }
}

async function refreshTask(taskId: number): Promise<void> {
  try {
    const path = `${await home()}/${ALBEDO_DIR}/events/task-${taskId}.jsonl`;
    if (!(await exists(path))) return publish(taskId, null);
    publish(taskId, derivePending(parseHookLines(await readTextFile(path))));
  } catch {
    /* unreadable this tick; the next one retries */
  }
}

const TASK_FILE = /task-(\d+)\.jsonl$/;

/**
 * Write the hook script and begin watching the event files. Idempotent, and
 * resolves to the script path the caller should pass to {@link hookSettingsArg}.
 */
export async function startHookEvents(): Promise<string> {
  const base = `${await home()}/${ALBEDO_DIR}`;
  const scriptPath = `${base}/hook.sh`;
  started ??= (async () => {
    await mkdir(`${base}/events`, { recursive: true });
    await writeTextFile(scriptPath, HOOK_SCRIPT);
    const sweep = () => void Promise.all([...fileTasks].map((id) => refreshTask(id)));
    try {
      unwatch = await watch(`${base}/events`, (event) => {
        for (const p of event.paths) {
          const m = TASK_FILE.exec(p);
          if (m) {
            const id = Number(m[1]);
            fileTasks.add(id);
            void refreshTask(id);
          }
        }
      }, { delayMs: 100 });
    } catch (err) {
      console.warn('[hooks] event watch unavailable, polling only', err);
    }
    // A watcher that starts and never fires is silent, so poll as well.
    timer = setInterval(sweep, 2_000);
  })();
  await started;
  return scriptPath;
}

/** Tasks whose session was started with the hooks, this run. */
const hooked = new Set<number>();

/**
 * True when the task's session reports its own prompts through hooks, so the
 * transcript's guess (an unanswered tool call means waiting) is not needed and
 * is wrong for any tool that merely takes a while.
 */
export function hasHooks(taskId: number): boolean {
  return hooked.has(taskId);
}

/** Forget a task's events: at (re)spawn, and when the task is deleted. */
export async function resetTaskEvents(taskId: number): Promise<void> {
  hooked.add(taskId);
  fileTasks.add(taskId);
  try {
    const path = `${await home()}/${ALBEDO_DIR}/events/task-${taskId}.jsonl`;
    if (await exists(path)) await writeTextFile(path, '');
  } catch {
    /* nothing to reset */
  }
  publish(taskId, null);
}

export async function stopHookEvents(): Promise<void> {
  if (timer !== null) clearInterval(timer);
  timer = null;
  try {
    unwatch?.();
  } catch {
    /* already gone */
  }
  unwatch = null;
  started = null;
}
