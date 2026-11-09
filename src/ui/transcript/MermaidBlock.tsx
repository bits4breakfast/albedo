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
  const openRef = useRef<HTMLButtonElement>(null);
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
      <div className="tx-md-pre tx-mermaid">
        <div className="tx-mermaid-bar">
          <span className="tx-mermaid-kind">{kind}</span>
          <button
            type="button"
            className="tx-mermaid-act"
            aria-pressed={showSource}
            title={showSource ? 'Show the diagram' : 'Show the mermaid text'}
            onClick={(e) => {
              e.stopPropagation();
              pinRef.current = readingEnd();
              setShowSource((s) => !s);
            }}
          >
            Source
          </button>
          <button
            type="button"
            className="tx-mermaid-act"
            ref={openRef}
            onClick={(e) => {
              e.stopPropagation();
              setWindowOpen(true);
            }}
          >
            Open in Window
          </button>
        </div>
        {showSource ? (
          <div className="tx-mermaid-source">
            <CodeBody code={code} lang={lang} />
          </div>
        ) : (
          <div className="tx-mermaid-figure">
            <DiagramImg image={image} kind={kind} />
          </div>
        )}
        {windowOpen ? (
          <MermaidWindow
            image={image}
            kind={kind}
            onClose={() => {
              setWindowOpen(false);
              openRef.current?.focus();
            }}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="tx-mermaid-wrap" ref={wrapRef}>
      {body}
    </div>
  );
}

/** Sized up front from the viewBox, so the row has its height before the image decodes. */
function DiagramImg({ image, kind, large = false }: { image: DiagramImage; kind: string; large?: boolean }): ReactNode {
  return (
    <img
      className="tx-mermaid-img"
      src={image.src}
      width={image.width}
      height={image.height}
      // In the window a small diagram may grow, up to twice its size.
      style={large ? { width: '100%', maxWidth: image.width * 2 } : undefined}
      alt={`${kind} diagram`}
      draggable={false}
    />
  );
}

/** The diagram larger, in a dialog over the app. Escape or a click outside closes it. */
function MermaidWindow({ image, kind, onClose }: { image: DiagramImage; kind: string; onClose: () => void }): ReactNode {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => dialogRef.current?.focus(), []);
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
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }}
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
