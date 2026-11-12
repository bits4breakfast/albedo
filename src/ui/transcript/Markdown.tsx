/**
 * The small hand-written markdown subset the transcript renders (paragraphs,
 * fenced code, inline code, nested lists, quotes, tables, emphasis, links),
 * built as React nodes. No markdown dependency and no
 * `dangerouslySetInnerHTML`, on purpose: model output is untrusted content
 * (see MessageRow).
 */

import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { ExternalLink, PathLink } from './Diff';
import { CodeBlock } from './CodeBlock';
import { MermaidBlock } from './MermaidBlock';
import { hostOf, safeHttpUrl, splitUrls } from '../../lib/urls';
import { bareFileRef, parsePathRef } from '../../lib/paths';
import { MentionChip } from './MentionChip';
import { CopyButton } from './CopyButton';
import type { Mention } from './mentions';

type Block =
  | { t: 'p'; text: string }
  | { t: 'h'; level: number; text: string }
  | { t: 'code'; lang: string; code: string }
  | { t: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { t: 'quote'; text: string }
  | { t: 'hr' }
  | { t: 'table'; align: Align[]; head: string[]; rows: string[][] };

type Align = 'left' | 'center' | 'right' | null;

/** One list item: its own text, then any blocks nested under it (sub-lists). */
interface ListItem {
  text: string;
  children: Block[];
}

const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const ITEM_RE = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/;
/** A GFM delimiter row: `|---|:--:|`, outer pipes optional. */
const DELIM_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * A table row's cells, GFM style: outer pipes optional, `\|` is a literal
 * pipe, and a pipe inside a code span does not split.
 */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  const cells: string[] = [];
  let cell = '';
  let tick = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (c === '\\' && s[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (c === '`') {
      let run = 1;
      while (s[i + run] === '`') run++;
      cell += '`'.repeat(run);
      i += run - 1;
      tick = tick === 0 ? run : tick === run ? 0 : tick;
    } else if (c === '|' && tick === 0) {
      cells.push(cell.trim());
      cell = '';
    } else cell += c;
  }
  // A trailing pipe closes the last cell rather than opening an empty one.
  if (cell.trim() !== '' || !s.trimEnd().endsWith('|')) cells.push(cell.trim());
  return cells;
}

/** Whether `lines[i]` opens a table: a header row followed by its delimiter row. */
function tableStartsAt(lines: readonly string[], i: number): boolean {
  const head = lines[i] ?? '';
  const delim = lines[i + 1] ?? '';
  if (!head.includes('|') || !DELIM_RE.test(delim)) return false;
  return splitRow(head).length === splitRow(delim).length;
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
}

/** Width of leading whitespace in columns, a tab advancing to the next multiple of 4. */
function columns(ws: string): number {
  let col = 0;
  for (const c of ws) col = c === '\t' ? col + 4 - (col % 4) : col + 1;
  return col;
}

interface ItemLine {
  /** Columns before the marker. */
  indent: number;
  ordered: boolean;
  num: number;
  text: string;
}

function itemAt(line: string): ItemLine | null {
  const m = ITEM_RE.exec(line);
  if (!m) return null;
  const indent = columns(m[1] ?? '');
  return { indent, ordered: m[2] === undefined, num: Number(m[3] ?? 1), text: m[4] ?? '' };
}

/**
 * One list starting at `lines[i]`, nested lists included, as a tree.
 *
 * Nesting is relative to marker indents, not CommonMark's content column:
 * a transcript viewer should show what the author meant, and `1. a` followed
 * by `  - b` (2 spaces) is meant as a sub-list -- Claude Code's terminal
 * renders it nested -- though CommonMark makes it a separate list. So the
 * list records its first item's indent as `base`. An item indented further
 * than the last item's marker opens a nested list under that item (any step:
 * 1, 2, 3 or 4 spaces); one at `base` or beyond, but not further than the
 * last item's marker, is a sibling; one left of `base` belongs to an outer
 * list. `floor` is the parent item's marker indent + 1 (0 at the top level).
 * A marker of the other kind (bullet vs number) at this level ends the list,
 * as in CommonMark. A blank
 * line ends it unless the next non-blank line is an item this list or one
 * of its sub-lists takes (a loose list). Continuation lines -- non-blank,
 * not an item, indented 2+ -- join the deepest open item, as before nesting
 * existed; that includes an indented code fence, which stays item text.
 *
 * Returns the list and the index of the first line it did not take.
 */
function parseList(lines: readonly string[], i: number, floor: number): [Block, number] {
  const first = itemAt(lines[i] ?? '');
  const ordered = first?.ordered ?? false;
  const start = first?.num ?? 1;
  const base = first?.indent ?? 0;
  const items: ListItem[] = [];
  let last = 0; // the last item's marker indent

  while (i < lines.length) {
    const l = lines[i] ?? '';
    if (l.trim() === '') {
      let j = i + 1;
      while (j < lines.length && (lines[j] ?? '').trim() === '') j++;
      const after = itemAt(lines[j] ?? '');
      if (after && after.indent >= floor && items.length > 0) {
        i = j;
        continue;
      }
      break;
    }
    const it = itemAt(l);
    if (it) {
      if (items.length > 0 && it.indent > last) {
        const [sub, next] = parseList(lines, i, last + 1);
        items[items.length - 1]?.children.push(sub);
        i = next;
        continue;
      }
      if (it.indent < base || (items.length > 0 && it.ordered !== ordered)) break;
      items.push({ text: it.text, children: [] });
      last = it.indent;
      i++;
      continue;
    }
    if (/^\s{2,}/.test(l) && items.length > 0) {
      const open = items[items.length - 1] as ListItem;
      open.text = `${open.text}\n${l.trim()}`;
      i++;
      continue;
    }
    break;
  }

  return [{ t: 'list', ordered, start, items }, i];
}

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

    // Before HR: a delimiter row like `---|---` must never read as a rule.
    if (tableStartsAt(lines, i)) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1] ?? '').map(alignOf);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length) {
        const l = lines[i] ?? '';
        if (l.trim() === '' || !l.includes('|')) break;
        // Short rows are padded and long ones cut, so every row has the header's width.
        const cells = splitRow(l).slice(0, head.length);
        while (cells.length < head.length) cells.push('');
        rows.push(cells);
        i++;
      }
      out.push({ t: 'table', align, head, rows });
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

    if (ITEM_RE.test(line)) {
      const [list, next] = parseList(lines, i, 0);
      out.push(list);
      i = next;
      continue;
    }

    const buf: string[] = [];
    while (i < lines.length) {
      const l = lines[i] ?? '';
      if (l.trim() === '') break;
      if (FENCE_RE.test(l) || HEADING_RE.test(l) || HR_RE.test(l) || ITEM_RE.test(l)) break;
      if (l.trimStart().startsWith('>')) break;
      // A table may start straight after a paragraph line, as on GitHub.
      if (tableStartsAt(lines, i)) break;
      buf.push(l);
      i++;
    }
    if (buf.length === 0) i++;
    else out.push({ t: 'p', text: buf.join('\n') });
  }

  return out;
}

