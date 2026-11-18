/**
 * The Context settings' real write path (#444 review): mkdir, then the file
 * written as `.part` with mode 0600 and renamed over the old one. The fs
 * plugin is stood in for by node's fs on a temporary folder, doing what the
 * plugin does and no more: no folder is made unless asked
 * (REGRESSIONS: a stand-in kinder than the real thing).
 */
import { mkdtempSync, readdirSync, statSync, readFileSync } from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'albedo-ctx-'));
const ops = vi.hoisted(() => [] as string[]);
vi.mock('@tauri-apps/api/path', () => ({ homeDir: async () => home }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: async (p: string) => nodeFs.stat(p).then(() => true, () => false),
  readTextFile: (p: string) => nodeFs.readFile(p, 'utf8'),
  mkdir: async (p: string, o?: { recursive?: boolean }) => {
    ops.push('mkdir');
    await nodeFs.mkdir(p, { recursive: o?.recursive ?? false });
  },
  // Like the plugin: the folder must exist; `mode` applies when the file is made.
  writeTextFile: async (p: string, data: string, o?: { mode?: number }) => {
    ops.push(`write ${p.slice(home.length)}`);
    await nodeFs.writeFile(p, data, { mode: o?.mode });
  },
  rename: async (from: string, to: string) => {
    ops.push(`rename ${from.slice(home.length)} -> ${to.slice(home.length)}`);
    await nodeFs.rename(from, to);
  },
}));

const { loadContext, resetContextSettingsForTests, saveContextSettings } = await import('./context');

afterAll(() => nodeFs.rm(home, { recursive: true, force: true }));

describe('the settings file on disk', () => {
  const settings = { instructions: 'Find the ticket.', tools: ['mcp__tracker__get_issue'], model: 'sonnet' as const, timeoutMs: 120_000 };

  it('is made in a folder that did not exist, 0600, through a .part renamed over it', async () => {
    resetContextSettingsForTests();
    expect(await loadContext(1)).toEqual({ kind: 'none' });
    await saveContextSettings(1, settings);
    const dir = join(home, '.albedo', 'guide-context');
    const file = join(dir, 'project-1.json');
    expect(ops).toEqual([
      'mkdir',
      'write /.albedo/guide-context/project-1.json.part',
      'rename /.albedo/guide-context/project-1.json.part -> /.albedo/guide-context/project-1.json',
    ]);
    expect(readdirSync(dir)).toEqual(['project-1.json']);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, ...settings });
    // Saved again over it, and read back by a fresh start.
    await saveContextSettings(1, { ...settings, model: 'opus' });
    resetContextSettingsForTests();
    expect(await loadContext(1)).toEqual({ kind: 'saved', settings: { ...settings, model: 'opus' } });
  });
});
