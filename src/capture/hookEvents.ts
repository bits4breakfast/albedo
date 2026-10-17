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
 * CLAUDE.md names two channels (pty, transcript). This is a third, structured,
 * added with the owner's explicit agreement. It is never terminal bytes: a
 * hook command writes a JSON line to a file, and this module reads the file.
 * It is the one place that knows the hook payload shape. The only thing that
 * flows the other way is an answer the user clicked (below).
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
 *
 * ## The one thing that flows back: an answer the user clicked
 *
 * The `PermissionRequest` hook does not exit at once. It writes its line, then
 * waits (up to {@link ANSWER_WINDOW_S}) for a file named after its own request
 * id, `answer-<taskId>-<req>.json`, and prints that file as its decision. That
 * file is written only by {@link answerPrompt}, only from a click on the
 * "waiting on you" card. This is how the card answers -- structured, by Claude
 * Code's documented hook decision, never by typing into the pty.
 *
 * Why this and not keystrokes, measured against Claude Code 2.1.302 driven in
 * a real pty (October 2026):
 *
 *   - The terminal dialog is NOT held back while the hook runs. It is drawn at
 *     once and stays fully usable; the hook and the dialog race, and whichever
 *     decides first applies. A slow hook therefore costs the terminal nothing.
 *   - Answer in the terminal first and Claude Code SIGTERMs the waiting hook
 *     within a second. Its decision can never land later: a terminal "No"
 *     followed by a hook "allow" ran nothing.
 *   - A hook that times out is cancelled and its output discarded. The dialog
 *     stays up and nothing is decided -- the timeout can never approve.
 *   - AskUserQuestion raises a PermissionRequest too, and `allow` with
 *     `updatedInput.answers` answers it ("User answered Claude's questions").
 *     Multi-select answers are labels joined by ", ".
 *
 * Keystrokes would have to guess which dialog is on screen right now, and a
 * stale guess types "1" into whatever replaced it -- possibly a different
 * permission. A decision file is keyed to one request and read by that
 * request's own hook, so it cannot answer anything else.
 */

import { homeDir } from '@tauri-apps/api/path';
import { exists, mkdir, readTextFile, rename, watch, writeTextFile, type UnwatchFn } from '@tauri-apps/plugin-fs';

// ---------------------------------------------------------------------------
// What a prompt is
// ---------------------------------------------------------------------------

export interface PromptOption {
  label: string;
  description: string | null;
}

export interface PromptQuestion {
  header: string | null;
  question: string;
  multiSelect: boolean;
  options: PromptOption[];
}

/**
 * A permission rule the card may add on "Allow, don't ask again". Kept as the
 * raw entry Claude Code suggested, because the decision must echo it verbatim.
 */
export interface SuggestedRule {
  /** `Tool(content)` as Claude Code's settings files spell it, for display. */
  label: string;
  /** Where Claude Code proposed to write it, e.g. `localSettings`. */
  destination: string;
  raw: Record<string, unknown>;
}

