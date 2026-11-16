/**
 * A fenced code block in a reply: highlighted lines in a well, the fence's
 * language at the top right, and the copy column at its right end (#242).
 * Its own file so the diagram block (#289) can fall back to it and show its
 * source the same way, without importing the whole message renderer.
 */

import { useMemo, type ReactNode } from 'react';
import { langForPath } from '../../lib/diff';
import { Code, composePieces, useCodeTokens } from './codeTokens';
import { CopyButton } from './CopyButton';

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

/** The copy column and the lines, without the block's frame. */
export function CodeBody({ code, lang }: { code: string; lang: string }): ReactNode {
  const resolved = useMemo(() => {
    const key = lang.toLowerCase();
    if (key.length === 0) return 'text';
    return CODE_LANG_ALIAS[key] ?? (key.includes('.') ? langForPath(key) : key);
  }, [lang]);
  const tokens = useCodeTokens(code, resolved);
  const lines = useMemo(() => code.split('\n'), [code]);

  return (
    <>
      {/* Always at the block's right end (#242). */}
      <CopyButton text={code} />
      <pre className="tx-pre tx-pre-code">
        {lines.map((line, i) => (
          <div className="tx-md-pre-line" key={i}>
            <Code pieces={composePieces(line, tokens[i], undefined)} />
          </div>
        ))}
      </pre>
    </>
  );
}

export function CodeBlock({ code, lang }: { code: string; lang: string }): ReactNode {
  return (
    <div className="tx-md-pre">
      {lang ? <div className="tx-md-pre-lang">{lang}</div> : null}
      <CodeBody code={code} lang={lang} />
    </div>
  );
}