/**
 * Decide whether an inline code span is a path reference.
 *
 * Deliberately strict: only when the span is *nothing but* the reference. A
 * span like `npm run build` may well contain something path-shaped, and
 * turning that into a link makes the pane feel unreliable -- a false positive
 * costs more than a missed link. Extraction itself stays in `parsePathRef`.
 *
 * Two shapes a code span has and prose does not:
 *  - a line range, `src/a.php:64-75`, which opens at its first line;
 *  - a bare file name, `Foo.php` or `Foo.php:12` (`bareFileRef`), which the
 *    shell looks up in the worktree when clicked.
 */
export function codeSpanRef(text: string): { path: string; line: number | null; bare?: boolean } | null {
  const range = /^(.*:\d{1,7})-\d{1,7}$/.exec(text.trim());
  const trimmed = range ? (range[1] ?? '') : text.trim();
  if (trimmed.length === 0) return null;
  const bare = bareFileRef(trimmed);
  if (bare) return { ...bare, bare: true };
  let ref: { path: string; line: number | null } | null = null;
  try {
    ref = parsePathRef(trimmed);
  } catch {
    return null;
  }
  if (!ref || ref.path.length === 0 || !trimmed.startsWith(ref.path)) return null;
  const rest = trimmed.slice(ref.path.length);
  if (rest.length > 0 && !/^:\d+(?::\d+)?$/.test(rest)) return null;
  return ref;
}