export type PendingPrompt =
  | {
      kind: 'question';
      toolUseId: string | null;
      /** One entry per question Claude asked; usually one. */
      questions: PromptQuestion[];
      /**
       * The `questions` array exactly as Claude sent it. An answer must echo it
       * back unchanged, and the parsed form above drops fields it does not show.
       */
      rawQuestions: unknown[];
      /** Set once the waiting PermissionRequest hook has registered; else null. */
      requestId: string | null;
      at: number;
    }
  | {
      kind: 'permission';
      toolUseId: string | null;
      toolName: string;
      /** A one-line description of what the tool wants to do. */
      summary: string;
      requestId: string | null;
      /**
       * The rules "don't ask again" would add, or null when Claude Code's
       * suggestion is anything other than plain allow rules (see
       * {@link alwaysAllowRules}). Null hides the button.
       */
      alwaysAllow: SuggestedRule[] | null;
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
  /** `PermissionRequest` only: the id the waiting hook polls an answer under. */
  requestId: string | null;
  /** `PermissionRequest` only: Claude Code's `permission_suggestions`. */
  suggestions: unknown[] | null;
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
        // Stamped by HOOK_SCRIPT. Checked here because it becomes a file name.
        requestId: REQUEST_ID.test(str(d['albedo_req']) ?? '') ? (d['albedo_req'] as string) : null,
        suggestions: Array.isArray(d['permission_suggestions']) ? (d['permission_suggestions'] as unknown[]) : null,
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

/**
 * What HOOK_SCRIPT stamps as `albedo_req`: `<pid>-<epoch ms>`. Unique per
 * waiting hook, and safe as part of a file name -- which is why anything else
 * is dropped rather than trusted.
 */
const REQUEST_ID = /^\d{1,10}-\d{10,16}$/;

function rawQuestionsOf(input: Record<string, unknown> | null): unknown[] {
  const raw = input?.['questions'];
  return Array.isArray(raw) ? raw : [];
}

function questionsOf(input: Record<string, unknown> | null): PromptQuestion[] {
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
 * The rules "Allow, don't ask again" may add, or null to not offer it.
 *
 * Offered only when EVERY suggestion is a plain `addRules` with behavior
 * `allow` and concrete rules. A suggestion can also switch the permission mode
 * or add directories, which is far wider than "this command again"; the card
 * shows a rule list, so it offers only what a rule list can honestly describe.
 * The terminal remains the place for anything else.
 *
 * Note the suggestion is not always what the terminal shows: measured, the
 * terminal offered `curl *` while the suggestion held the exact command. The
 * card offers the suggestion, i.e. the narrower rule, and says which.
 */
export function alwaysAllowRules(suggestions: readonly unknown[] | null): SuggestedRule[] | null {
  if (!suggestions || suggestions.length === 0) return null;
  const out: SuggestedRule[] = [];
  for (const s of suggestions) {
    if (!s || typeof s !== 'object') return null;
    const o = s as Record<string, unknown>;
    const destination = str(o['destination']);
    if (o['type'] !== 'addRules' || o['behavior'] !== 'allow' || destination === null) return null;
    const rules = o['rules'];
    if (!Array.isArray(rules) || rules.length === 0) return null;
    const labels: string[] = [];
    for (const r of rules) {
      const tool = r && typeof r === 'object' ? str((r as Record<string, unknown>)['toolName']) : null;
      if (tool === null) return null;
      const content = str((r as Record<string, unknown>)['ruleContent']);
      labels.push(content === null ? tool : `${tool}(${content})`);
    }
    out.push({ label: labels.join(', '), destination, raw: o });
  }
  return out;
}

function sameQuestions(a: readonly PromptQuestion[], b: readonly PromptQuestion[]): boolean {
  return a.length === b.length && a.every((q, i) => q.question === b[i]?.question);
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
        if (e.toolName === ASK_TOOL) {
          // AskUserQuestion asks permission too: this is the same question its
          // PreToolUse raised, now with a hook waiting to carry the answer. Keep
          // that tool_use_id (this payload has none) so its PostToolUse clears it.
          const questions = questionsOf(e.toolInput);
          // (Widened: tsc narrows the loop variable to its initial null here.)
          const prev = pending as PendingPrompt | null;
          const keep = prev?.kind === 'question' && sameQuestions(prev.questions, questions) ? prev : null;
          pending = {
            kind: 'question',
            toolUseId: keep?.toolUseId ?? null,
            questions,
            rawQuestions: rawQuestionsOf(e.toolInput),
            requestId: e.requestId,
            at: e.at,
          };
          break;
        }
        pending = {
          kind: 'permission',
          toolUseId: e.toolUseId,
          toolName: e.toolName ?? 'a tool',
          summary: summarize(e.toolName ?? 'a tool', e.toolInput),
          requestId: e.requestId,
          alwaysAllow: alwaysAllowRules(e.suggestions),
          at: e.at,
        };
        break;
      case 'PreToolUse':
        if (e.toolName === ASK_TOOL) {
          pending = {
            kind: 'question',
            toolUseId: e.toolUseId,
            questions: questionsOf(e.toolInput),
            rawQuestions: rawQuestionsOf(e.toolInput),
            requestId: null,
            at: e.at,
          };
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
// Answering -- the decision JSON the waiting hook prints. Pure.
// ---------------------------------------------------------------------------

/**
 * How long the PermissionRequest hook waits for a click, in seconds. Past it
 * the hook is gone and the card can only send the user to the terminal.
 *
 * An hour: long enough to come back to a session from another one, short
 * enough that a forgotten prompt does not keep a polling shell alive all day.
 * The polling is a `sleep 0.5` loop, so the cost while waiting is negligible.
 */
export const ANSWER_WINDOW_S = 3600;

/** Hook stdout: the documented `hookSpecificOutput` for PermissionRequest. */
export interface HookDecision {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest';
    decision:
      | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: Array<Record<string, unknown>> }
      | { behavior: 'deny'; message: string; interrupt: boolean };
  };
}

export type PermissionChoice = 'allow' | 'allow-always' | 'deny';

/** What Claude is told when the user denies from the card. */
export const DENY_MESSAGE = 'The user denied this from Albedo.';

/**
 * The decision for a permission prompt, or null when this choice cannot be
 * made from the card.
 *
 * `allow` carries no `updatedInput`, so the tool runs with exactly the input
 * the user was shown. `deny` interrupts, as the terminal's "No" does: Claude
 * stops and waits to be told what to do instead, rather than trying the next
 * thing on its own.
 */
export function permissionDecision(prompt: PendingPrompt, choice: PermissionChoice): HookDecision | null {
  if (prompt.kind !== 'permission') return null;
  const wrap = (decision: HookDecision['hookSpecificOutput']['decision']): HookDecision => ({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision },
  });
  switch (choice) {
    case 'allow':
      return wrap({ behavior: 'allow' });
    case 'allow-always':
      if (prompt.alwaysAllow === null) return null;
      return wrap({ behavior: 'allow', updatedPermissions: prompt.alwaysAllow.map((r) => r.raw) });
    case 'deny':
      return wrap({ behavior: 'deny', message: DENY_MESSAGE, interrupt: true });
  }
}

/**
 * One question's answer as the user picked it on the card.
 *
 * `other` is the free text the terminal's "Type something." takes; it is
 * appended after any picked labels, so a multi-select can carry both.
 */
export interface QuestionPick {
  labels: string[];
  other: string;
}

/** The answer string for one question, or null when nothing was chosen. */
export function answerText(q: PromptQuestion, pick: QuestionPick | undefined): string | null {
  if (!pick) return null;
  const known = new Set(q.options.map((o) => o.label));
  // Option order, not click order, and only labels this question offers.
  const labels = q.options.map((o) => o.label).filter((l) => pick.labels.includes(l) && known.has(l));
  const chosen = q.multiSelect ? labels : labels.slice(0, 1);
  const other = pick.other.replace(/\s+/g, ' ').trim();
  // Single-select takes one answer: typed text replaces a picked label, as
  // choosing "Type something." in the terminal does.
  const parts = q.multiSelect ? [...chosen, ...(other ? [other] : [])] : other ? [other] : chosen;
  // Measured: Claude Code renders a multi-select answer as "Apple, Plum".
  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * The decision answering an AskUserQuestion, or null unless EVERY question has
 * an answer. Echoes `questions` verbatim and adds `answers`, keyed by question
 * text, as the hooks reference specifies for this tool.
 */
export function questionDecision(prompt: PendingPrompt, picks: ReadonlyArray<QuestionPick | undefined>): HookDecision | null {
  if (prompt.kind !== 'question' || prompt.questions.length === 0) return null;
  if (prompt.rawQuestions.length !== prompt.questions.length) return null; // a question we could not parse
  const answers: Record<string, string> = {};
  for (const [i, q] of prompt.questions.entries()) {
    const text = answerText(q, picks[i]);
    if (text === null) return null;
    answers[q.question] = text;
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow', updatedInput: { questions: prompt.rawQuestions, answers } },
    },
  };
}

/**
 * True when `current` is still exactly the prompt the card showed as `shown`,
 * and a hook is still waiting for its answer.
 *
 * Identity is the request id: it names one waiting hook process, so a prompt
 * that was answered in the terminal and replaced by another -- even an
 * identical-looking one -- has a different id and fails this.
 */
export function isAnswerable(current: PendingPrompt | null, shown: PendingPrompt, now: number): boolean {
  if (current === null || shown.kind === 'notice' || current.kind !== shown.kind) return false;
  if (shown.requestId === null || current.requestId !== shown.requestId) return false;
  // Leave a margin: a click in the last seconds could land after the hook quit.
  return now - shown.at < (ANSWER_WINDOW_S - 15) * 1000;
}

/** The file the waiting hook polls for. Mirrors the name in HOOK_SCRIPT. */
export function answerFileName(taskId: number, requestId: string): string {
  return `answer-${taskId}-${requestId}.json`;
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
 * tool_response and can be megabytes. Always exits 0.
 *
 * Every event but one prints nothing, so it can never block or alter Claude
 * Code. The exception is `PermissionRequest`: it stamps a request id, then
 * waits for `answer-<taskId>-<req>.json` and prints it as the decision (see
 * the module header for why that is safe). Printing nothing -- the window
 * running out, or Claude Code killing it because the terminal answered first
 * -- leaves the decision to the terminal, which is the behaviour without
 * Albedo. Nothing here can produce a decision the user did not click.
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
  PermissionRequest)
    req="$$-$now"
    body=$(printf '%s' "$payload" | tr -d '\\n')
    printf '%s,"albedo_at":%s,"albedo_req":"%s"}\\n' "\${body%\\}}" "$now" "$req" >> "$f"
    # Answers written after their hook was gone are never read; sweep them.
    find "$dir" -name 'answer-*' -mmin +180 -exec rm -f {} + 2>/dev/null
    ans="$dir/answer-$1-$req.json"
    # $2 overrides the window, in seconds; only the tests pass it.
    win=\${2:-${ANSWER_WINDOW_S}}
    i=0
    while [ "$i" -lt $((win * 2)) ]; do
      if [ -f "$ans" ]; then cat "$ans"; rm -f "$ans"; exit 0; fi
      sleep 0.5
      i=$((i + 1))
    done ;;
  PreToolUse|Notification)
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
 *
 * `PermissionRequest` gets its own `timeout`, a little past the script's own
 * window so the script quits first: the default (600 s) would cut the answer
 * window short. A timed-out hook decides nothing (measured), so this bounds
 * how long the card can answer, never what it answers.
 */
