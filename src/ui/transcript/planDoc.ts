/**
 * A plan in the "waiting on you" card (#272): which file a question points
 * to, reading it, and the answer a set of comments on it becomes.
 *
 * A session asking to approve a plan usually writes the plan to a markdown
 * file and names it in the question ("Full plan: /…/scratchpad/plan.md").
 * The card shows that file as a document. Only an absolute path ending in
 * `.md` counts, the first one if there are several; nothing else the
 * question names is opened. The read is Rust's `read_plan_file`
 * (src-tauri/src/fsscope.rs), which grants nothing: the text comes back over
 * IPC, at most {@link PLAN_MAX_BYTES} of it.
 */

/** Mirrors `PLAN_MAX_BYTES` in src-tauri/src/fsscope.rs. */
export const PLAN_MAX_BYTES = 256 * 1024;

/**
 * The first absolute `.md` path in `text`, or null. A path starts the text or
 * follows a space or an opening bracket or quote -- so a URL's path, after
 * `host`, is never one -- and ends at a space, a closing bracket or quote, or
 * sentence punctuation (a full stop only at a sentence's end: `plan.md.bak`
 * is not a plan).
 */
export function planPathIn(text: string): string | null {
  const re = /(?:^|[\s(<[`'"])(\/[^\s`'"<>()[\]]*?\.md)(?=$|[\s`'")>\],;:!?]|\.(?:\s|$))/gi;
  for (const m of text.matchAll(re)) {
    const path = m[1];
    // `//host/x.md` is not a file path.
    if (path && !path.startsWith('//')) return path;
  }
  return null;
}

/** The last part of a path, and the folder before it (with its trailing slash). */
export function splitPath(path: string): { name: string; folder: string } {
  const cut = path.lastIndexOf('/');
  return { name: path.slice(cut + 1), folder: path.slice(0, cut + 1) };
}

export interface PlanFile {
  /** The canonical path read. */
  path: string;
  text: string;
  /** The whole file, in bytes. */
  size: number;
  /** More than {@link PLAN_MAX_BYTES}: `text` is its head. */
  truncated: boolean;
}

export type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/**
 * The plan file's text, or null when it is missing, unreadable, refused, or
 * anything but an absolute `.md` path. Null shows no document: the path stays
 * text in the question.
 */
export async function readPlanFile(path: string, invoke: Invoke = tauriInvoke): Promise<PlanFile | null> {
  if (!path.startsWith('/') || !/\.md$/i.test(path)) return null;
  try {
    const got = await invoke<PlanFile>('read_plan_file', { path });
    if (!got || typeof got.text !== 'string' || typeof got.path !== 'string') return null;
    return {
      path: got.path,
      text: got.text,
      size: typeof got.size === 'number' ? got.size : got.text.length,
      truncated: got.truncated === true,
    };
  } catch {
    return null; // missing or refused: the question keeps the path as text
  }
}

/** "256 KB", "1.2 MB". */
export function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const RECOMMENDED = /\(recommended\)\s*$/i;

/** An option the session marked as its suggestion: its label ends "(Recommended)". */
export function isRecommended(label: string): boolean {
  return RECOMMENDED.test(label);
}

/**
 * The option a set of comments answers as: the first whose label begins by
 * asking for changes (Revise, Change, Feedback, …) -- so "Approve with
 * edits" is not one -- without "(Recommended)"; else "Revise".
 */
export function reviseLabel(labels: readonly string[]): string {
  const hit = labels.find((l) => /^\W*(revis|chang|feedback|amend|adjust|rework|edit|modif|request changes)/i.test(l));
  return hit ? hit.replace(RECOMMENDED, '').trim() : 'Revise';
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

export interface CommentForAnswer {
  quote: string;
  comment: string;
}

/**
 * Comments as one answer, in the order given:
 *
 *   Revise. Comments on the plan (plan.md):
 *
 *   1. On "<passage>":
 *      <comment>
 *
 * A passage is one line (its whitespace squeezed); a comment keeps its lines,
 * each indented under its number. `file` null leaves out the parenthesis.
 */
export function composeComments(label: string, file: string | null, comments: readonly CommentForAnswer[]): string {
  const head = `${label}. Comments on the plan${file ? ` (${file})` : ''}:`;
  const items = comments.map((c, i) => {
    const quote = c.quote.replace(/\s+/g, ' ').trim();
    const body = c.comment
      .trim()
      .split('\n')
      .map((l) => `   ${l.trimEnd()}`)
      .join('\n');
    return `${i + 1}. On "${quote}":\n${body}`;
  });
  return [head, ...items].join('\n\n');
}
