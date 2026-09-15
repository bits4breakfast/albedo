/**
 * How each tool's input should be *read*.
 *
 * ## FORMAT KNOWLEDGE -- read this before changing anything here
 *
 * This is the single place that knows the shape of a tool's `input` object.
 * Same isolation rule as `envelopes.ts`: no other file in `src/ui/transcript`
 * may reach into a tool input by key name. A new tool is one entry in the table
 * below, and an unknown tool falls back to pretty-printed JSON, which is a
 * perfectly good default when the shape is unknown.
 *
 * ## Why this exists
 *
 * The chip used to dump every input as pretty-printed JSON, which turned the
 * most common tool call in any session -- a Bash command -- into an escaped,
 * brace-wrapped, soft-wrapped single line. That is the same "reading things in
 * flat terminal output is tiring" failure the app exists to fix, reproduced
 * inside the pane meant to fix it.
 *
 * Rendering is a readability choice, so it is never the only choice: the chip
 * keeps a "raw" toggle and the original JSON is always one click away.
 */

import { langForPath } from '../../lib/diff';

/** Below this, a one-line command is easier to read unbroken. */
const SHELL_WRAP_MIN = 88;

/**
 * Put a long `&&` chain onto separate lines.
 *
 * Every break goes *after* a `&&`, `||` or `;`, which are all valid shell line
 * continuations -- so the displayed command stays runnable and means exactly
 * what the original meant. Copy-paste fidelity is the constraint that picks
 * those three: breaking elsewhere would produce something that reads fine and
 * runs differently.
 *
 * Left alone when the command already has newlines (a heredoc or a script the
 * author formatted themselves -- their structure beats ours) or when it is
 * short enough to read as one line. Bare `|` is deliberately not a break point:
 * pipelines read well inline and splitting them fragments more than it helps.
 *
 * Quote-aware, because `echo "a && b"` contains no operator at all.
 */
