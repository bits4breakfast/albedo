/**
 * Just enough JSON-RPC over LSP's `Content-Length` framing to drive one
 * language server: requests with answers, notifications both ways, and
 * answering the server's own requests.
 *
 * No dependency on Tauri: a `Transport` is "write these bytes" plus "here are
 * bytes that arrived", so the framing and the bookkeeping are tested with a
 * fake and the process plumbing lives in `phpantom.ts`.
 */

export interface Transport {
  write(bytes: Uint8Array): Promise<void>;
}

export interface Message {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One message, framed. Content-Length counts BYTES, not UTF-16 units. */
export function frame(message: Message): Uint8Array {
  const body = encoder.encode(JSON.stringify(message));
  const head = encoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

const CRLFCRLF = [13, 10, 13, 10];

function indexOfHeaderEnd(buf: Uint8Array): number {
  outer: for (let i = 0; i + 3 < buf.length; i++) {
    for (let j = 0; j < 4; j++) if (buf[i + j] !== CRLFCRLF[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * Reassembles messages from chunks cut anywhere: mid-header, mid-body, or
 * several messages in one chunk. A message whose body is not JSON is dropped,
 * not thrown on -- one bad frame must not kill the connection.
 */
export class Deframer {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): Message[] {
    const next = new Uint8Array(this.buf.length + chunk.length);
    next.set(this.buf, 0);
    next.set(chunk, this.buf.length);
    this.buf = next;

    const out: Message[] = [];
    for (;;) {
      const end = indexOfHeaderEnd(this.buf);
      if (end === -1) break;
      const header = decoder.decode(this.buf.subarray(0, end));
      const m = /content-length:\s*(\d+)/i.exec(header);
      if (!m) {
        // Not a header we can read: skip past it rather than wedge forever.
        this.buf = this.buf.slice(end + 4);
        continue;
      }
      const length = Number(m[1]);
      const start = end + 4;
      if (this.buf.length < start + length) break;
      const body = decoder.decode(this.buf.subarray(start, start + length));
      this.buf = this.buf.slice(start + length);
      try {
        out.push(JSON.parse(body) as Message);
      } catch {
        /* dropped, see above */
      }
    }
    return out;
  }
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

type ServerRequestHandler = (method: string, params: unknown) => unknown;
type NotificationHandler = (method: string, params: unknown) => void;

export class Connection {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly deframer = new Deframer();
  private closed: Error | null = null;

  constructor(
    private readonly transport: Transport,
    /** The server asked us something; the return value is the answer. */
    private readonly onRequest: ServerRequestHandler = () => null,
    private readonly onNotification: NotificationHandler = () => {},
  ) {}

  /** Feed bytes the server wrote. */
  receive(chunk: Uint8Array): void {
    for (const msg of this.deframer.push(chunk)) this.dispatch(msg);
  }

  private dispatch(msg: Message): void {
    if (msg.method !== undefined) {
      if (msg.id === undefined || msg.id === null) {
        this.onNotification(msg.method, msg.params);
        return;
      }
      let result: unknown = null;
      try {
        result = this.onRequest(msg.method, msg.params);
      } catch {
        result = null;
      }
      void this.send({ jsonrpc: '2.0', id: msg.id, result: result ?? null });
      return;
    }
    if (typeof msg.id !== 'number') return;
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    if (msg.error) waiter.reject(new RpcError(msg.error.message, msg.error.code));
    else waiter.resolve(msg.result);
  }

  private send(msg: Message): Promise<void> {
    if (this.closed) return Promise.reject(this.closed);
    return this.transport.write(frame(msg));
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 15_000): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`${method} timed out after ${timeoutMs}ms`, -32001));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send({ jsonrpc: '2.0', id, method, params }).catch((e: unknown) => {
        const waiter = this.pending.get(id);
        this.pending.delete(id);
        waiter?.reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params }).catch(() => {
      /* a notification to a dead server has nowhere to go */
    });
  }

  /** The server went away: every waiter fails now rather than at its timeout. */
  close(reason: Error): void {
    if (this.closed) return;
    this.closed = reason;
    for (const w of this.pending.values()) w.reject(reason);
    this.pending.clear();
  }
}
