/**
 * Syntax colour for code: Shiki's tokens for a blob (`useCodeTokens`), split
 * at a diff's word-level segments (`composePieces`) so one span carries both
 * the token's colour and the segment's changed flag. Shared by the diff, code
 * blocks and Mermaid source.
 */

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { DiffSegment } from '../../types';
import { highlightToTokens, peekTokens, plainTokens } from '../../lib/highlight';
import type { DualToken } from '../../lib/highlight';

/** Past this many lines, highlighting a blob costs more than it gives. */
const MAX_HIGHLIGHT_LINES = 6000;

/**
 * Tokenize a blob, re-rendering when the async result lands. Starts from the
 * cache so an already-seen blob paints highlighted on the first frame.
 */
export function useCodeTokens(text: string, lang: string): DualToken[][] {
  const tooBig = useMemo(() => text.length > 0 && countLines(text) > MAX_HIGHLIGHT_LINES, [text]);
  const [tokens, setTokens] = useState<DualToken[][]>(
    () => (tooBig ? plainTokens(text) : peekTokens(text, lang)) ?? plainTokens(text),
  );

  useEffect(() => {
    if (tooBig) {
      setTokens(plainTokens(text));
      return;
    }
    const cached = peekTokens(text, lang);
    if (cached) {
      setTokens(cached);
      return;
    }
    let live = true;
    setTokens(plainTokens(text));
    void highlightToTokens(text, lang).then((t) => {
      if (live) setTokens(t);
    });
    return () => {
      live = false;
    };
  }, [text, lang, tooBig]);

  return tokens;
}

/** Split a source text the same way `diffStrings` does, so line numbers agree. */
export function sourceLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.replace(/\r\n/g, '\n').split('\n');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function countLines(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

interface Piece {
  text: string;
  style: Record<string, string>;
  changed: boolean;
}

/** Normalise a token line so its text covers exactly `content`. */
function normaliseTokens(content: string, tokens: DualToken[] | undefined): Array<{ text: string; style: Record<string, string> }> {
  const out: Array<{ text: string; style: Record<string, string> }> = [];
  let used = 0;
  for (const t of tokens ?? []) {
    if (used >= content.length) break;
    const text = t.content.length > content.length - used ? content.slice(used, content.length) : t.content;
    if (text.length === 0) continue;
    out.push({ text, style: t.style });
    used += text.length;
  }
  if (used < content.length) out.push({ text: content.slice(used), style: {} });
  return out;
}

/**
 * Split syntax tokens at word-level change boundaries.
 *
 * Both layers survive: each returned piece keeps the colour of the token it
 * came from and the changed flag of the segment it falls in. Without this split
 * the two would fight -- either the change background would swallow the syntax
 * colours, or the word highlight would have to be a sibling element that cannot
 * line up with token boundaries.
 */
export function composePieces(
  content: string,
  tokens: DualToken[] | undefined,
  segments: DiffSegment[] | undefined,
): Piece[] {
  const toks = normaliseTokens(content, tokens);
  if (!segments || segments.length === 0) {
    return toks.map((t) => ({ text: t.text, style: t.style, changed: false }));
  }

  const flags = new Uint8Array(content.length);
  let off = 0;
  for (const s of segments) {
    const end = Math.min(content.length, off + s.text.length);
    if (s.changed && end > off) flags.fill(1, off, end);
    off = end;
    if (off >= content.length) break;
  }

  const out: Piece[] = [];
  let pos = 0;
  for (const t of toks) {
    let start = 0;
    while (start < t.text.length) {
      const flag = flags[pos + start] ?? 0;
      let end = start + 1;
      while (end < t.text.length && (flags[pos + end] ?? 0) === flag) end++;
      out.push({ text: t.text.slice(start, end), style: t.style, changed: flag === 1 });
      start = end;
    }
    pos += t.text.length;
  }
  return out;
}

export function Code({ pieces }: { pieces: Piece[] }): ReactNode {
  if (pieces.length === 0) return <span className="tx-d-code" />;
  return (
    <span className="tx-d-code">
      {pieces.map((p, i) => (
        <span key={i} className={p.changed ? 'tx-tok tx-d-word' : 'tx-tok'} style={p.style as CSSProperties}>
          {p.text}
        </span>
      ))}
    </span>
  );
}

/**
 * A block of code, highlighted, one element per line. Shared by the markdown
 * renderer and the tool chip so every code surface in the pane looks the same.
 */
export function CodeLines({ code, lang, className }: { code: string; lang: string; className?: string }): ReactNode {
  const tokens = useCodeTokens(code, lang);
  const lines = useMemo(() => code.split('\n'), [code]);
  return (
    <pre className={`tx-pre tx-pre-code${className ? ` ${className}` : ''}`}>
      {lines.map((line, i) => (
        <div className="tx-md-pre-line" key={i}>
          <Code pieces={composePieces(line, tokens[i], undefined)} />
        </div>
      ))}
    </pre>
  );
}
