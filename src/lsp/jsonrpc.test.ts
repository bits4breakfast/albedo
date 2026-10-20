import { describe, expect, it } from 'vitest';
import { Connection, Deframer, frame, type Message } from './jsonrpc';

const text = new TextDecoder();

describe('frame / Deframer', () => {
  it('counts bytes, not characters, so a non-ASCII body survives', () => {
    const msg: Message = { jsonrpc: '2.0', method: 'x', params: { s: 'café — ✓' } };
    const bytes = frame(msg);
    const head = /Content-Length: (\d+)\r\n\r\n/.exec(text.decode(bytes))!;
    const json = JSON.stringify(msg);
    expect(json.length).toBeLessThan(new TextEncoder().encode(json).length);
    expect(Number(head[1])).toBe(new TextEncoder().encode(json).length);
    expect(new Deframer().push(bytes)).toEqual([msg]);
  });

  it('reassembles messages split anywhere and several per chunk', () => {
    const a: Message = { jsonrpc: '2.0', id: 1, result: 'é'.repeat(50) };
    const b: Message = { jsonrpc: '2.0', method: 'n' };
    const all = new Uint8Array([...frame(a), ...frame(b)]);
    for (const cut of [1, 7, 20, 30, all.length - 3]) {
      const d = new Deframer();
      const out = [...d.push(all.slice(0, cut)), ...d.push(all.slice(cut))];
      expect(out).toEqual([a, b]);
    }
  });

  it('drops a body that is not JSON and keeps going', () => {
    const bad = new TextEncoder().encode('Content-Length: 3\r\n\r\n{x}');
    const good = frame({ jsonrpc: '2.0', method: 'ok' });
    expect(new Deframer().push(new Uint8Array([...bad, ...good]))).toEqual([{ jsonrpc: '2.0', method: 'ok' }]);
  });
});

function pair(onRequest?: (m: string, p: unknown) => unknown, onNote?: (m: string, p: unknown) => void) {
  const sent: Message[] = [];
  const conn = new Connection(
    { write: async (b) => void sent.push(...new Deframer().push(b)) },
    onRequest,
    onNote,
  );
  const reply = (m: Message) => conn.receive(frame(m));
  return { conn, sent, reply };
}

describe('Connection', () => {
  it('matches answers to requests by id', async () => {
    const { conn, sent, reply } = pair();
    const p1 = conn.request('a', 1);
    const p2 = conn.request('b', 2);
    await Promise.resolve();
    reply({ jsonrpc: '2.0', id: sent[1]!.id, result: 'two' });
    reply({ jsonrpc: '2.0', id: sent[0]!.id, result: 'one' });
    await expect(p1).resolves.toBe('one');
    await expect(p2).resolves.toBe('two');
  });

  it('rejects on an error answer', async () => {
    const { conn, sent, reply } = pair();
    const p = conn.request('a', null);
    await Promise.resolve();
    reply({ jsonrpc: '2.0', id: sent[0]!.id, error: { code: -32601, message: 'nope' } });
    await expect(p).rejects.toThrow('nope');
  });

  it("answers the server's requests and passes notifications on", async () => {
    const notes: string[] = [];
    const { sent, reply } = pair(
      (m) => (m === 'workspace/configuration' ? [] : null),
      (m) => notes.push(m),
    );
    reply({ jsonrpc: '2.0', id: 7, method: 'workspace/configuration', params: {} });
    reply({ jsonrpc: '2.0', id: 8, method: 'client/registerCapability', params: {} });
    reply({ jsonrpc: '2.0', method: '$/progress', params: {} });
    await Promise.resolve();
    expect(sent).toEqual([
      { jsonrpc: '2.0', id: 7, result: [] },
      { jsonrpc: '2.0', id: 8, result: null },
    ]);
    expect(notes).toEqual(['$/progress']);
  });

  it('fails every waiter at once when closed', async () => {
    const { conn } = pair();
    const p = conn.request('a', null);
    conn.close(new Error('gone'));
    await expect(p).rejects.toThrow('gone');
    await expect(conn.request('b', null)).rejects.toThrow('gone');
  });
});
