/**
 * The Checks dialog's log is `<pre className="tx-pre ck-log">`: transcript.css
 * caps a `.tx-pre` at 340px with no margin, and checks.css lifts the cap for
 * the log. That must not depend on which stylesheet the bundle loads last --
 * splitting modules (#368) reordered them, and `.ck-log` alone then lost.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const checks = readFileSync(new URL('./checks.css', import.meta.url), 'utf8');
const transcript = readFileSync(new URL('./transcript/transcript.css', import.meta.url), 'utf8');
const dialog = readFileSync(new URL('./ChecksDialog.tsx', import.meta.url), 'utf8');

/** Every rule in `css` as [selector, declarations], comments removed. */
function rules(css: string): [string, string][] {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1]!.trim(), m[2]!]);
}

/** Classes in the selector's last compound: its (0,n,0) here. */
const classCount = (selector: string) => (selector.split(/[\s>+~]+/).pop()!.match(/\.[\w-]+/g) ?? []).length;

describe('the Checks log', () => {
  it('is still a transcript pre with the log class', () => {
    expect(dialog).toContain('className="tx-pre ck-log"');
  });

  it("outranks .tx-pre's cap whatever the stylesheet order", () => {
    const base = rules(transcript).find(([sel]) => sel === '.tx-pre');
    expect(base?.[1]).toMatch(/max-height:\s*340px/);
    const log = rules(checks).filter(([sel, body]) => /\.ck-log\b/.test(sel) && /max-height/.test(body));
    expect(log).toHaveLength(1);
    const [sel, body] = log[0]!;
    expect(body).toMatch(/max-height:\s*none/);
    // On the same element as .tx-pre, so it must name it to outrank it.
    expect(sel.split(/[\s>+~]+/).pop()).toMatch(/\.tx-pre/);
    expect(classCount(sel)).toBeGreaterThan(classCount('.tx-pre'));
  });
});
