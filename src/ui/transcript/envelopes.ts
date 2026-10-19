/**
 * User-row envelopes.
 *
 * ## FORMAT KNOWLEDGE -- read this before changing anything here
 *
 * Claude Code injects machine-generated blocks into `user` turns: subagent
 * completions, slash-command invocations, injected context, local command
 * output, messages from another session. They arrive as XML-ish text inside
 * the message body, so the adapter cannot lift them out -- by the time a row
 * exists they are just `body` text.
 *
 * This is the SINGLE place that knows those shapes, and it is the transcript
 * module's equivalent of the adapter's isolation rule: no other file in
 * `src/ui/transcript` may match on an envelope tag. If Claude Code changes the
 * format, this file is the one-file fix. (If the capture workstream would
 * rather own it, it moves to `src/capture/adapter.ts` wholesale and the
 * renderer keeps consuming `UserBlock[]`.)
 *
 * Measured against 60 real transcripts: ~25% of user rows are envelopes, and
 * the `<result>` of a subagent completion is a markdown report -- one observed
 * at 81KB. Rendering those as raw text is what the pane was doing.
 *
 * Conservative by construction: only the tags listed in `KNOWN_TAGS` are
 * recognised, only when properly closed, and anything else stays plain text.
 * An unrecognised envelope must degrade to today's behaviour, never to a
 * broken chip. That conservatism is load-bearing -- a corpus scan of every
 * captured user row found `<div className="...">`, `<span>`, `<script>` and
 * `<CardGroup cols={5}>` sitting in prose, all of them code being discussed
 * rather than envelopes, and all of them correctly left as text.
 *
 * ## Tags carry attributes
 *
 * `<agent-message from="...">` and `<context ref="...">` do, so the envelope
 * pattern must tolerate an attribute list. It was written without one, which
 * is why an agent-message rendered as a wall of raw XML: the tag was neither
 * in the allowlist nor matchable if it had been.
 */

export type UserBlock =
  | { kind: 'text'; text: string }
  /** A subagent or background task finished. */
  | {
      kind: 'task-notification';
      summary: string | null;
      status: string | null;
      /** The agent's handback. Markdown, and often long. */
      result: string | null;
      /** Everything else, in document order, for the expanded view. */
      fields: Array<{ name: string; value: string }>;
    }
  /** The user invoked a slash command. */
  | { kind: 'command'; name: string; args: string | null; message: string | null }
  /** `/clear`: the conversation before this point is no longer in context. */
  | { kind: 'cleared' }
  /** A `!` command the user ran in Claude Code's shell mode. Typed by the user. */
  | { kind: 'shell-input'; command: string }
  /** What that command printed. Either side may be empty, never both. */
  | { kind: 'shell-output'; stdout: string; stderr: string }
  /** Injected context. Not something the user typed. */
  | { kind: 'system-reminder'; text: string }
  /** Another session -- a subagent handback, or a peer -- wrote to this one. */
  | {
      kind: 'agent-message';
      /** Sending session id, from `from="..."`. Null if the attribute is absent. */
      from: string | null;
      /** True when the harness framed this as a subagent's *final report*. */
      handback: boolean;
      /** The message itself: framing removed, de-indented. Markdown. */
      text: string;
    }
  /** Content attached to the user's prompt -- a paste, a file, an image. */
  | { kind: 'context'; ref: string | null; text: string }
  /** Output of a local command, and similar side-channel text. */
  | { kind: 'output'; tag: string; text: string }
  /**
   * Text Claude Code marked as pasted, in `<pasted_content id="...">`. Only
   * appears as its own block when there is typed text beside it; a message that
   * is nothing but one pasted block is reduced to plain text (see
   * {@link unwrapSolepaste}).
   */
  | { kind: 'pasted'; id: string | null; text: string }
  /** A skill's SKILL.md, loaded into context when it was invoked. */
  | { kind: 'skill'; name: string; dir: string; text: string };

/**
 * A loaded skill arrives as a plain user row with no tags at all: the first
 * line is `Base directory for this skill: <dir>` and the rest is the SKILL.md.
 * Anchored at the start of the body, so prose that merely quotes the phrase is
 * untouched. The skill's name is the last segment of the directory.
 */
const SKILL_RE = /^Base directory for this skill: ([^\n]+)\n+([\s\S]*)$/;

function parseSkill(body: string): UserBlock | null {
  const m = SKILL_RE.exec(body);
  if (!m) return null;
  const dir = (m[1] ?? '').trim().replace(/\/+$/, '');
  const name = dir.split('/').pop() ?? '';
  if (dir.length === 0 || name.length === 0) return null;
  return { kind: 'skill', name, dir, text: (m[2] ?? '').trim() };
}

