import { describe, expect, it } from 'vitest';
import { ancestors, buildTree, changedDirs, parentOf, visibleRows } from './projectTreeModel';

const FILES = ['src/ui/b.ts', 'README.md', 'src/a.ts', 'src/ui/A.tsx', 'docs/guide.md', 'file10.txt', 'file2.txt'];

describe('buildTree / visibleRows', () => {
  it('lists folders first, then files, collapsed by default', () => {
    const rows = visibleRows(buildTree(FILES), new Set());
    expect(rows.map((r) => r.name)).toEqual(['docs', 'src', 'file2.txt', 'file10.txt', 'README.md']);
    expect(rows.every((r) => r.depth === 0)).toBe(true);
  });

  it('shows an open folder’s children one level deeper', () => {
    const rows = visibleRows(buildTree(FILES), new Set(['src', 'src/ui']));
    expect(rows.map((r) => `${'  '.repeat(r.depth)}${r.name}`)).toEqual([
      'docs',
      'src',
      '  ui',
      '    A.tsx',
      '    b.ts',
      '  a.ts',
      'file2.txt',
      'file10.txt',
      'README.md',
    ]);
    expect(rows.find((r) => r.path === 'src')?.open).toBe(true);
  });

  it('hides the children of a closed folder even when a nested one is open', () => {
    const rows = visibleRows(buildTree(FILES), new Set(['src/ui']));
    expect(rows.map((r) => r.path)).not.toContain('src/ui/b.ts');
  });

  it('keeps file rows’ paths worktree-relative', () => {
    const rows = visibleRows(buildTree(FILES), new Set(['src']));
    expect(rows.find((r) => r.name === 'a.ts')?.path).toBe('src/a.ts');
  });
});

describe('ancestors / changedDirs / parentOf', () => {
  it('lists the folders a path sits in, outermost first', () => {
    expect(ancestors('a/b/c.ts')).toEqual(['a', 'a/b']);
    expect(ancestors('c.ts')).toEqual([]);
  });

  it('marks every folder above a changed file', () => {
    expect([...changedDirs(['src/ui/x.ts', 'top.md'])].sort()).toEqual(['src', 'src/ui']);
  });

  it('finds the parent folder', () => {
    expect(parentOf('src/ui')).toBe('src');
    expect(parentOf('src')).toBeNull();
  });
});
