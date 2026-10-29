/**
 * The one place that reads background work's lines (#122): calls, results,
 * `<task-notification>` envelopes, and the attachments that carry the ones
 * delivered into a running turn. Synthetic lines in the shapes Claude Code
 * 2.1.312 writes; no real session.
 */

import { describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';

import { backgroundFactsOf, backgroundSqlPredicate, parseLine, turnEdgeOf } from './adapter';
import { deriveStatus } from './status';
import { workingState } from '../ui/transcript/working';
import {
  asyncAgent,
  backgroundShell,
  callLine,
  monitor,
  noticeAttachmentLine,
  noticeUserLine,
  notification,
  stopWakeups,
  taskStop,
  wakeup,
} from './backgroundFixtures';

const T = Date.parse('2026-10-28T10:00:00.000Z');

const facts = (line: Record<string, unknown>) => parseLine(JSON.stringify(line), 0).flatMap((m) => backgroundFactsOf(m));
const done = notification({ taskIds: ['b1'], toolUseId: 't1', status: 'completed' });

describe('background lines', () => {
  it('keeps a notification delivered into a running turn, as a system row with no text', () => {
    const rows = parseLine(JSON.stringify(noticeAttachmentLine(done, T)), 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: 'system', body: null, sessionId: 's1' });
    // Not a turn's edge: a turn is running when it comes.
    expect(turnEdgeOf(rows[0]?.rawJson ?? '')).toBeNull();
  });

  it('keeps the turn it came into running, as the result before it did', () => {
    const lines = [...backgroundShell('t1', 'b1', T), noticeAttachmentLine(done, T + 5_000)];
    let id = 0;
    const rows = lines.flatMap((l, i) => parseLine(JSON.stringify(l), i).map((m) => ({ ...m, id: ++id, taskId: 1 })));
    expect(deriveStatus(rows, T + 10_000)).toBe('running');
    // In a turn, with nothing after it: Claude is thinking about it.
    expect(workingState(rows, { sending: false, echoAt: null, complete: true }).step).toEqual({ kind: 'thinking' });
  });

  it('reads the same on builds that wrote no origin, and leaves every other attachment out', () => {
    const noOrigin = noticeAttachmentLine(done, T);
    delete (noOrigin['attachment'] as Record<string, unknown>)['origin'];
    expect(parseLine(JSON.stringify(noOrigin), 0)).toHaveLength(1);

    const sidechain = noticeAttachmentLine(done, T, { isSidechain: true });
    expect(parseLine(JSON.stringify(sidechain), 0)).toEqual([]);
    const other = { type: 'attachment', sessionId: 's1', timestamp: new Date(T).toISOString(), attachment: { type: 'total_tokens_reminder' } };
    expect(parseLine(JSON.stringify(other), 0)).toEqual([]);
    // A message the person typed mid-turn is still theirs, under "You".
    const typed = noticeAttachmentLine('Also check the docs', T);
    (typed['attachment'] as Record<string, unknown>)['commandMode'] = 'prompt';
    (typed['attachment'] as Record<string, unknown>)['origin'] = { kind: 'human' };
    expect(parseLine(JSON.stringify(typed), 0)).toMatchObject([{ role: 'user', body: 'Also check the docs' }]);
  });

  it('reads an end from a notification, as a user line or an attachment', () => {
    const end = { fact: 'end', toolUseIds: ['t1'], taskIds: ['b1'] };
    expect(facts(noticeUserLine(done, T))).toEqual([end]);
    expect(facts(noticeAttachmentLine(done, T))).toEqual([end]);
  });

  it("reads no end from a monitor's event, which has no status", () => {
    expect(facts(noticeUserLine(notification({ taskIds: ['bm'], summary: 'Monitor event: "Watch the build log"', event: 'step 3' }), T))).toEqual([]);
  });

  it('reads no end from a prompt that only talks about notifications', () => {
    expect(facts(noticeUserLine(`What does this mean?\n${done}`, T))).toEqual([]);
  });

  it('reads the calls and what their results say', () => {
    const [shellCall, shellResult] = backgroundShell('t1', 'b1', T);
    expect(facts(shellCall!)).toEqual([{ fact: 'call', toolUseId: 't1', kind: 'shell', description: 'Poll CI until green' }]);
    expect(facts(shellResult!)).toMatchObject([{ fact: 'result', toolUseId: 't1', ok: true, taskId: 'b1', scheduledFor: null }]);

    expect(facts(asyncAgent('g1', 'a1', T)[1]!)).toMatchObject([{ fact: 'result', taskId: 'a1' }]);
    expect(facts(monitor('m1', 'bm', T)[1]!)).toMatchObject([{ fact: 'result', taskId: 'bm', timeoutMs: 1_800_000, persistent: false }]);
    expect(facts(wakeup('w1', T, 300)[1]!)).toMatchObject([{ fact: 'result', taskId: null, scheduledFor: T + 300_000 }]);
    expect(facts(wakeup('w1', T, 300)[0]!)).toEqual([
      { fact: 'call', toolUseId: 'w1', kind: 'wakeup', description: 'Timer: wait 5 minutes before the next check' },
    ]);
  });

  it('reads TaskStop and a stopped loop as stops, not starts', () => {
    expect(facts(taskStop('s1', 'b1', T)[1]!)).toEqual([{ fact: 'stop', taskId: 'b1' }]);
    expect(facts(stopWakeups('w2', T)[0]!)).toEqual([]);
    expect(facts(stopWakeups('w2', T)[1]!)).toEqual([{ fact: 'wakeups-stopped' }]);
  });

  it('preselects exactly the rows that matter in SQL', () => {
    const db = new BetterSqlite3(':memory:');
    db.exec('CREATE TABLE t (role TEXT, tool_name TEXT, raw_json TEXT)');
    const insert = db.prepare('INSERT INTO t VALUES (?, ?, ?)');
    const lines = [
      ...backgroundShell('t1', 'b1', T),
      ...monitor('m1', 'bm', T),
      ...wakeup('w1', T, 300),
      ...taskStop('s1', 'b1', T),
      noticeUserLine(done, T),
      noticeAttachmentLine(done, T),
      // Not background work: a plain call and its result, and a prompt.
      callLine('x1', 'Bash', { command: 'ls' }, T),
      { type: 'user', sessionId: 's1', timestamp: new Date(T).toISOString(), message: { role: 'user', content: 'hello' } },
    ];
    for (const line of lines) for (const m of parseLine(JSON.stringify(line), 0)) insert.run(m.role, m.toolName, m.rawJson);
    const hits = db.prepare(`SELECT role, tool_name FROM t WHERE ${backgroundSqlPredicate()}`).all() as { role: string; tool_name: string | null }[];
    // Everything but TaskStop's call (its result says it), `ls` and the prompt.
    expect(hits).toHaveLength(lines.length - 3);
    expect(hits.some((h) => h.tool_name === 'Bash' && h.role === 'tool_use')).toBe(true);
    db.close();
  });
});
