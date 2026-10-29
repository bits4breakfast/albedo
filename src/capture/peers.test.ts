import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestDb, type TestDb } from '../db/testkit';

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => harness.db } }));

import { insertMessages, resetDb } from '../db';
import { peerMessageIdOf, sentMessageIdOf } from './adapter';
import { __resetSenders, senderTaskOf } from './peers';

const MSG = 'c25d6760-0000-4000-8000-000000000001';

/** The sender's side, as Claude Code writes it: JSON text inside the result. */
function sendResult(msgId: string) {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: [{ type: 'text', text: JSON.stringify({ success: true, message: '"Rebase" → Fix login', msg_id: msgId }) }],
        },
      ],
    },
  });
}

/** The receiver's side: origin.kind "peer" and the same id. */
const received = (msgId: string) =>
  JSON.stringify({ type: 'user', isMeta: true, origin: { kind: 'peer', name: 'Add export', msg_id: msgId } });

const row = (o: { taskId: number | null; sessionId: string; seq: number; toolName: string; rawJson: string }) => ({
  ...o,
  role: 'tool_result' as const,
  targetPath: null,
  body: null,
  agentId: null,
  ts: 1,
});

describe('adapter: the two ends of a message', () => {
  it('reads the id off the receiving line, and only off a peer origin', () => {
    expect(peerMessageIdOf(received(MSG))).toBe(MSG);
    expect(peerMessageIdOf(JSON.stringify({ type: 'user', origin: { kind: 'human', msg_id: MSG } }))).toBeNull();
    expect(peerMessageIdOf('{"type":"user"}')).toBeNull();
    expect(peerMessageIdOf('not json')).toBeNull();
  });

  it("reads the id off the sender's SendMessage result", () => {
    expect(sentMessageIdOf(sendResult(MSG))).toBe(MSG);
    expect(sentMessageIdOf(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'plain' }] } }))).toBeNull();
  });
});

describe('senderTaskOf', () => {
  let db: TestDb;
  beforeEach(() => {
    resetDb();
    __resetSenders();
    db = createTestDb();
    harness.db = db;
  });

  it("finds the sender's task from the message id", async () => {
    await insertMessages([row({ taskId: 27, sessionId: 'sender', seq: 100, toolName: 'SendMessage', rawJson: sendResult(MSG) })]);
    expect(await senderTaskOf(MSG)).toBe(27);
  });

  it('ignores a result that merely quotes the id, and a sender no task owns', async () => {
    await insertMessages([
      // A search over transcripts printed the id: another tool, not a send.
      row({ taskId: 11, sessionId: 'searcher', seq: 100, toolName: 'Bash', rawJson: JSON.stringify({ text: MSG }) }),
      // A plain terminal session sent it.
      row({ taskId: null, sessionId: 'terminal', seq: 100, toolName: 'SendMessage', rawJson: sendResult(MSG) }),
    ]);
    expect(await senderTaskOf(MSG)).toBeNull();
  });

  it('finds a sender captured after a first miss', async () => {
    expect(await senderTaskOf(MSG)).toBeNull();
    await insertMessages([row({ taskId: 27, sessionId: 'sender', seq: 100, toolName: 'SendMessage', rawJson: sendResult(MSG) })]);
    expect(await senderTaskOf(MSG)).toBe(27);
  });
});