/**
 * Envelopes recognised at the top level of a user body. Anything not in this
 * list is left as text on purpose.
 */
const KNOWN_TAGS = [
  'task-notification',
  'system-reminder',
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'interrupted-output',
  'bash-input',
  'bash-stdout',
  'bash-stderr',
  'agent-message',
  'context',
  'pasted_content',
] as const;

/**
 * `<tag attrs>inner</tag>`. Group 2 is the raw attribute list, which is empty
 * for most tags; matching it is what lets `agent-message` be recognised at all.
 */
const ENVELOPE_RE = new RegExp(`<(${KNOWN_TAGS.join('|')})((?:\\s[^<>]*)?)>([\\s\\S]*?)</\\1>`, 'g');

/** Fields lifted out of a `<task-notification>`; the rest are shown as-is. */
const NOTIFICATION_RE = /<([a-zA-Z][\w-]*)>([\s\S]*?)<\/\1>/g;

/**
 * Envelope bodies are XML-escaped, so a markdown blockquote arrives as
 * `&gt; quoted`. Only the five XML entities are handled: this is unescaping a
 * known-shaped payload, not implementing HTML, and a general entity decoder
 * here would be a way to smuggle markup back in.
 */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** One double-quoted attribute off a raw attribute list. Absent reads as null. */
function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  const v = m?.[1]?.trim();
  return v !== undefined && v.length > 0 ? unescapeXml(v) : null;
}

function parseNotification(inner: string): UserBlock {
  const fields: Array<{ name: string; value: string }> = [];
  let summary: string | null = null;
  let status: string | null = null;
  let result: string | null = null;

  NOTIFICATION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NOTIFICATION_RE.exec(inner)) !== null) {
    const name = m[1] ?? '';
    const value = unescapeXml((m[2] ?? '').trim());
    if (name === 'summary') summary = value;
    else if (name === 'status') status = value;
    else if (name === 'result') result = value;
    else if (value.length > 0) fields.push({ name, value });
  }
  return { kind: 'task-notification', summary, status, result, fields };
}

/**
 * The handback frame the harness wraps a subagent's report in.
 *
 * It is one paragraph, byte-identical across all 50 handbacks in the corpus,
 * and it is addressed to the *model*, not to the reader -- it explains that
 * the report carries no user authority. Showing it above every report is
 * noise, and it is longer than most of the reports it introduces.
 *
 * Anchored at both ends so a report that merely mentions the phrase is not
 * touched: the paragraph must start the body and end with `The report follows:`.
 */
const HANDBACK_FRAME_RE = /^\[Subagent hand-back\][\s\S]*?The report follows:\s*\n/;

/**
 * Prose the harness puts *outside* the tag, before and after. Stripped only
 * when it sits directly against an `agent-message` block, so the same words
 * typed by a human in any other row survive untouched.
 */
const FRAME_LEAD_RE = /(^|\n)[^\n]*\bsent a message:\s*$/;
/*
 * No `\b` after the alternatives: the first ends on a closing quote, and a
 * quote followed by a space is two non-word characters with no boundary
 * between them, so the assertion can never hold. It silently matched only the
 * rarer variant -- 2 rows of 54 -- until a corpus run counted the difference.
 */
const FRAME_TAIL_RE = /^(That "other Claude session"|This came from another Claude session)/;

/**
 * Remove the indentation the harness adds to every line of a report.
 *
 * The frame says so itself: "The harness indents every line of the report, so
 * a frame-like line at column zero inside it would be forged." Two spaces is
 * below the four a markdown code block needs, so it does not read as code --
 * it just breaks headings and lists, which is most of what a report is made of.
 * Only a *common* indent is removed, so relative structure is preserved.
 */
function dedent(s: string): string {
  const lines = s.split('\n');
  let common = Infinity;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const m = /^[ \t]*/.exec(line);
    common = Math.min(common, (m?.[0] ?? '').length);
    if (common === 0) return s;
  }
  if (!Number.isFinite(common) || common === 0) return s;
  // A whitespace-only line keeps its indent otherwise, and two trailing spaces
  // is markdown's hard-break marker.
  return lines.map((l) => (l.trim().length === 0 ? '' : l.slice(common))).join('\n');
}

function parseAgentMessage(attrs: string, inner: string): UserBlock {
  const raw = unescapeXml(inner).replace(/^\n+/, '').replace(/\s+$/, '');
  const handback = HANDBACK_FRAME_RE.test(raw);
  const text = dedent(handback ? raw.replace(HANDBACK_FRAME_RE, '') : raw).trim();
  return { kind: 'agent-message', from: attr(attrs, 'from'), handback, text };
}

