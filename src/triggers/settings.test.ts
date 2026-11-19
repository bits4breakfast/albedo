/**
 * Triggers' settings (#448): Off unless turned on, kept in their own file per
 * project under ~/.albedo/triggers, written as .part then renamed, mode 0600.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const fsCalls: Array<[string, ...unknown[]]> = [];
vi.mock('@tauri-apps/plugin-fs', () => ({
  mkdir: vi.fn(async (...a: unknown[]) => void fsCalls.push(['mkdir', ...a])),
  writeTextFile: vi.fn(async (...a: unknown[]) => void fsCalls.push(['writeTextFile', ...a])),
  rename: vi.fn(async (...a: unknown[]) => void fsCalls.push(['rename', ...a])),
  exists: vi.fn(async () => false),
  readTextFile: vi.fn(async () => ''),
}));
vi.mock('@tauri-apps/api/path', () => ({ homeDir: async () => '/Users/sample/' }));

const {
  DEFAULT_TRIGGERS,
  asTriggerSettings,
  loadTriggerSettings,
  modeAllowed,
  saveTriggerSettings,
  setTriggerFiles,
  triggerSettingsFor,
  writeTriggerFile,
} = await import('./settings');

afterEach(() => {
  fsCalls.length = 0;
});

describe('settings', () => {
  it('every event is Off by default', () => {
    expect(Object.values(DEFAULT_TRIGGERS).every((r) => r.mode === 'off')).toBe(true);
    expect(asTriggerSettings({})).toEqual(DEFAULT_TRIGGERS);
  });

  it('only the approval can Suggest: merging is only ever a suggestion, and nothing else has one', () => {
    expect(modeAllowed('approved', 'suggest')).toBe(true);
    for (const e of ['merged', 'ciFailed', 'review'] as const) expect(modeAllowed(e, 'suggest')).toBe(false);
    // A hand-edited file asking for one is Off, never a guess.
    expect(asTriggerSettings({ merged: { mode: 'suggest', template: 'x' } })!.merged).toEqual({ mode: 'off', template: 'x' });
    expect(asTriggerSettings({ approved: { mode: 'auto' } })!.approved.mode).toBe('off');
  });

  it('writes its own file: the folder made, a .part written 0600, then renamed over the file', async () => {
    await writeTriggerFile(3, '{}');
    expect(fsCalls).toEqual([
      ['mkdir', '/Users/sample/.albedo/triggers', { recursive: true }],
      ['writeTextFile', '/Users/sample/.albedo/triggers/project-3.json.part', '{}', { mode: 0o600 }],
      ['rename', '/Users/sample/.albedo/triggers/project-3.json.part', '/Users/sample/.albedo/triggers/project-3.json'],
    ]);
  });

  it('nothing is decided for a project until its settings are read; then they are used', async () => {
    const files = new Map<number, string>();
    let reads = 0;
    const prev = setTriggerFiles({
      read: async (id) => {
        reads += 1;
        return files.get(id) ?? null;
      },
      write: async (id, json) => void files.set(id, json),
    });
    try {
      expect(triggerSettingsFor(5)).toBeUndefined();
      await loadTriggerSettings(5);
      expect(triggerSettingsFor(5)).toEqual(DEFAULT_TRIGGERS);
      await saveTriggerSettings(5, { ...DEFAULT_TRIGGERS, merged: { mode: 'draft', template: '/after-merge' } });
      expect(JSON.parse(files.get(5)!)).toMatchObject({ version: 1, merged: { mode: 'draft', template: '/after-merge' } });
      expect(triggerSettingsFor(5)!.merged.mode).toBe('draft');
      expect(reads).toBe(1);
      // A project with no project: nothing on.
      expect(triggerSettingsFor(null)).toEqual(DEFAULT_TRIGGERS);
    } finally {
      setTriggerFiles(prev);
    }
  });

  it('a file that cannot be used reads as all Off; one that cannot be checked decides nothing', async () => {
    const { UncheckedError } = await import('./settings');
    const prev = setTriggerFiles({
      read: async (id) => {
        if (id === 1) return 'not json';
        throw new UncheckedError('no access');
      },
      write: async () => {},
    });
    try {
      expect((await loadTriggerSettings(1)).kind).toBe('unreadable');
      expect(triggerSettingsFor(1)).toEqual(DEFAULT_TRIGGERS);
      expect((await loadTriggerSettings(2)).kind).toBe('unchecked');
      expect(triggerSettingsFor(2)).toBeUndefined();
    } finally {
      setTriggerFiles(prev);
    }
  });
});
