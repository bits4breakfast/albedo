/**
 * One transcript row, rendered according to its `role`.
 *
 * Markdown in assistant text is rendered by a small hand-written subset
 * (paragraphs, fenced code, inline code, lists, quotes, emphasis, links as
 * plain text) that builds React nodes. There is no markdown dependency and no
 * `dangerouslySetInnerHTML` anywhere in this module, on purpose: model output
 * is untrusted content, and injecting it as HTML is the one security mistake
 * available here. Links are rendered as text rather than anchors for the same
 * reason -- a transcript is for reading, not for navigating somewhere a model
 * chose.
 */

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { FileDiff, Message } from '../../types';
import { diffStrings, langForPath, parseUnifiedDiff } from '../../lib/diff';
import Diff, { Code, composePieces, useCodeTokens } from './Diff';
import ToolChip, { isObj, str, targetOf, toolInput, toolResultText } from './ToolChip';

const DIFF_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export interface MessageRowProps {
  message: Message;
  /** The paired `tool_result` row for a `tool_use`, when it has arrived. */
  result?: Message | null;
}

export function MessageRow({ message, result = null }: MessageRowProps): ReactNode {
  switch (message.role) {
    case 'user':
      return <UserRow message={message} />;
    case 'assistant':
      return message.toolName === 'thinking' ? <ThinkingRow message={message} /> : <AssistantRow message={message} />;
    case 'system':
      return <SystemRow message={message} />;
    case 'tool_use':
      return <ToolUseRow message={message} result={result} />;
    case 'tool_result':
      // Normally consumed by its tool_use row; an orphan still deserves display.
      return <OrphanResultRow message={message} />;
    default:
      return null;
  }
}

export default MessageRow;

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

function UserRow({ message }: { message: Message }): ReactNode {
  const text = message.body ?? '';
  return (
    <div className="tx-row tx-row-user">
      <div className="tx-gutter">you</div>
      <div className="tx-content">
        <div className="tx-user-text">{text}</div>
      </div>
    </div>
  );
}

function AssistantRow({ message }: { message: Message }): ReactNode {
  return (
    <div className="tx-row tx-row-assistant">
      <div className="tx-gutter" />
      <div className="tx-content">
        <Markdown text={message.body ?? ''} />
      </div>
    </div>
  );
}

function ThinkingRow({ message }: { message: Message }): ReactNode {
  const [open, setOpen] = useState(false);
  const text = message.body ?? '';
  const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
  return (
    <div className="tx-row tx-row-thinking">
      <div className="tx-gutter" />
      <div className="tx-content">
        <button type="button" className="tx-think-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? '▾' : '▸'} thinking{words > 0 ? ` · ${words} words` : ''}
        </button>
        {open ? <div className="tx-think-body">{text}</div> : null}
      </div>
    </div>
  );
}

function SystemRow({ message }: { message: Message }): ReactNode {
  const text = (message.body ?? '').trim();
  if (text.length === 0) return null;
  return (
    <div className="tx-row tx-row-system">
      <div className="tx-gutter">sys</div>
      <div className="tx-content">
        <div className="tx-system-text">{text}</div>
      </div>
    </div>
  );
}

