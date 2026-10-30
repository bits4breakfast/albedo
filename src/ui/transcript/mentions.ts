/**
 * `@` references in the message box (#154): another open task, or a file or
 * folder in this task's worktree.
 *
 * ## In the box
 *
 * Typing `@` at the start of the box or after whitespace opens a list
 * (MentionPopover.tsx). Picking from it puts a token in the draft, as a paste
 * does (#134), and keeps what the token stands for in a store beside the
 * text:
 *
 *   - a task:  `@[Fix login retry]`  -- the brackets mark where it ends;
 *   - a file:  `@src/foo.ts`, a folder `@src/ui/` -- Claude Code's own
 *     syntax, so the token reads exactly as it will be sent.
 *
 * A token stands for its reference only while it is intact: exactly the text
 * that was inserted, standing on its own (start or whitespace before it,
 * whitespace, punctuation or the end after). Edit a character and it is plain
 * text again, sent as typed. Text never picked from the list is never touched.
 *
 * ## On send (`markMentions`)
 *
 * Each intact token becomes an Albedo marker (albedoMarkers.ts):
 *
 *     <task-ref session="…" session-id="…" task="…" task-id="…" worktree="…"
 *       transcript="…">@Fix login retry</task-ref>
 *     <file-ref path="src/foo.ts"> @src/foo.ts </file-ref>
 *
 * The task's attributes are what Claude needs to act on it without guessing:
 * `session` is the name `SendMessage` addresses a local session by (Albedo
 * names a session after its task: `--name` on spawn, `/rename` on a rename,
 * #152), `session-id` is the fact behind it, and `worktree` and `transcript`
 * let Claude read the other task's files and history directly when the
 * session is not running. `task-id` is Albedo's, for the transcript's link.
 *
 * Measured on Claude Code 2.1.314 (Haiku, a scratch repo, the message sent as
 * Albedo sends it -- a bracketed paste, then Enter): `@src/foo.ts` is attached
 * (a `file` attachment line follows the prompt) bare, inside a collapsed
 * multi-line paste, and inside `<file-ref …> @src/foo.ts </file-ref>`. It is
 * NOT attached when a character other than whitespace touches it on either
 * side: `<file-ref …>@src/foo.ts</file-ref>` and `> @src/foo.ts</file-ref>`
 * both went unattached. Hence the two spaces. The task's `>@Fix …` touches its
 * tag on purpose: Claude Code does not try to attach a file called `Fix`.
 *
 * ## In the transcript
 *
 * `envelopes.ts` turns each marker back into its label (`@Fix login retry`,
 * `@src/foo.ts`) in the user's text and lists it as a {@link Mention}, which
 * MessageRow draws as a chip. A bare `@path` the person typed (in the box or
 * the terminal) is recognised too (`bareFileMentions`), since Claude Code
 * attached it all the same.
 */

import { BASENAME_TIER, basenameStart, fuzzyMatch, matchPath, normaliseQuery, TopK } from '../../lib/fuzzy';
import { displayName } from '../text';
import { encodeInlineMarker, splitMarkers, INLINE_TAGS, type Marker } from './albedoMarkers';
import type { Project, Task } from '../../types';

// ---------------------------------------------------------------------------
// What a reference is
// ---------------------------------------------------------------------------

export interface TaskMention {
  kind: 'task';
  /** As the transcript and the echo show it: `@` and the title. */
  label: string;
  title: string;
  /** Albedo's task id: what the transcript links to. Null when not known. */
  taskId: number | null;
  /** The session's name, as `SendMessage` addresses it. */
  session: string | null;
  sessionId: string | null;
  worktree: string | null;
  transcript: string | null;
}

export interface FileMention {
  kind: 'file';
  label: string;
  /** Worktree-relative, as the list showed it. A folder ends in `/`. */
  path: string;
}

export type Mention = TaskMention | FileMention;

/** The store beside the draft: token text -> what it stands for. */
export type MentionStore = ReadonlyMap<string, Mention>;

