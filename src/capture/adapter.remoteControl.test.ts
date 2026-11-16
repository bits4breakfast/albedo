/**
 * Remote Control's "is active" line (#114): the one place that reads it.
 * Synthetic lines in the shape Claude Code 2.1.312 writes; no real session.
 */

import { describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';

import {
  parseLine,
  remoteControlSqlPredicate,
  remoteControlUrlOf,
  remoteSessionFactOf,
  remoteSessionFactsIn,
} from './adapter';
import remoteSession from './fixtures/remote-session.jsonl?raw';

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

/**
 * The other fact (#343): the link Claude Code writes with the first prompt of
 * each process. A session resumed with Remote Control on writes only this.
 * The fixture has both shapes in order: off, the "is active" line after
 * `/remote-control`, the link at the next prompt, and a resumed process that
 * comes back on with the link alone.
 */
describe('remoteSessionFactsIn', () => {
  const SID = '44444444-5555-6666-7777-888888888888';
  const LINK = 'https://example.com/code/session_example';
  const ms = (iso: string) => Date.parse(iso);

  it('reads every main-thread fact in file order: off, then the link', () => {
    expect(remoteSessionFactsIn(remoteSession)).toEqual([
      { sessionId: SID, url: null, ts: ms('2026-10-29T13:32:08.183Z') },
      { sessionId: SID, url: LINK, ts: ms('2026-10-29T15:33:43.905Z') },
      { sessionId: SID, url: LINK, ts: ms('2026-11-10T12:10:22.613Z') },
    ]);
  });

  it('the same fixture carries the older "is active" line, read by its own reader', () => {
    const urls = remoteSession
      .split('\n')
      .filter(Boolean)
      .map(remoteControlUrlOf)
      .filter((u) => u !== null);
    expect(urls).toEqual([LINK]);
  });

  it('is never stored as a row: a new kind of row would read as the session’s last word', () => {
    const line = remoteSession.split('\n').find((l) => l.includes('"remote_session_change"'))!;
    expect(parseLine(line, 0)).toEqual([]);
  });

  it('is null for a sidechain, another attachment, or no session', () => {
    const line = (over: Record<string, unknown>, att: Record<string, unknown> = {}) =>
      JSON.stringify({
        type: 'attachment',
        isSidechain: false,
        sessionId: 's1',
        timestamp: '2026-11-10T12:00:00.000Z',
        attachment: { type: 'remote_session_change', url: URL, ...att },
        ...over,
      });
    expect(remoteSessionFactOf(line({}))).toEqual({ sessionId: 's1', url: URL, ts: ms('2026-11-10T12:00:00.000Z') });
    expect(remoteSessionFactOf(line({}, { url: '' }))?.url).toBeNull();
    expect(remoteSessionFactOf(line({ isSidechain: true }))).toBeNull();
    expect(remoteSessionFactOf(line({}, { type: 'date' }))).toBeNull();
    expect(remoteSessionFactOf(line({ sessionId: '' }))).toBeNull();
    expect(remoteSessionFactOf(line({ type: 'user' }))).toBeNull();
    expect(remoteSessionFactOf('{"remote_session_change": broken')).toBeNull();
  });
});