function OrphanResultRow({ message }: { message: Message }): ReactNode {
  const text = toolResultText(message);
  if (text.trim().length === 0) return null;
  return (
    <div className="tx-row tx-row-tool">
      <div className="tx-gutter" />
      <div className="tx-content">
        <pre className="tx-pre">{text}</pre>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

function ToolUseRow({ message, result }: { message: Message; result: Message | null }): ReactNode {
  const rendered = useDiffsFor(message, result);

  if (rendered && rendered.diffs.length > 0) {
    return (
      <div className="tx-row tx-row-tool">
        <div className="tx-gutter" />
        <div className="tx-content">
          <ToolChip message={message} result={result} />
          {rendered.diffs.map((d, i) => (
            <Diff key={i} diff={d} expand={rendered.expand[i] ?? null} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="tx-row tx-row-tool">
      <div className="tx-gutter" />
      <div className="tx-content">
        <ToolChip message={message} result={result} />
      </div>
    </div>
  );
}

interface RenderedDiffs {
  diffs: FileDiff[];
  expand: Array<{ oldText: string; newText: string } | null>;
}

/** Decide whether this tool call is a diff, and build it if so. */
function useDiffsFor(message: Message, result: Message | null): RenderedDiffs | null {
  const resultText = result ? toolResultText(result) : '';
  return useMemo(() => {
    const tool = message.toolName ?? '';
    const input = toolInput(message);

    if (DIFF_TOOLS.has(tool)) {
      const path = targetOf(message) ?? 'file';
      const diffs: FileDiff[] = [];
      const expand: Array<{ oldText: string; newText: string } | null> = [];

      if (tool === 'Write') {
        const content = str(input.content);
        if (content === null) return null;
        diffs.push(diffStrings('', content, path));
        expand.push({ oldText: '', newText: content });
      } else if (tool === 'MultiEdit') {
        const edits = Array.isArray(input.edits) ? input.edits : [];
        for (const edit of edits) {
          if (!isObj(edit)) continue;
          const oldText = str(edit.old_string);
          const newText = str(edit.new_string);
          if (oldText === null || newText === null) continue;
          diffs.push(diffStrings(oldText, newText, path));
          expand.push({ oldText, newText });
        }
      } else {
        const oldText = str(input.old_string) ?? str(input.old_source);
        const newText = str(input.new_string) ?? str(input.new_source);
        if (oldText === null || newText === null) return null;
        diffs.push(diffStrings(oldText, newText, path));
        expand.push({ oldText, newText });
      }
      return diffs.length > 0 ? { diffs, expand } : null;
    }

    if (tool === 'Bash') {
      const command = str(input.command) ?? '';
      if (!/\bgit\s+(-[^\s]+\s+)*diff\b/.test(command)) return null;
      if (resultText.length === 0) return null;
      const diffs = parseUnifiedDiff(resultText);
      if (diffs.length === 0) return null;
      return { diffs, expand: diffs.map(() => null) };
    }

    return null;
  }, [message, resultText]);
}

// ---------------------------------------------------------------------------
// Markdown subset
// ---------------------------------------------------------------------------

type Block =
  | { t: 'p'; text: string }
  | { t: 'h'; level: number; text: string }
  | { t: 'code'; lang: string; code: string }
  | { t: 'list'; ordered: boolean; items: string[] }
  | { t: 'quote'; text: string }
  | { t: 'hr' };

const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const ITEM_RE = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/;

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i++;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1] ?? '```';
      const lang = (fence[2] ?? '').trim();
      i++;
      const buf: string[] = [];
      let closed = false;
      while (i < lines.length) {
        const l = lines[i] ?? '';
        if (l.trim().startsWith(marker)) {
          i++;
          closed = true;
          break;
        }
        buf.push(l);
        i++;
      }
      void closed; // an unclosed fence still renders as code, which is what the author meant
      out.push({ t: 'code', lang, code: buf.join('\n') });
      continue;
    }

    if (HR_RE.test(line)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      out.push({ t: 'h', level: (heading[1] ?? '#').length, text: heading[2] ?? '' });
      i++;
      continue;
    }

    if (line.trimStart().startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? '';
        if (!l.trimStart().startsWith('>')) break;
        buf.push(l.trimStart().replace(/^>\s?/, ''));
        i++;
      }
      out.push({ t: 'quote', text: buf.join('\n') });
      continue;
    }

    const item = ITEM_RE.exec(line);
    if (item) {
      const ordered = item[2] === undefined;
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? '';
        const m = ITEM_RE.exec(l);
        if (m) {
          items.push(m[4] ?? '');
          i++;
          continue;
        }
        // Continuation of the previous item: indented, non-empty, not a new block.
        if (l.trim() !== '' && /^\s{2,}/.test(l) && items.length > 0) {
          items[items.length - 1] = `${items[items.length - 1] ?? ''}\n${l.trim()}`;
          i++;
          continue;
        }
        break;
      }
      out.push({ t: 'list', ordered, items });
      continue;
    }

    const buf: string[] = [];
    while (i < lines.length) {
      const l = lines[i] ?? '';
      if (l.trim() === '') break;
      if (FENCE_RE.test(l) || HEADING_RE.test(l) || HR_RE.test(l) || ITEM_RE.test(l)) break;
      if (l.trimStart().startsWith('>')) break;
      buf.push(l);
      i++;
    }
    if (buf.length === 0) i++;
    else out.push({ t: 'p', text: buf.join('\n') });
  }

  return out;
}