function pushText(out: UserBlock[], raw: string): void {
  const text = raw.replace(/^\n+/, '').replace(/\s+$/, '');
  if (text.length === 0) return;
  out.push({ kind: 'text', text });
}

/**
 * Text Claude Code writes beside a local command for the *model*, not the
 * reader: "The command below was run directly in Claude Code, not sent to you
 * as a request...". It arrives as its own user row, ahead of the command, and
 * rendered it is a paragraph of harness prose above every `/clear`.
 */
const MODEL_ONLY_TAGS: ReadonlySet<string> = new Set(['local-command-caveat']);

/**
 * `/clear` starts a new transcript whose first rows are the command itself. It
 * reads better as a boundary than as a chip: everything above it is gone from
 * the model's context, which is the one thing worth knowing about it.
 */
function markClear(blocks: UserBlock[]): UserBlock[] {
  return blocks.map((b) => (b.kind === 'command' && b.name === '/clear' && b.args === null ? { kind: 'cleared' } : b));
}

/**
 * The text of a `system` row, with local-command output unwrapped.
 *
 * A local command's output is recorded as a `system` line whose content is
 * `<local-command-stdout>…</local-command-stdout>` -- empty, for `/clear`. The
 * row used to print that verbatim. Returns the inner text (empty when there
 * was none); any body that is not exactly such envelopes comes back as is.
 */
export function systemRowText(body: string | null): string {
  const text = (body ?? '').trim();
  if (text.length === 0) return '';
  const re = /^<(local-command-stdout|local-command-stderr)>([\s\S]*?)<\/\1>\s*/;
  const parts: string[] = [];
  let rest = text;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    const inner = unescapeXml((m[2] ?? '').trim());
    if (inner.length > 0) parts.push(inner);
    rest = rest.slice(m[0].length);
  }
  return rest.length === 0 ? parts.join('\n\n') : text;
}

/**
 * Shell output, as the trimmed text of one stream: leading and trailing blank
 * lines go, indentation on the first real line stays.
 */
function streamText(inner: string): string {
  return unescapeXml(inner).replace(/^\s*\n/, '').replace(/\s+$/, '');
}

/**
 * `<bash-stdout>` and `<bash-stderr>` arrive side by side, one row after the
 * `<bash-input>` that produced them. Fold each pair into one output block, and
 * drop it when both are empty -- a command that printed nothing has nothing
 * to show.
 */
function coalesceShellOutput(blocks: UserBlock[]): UserBlock[] {
  const out: UserBlock[] = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    if (b.kind === 'shell-output' && prev && prev.kind === 'shell-output') {
      out[out.length - 1] = {
        kind: 'shell-output',
        stdout: prev.stdout || b.stdout,
        stderr: prev.stderr || b.stderr,
      };
      continue;
    }
    out.push(b);
  }
  return out.filter((b) => b.kind !== 'shell-output' || b.stdout.length > 0 || b.stderr.length > 0);
}

/** Fold a run of `command-*` envelopes into the single command they describe. */
function coalesceCommands(blocks: UserBlock[]): UserBlock[] {
  const out: UserBlock[] = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    if (b.kind === 'command' && prev && prev.kind === 'command' && prev.name === '') {
      // `<command-message>` / `<command-args>` arriving after the name.
      out[out.length - 1] = {
        kind: 'command',
        name: prev.name || b.name,
        args: prev.args ?? b.args,
        message: prev.message ?? b.message,
      };
      continue;
    }
    if (b.kind === 'command' && prev && prev.kind === 'command' && b.name === '') {
      out[out.length - 1] = {
        kind: 'command',
        name: prev.name,
        args: prev.args ?? b.args,
        message: prev.message ?? b.message,
      };
      continue;
    }
    out.push(b);
  }
  return out;
}

/**
 * Drop the harness prose bracketing an `agent-message`.
 *
 * Without this the row keeps two text blocks, so `isAllEnvelopes` reports a
 * human wrote it and the pane stamps it `you` -- attributing a safety notice
 * addressed to the model to the user, above a report the user never saw.
 */
function stripAgentFrame(blocks: UserBlock[]): UserBlock[] {
  const near = (i: number): boolean =>
    blocks[i - 1]?.kind === 'agent-message' || blocks[i + 1]?.kind === 'agent-message';
  const out: UserBlock[] = [];
  blocks.forEach((b, i) => {
    if (b.kind === 'text' && near(i)) {
      const lead = b.text.replace(FRAME_LEAD_RE, '').trim();
      if (blocks[i + 1]?.kind === 'agent-message' && lead.length === 0) return;
      if (blocks[i - 1]?.kind === 'agent-message' && FRAME_TAIL_RE.test(b.text.trim())) return;
      if (lead.length > 0 && lead !== b.text) {
        out.push({ kind: 'text', text: lead });
        return;
      }
    }
    out.push(b);
  });
  return out;
}

