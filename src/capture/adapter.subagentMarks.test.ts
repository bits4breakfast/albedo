/**
 * What resumes a subagent and what stops one, read from the parent's lines
 * (#139). Synthetic lines in the shapes Claude Code 2.1.314 writes; no real
 * session.
 */

import { describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';

import { backgroundFactsOf, parseLine, subagentMarkSqlPredicate, subagentMarksOf } from './adapter';
import {
  agentNotification,
  asyncAgent,
  backgroundShell,
  callLine,
  noticeAttachmentLine,
  noticeUserLine,
  notification,
  sendMessageResume,
  systemNoticeUserLine,
} from './backgroundFixtures';

const T = Date.parse('2026-10-28T10:00:00.000Z');

const marks = (line: Record<string, unknown>) => parseLine(JSON.stringify(line), 0).flatMap((m) => subagentMarksOf(m));

describe('subagentMarksOf', () => {
  it('reads "waiting on its own background work" as a stop for now, as a user line or an attachment', () => {
    const text = agentNotification({ agentId: 'ag1', toolUseId: 'tu1', waiting: true });
    const waiting = [{ mark: 'stopped', agentId: 'ag1', waiting: true }];
    expect(marks(systemNoticeUserLine(text, T))).toEqual(waiting);
    expect(marks(noticeAttachmentLine(text, T))).toEqual(waiting);
  });

  it('reads a plain completion, a failure and a kill as finished', () => {
    for (const status of ['completed', 'failed', 'killed', 'stopped']) {
      expect(marks(systemNoticeUserLine(agentNotification({ agentId: 'ag1', status }), T))).toEqual([
        { mark: 'stopped', agentId: 'ag1', waiting: false },
      ]);
    }
  });

  it('is only "waiting" when the status is completed', () => {
    // A failed agent is not coming back on its own, whatever its note said.
    const text = agentNotification({ agentId: 'ag1', status: 'failed', waiting: true });
    expect(marks(systemNoticeUserLine(text, T))).toEqual([{ mark: 'stopped', agentId: 'ag1', waiting: false }]);
  });

  it('still counts a waiting agent as ended for the background fold', () => {
    // The fold (#122) is unchanged: the agent's background item ends, and the
    // Agents strip is what says it is waiting.
    const text = agentNotification({ agentId: 'ag1', toolUseId: 'tu1', waiting: true });
    const rows = parseLine(JSON.stringify(systemNoticeUserLine(text, T)), 0);
    expect(rows.flatMap((m) => backgroundFactsOf(m))).toEqual([{ fact: 'end', toolUseIds: ['tu1'], taskIds: ['ag1'] }]);
  });

  it('reads a SendMessage result that resumed an agent', () => {
    const [call, result] = sendMessageResume('sm1', 'ag1', T);
    expect(marks(call as Record<string, unknown>)).toEqual([]);
    expect(marks(result as Record<string, unknown>)).toEqual([{ mark: 'resumed', agentId: 'ag1' }]);
  });

  it('reads nothing from a failed resume, a monitor event, a prompt quoting a notification, or other rows', () => {
    const [, failed] = sendMessageResume('sm1', 'ag1', T);
    (failed as Record<string, unknown>)['toolUseResult'] = { success: false, resumedAgentId: 'ag1' };
    expect(marks(failed as Record<string, unknown>)).toEqual([]);
    expect(marks(noticeUserLine(notification({ taskIds: ['bm'], summary: 'Monitor event', event: 'step 3' }), T))).toEqual([]);
    expect(marks(noticeUserLine(`What does this mean?\n${agentNotification({ agentId: 'ag1', waiting: true })}`, T))).toEqual([]);
    for (const line of asyncAgent('g1', 'ag1', T)) expect(marks(line)).toEqual([]);
  });

  it('preselects exactly the rows it reads, in SQL', () => {
    const db = new BetterSqlite3(':memory:');
    db.exec('CREATE TABLE t (role TEXT, tool_name TEXT, raw_json TEXT)');
    const insert = db.prepare('INSERT INTO t VALUES (?, ?, ?)');
    const hitting = [
      systemNoticeUserLine(agentNotification({ agentId: 'ag1', waiting: true }), T),
      noticeAttachmentLine(agentNotification({ agentId: 'ag1' }), T),
      ...sendMessageResume('sm1', 'ag1', T).slice(1),
    ];
    const missing = [
      ...asyncAgent('g1', 'ag1', T),
      ...backgroundShell('t1', 'b1', T).slice(0, 1),
      callLine('x1', 'Bash', { command: 'ls' }, T),
      ...sendMessageResume('sm2', 'ag2', T).slice(0, 1),
    ];
    for (const line of [...hitting, ...missing]) {
      for (const m of parseLine(JSON.stringify(line), 0)) insert.run(m.role, m.toolName, m.rawJson);
    }
    const hits = db.prepare(`SELECT raw_json FROM t WHERE ${subagentMarkSqlPredicate()}`).all() as { raw_json: string }[];
    expect(hits).toHaveLength(hitting.length);
    db.close();
  });
});