const INLINE_RE =
  /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|(?<![\p{L}\p{N}_])__([\s\S]+?)__(?![\p{L}\p{N}_])|\*([^*\n]+?)\*|(?<![\p{L}\p{N}_])_([^_\n]+?)_(?![\p{L}\p{N}_])|~~([\s\S]+?)~~|\[([^\]\n]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/gu;

/**
 * Where each reference's label (`@Fix login retry`, `@src/foo.ts`) stands in
 * a run of plain text: on its own, as `bareFileMentions` and the composer's
 * tokens require. Longest label first, so `@a.tsx` is not cut at `@a.ts`.
 */
function mentionRe(mentions: readonly Mention[]): RegExp | null {
  if (mentions.length === 0) return null;
  const labels = [...new Set(mentions.map((m) => m.label))].sort((a, b) => b.length - a.length);
  const alt = labels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`(?<=^|[\\s(\\["'])(?:${alt})(?=$|[\\s.,;:!?)\\]}'"])`, 'g');
}

/**
 * Inline markdown to React nodes. Never produces raw HTML. `mentions`: the
 * references in a message you wrote (#154), drawn as chips where their label
 * stands in plain text -- never inside code.
 */
export function parseInline(text: string, depth = 0, mentions: readonly Mention[] = []): ReactNode[] {
  if (depth > 3) return [text];
  const out: ReactNode[] = [];
  const re = new RegExp(INLINE_RE.source, 'gu');
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;

  /** Plain text between markup, with any web URL in it made a link. */
  const pushUrls = (chunk: string): void => {
    for (const part of splitUrls(chunk)) {
      if (typeof part === 'string') out.push(part);
      else out.push(<ExternalLink key={key++} url={part.url} />);
    }
  };
  const refs = mentionRe(mentions);
  /** ...and each reference's label a chip. */
  const pushPlain = (chunk: string): void => {
    if (refs === null || !chunk.includes('@')) {
      pushUrls(chunk);
      return;
    }
    let at = 0;
    for (const m of chunk.matchAll(refs)) {
      const mention = mentions.find((x) => x.label === m[0]);
      if (!mention) continue;
      if (m.index > at) pushUrls(chunk.slice(at, m.index));
      out.push(<MentionChip key={key++} mention={mention} />);
      at = m.index + m[0].length;
    }
    if (at < chunk.length) pushUrls(chunk.slice(at));
  };

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) pushPlain(text.slice(last, m.index));
    const [, , codeText, strongA, strongB, emA, emB, strike, linkText, linkUrl] = m;

    if (codeText !== undefined) {
      const ref = codeSpanRef(codeText);
      const asUrl = safeHttpUrl(codeText);
      // With a copy icon at its end, always (#242, #244), a sibling so a path
      // chip or a link keeps its own click.
      out.push(
        <span key={key++} className="tx-md-code-wrap">
          {asUrl !== null && /^https?:\/\//i.test(codeText.trim()) ? (
            <ExternalLink url={asUrl} className="tx-md-code">
              {codeText}
            </ExternalLink>
          ) : ref ? (
            <PathLink path={ref.path} line={ref.line} lookup={ref.bare === true} className="tx-md-code tx-md-code-link">
              {codeText}
            </PathLink>
          ) : (
            <code className="tx-md-code">{codeText}</code>
          )}
          <CopyButton text={codeText} inline />
        </span>,
      );
    } else if (strongA !== undefined || strongB !== undefined) {
      out.push(<strong key={key++}>{parseInline(strongA ?? strongB ?? '', depth + 1, mentions)}</strong>);
    } else if (emA !== undefined || emB !== undefined) {
      out.push(<em key={key++}>{parseInline(emA ?? emB ?? '', depth + 1, mentions)}</em>);
    } else if (strike !== undefined) {
      out.push(<s key={key++}>{parseInline(strike, depth + 1, mentions)}</s>);
    } else if (linkText !== undefined) {
      const target = linkUrl ? safeHttpUrl(linkUrl) : null;
      const label = linkText.length > 0 ? linkText : (linkUrl ?? '');
      if (target === null) {
        // Not a web link (relative, `file:`, `javascript:` ...): shown, not clickable.
        out.push(
          <span key={key++} className="tx-md-link" title={linkUrl ?? ''}>
            {label}
          </span>,
        );
      } else {
        // The label is the model's; the host is the truth. When they differ the
        // host is shown beside it, so a label cannot disguise the destination.
        const host = hostOf(target);
        const labelIsUrl = /^https?:\/\//i.test(label.trim());
        out.push(
          <ExternalLink key={key++} url={target} className="tx-md-link">
            {label}
            {host && !labelIsUrl ? <span className="tx-url-host"> ({host})</span> : null}
          </ExternalLink>,
        );
      }
    } else {
      out.push(m[0]);
    }
    last = m.index + m[0].length;
  }

  if (last < text.length) pushPlain(text.slice(last));
  return out;
}

