/**
 * The pasted-text inspector is `<pre className="tx-pre tx-paste-view">`. Its
 * own height and padding must win over `.tx-pre`'s 340px transcript cap, and
 * `.tx-pre` is declared later in transcript.css, so the rule has to outrank it
 * rather than rely on order (#382).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./transcript.css', import.meta.url), 'utf8');
const view = readFileSync(new URL('./PastedTexts.tsx', import.meta.url), 'utf8');

/** Every rule as [selector, declarations], comments removed. */
function rules(text: string): [string, string][] {
  const plain = text.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1]!.trim(), m[2]!]);
}

const classCount = (selector: string) => (selector.split(/[\s>+~]+/).pop()!.match(/\.[\w-]+/g) ?? []).length;

describe('the pasted-text inspector', () => {
  it('is still a transcript pre with the inspector class', () => {
    expect(view).toContain('className="tx-pre tx-paste-view"');
  });

  it("outranks .tx-pre's cap and padding whatever the order", () => {
    const base = rules(css).find(([sel]) => sel === '.tx-pre');
    expect(base?.[1]).toMatch(/max-height:\s*340px/);
    const own = rules(css).filter(([sel, body]) => /\.tx-paste-view\b/.test(sel) && /max-height/.test(body));
    expect(own).toHaveLength(1);
    const [sel, body] = own[0]!;
    expect(body).toMatch(/max-height:\s*min\(60vh,\s*640px\)/);
    expect(body).toMatch(/padding:\s*10px 12px/);
    expect(classCount(sel)).toBeGreaterThan(classCount('.tx-pre'));
  });
});