export function formatShellCommand(command: string): string {
  if (typeof command !== 'string' || command.length === 0) return '';
  if (command.includes('\n')) return command;
  if (command.length <= SHELL_WRAP_MIN) return command;

  let out = '';
  let quote: string | null = null;
  let i = 0;

  while (i < command.length) {
    const c = command[i] ?? '';

    if (quote !== null) {
      out += c;
      if (c === '\\' && quote === '"' && i + 1 < command.length) {
        out += command[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }

    if (c === '\\' && i + 1 < command.length) {
      out += c + (command[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += c;
      i++;
      continue;
    }

    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      out += `${two}\n`;
      i += 2;
      while (command[i] === ' ') i++;
      continue;
    }
    if (c === ';') {
      // `;;` is a case-statement terminator, not two separators: consume it
      // whole, or the second `;` reads as a break point.
      if (command[i + 1] === ';') {
        out += ';;';
        i += 2;
        continue;
      }
      out += ';\n';
      i++;
      while (command[i] === ' ') i++;
      continue;
    }

    out += c;
    i++;
  }

  return out.replace(/\s+$/, '');
}

// ---------------------------------------------------------------------------
// Input views
// ---------------------------------------------------------------------------

export interface InputField {
  label: string;
  value: string;
  /** Render as a clickable path. */
  path?: boolean;
}

export type InputView =
  /** A shell command, highlighted as shell. */
  | { kind: 'shell'; command: string; description: string | null; fields: InputField[] }
  /** A short label/value list, in the shape a person would type it. */
  | { kind: 'fields'; fields: InputField[] }
  /** A file being written: path plus content in the file's own grammar. */
  | { kind: 'file'; path: string; content: string; lang: string; fields: InputField[] }
  /** A question put to the user, with the options they chose between. */
  | { kind: 'questions'; questions: QuestionView[] }
  /** Unknown shape: pretty-printed JSON, the honest fallback. */
  | { kind: 'json' };

export interface QuestionOption {
  label: string;
  description: string | null;
  /** A mockup, snippet or diff shown beside the option. */
  preview: string | null;
}

export interface QuestionView {
  /** Short chip label, e.g. "Auth method". */
  header: string | null;
  question: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

type Obj = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function field(label: string, value: string | null, path = false): InputField[] {
  return value === null ? [] : [{ label, value, ...(path ? { path: true } : {}) }];
}

/** Line range in the shape a person says it: "120–160", "from 120", "first 40". */
function readRange(input: Obj): string | null {
  const offset = num(input.offset);
  const limit = num(input.limit);
  if (offset !== null && limit !== null) return `${offset}–${offset + limit}`;
  if (offset !== null) return `from ${offset}`;
  if (limit !== null) return `first ${limit}`;
  return null;
}

/**
 * The table. Short on purpose: the win is concentrated in Bash, and a table is
 * obvious to extend when a new tool shows up.
 *
 * Edit / MultiEdit / NotebookEdit are absent deliberately -- they already
 * render as a diff directly beneath the chip, which is the better view.
 */
export function inputViewFor(toolName: string | null, input: Obj): InputView {
  switch (toolName) {
    case 'Bash': {
      const command = str(input.command);
      if (command === null) return { kind: 'json' };
      return {
        kind: 'shell',
        command: formatShellCommand(command),
        description: str(input.description),
        fields: [
          ...field('timeout', num(input.timeout) === null ? null : `${num(input.timeout)} ms`),
          ...field('background', input.run_in_background === true ? 'yes' : null),
        ],
      };
    }

    case 'Read': {
      const path = str(input.file_path) ?? str(input.notebook_path);
      if (path === null) return { kind: 'json' };
      return { kind: 'fields', fields: [...field('file', path, true), ...field('lines', readRange(input))] };
    }

    case 'Grep': {
      const pattern = str(input.pattern);
      if (pattern === null) return { kind: 'json' };
      return {
        kind: 'fields',
        fields: [
          { label: 'pattern', value: pattern },
          ...field('in', str(input.path), true),
          ...field('files', str(input.glob) ?? str(input.type)),
          ...field('mode', str(input.output_mode)),
          ...field('ignore case', input['-i'] === true ? 'yes' : null),
        ],
      };
    }

    case 'Glob': {
      const pattern = str(input.pattern);
      if (pattern === null) return { kind: 'json' };
      return { kind: 'fields', fields: [{ label: 'pattern', value: pattern }, ...field('in', str(input.path), true)] };
    }

    case 'Write': {
      const path = str(input.file_path);
      const content = typeof input.content === 'string' ? input.content : null;
      if (path === null || content === null) return { kind: 'json' };
      return { kind: 'file', path, content, lang: langForPath(path), fields: [] };
    }

    /*
     * A question put to the user. 320 calls in the corpus, and the one tool
     * whose *result* is the point: the input is what was asked, the answer
     * lives in the paired `tool_result` and is what a reader is looking for.
     * `parseQuestionAnswers` pairs them back up.
     */
    case 'AskUserQuestion': {
      const questions = asQuestions(input.questions);
      if (questions.length === 0) return { kind: 'json' };
      return { kind: 'questions', questions };
    }

    default:
      return { kind: 'json' };
  }
}

function asQuestions(raw: unknown): QuestionView[] {
  if (!Array.isArray(raw)) return [];
  const out: QuestionView[] = [];
  for (const q of raw) {
    if (typeof q !== 'object' || q === null) continue;
    const o = q as Obj;
    const question = str(o.question);
    if (question === null) continue;
    const options: QuestionOption[] = [];
    if (Array.isArray(o.options)) {
      for (const op of o.options) {
        if (typeof op !== 'object' || op === null) continue;
        const oo = op as Obj;
        const label = str(oo.label);
        if (label === null) continue;
        options.push({ label, description: str(oo.description), preview: str(oo.preview) });
      }
    }
    out.push({ header: str(o.header), question, multiSelect: o.multiSelect === true, options });
  }
  return out;
}

/**
 * The answers, read back out of the `tool_result`.
 *
 * The result is prose, not JSON -- `Your questions have been answered:
 * "<question>"="<answer>", "<question>"="<answer>". You can now continue...`
 * -- optionally followed by ` selected preview:` and the chosen option's
 * preview text, which is ignored here because the option carries its own.
 *
 * Quote-delimited, so an answer containing a comma ("Commission only, via
 * CommissionCalculatorService") survives; splitting on the comma would not.
 * Keyed by question text, which is what links an answer back to its question
 * when one call asked several.
 */
const ANSWER_RE = /"([^"]*)"="([^"]*)"/g;

export function parseQuestionAnswers(resultText: string): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof resultText !== 'string' || !resultText.includes('="')) return out;
  ANSWER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANSWER_RE.exec(resultText)) !== null) {
    const q = m[1] ?? '';
    const a = m[2] ?? '';
    if (q.length > 0 && a.length > 0) out.set(q, a);
  }
  return out;
}
