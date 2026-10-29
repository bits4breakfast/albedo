/**
 * Remote Control's "is active" line (#114): the one place that reads it.
 * Synthetic lines in the shape Claude Code 2.1.312 writes; no real session.
 */

import { describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';

import { parseLine, remoteControlSqlPredicate, remoteControlUrlOf } from './adapter';

const URL = 'https://claude.ai/code/session_example';

function bridgeLine(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    parentUuid: 'p1',
    isSidechain: false,
    type: 'system',
    subtype: 'bridge_status',
    content: `/remote-control is active · Continue here, on your phone, or at ${URL}`,
    url: URL,
    isMeta: false,
    timestamp: '2026-10-28T00:39:42.990Z',
    uuid: 'u1',
    sessionId: 's1',
    version: '2.1.312',
    ...over,
  });
}

describe('remoteControlUrlOf', () => {
  it('reads the link off an "is active" line', () => {
    expect(remoteControlUrlOf(bridgeLine())).toBe(URL);
  });

  it('falls back to the link in the text when the line has no url field', () => {
    expect(remoteControlUrlOf(bridgeLine({ url: undefined }))).toBe(URL);
  });

  it('is null for anything else', () => {
    // Another status the same subtype might carry: not "is active".
    expect(remoteControlUrlOf(bridgeLine({ content: '/remote-control disconnected' }))).toBeNull();
    expect(remoteControlUrlOf(bridgeLine({ subtype: 'informational' }))).toBeNull();
    expect(remoteControlUrlOf(bridgeLine({ type: 'user' }))).toBeNull();
    expect(remoteControlUrlOf(bridgeLine({ isSidechain: true }))).toBeNull();
    expect(remoteControlUrlOf(JSON.stringify({ type: 'bridge-session', bridgeSessionId: 'cse_example' }))).toBeNull();
    expect(remoteControlUrlOf('{not json')).toBeNull();
  });

  it('is stored as a system row, so the database can find it', () => {
    const rows = parseLine(bridgeLine(), 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe('system');
    expect(remoteControlUrlOf(rows[0]?.rawJson ?? '')).toBe(URL);
  });

  it('keeps bridge-session lines out of the database', () => {
    expect(parseLine(JSON.stringify({ type: 'bridge-session', bridgeSessionId: 'cse_example', sessionId: 's1' }), 0)).toEqual([]);
  });

  it('preselects the line in SQL, matching `_` literally', () => {
    const db = new BetterSqlite3(':memory:');
    db.exec('CREATE TABLE t (raw_json TEXT)');
    const insert = db.prepare('INSERT INTO t VALUES (?)');
    insert.run(bridgeLine());
    insert.run(bridgeLine({ subtype: 'bridgeXstatus' }));
    insert.run(JSON.stringify({ type: 'system', subtype: 'turn_duration' }));
    const hits = db.prepare(`SELECT raw_json FROM t WHERE ${remoteControlSqlPredicate()}`).all();
    expect(hits).toHaveLength(1);
    db.close();
  });
});