export function hookSettingsArg(taskId: number, scriptPath: string): string {
  const command = `sh ${JSON.stringify(scriptPath)} ${taskId}`;
  const hook = [{ type: 'command', command }];
  return JSON.stringify({
    hooks: {
      PermissionRequest: [{ hooks: [{ type: 'command', command, timeout: ANSWER_WINDOW_S + 30 }] }],
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
  // The request id is part of identity: it arrives on a later line than the
  // question it belongs to, and that is what makes the card answerable.
  const reqOf = (p: PendingPrompt) => (p.kind === 'notice' ? null : p.requestId);
  const same =
    prev === null
      ? next === null
      : next !== null && prev.at === next.at && prev.kind === next.kind && reqOf(prev) === reqOf(next);
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
    publish(taskId, withoutAnswered(derivePending(parseHookLines(await readTextFile(path))), answered));
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

/**
 * Requests whose hook took an answer from the card, this run.
 *
 * Needed because a deny interrupts the turn, and an interrupted turn fires no
 * Stop (measured; the same is true of Esc in the terminal). Without this the
 * card -- and the task's blocked status -- would outlive the answer until the
 * next prompt. A taken answer is proof the request is over, so it retires it.
 */
const answered = new Set<string>();

/** The prompt, unless the card's answer to it was already taken. Pure. */
export function withoutAnswered(p: PendingPrompt | null, done: ReadonlySet<string>): PendingPrompt | null {
  if (p === null || p.kind === 'notice' || p.requestId === null) return p;
  return done.has(p.requestId) ? null : p;
}

/** How long to wait for the hook to take a written answer. It polls at 2 Hz. */
const TAKE_TIMEOUT_MS = 3_000;

export type AnswerResult =
  /** Not written: the prompt had changed or the hook's window had closed. */
  | 'refused'
  /** The hook printed it: Claude Code has the answer. */
  | 'taken'
  /** Written but not picked up -- the hook was gone (answered in the terminal). */
  | 'untaken';

/**
 * Hand the waiting hook the user's answer. Call only from a click.
 *
 * Re-checks, at the moment of writing, that the task's prompt is still the one
 * the card showed ({@link isAnswerable}); a prompt answered in the terminal in
 * the meantime is refused here rather than at render time. The file is written
 * under a temporary name and renamed, so the hook -- which reads the file the
 * moment it exists -- can never print half of it.
 *
 * The hook deletes the file as it prints it, so the file disappearing is the
 * acknowledgement. One left in place was never read and never will be: its
 * hook was killed (Claude Code does that the moment the terminal answers), and
 * no other hook polls that name.
 */
export async function answerPrompt(taskId: number, shown: PendingPrompt, decision: HookDecision): Promise<AnswerResult> {
  if (shown.kind === 'notice' || shown.requestId === null) return 'refused';
  if (!isAnswerable(pendingPrompt(taskId), shown, Date.now())) return 'refused';
  let final: string;
  try {
    const dir = `${await home()}/${ALBEDO_DIR}/events`;
    final = `${dir}/${answerFileName(taskId, shown.requestId)}`;
    const tmp = `${final}.part`;
    await writeTextFile(tmp, JSON.stringify(decision));
    // Last look: the write took a tick, and the terminal may have won it.
    if (!isAnswerable(pendingPrompt(taskId), shown, Date.now())) return 'refused';
    await rename(tmp, final);
  } catch (err) {
    console.warn('[hooks] could not write the answer', err);
    return 'refused';
  }
  const until = Date.now() + TAKE_TIMEOUT_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      if (!(await exists(final))) {
        answered.add(shown.requestId);
        await refreshTask(taskId);
        return 'taken';
      }
    } catch {
      /* unreadable this tick; try again */
    }
  }
  return 'untaken';
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
