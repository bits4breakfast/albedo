/**
 * The stored strings are a format users already have on disk. These pin it:
 * every codec reads the values the hand-written readers it replaced wrote, and
 * writes them back byte for byte.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flagCodec,
  idCodec,
  KEYS,
  numberListCodec,
  oneOfCodec,
  readPersisted,
  stringListCodec,
  writePersisted,
  type Codec,
} from './persisted';
import { taskModelCodec } from './taskModel';
import { zoomCodec } from './zoom';

// This environment has no working Storage (see Composer.test.tsx): a Map stands in.
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function roundTrip<T>(codec: Codec<T>, value: T): T {
  writePersisted('k', codec, value);
  return readPersisted('k', codec, Symbol('fallback') as unknown as T);
}

describe('readPersisted / writePersisted', () => {
  it('falls back when the key is absent or does not decode', () => {
    expect(readPersisted('k', flagCodec, false)).toBe(false);
    window.localStorage.setItem('k', 'yes');
    expect(readPersisted('k', flagCodec, true)).toBe(true);
  });

  it('falls back when the stored JSON is broken, rather than throwing', () => {
    window.localStorage.setItem('k', '[1,');
    expect(readPersisted('k', numberListCodec, [])).toEqual([]);
    window.localStorage.setItem('k', '');
    expect(readPersisted('k', numberListCodec, [])).toEqual([]);
  });

  it('never throws when storage does', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readPersisted('k', idCodec, null)).toBeNull();
    expect(() => writePersisted('k', idCodec, 3)).not.toThrow();
  });

  it('removes the key when the codec encodes null, and leaves it on undefined', () => {
    window.localStorage.setItem(KEYS.composerPx, '96');
    writePersisted(KEYS.composerPx, { decode: () => null, encode: () => null }, 0);
    expect(window.localStorage.getItem(KEYS.composerPx)).toBeNull();

    window.localStorage.setItem(KEYS.rightTab, 'files');
    writePersisted(KEYS.rightTab, { decode: () => null, encode: () => undefined }, 0);
    expect(window.localStorage.getItem(KEYS.rightTab)).toBe('files');
  });
});

describe('shared codecs', () => {
  it('flags are 1 and 0', () => {
    writePersisted('k', flagCodec, true);
    expect(window.localStorage.getItem('k')).toBe('1');
    expect(roundTrip(flagCodec, false)).toBe(false);
    expect(window.localStorage.getItem('k')).toBe('0');
  });

  it('ids are plain numbers, read as leniently as before', () => {
    expect(roundTrip(idCodec, 42)).toBe(42);
    expect(window.localStorage.getItem('k')).toBe('42');
    expect(idCodec.decode('abc')).toBeNull();
    // Number('') is 0: the old reader accepted it, so this one does.
    expect(idCodec.decode('')).toBe(0);
  });

  it('id and string lists are JSON arrays, dropping foreign members', () => {
    expect(roundTrip(numberListCodec, [3, 1])).toEqual([3, 1]);
    expect(window.localStorage.getItem('k')).toBe('[3,1]');
    expect(numberListCodec.decode('[1,"2",null,3]')).toEqual([1, 3]);
    expect(numberListCodec.decode('{"a":1}')).toBeNull();
    expect(roundTrip(stringListCodec, ['repo:/a', 'wt:2'])).toEqual(['repo:/a', 'wt:2']);
    expect(window.localStorage.getItem('k')).toBe('["repo:/a","wt:2"]');
    expect(stringListCodec.decode('["a",1]')).toEqual(['a']);
  });

  it('oneOf accepts only its values', () => {
    const codec = oneOfCodec(['row', 'column'] as const);
    expect(roundTrip(codec, 'column')).toBe('column');
    expect(codec.decode('diagonal')).toBeNull();
  });
});

describe('per-key codecs', () => {
  it('zoom reads only a step on the scale', () => {
    expect(roundTrip(zoomCodec, 1.25)).toBe(1.25);
    expect(window.localStorage.getItem('k')).toBe('1.25');
    expect(zoomCodec.decode('1.3')).toBeNull();
    expect(zoomCodec.decode('')).toBeNull();
  });

  it('a blank task model is the default and is removed, a real one is trimmed', () => {
    writePersisted(KEYS.taskModel(7), taskModelCodec, '  opus ');
    expect(window.localStorage.getItem('albedo.taskModel.7')).toBe('opus');
    writePersisted(KEYS.taskModel(7), taskModelCodec, '   ');
    expect(window.localStorage.getItem('albedo.taskModel.7')).toBeNull();
    expect(taskModelCodec.decode('  ')).toBeNull();
  });
});

describe('KEYS', () => {
  it('keeps every key users already have', () => {
    expect(KEYS).toMatchObject({
      sidebarWidth: 'albedo.shell.sidebarWidth',
      paneMode: 'albedo.shell.paneMode',
      splitRatio: 'albedo.shell.splitRatio',
      orientation: 'albedo.shell.orientation',
      selectedTask: 'albedo.shell.selectedTask',
      activeProject: 'albedo.shell.activeProject',
      rightTab: 'albedo.shell.rightTab',
      filesPinned: 'albedo.shell.filesPinned',
      filesWidth: 'albedo.shell.filesWidth',
      shellOpen: 'albedo.shell.shellDrawerOpen',
      shellHeight: 'albedo.shell.shellDrawerHeight',
      dismissedNotices: 'albedo.shell.dismissedNotices',
      hiddenProjects: 'albedo.shell.hiddenProjects',
      projectOrder: 'albedo.shell.projectOrder',
      theme: 'albedo.shell.theme',
      zoom: 'albedo.zoom',
      lastProjectId: 'albedo.worktree.lastProjectId',
      touchedMode: 'albedo.touched.mode',
      composerPx: 'albedo.composerPx',
      notifications: 'albedo.notifications',
      commentsIntro: 'albedo.comments.intro',
    });
    expect(KEYS.taskModel(3)).toBe('albedo.taskModel.3');
  });
});