const NO_MENTIONS: readonly Mention[] = [];

export function Markdown({ text, mentions = NO_MENTIONS }: { text: string; mentions?: readonly Mention[] }): ReactNode {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  if (text.trim().length === 0) return null;
  return (
    <div className="tx-md">
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'code':
            // A diagram is drawn (#289); any other fence is code.
            return b.lang.toLowerCase() === 'mermaid' ? (
              <MermaidBlock key={i} code={b.code} lang={b.lang} />
            ) : (
              <CodeBlock key={i} code={b.code} lang={b.lang} />
            );
          case 'h': {
            const level = Math.min(4, Math.max(1, b.level));
            return (
              <div key={i} className={`tx-md-h tx-md-h${level}`}>
                {parseInline(b.text, 0, mentions)}
              </div>
            );
          }
          case 'hr':
            return <div key={i} className="tx-md-hr" />;
          case 'table':
            return (
              // The wrapper scrolls sideways, so a wide table never widens the pane.
              <div key={i} className="tx-md-table-wrap">
                <table className="tx-md-table">
                  <thead>
                    <tr>
                      {b.head.map((cell, j) => (
                        <th key={j} style={b.align[j] ? { textAlign: b.align[j] } : undefined}>
                          {parseInline(cell, 0, mentions)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, j) => (
                          <td key={j} style={b.align[j] ? { textAlign: b.align[j] } : undefined}>
                            {parseInline(cell, 0, mentions)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'quote':
            return (
              <blockquote key={i} className="tx-md-quote">
                {parseInline(b.text, 0, mentions)}
              </blockquote>
            );
          case 'list':
            return <MdList key={i} list={b} mentions={mentions} />;
          case 'p':
          default:
            return (
              <p key={i} className="tx-md-p">
                {parseInline(b.text, 0, mentions)}
              </p>
            );
        }
      })}
    </div>
  );
}

/** A list and, inside each item, the lists nested under it. */
function MdList({ list, mentions }: { list: Extract<Block, { t: 'list' }>; mentions: readonly Mention[] }): ReactNode {
  const items = list.items.map((it, j) => (
    <li key={j}>
      {parseInline(it.text, 0, mentions)}
      {it.children.map((c, k) => (c.t === 'list' ? <MdList key={k} list={c} mentions={mentions} /> : null))}
    </li>
  ));
  return list.ordered ? (
    <ol className="tx-md-list" start={list.start === 1 ? undefined : list.start}>
      {items}
    </ol>
  ) : (
    <ul className="tx-md-list">{items}</ul>
  );
}
