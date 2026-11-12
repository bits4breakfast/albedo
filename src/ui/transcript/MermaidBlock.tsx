/**
 * A ```` ```mermaid ```` fence drawn as a diagram (#289).
 *
 * Until the drawing is ready the fence shows as the code block it always was,
 * so a reply is readable at once and nothing is blank. A fence mermaid cannot
 * parse stays code, with the parse error under it, inside the same frame.
 * A drawn diagram has one bar: its kind on the left, Source and Open in
 * Window on the right. See mermaid.ts for why it is an image.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from '../theme';
import { CodeBlock, CodeBody } from './CodeBlock';
import { CopyButton } from './CopyButton';
import { CodeLines } from './codeTokens';
import { drawDiagram, peekDiagram, type DiagramImage, type DrawResult } from './mermaid';

/** Within this many px of the end counts as reading the end (as TranscriptPane's STICK_PX). */
const AT_END_PX = 4;

function scroller(from: Element | null): HTMLElement | null {
  return (from?.closest('.tx-scroll') as HTMLElement | null) ?? null;
}

export function MermaidBlock({ code, lang }: { code: string; lang: string }): ReactNode {
  const { resolved } = useTheme();
  const [result, setResult] = useState<DrawResult | undefined>(() => peekDiagram(code, resolved));
  const [showSource, setShowSource] = useState(false);
  const [windowOpen, setWindowOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Whether a reader at the end of the transcript should stay there when
  // this block changes height (the drawing replacing the code, or Source).
  const pinRef = useRef(false);

  const readingEnd = () => {
    const el = scroller(wrapRef.current);
    return el !== null && el.clientHeight > 0 && el.scrollHeight - el.scrollTop - el.clientHeight < AT_END_PX;
  };

  useEffect(() => {
    const cached = peekDiagram(code, resolved);
    if (cached) {
      setResult(cached);
      return;
    }
    let live = true;
    void drawDiagram(code, resolved).then((r) => {
      if (!live) return;
      pinRef.current = readingEnd();
      setResult(r);
    });
    return () => {
      live = false;
    };
  }, [code, resolved]);

  // After the commit, so the end is measured with the block at its new height.
  useLayoutEffect(() => {
    if (!pinRef.current) return;
    pinRef.current = false;
    const el = scroller(wrapRef.current);
    if (el) el.scrollTop = el.scrollHeight;
  }, [result, showSource]);

  let body: ReactNode;
  if (result === undefined) {
    body = <CodeBlock code={code} lang={lang} />;
  } else if (!result.ok) {
    body = (
      // The code block's face, with the copy column beside the code only.
      <div className="tx-md-pre">
        {lang ? <div className="tx-md-pre-lang">{lang}</div> : null}
        <div className="tx-mermaid-code">
          <CodeBody code={code} lang={lang} />
        </div>
        <div className="tx-mermaid-error" role="note">
          <div className="tx-mermaid-error-head">Couldn’t draw this diagram</div>
          <div className="tx-mermaid-error-text">{result.error}</div>
        </div>
      </div>
    );
  } else {
    const { image, kind } = result;
    body = (
      // The code block's frame and its copy column, full height at the right
      // end as on every code block (#242); the bar and the drawing stop at it.
      <div className="tx-md-pre tx-mermaid">
        <CopyButton text={code} />
        <div className="tx-mermaid-bar">
          <span className="tx-mermaid-kind">{kind}</span>
          <button
            type="button"
            className="tx-btn"
            // Says what it will show, as a toggle without a pressed style of its own.
            onClick={(e) => {
              e.stopPropagation();
              pinRef.current = readingEnd();
              setShowSource((s) => !s);
            }}
          >
            {showSource ? 'Diagram' : 'Source'}
          </button>
          <button
            type="button"
            className="tx-btn"
            onClick={(e) => {
              e.stopPropagation();
              setWindowOpen(true);
            }}
          >
            Open in Window
          </button>
        </div>
        {showSource ? (
          // A code block's body: its lines, and its language where a code
          // block keeps it (a comment on a passage reads it from there).
          <div className="tx-mermaid-source">
            {lang ? <div className="tx-md-pre-lang">{lang}</div> : null}
            <CodeLines code={code} lang={lang.toLowerCase()} />
          </div>
        ) : (
          <div className="tx-mermaid-figure">
            <DiagramImg image={image} kind={kind} />
          </div>
        )}
        {windowOpen ? <MermaidWindow image={image} kind={kind} onClose={() => setWindowOpen(false)} /> : null}
      </div>
    );
  }

  return (
    <div className="tx-mermaid-wrap" ref={wrapRef}>
      {body}
    </div>
  );
}

/**
 * Never drawn below this share of its natural size: past it the text is too
 * small to read, so the figure scrolls sideways instead.
 */
export const MIN_SCALE = 0.8;

/** Sized up front from the viewBox, so the row has its height before the image decodes. */
function DiagramImg({ image, kind, large = false }: { image: DiagramImage; kind: string; large?: boolean }): ReactNode {
  return (
    <img
      className="tx-mermaid-img"
      src={image.src}
      width={image.width}
      height={image.height}
      // In the transcript: fits the column down to MIN_SCALE, then scrolls.
      // In the window: as large as the window allows in both directions, a
      // small diagram up to twice its size (CSS fits the height).
      style={large ? { width: '100%', maxWidth: image.width * 2 } : { minWidth: Math.round(image.width * MIN_SCALE) }}
      alt={`${kind} diagram`}
      draggable={false}
    />
  );
}

/** The diagram larger, in a dialog over the app. Escape or a click outside closes it. */
function MermaidWindow({ image, kind, onClose }: { image: DiagramImage; kind: string; onClose: () => void }): ReactNode {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => dialogRef.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    // Capture, as the other dialogs: the editor closes its file on Escape
    // from a window listener of its own.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  // Give the keyboard back to wherever it was when the dialog appeared.
  const [from] = useState(() => document.activeElement);
  useEffect(() => {
    return () => {
      if (from instanceof HTMLElement && from.isConnected) from.focus();
    };
  }, [from]);
  return createPortal(
    <div className="wt-overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="wt-modal tx-mermaid-window"
        role="dialog"
        aria-modal="true"
        aria-label={`${kind} diagram`}
        tabIndex={-1}
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="wt-modal-head">
          <h2 className="wt-modal-title">{kind} Diagram</h2>
        </div>
        <div className="wt-modal-body">
          <div className="tx-mermaid-well">
            <DiagramImg image={image} kind={kind} large />
          </div>
        </div>
        <div className="wt-modal-foot">
          <span className="wt-foot-spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