const INLINE_RE =
  /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\n]+?)\*|_([^_\n]+?)_|~~([\s\S]+?)~~|\[([^\]\n]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g;

/** Inline markdown to React nodes. Never produces raw HTML. */
export function parseInline(text: string, depth = 0): ReactNode[] {
  if (depth > 3) return [text];
  const out: ReactNode[] = [];
  const re = new RegExp(INLINE_RE.source, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const [, , codeText, strongA, strongB, emA, emB, strike, linkText, linkUrl] = m;

    if (codeText !== undefined) {
      out.push(
        <code key={key++} className="tx-md-code">
          {codeText}
        </code>,
      );
    } else if (strongA !== undefined || strongB !== undefined) {
      out.push(<strong key={key++}>{parseInline(strongA ?? strongB ?? '', depth + 1)}</strong>);
    } else if (emA !== undefined || emB !== undefined) {
      out.push(<em key={key++}>{parseInline(emA ?? emB ?? '', depth + 1)}</em>);
    } else if (strike !== undefined) {
      out.push(<s key={key++}>{parseInline(strike, depth + 1)}</s>);
    } else if (linkText !== undefined) {
      // Deliberately not an anchor: model output does not get to be clickable.
      out.push(
        <span key={key++} className="tx-md-link" title={linkUrl ?? ''}>
          {linkText.length > 0 ? linkText : (linkUrl ?? '')}
        </span>,
      );
    } else {
      out.push(m[0]);
    }
    last = m.index + m[0].length;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }): ReactNode {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  if (text.trim().length === 0) return null;
  return (
    <div className="tx-md">
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'code':
            return <CodeBlock key={i} code={b.code} lang={b.lang} />;
          case 'h': {
            const level = Math.min(4, Math.max(1, b.level));
            return (
              <div key={i} className={`tx-md-h tx-md-h${level}`}>
                {parseInline(b.text)}
              </div>
            );
          }
          case 'hr':
            return <div key={i} className="tx-md-hr" />;
          case 'quote':
            return (
              <blockquote key={i} className="tx-md-quote">
                {parseInline(b.text)}
              </blockquote>
            );
          case 'list':
            return b.ordered ? (
              <ol key={i} className="tx-md-list">
                {b.items.map((it, j) => (
                  <li key={j}>{parseInline(it)}</li>
                ))}
              </ol>
            ) : (
              <ul key={i} className="tx-md-list">
                {b.items.map((it, j) => (
                  <li key={j}>{parseInline(it)}</li>
                ))}
              </ul>
            );
          case 'p':
          default:
            return (
              <p key={i} className="tx-md-p">
                {parseInline(b.text)}
              </p>
            );
        }
      })}
    </div>
  );
}

const CODE_LANG_ALIAS: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  yml: 'yaml',
  md: 'markdown',
  'c++': 'cpp',
  golang: 'go',
};

function CodeBlock({ code, lang }: { code: string; lang: string }): ReactNode {
  const resolved = useMemo(() => {
    const key = lang.toLowerCase();
    if (key.length === 0) return 'text';
    return CODE_LANG_ALIAS[key] ?? (key.includes('.') ? langForPath(key) : key);
  }, [lang]);
  const tokens = useCodeTokens(code, resolved);
  const lines = useMemo(() => code.split('\n'), [code]);

  return (
    <div className="tx-md-pre">
      {lang ? <div className="tx-md-pre-lang">{lang}</div> : null}
      <pre className="tx-pre tx-pre-code">
        {lines.map((line, i) => (
          <div className="tx-md-pre-line" key={i}>
            <Code pieces={composePieces(line, tokens[i], undefined)} />
          </div>
        ))}
      </pre>
    </div>
  );
}
