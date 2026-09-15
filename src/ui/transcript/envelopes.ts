/**
 * User-row envelopes.
 *
 * ## FORMAT KNOWLEDGE -- read this before changing anything here
 *
 * Claude Code injects machine-generated blocks into `user` turns: subagent
 * completions, slash-command invocations, injected context, local command
 * output. They arrive as XML-ish text inside the message body, so the adapter
 * cannot lift them out -- by the time a row exists they are just `body` text.
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
 * broken chip.
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
  /** Injected context. Not something the user typed. */
  | { kind: 'system-reminder'; text: string }
  /** Output of a local command, and similar side-channel text. */
  | { kind: 'output'; tag: string; text: string };

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
] as const;

const ENVELOPE_RE = new RegExp(`<(${KNOWN_TAGS.join('|')})>([\\s\\S]*?)</\\1>`, 'g');

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

function pushText(out: UserBlock[], raw: string): void {
  const text = raw.replace(/^\n+/, '').replace(/\s+$/, '');
  if (text.length === 0) return;
  out.push({ kind: 'text', text });
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
 * Split a user row's body into renderable blocks.
 *
 * Always returns at least one block for non-empty input, and never throws: a
 * body it does not understand comes back as a single `text` block, which is
 * exactly what the pane rendered before this existed.
 */
export function parseUserBody(body: string): UserBlock[] {
  if (typeof body !== 'string' || body.length === 0) return [];
  try {
    const out: UserBlock[] = [];
    let last = 0;
    ENVELOPE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = ENVELOPE_RE.exec(body)) !== null) {
      const tag = m[1] ?? '';
      const inner = m[2] ?? '';
      if (m.index > last) pushText(out, body.slice(last, m.index));
      last = m.index + m[0].length;

      switch (tag) {
        case 'task-notification':
          out.push(parseNotification(inner));
          break;
        case 'system-reminder':
          out.push({ kind: 'system-reminder', text: unescapeXml(inner.trim()) });
          break;
        case 'command-name':
          out.push({ kind: 'command', name: unescapeXml(inner.trim()), args: null, message: null });
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
    if (out.length === 0) pushText(out, body);
    return coalesceCommands(out);
  } catch {
    return [{ kind: 'text', text: body }];
  }
}

/** True when the row is nothing but machine-generated envelopes. */
export function isAllEnvelopes(blocks: readonly UserBlock[]): boolean {
  return blocks.length > 0 && blocks.every((b) => b.kind !== 'text');
}
