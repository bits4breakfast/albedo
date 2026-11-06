/**
 * A task's issue key never truncates (#278): the row's name is the key, so
 * the rest of the title, then the repo name, then the marks give way first.
 * Checked on the CSS that does it, since jsdom has no layout; the real-engine
 * check is the screenshots at 260px and 300px.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const list = readFileSync(new URL('./tasklist.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (sel: string) => {
  const i = list.indexOf(`${sel} {`);
  expect(i, sel).toBeGreaterThan(-1);
  return list.slice(i, list.indexOf('}', i));
};

describe('the issue key never truncates (#278)', () => {
  it('keeps its full width, on a title laid out as a flex line', () => {
    expect(rule('.task-key')).toContain('flex: none');
    expect(rule('.task-title:has(> .task-key)')).toContain('display: flex');
  });

  it('the rest of the title gives way: it grows from zero and ellipsizes', () => {
    const rest = rule('.task-rest');
    expect(rest).toContain('width: 0');
    expect(rest).toContain('flex-grow: 1');
    expect(rest).toContain('min-width: 0');
    expect(rest).toContain('text-overflow: ellipsis');
  });

  it('on a row with a key, the title track never goes below the key', () => {
    expect(rule('.task-row:has(> .task-title > .task-key)')).toContain(
      'grid-template-columns: minmax(min-content, 1fr) auto auto',
    );
  });

  it('the threads chip: quiet, and in the Needs You text tier when changes were requested', () => {
    expect(rule('.task-threads')).toContain('color: var(--muted)');
    expect(rule('.task-threads[data-changes]')).toContain('color: var(--status-blocked)');
  });
});