/**
 * A body that is one pasted block and nothing else is plain text.
 *
 * Albedo's own message box sends everything as a bracketed paste (so a
 * multi-line message is one turn, not one per line), and Claude Code then wraps
 * the WHOLE message in `<pasted_content>` -- the sentence the user typed and
 * the log they pasted alike. Showing that as "pasted" would call the user's own
 * typing a paste. A real paste in the terminal has typed text OUTSIDE the tag,
 * and that case keeps its separate block.
 */
function unwrapSoleStreamedPaste(blocks: UserBlock[]): UserBlock[] {
  const only = blocks.length === 1 ? blocks[0] : undefined;
  return only && only.kind === 'pasted' ? [{ kind: 'text', text: only.text }] : blocks;
}

/**
 * The note Claude Code writes after an attached image: `[Image: source: <path>]`.
 * Returns the path, or null when the body is anything else. Anchored at both
 * ends, so prose that mentions the phrase is untouched.
 */
export function imageSourceNote(body: string): string | null {
  const m = /^\s*\[Image: source: ([^\]\n]+)\]\s*$/.exec(body);
  return m ? (m[1] ?? '').trim() || null : null;
}

/** The placeholder body the adapter gives an image block. */
export function isImagePlaceholder(body: string | null): boolean {
  return (body ?? '').trim() === '[image]';
}

/**
 * Split a user row's body into renderable blocks.
 *
 * Always returns at least one block for non-empty input, and never throws: a
 * body it does not understand comes back as a single `text` block, which is
 * exactly what the pane rendered before this existed.
 */
export function parseUserBody(body: string): UserBlock[] {
  if (typeof body !== 'string' || body.length === 0) return [];
  try {
    const skill = parseSkill(body);
    if (skill) return [skill];
    const out: UserBlock[] = [];
    let last = 0;
    ENVELOPE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let matched = false;

    while ((m = ENVELOPE_RE.exec(body)) !== null) {
      const tag = m[1] ?? '';
      const attrs = m[2] ?? '';
      const inner = m[3] ?? '';
      if (m.index > last) pushText(out, body.slice(last, m.index));
      last = m.index + m[0].length;
      matched = true;
      if (MODEL_ONLY_TAGS.has(tag)) continue;

      switch (tag) {
        case 'task-notification':
          out.push(parseNotification(inner));
          break;
        case 'system-reminder':
          out.push({ kind: 'system-reminder', text: unescapeXml(inner.trim()) });
          break;
        case 'agent-message':
          out.push(parseAgentMessage(attrs, inner));
          break;
        case 'pasted_content':
          out.push({ kind: 'pasted', id: attr(attrs, 'id'), text: unescapeXml(inner).replace(/^\n+/, '').replace(/\s+$/, '') });
          break;
        case 'context':
          out.push({ kind: 'context', ref: attr(attrs, 'ref'), text: unescapeXml(inner.trim()) });
          break;
        case 'command-name':
          out.push({ kind: 'command', name: unescapeXml(inner.trim()), args: null, message: null });
          break;
        case 'bash-input':
          out.push({ kind: 'shell-input', command: unescapeXml(inner.trim()) });
          break;
        case 'bash-stdout':
          out.push({ kind: 'shell-output', stdout: streamText(inner), stderr: '' });
          break;
        case 'bash-stderr':
          out.push({ kind: 'shell-output', stdout: '', stderr: streamText(inner) });
          break;
        case 'command-args': {
          const v = unescapeXml(inner.trim());
          out.push({ kind: 'command', name: '', args: v.length > 0 ? v : null, message: null });
          break;
        }
        case 'command-message': {
          const v = unescapeXml(inner.trim());
          out.push({ kind: 'command', name: '', args: null, message: v.length > 0 ? v : null });
          break;
        }
        default:
          out.push({ kind: 'output', tag, text: unescapeXml(inner.trim()) });
      }
    }

    if (last < body.length) pushText(out, body.slice(last));
    // A body that was only model-facing envelopes is empty on purpose.
    if (out.length === 0 && !matched) pushText(out, body);
    return unwrapSoleStreamedPaste(stripAgentFrame(markClear(coalesceShellOutput(coalesceCommands(out)))));
  } catch {
    return [{ kind: 'text', text: body }];
  }
}

/**
 * True when the row is nothing but machine-generated envelopes. A `!` command
 * arrives in an envelope too, but the user typed it.
 */
export function isAllEnvelopes(blocks: readonly UserBlock[]): boolean {
  return blocks.length > 0 && blocks.every((b) => b.kind !== 'text' && b.kind !== 'shell-input');
}