export function isFolder(m: FileMention): boolean {
  return m.path.endsWith('/');
}

// ---------------------------------------------------------------------------
// Tokens in the draft
// ---------------------------------------------------------------------------

/** `@path` as Claude Code reads it; quoted when the path holds whitespace. */
export function atPath(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

/** The token a picked task puts in the draft. `taken`: tokens already standing for another task. */
export function taskToken(title: string, project: string | null, taken: (token: string) => boolean): string {
  const name = oneLineTitle(title).replace(/\]/g, ')');
  const plain = `@[${name}]`;
  if (!taken(plain)) return plain;
  const withProject = project ? `@[${name} · ${project.replace(/\]/g, ')')}]` : plain;
  if (!taken(withProject)) return withProject;
  for (let n = 2; ; n++) {
    const numbered = `@[${name} (${n})]`;
    if (!taken(numbered)) return numbered;
  }
}

function oneLineTitle(title: string): string {
  // eslint-disable-next-line no-control-regex
  return title.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
}

/** Characters that may follow a token and still leave it whole. */
const AFTER_RE = /^(?:$|[\s.,;:!?)\]}'"])/;
/** Characters that may stand before a token. */
const BEFORE_RE = /(?:^|[\s(["'])$/;

/** Where an intact token sits in the draft: `[start, end)`. */
export interface MentionToken {
  token: string;
  mention: Mention;
  start: number;
  end: number;
}

/**
 * Every intact token in the draft, in order, none overlapping. Longer tokens
 * first where two could claim the same text (`@src/a.ts` and `@src/a.tsx`).
 */
export function intactMentions(draft: string, store: MentionStore): MentionToken[] {
  if (store.size === 0 || !draft.includes('@')) return [];
  const found: MentionToken[] = [];
  const tokens = [...store.keys()].sort((a, b) => b.length - a.length);
  const claimed: Array<[number, number]> = [];
  for (const token of tokens) {
    const mention = store.get(token)!;
    for (let at = draft.indexOf(token); at >= 0; at = draft.indexOf(token, at + 1)) {
      const end = at + token.length;
      if (!BEFORE_RE.test(draft.slice(Math.max(0, at - 1), at))) continue;
      if (!AFTER_RE.test(draft.slice(end, end + 1))) continue;
      if (claimed.some(([a, b]) => at < b && end > a)) continue;
      claimed.push([at, end]);
      found.push({ token, mention, start: at, end });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** The references the draft still uses: what a draft keeps. */
export function mentionsIn(draft: string, store: MentionStore): Map<string, Mention> {
  const used = new Map<string, Mention>();
  for (const t of intactMentions(draft, store)) used.set(t.token, t.mention);
  return used;
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

/** The marker a reference is sent as. */
export function encodeMention(m: Mention): string {
  if (m.kind === 'file') return encodeInlineMarker('file-ref', { path: m.path }, ` ${atPath(m.path)} `);
  const attrs: Record<string, string> = {};
  if (m.session) attrs.session = m.session;
  if (m.sessionId) attrs['session-id'] = m.sessionId;
  attrs.task = m.title;
  if (m.taskId !== null) attrs['task-id'] = String(m.taskId);
  if (m.worktree) attrs.worktree = m.worktree;
  if (m.transcript) attrs.transcript = m.transcript;
  // The label never holds the closing tag: a title's angle brackets go.
  return encodeInlineMarker('task-ref', attrs, `@${m.title.replace(/[<>]/g, '')}`);
}

/**
 * What the composer sends, before its pastes go in (`markPastes`): every
 * intact token replaced by its marker. Everything else is left as typed.
 */
export function markMentions(draft: string, store: MentionStore): string {
  const tokens = intactMentions(draft, store);
  if (tokens.length === 0) return draft;
  let out = '';
  let at = 0;
  for (const t of tokens) {
    out += draft.slice(at, t.start) + encodeMention(t.mention);
    at = t.end;
  }
  return out + draft.slice(at);
}

function isInline(m: Marker): boolean {
  return (INLINE_TAGS as readonly string[]).includes(m.tag);
}

/** The reference a marker stands for, or null for any other marker. */
export function mentionOfMarker(m: Marker): Mention | null {
  if (m.tag === 'file-ref') {
    const path = m.attrs.path ?? m.content.trim().replace(/^@"?|"$/g, '');
    if (path === '') return null;
    return { kind: 'file', label: `@${path}`, path };
  }
  if (m.tag === 'task-ref') {
    const title = m.attrs.task ?? m.content.trim().replace(/^@/, '');
    const id = Number(m.attrs['task-id']);
    return {
      kind: 'task',
      label: `@${title}`,
      title,
      taskId: Number.isInteger(id) && id > 0 ? id : null,
      session: m.attrs.session ?? null,
      sessionId: m.attrs['session-id'] ?? null,
      worktree: m.attrs.worktree ?? null,
      transcript: m.attrs.transcript ?? null,
    };
  }
  return null;
}

/**
 * A sent body's references back as tokens and a store: for a message that
 * comes back to the box (a failed send) or is edited in the Queued band.
 * The inverse of `markMentions`. Every other marker is left as it is.
 */
export function unmarkMentions(body: string): { text: string; mentions: Map<string, Mention> } {
  const mentions = new Map<string, Mention>();
  if (!body.includes('-ref')) return { text: body, mentions };
  let text = '';
  for (const p of splitMarkers(body, INLINE_TAGS)) {
    if (p.kind === 'text') {
      text += p.text;
      continue;
    }
    const m = mentionOfMarker(p.marker);
    if (m === null) {
      text += body.slice(p.marker.start, p.marker.end);
      continue;
    }
    let token: string;
    if (m.kind === 'file') token = atPath(m.path);
    else {
      const prior = [...mentions].find(([, v]) => v.kind === 'task' && v.taskId === m.taskId && v.title === m.title);
      token = prior ? prior[0] : taskToken(m.title, null, (t) => mentions.has(t));
    }
    mentions.set(token, m);
    text += token;
  }
  return { text, mentions };
}

/** A reference as one short mention, for the echo and the Queued band. */
export function mentionLabelOf(m: Marker): string | null {
  return isInline(m) ? (mentionOfMarker(m)?.label ?? null) : null;
}

// ---------------------------------------------------------------------------
// The transcript: references in the user's text
// ---------------------------------------------------------------------------

/**
 * The user's text with each reference marker replaced by its label, and the
 * references found. `unescape` applies to the plain text only, never to a
 * marker's attributes (a title with a quote in it stays whole).
 */
export function inlineMentions(raw: string, unescape: (s: string) => string = (s) => s): { text: string; mentions: Mention[] } {
  if (!raw.includes('-ref')) {
    const text = unescape(raw);
    return { text, mentions: bareFileMentions(text) };
  }
  const mentions: Mention[] = [];
  let text = '';
  for (const p of splitMarkers(raw, INLINE_TAGS)) {
    if (p.kind === 'text') {
      text += unescape(p.text);
      continue;
    }
    const m = mentionOfMarker(p.marker);
    if (m === null) text += unescape(raw.slice(p.marker.start, p.marker.end));
    else {
      if (!mentions.some((x) => x.label === m.label)) mentions.push(m);
      text += m.label;
    }
  }
  for (const b of bareFileMentions(text)) if (!mentions.some((x) => x.label === b.label)) mentions.push(b);
  return { text, mentions };
}

/**
 * `@path` as Claude Code takes it: at the start or after whitespace, up to the
 * next whitespace, or quoted. Only what looks like a path -- a `/` in it, or a
 * file extension -- so `@Override` or `@here` in prose stay text. Trailing
 * punctuation (`see @a.ts.`) is not part of the path.
 */
const BARE_RE = /(^|\s)@("[^"\n]+"|[^\s"<>@]+)/g;

export function bareFileMentions(text: string): FileMention[] {
  if (!text.includes('@')) return [];
  const out: FileMention[] = [];
  for (const m of text.matchAll(BARE_RE)) {
    let path = m[2] as string;
    if (path.startsWith('"')) path = path.slice(1, -1);
    else path = path.replace(/[.,;:!?)\]}'"]+$/, '');
    if (path.startsWith('[') || path.includes(':')) continue; // a task token as typed, `@server:resource`
    const looksLikePath = path.includes('/') || /\.[A-Za-z0-9]{1,10}$/.test(path);
    if (!looksLikePath || /^\.+$/.test(path)) continue;
    const label = `@${path}`;
    if (!out.some((x) => x.label === label)) out.push({ kind: 'file', label, path });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The trigger
// ---------------------------------------------------------------------------

/**
 * The `@` the caret is in, with what was typed after it, or null. An `@`
 * counts at the start of the box or after whitespace (not in `a@b.c`); the
 * query runs from it to the caret and holds no whitespace, so a space ends
 * it and the text stays as typed.
 */
export function mentionTrigger(text: string, caret: number): { start: number; query: string } | null {
  if (caret < 1 || caret > text.length) return null;
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  if (at > 0 && !/\s/.test(before[at - 1] ?? '')) return null;
  // Already a picked task's token (`@[Title]`): the list is not for editing it.
  if (query.startsWith('[')) return null;
  return { start: at, query };
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export interface TaskItem {
  kind: 'task';
  key: string;
  task: Task;
  projectName: string | null;
  /** In the same project as the task being written in. */
  sameProject: boolean;
  hits: number[];
  /** Matched on the branch, not the title: after every title match. */
  byBranch: boolean;
  score: number;
}

export interface PathItem {
  kind: 'file' | 'folder';
  key: string;
  /** Worktree-relative; a folder ends in `/`. */
  path: string;
  /** Basename (a folder's with its `/`). */
  name: string;
  nameHits: number[];
  /** The directory it is in, without the trailing `/`. */
  dir: string;
  dirHits: number[];
  score: number;
}

export type MentionItem = TaskItem | PathItem;

/** Rows per section: a short list under the caret, not a second Quick Open. */
export const TASK_LIMIT = 6;
export const PATH_LIMIT = 8;

/**
 * The other open tasks, for a query: not this one, not archived, only those
 * with a session to address. This project's first, then the others; within
 * each, the best match first, or the most recently active with no query.
 */
export function rankTasks(
  tasks: readonly Task[],
  projects: readonly Project[],
  current: { id: number; projectId: number | null },
  rawQuery: string,
  limit = TASK_LIMIT,
): TaskItem[] {
  const q = normaliseQuery(rawQuery);
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const out: TaskItem[] = [];
  for (const task of tasks) {
    if (task.id === current.id || task.status === 'archived' || task.sessionId === null) continue;
    let hits: number[] = [];
    let score = 0;
    let byBranch = false;
    if (q !== '') {
      const title = oneLineTitle(task.title);
      const onTitle = fuzzyMatch(q, title, title.toLowerCase());
      const onBranch = onTitle === null && task.branch ? fuzzyMatch(q, task.branch, task.branch.toLowerCase()) : null;
      if (onTitle === null && onBranch === null) continue;
      // A branch match comes after the title matches; its hits are not on the title.
      hits = onTitle?.indices ?? [];
      score = onTitle?.score ?? onBranch?.score ?? 0;
      byBranch = onTitle === null;
    }
    out.push({
      kind: 'task',
      key: `t:${task.id}`,
      task,
      projectName: task.projectId === null ? null : (names.get(task.projectId) ?? null),
      sameProject: task.projectId === current.projectId,
      hits,
      byBranch,
      score,
    });
  }
  out.sort((a, b) => {
    if (a.sameProject !== b.sameProject) return a.sameProject ? -1 : 1;
    if (a.byBranch !== b.byBranch) return a.byBranch ? 1 : -1;
    if (a.score !== b.score) return b.score - a.score;
    return (b.task.lastActivityAt ?? b.task.createdAt) - (a.task.lastActivityAt ?? a.task.createdAt);
  });
  return out.slice(0, limit);
}

interface PreparedPath {
  path: string;
  lower: string;
  base: number;
  folder: boolean;
}

const preparedPaths = new WeakMap<readonly string[], PreparedPath[]>();

/** Files and the folders they are in, lowercased once per index. */
function preparePaths(files: readonly string[]): PreparedPath[] {
  let p = preparedPaths.get(files);
  if (p) return p;
  const dirs = new Set<string>();
  for (const f of files) {
    for (let i = f.indexOf('/'); i > 0; i = f.indexOf('/', i + 1)) dirs.add(f.slice(0, i));
  }
  p = [
    ...files.map((path) => ({ path, lower: path.toLowerCase(), base: basenameStart(path), folder: false })),
    ...[...dirs].map((path) => ({ path, lower: path.toLowerCase(), base: basenameStart(path), folder: true })),
  ];
  preparedPaths.set(files, p);
  return p;
}

/**
 * Files and folders of the worktree for a query, fuzzy as Go to File ranks
 * them (`matchPath`: a basename hit beats one that needed the directory).
 * Nothing for an empty query: an unranked list of every file helps nobody.
 */
export function rankPaths(files: readonly string[], rawQuery: string, limit = PATH_LIMIT): PathItem[] {
  const q = normaliseQuery(rawQuery.replace(/^"/, ''));
  if (q === '') return [];
  const top = new TopK<PathItem>(limit, (a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  for (const f of preparePaths(files)) {
    const hit = matchPath(q, f.path, f.lower, f.base);
    if (!hit) continue;
    const dir = f.base > 0 ? f.path.slice(0, f.base - 1) : '';
    const nameHits: number[] = [];
    const dirHits: number[] = [];
    for (const i of hit.indices) {
      if (i >= f.base) nameHits.push(i - f.base);
      else if (i < dir.length) dirHits.push(i);
    }
    // A folder is a weaker answer than a file of the same score: one step down.
    const score = f.folder ? hit.score - (hit.score >= BASENAME_TIER ? 1 : 0) - 1 : hit.score;
    top.push({
      kind: f.folder ? 'folder' : 'file',
      key: `${f.folder ? 'd' : 'f'}:${f.path}`,
      path: f.folder ? `${f.path}/` : f.path,
      name: f.folder ? `${f.path.slice(f.base)}/` : f.path.slice(f.base),
      nameHits,
      dir,
      dirHits,
      score,
    });
  }
  return top.items;
}

// ---------------------------------------------------------------------------
// From a task to its reference
// ---------------------------------------------------------------------------

/**
 * Where Claude Code keeps a session's transcript: `~/.claude/projects/` and
 * the folder it ran in with every character other than a letter or digit as
 * `-` (as measured: `/private/tmp/a_b.c` -> `-private-tmp-a-b-c`). Claude
 * Code shortens a name past 200 characters with a hash Albedo does not
 * reproduce, so a folder that long gets no path rather than a wrong one.
 */
export function transcriptPathFor(worktree: string, sessionId: string): string | null {
  const dir = worktree.replace(/\/+$/, '').replace(/[^A-Za-z0-9]/g, '-');
  if (dir.length === 0 || dir.length > 200) return null;
  return `~/.claude/projects/${dir}/${sessionId}.jsonl`;
}

export function taskMention(task: Task): TaskMention {
  const title = oneLineTitle(task.title);
  return {
    kind: 'task',
    label: `@${title}`,
    title,
    taskId: task.id,
    // The name Albedo gave the session (App `sessionNameFor`, taskRename.ts).
    session: displayName(title),
    sessionId: task.sessionId,
    worktree: task.worktreePath || null,
    transcript: task.sessionId && task.worktreePath ? transcriptPathFor(task.worktreePath, task.sessionId) : null,
  };
}

export function fileMention(path: string): FileMention {
  return { kind: 'file', label: `@${path}`, path };
}
