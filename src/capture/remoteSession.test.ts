/**
 * Whether Remote Control is on, from the two facts the transcript has (#343):
 * the stored "is active" row and the in-memory link attachment. Only what was
 * written since the pty spawned counts, and the newer fact decides.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ line: null as { url: string; ts: number } | null, asked: [] as [string, number][] }));
vi.mock('../db', () => ({
  remoteControlLineSince: vi.fn(async (sessionId: string, since: number) => {
    h.asked.push([sessionId, since]);
    return h.line !== null && h.line.ts >= since ? h.line : null;
  }),
}));

const { __resetRemoteSessions, onRemoteSessionChange, recordRemoteSessions, remoteControlSince, remoteSessionSince } =
  await import('./remoteSession');

const URL = 'https://claude.ai/code/session_example';
const SPAWN = 10_000;

afterEach(() => {
  __resetRemoteSessions();
  h.line = null;
  h.asked.length = 0;
});

describe('remoteControlSince', () => {
  it('is off with nothing written since the spawn', async () => {
    expect(await remoteControlSince('s1', SPAWN)).toBeNull();
    expect(h.asked).toEqual([['s1', SPAWN]]);
  });

  it('is on from the "is active" row alone (a fresh /remote-control)', async () => {
    h.line = { url: URL, ts: SPAWN + 1_000 };
    expect(await remoteControlSince('s1', SPAWN)).toBe(URL);
  });

  it('is on from the link alone (a session resumed with it on)', async () => {
    recordRemoteSessions([{ sessionId: 's1', url: URL, ts: SPAWN + 500 }]);
    expect(await remoteControlSince('s1', SPAWN)).toBe(URL);
  });

  it('a link from before the spawn is an earlier process: it does not count', async () => {
    recordRemoteSessions([{ sessionId: 's1', url: URL, ts: SPAWN - 1 }]);
    expect(remoteSessionSince('s1', SPAWN)).toBeNull();
    expect(await remoteControlSince('s1', SPAWN)).toBeNull();
  });

  it('the newer fact decides: off at the first prompt, then the "is active" row, is on', async () => {
    recordRemoteSessions([{ sessionId: 's1', url: null, ts: SPAWN + 100 }]);
    h.line = { url: URL, ts: SPAWN + 5_000 };
    expect(await remoteControlSince('s1', SPAWN)).toBe(URL);
  });

  it('the newer fact decides: an "is active" row, then a link of null, is off', async () => {
    h.line = { url: URL, ts: SPAWN + 100 };
    recordRemoteSessions([{ sessionId: 's1', url: null, ts: SPAWN + 5_000 }]);
    expect(await remoteControlSince('s1', SPAWN)).toBeNull();
  });

  it('keeps the newest fact per session, and tells who changed', () => {
    const heard: string[] = [];
    const off = onRemoteSessionChange((sid) => heard.push(sid));
    recordRemoteSessions([
      { sessionId: 's1', url: null, ts: SPAWN + 1 },
      { sessionId: 's1', url: URL, ts: SPAWN + 2 },
      { sessionId: 's2', url: URL, ts: SPAWN + 3 },
    ]);
    // An older fact read later (a replay) does not overwrite.
    recordRemoteSessions([{ sessionId: 's1', url: null, ts: SPAWN }]);
    off();
    expect(remoteSessionSince('s1', 0)).toEqual({ sessionId: 's1', url: URL, ts: SPAWN + 2 });
    expect(heard).toEqual(['s1', 's2']);
  });
});
