import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ rows: [] as { rawJson: string }[], calls: 0 }));
vi.mock('../db', () => ({
  getMessages: async () => {
    harness.calls++;
    return harness.rows;
  },
}));

import { permissionModeOf, permissionModesIn, type PermissionMode } from './adapter';
import {
  applyPermissionModes,
  lastPermissionModeIn,
  loadPermissionMode,
  onPermissionModeChange,
  permissionModeFor,
  recordPermissionModes,
} from './permissionMode';

const S = 'sess-1';
const T = 'sess-2';
const modeLine = (mode: string, sessionId = S) => JSON.stringify({ type: 'permission-mode', permissionMode: mode, sessionId });
const userLine = (mode: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', permissionMode: mode, sessionId: S, isSidechain: false, message: { role: 'user', content: 'hi' }, ...extra });

beforeEach(() => {
  harness.rows = [];
  harness.calls = 0;
});

describe('permissionModeOf', () => {
  it('reads permission-mode lines and the user line of a prompt', () => {
    expect(permissionModeOf(modeLine('plan'))).toEqual({ sessionId: S, mode: 'plan' });
    expect(permissionModeOf(userLine('acceptEdits'))).toEqual({ sessionId: S, mode: 'acceptEdits' });
  });

  it('reads an unrecognised mode as null, not as a guess', () => {
    expect(permissionModeOf(modeLine('somethingNew'))).toEqual({ sessionId: S, mode: null });
  });

  it('records nothing for lines without the field, subagent lines, other types and junk', () => {
    expect(permissionModeOf(JSON.stringify({ type: 'user', sessionId: S, message: { content: [] } }))).toBeUndefined();
    expect(permissionModeOf(userLine('bypassPermissions', { isSidechain: true }))).toBeUndefined();
    expect(permissionModeOf(JSON.stringify({ type: 'assistant', permissionMode: 'plan', sessionId: S }))).toBeUndefined();
    expect(permissionModeOf(JSON.stringify({ type: 'permission-mode', permissionMode: 'plan' }))).toBeUndefined();
    expect(permissionModeOf('{not json "permissionMode"')).toBeUndefined();
  });
});

describe('permissionModesIn', () => {
  it('keeps the latest mode per session across mixed lines', () => {
    const text = [
      modeLine('default'),
      userLine('default'),
      JSON.stringify({ type: 'assistant', sessionId: S, message: { content: 'the word "permissionMode" in prose' } }),
      modeLine('auto', T),
      modeLine('plan'),
      userLine('bypassPermissions', { isSidechain: true }),
      '',
    ].join('\n');
    expect(permissionModesIn(text)).toEqual(
      new Map<string, PermissionMode | null>([
        [S, 'plan'],
        [T, 'auto'],
      ]),
    );
  });
});

describe('applyPermissionModes', () => {
  it('reports only the sessions whose mode changed', () => {
    const state = new Map<string, PermissionMode | null>();
    expect(applyPermissionModes(state, new Map([[S, 'auto']]))).toEqual([S]);
    expect(applyPermissionModes(state, new Map([[S, 'auto'], [T, 'plan']]))).toEqual([T]);
    expect(applyPermissionModes(state, new Map([[S, null]]))).toEqual([S]);
    expect(state.get(S)).toBeNull();
  });
});

describe('lastPermissionModeIn', () => {
  it('takes the newest row that records a mode, skipping tool results', () => {
    const toolResult = JSON.stringify({ type: 'user', sessionId: S, message: { content: [{ type: 'tool_result' }] } });
    expect(lastPermissionModeIn([{ rawJson: userLine('default') }, { rawJson: userLine('plan') }, { rawJson: toolResult }])).toBe('plan');
    expect(lastPermissionModeIn([{ rawJson: toolResult }])).toBeUndefined();
  });
});

describe('the store', () => {
  it('holds the latest mode per session and tells listeners', () => {
    const heard: string[] = [];
    const off = onPermissionModeChange((sid) => heard.push(sid));
    recordPermissionModes(new Map([['live-1', 'auto']]));
    recordPermissionModes(new Map([['live-1', 'plan']]));
    recordPermissionModes(new Map([['live-1', 'plan']]));
    off();
    expect(permissionModeFor('live-1')).toBe('plan');
    expect(heard).toEqual(['live-1', 'live-1']);
  });

  it('is unknown for a session never seen, and for an unrecognised mode', () => {
    expect(permissionModeFor('never-seen')).toBeNull();
    recordPermissionModes(new Map([['odd-1', null]]));
    expect(permissionModeFor('odd-1')).toBeNull();
  });

  it('recovers a mode from stored rows once, and never over a live one', async () => {
    harness.rows = [{ rawJson: userLine('acceptEdits') }];
    await loadPermissionMode('stored-1');
    await loadPermissionMode('stored-1');
    expect(permissionModeFor('stored-1')).toBe('acceptEdits');
    expect(harness.calls).toBe(1);

    recordPermissionModes(new Map([['live-2', 'plan']]));
    await loadPermissionMode('live-2');
    expect(permissionModeFor('live-2')).toBe('plan');
    expect(harness.calls).toBe(1);
  });

  it('leaves a session with no stored mode unknown', async () => {
    await loadPermissionMode('stored-2');
    expect(permissionModeFor('stored-2')).toBeNull();
  });
});
