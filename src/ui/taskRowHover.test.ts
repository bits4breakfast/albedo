/**
 * On hover a task row swaps its age for ⌘N, in the same cell -- the cell the
 * ⋯ button covers. A row with ⋯ must hide ⌘N as well, or a sliver of it shows
 * at the button's left edge (#230). jsdom matches no :hover, so this reads
 * the rules from tasklist.css, in order.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./tasklist.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Each rule's selectors and body, in source order. */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1]!.split(',').map((s) => s.trim().replace(/\s+/g, ' ')),
  body: m[2]!,
}));

function lastRuleFor(selector: string): { at: number; body: string } | null {
  for (let i = rules.length - 1; i >= 0; i--) if (rules[i]!.selectors.includes(selector)) return { at: i, body: rules[i]!.body };
  return null;
}

describe('a hovered task row with ⋯ (#230)', () => {
  it('hides ⌘N, after the rule that shows it on hover', () => {
    const shows = lastRuleFor('.task-row:hover .task-index');
    const hides = lastRuleFor('.task-row:hover:has(> .task-more) .task-index');
    expect(shows?.body).toMatch(/visibility:\s*visible/);
    expect(hides?.body).toMatch(/visibility:\s*hidden/);
    expect(hides!.at).toBeGreaterThan(shows!.at);
  });

  it('keeps ⌘N hidden while its menu is open', () => {
    expect(lastRuleFor(".task-row[data-menu-open='true'] .task-index")?.body).toMatch(/visibility:\s*hidden/);
  });

  it('still hides the age, as before', () => {
    expect(lastRuleFor('.task-row:hover .task-age')?.body).toMatch(/visibility:\s*hidden/);
  });

  it('never by opacity (contrast rule 2)', () => {
    for (const r of rules) if (r.selectors.some((s) => s.includes('.task-index'))) expect(r.body).not.toMatch(/opacity/);
  });
});
