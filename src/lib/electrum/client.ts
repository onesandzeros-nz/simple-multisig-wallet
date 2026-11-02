import { encodeRequest, errorMessage, feedLines, RpcResponse } from './protocol';

/**
 * Minimal Electrum client. The socket is injected so the whole protocol
 * can be driven by a fake in tests; React Native supplies a real TCP
 * socket via rnSocket.ts.
 */
export interface ElectrumSocket {
  write(data: string): void;
  destroy(): void;
  on(event: 'data', cb: (chunk: string) => void): void;
  on(event: 'connect' | 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

export interface ElectrumTarget {
  host: string;
  port: number;
  /** TLS on the wire — electrs commonly serves plain TCP on 50001. */
  tls?: boolean;
}

export type ElectrumSocketFactory = (target: ElectrumTarget) => ElectrumSocket;

const CLIENT_NAME = 'simple-multisig';
const PROTOCOL_VERSION = '1.4';
const DEFAULT_TIMEOUT_MS = 20_000;
// A single Electrum response line is at most a few hundred KB (a big address
// history). A server that streams past this without a newline is faulty or
// hostile and would otherwise grow the buffer without bound — cut it off.
const MAX_LINE_BYTES = 5_000_000;

export class ElectrumClient {
  private socket: ElectrumSocket | null = null;
  private buffered = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: any }>();
  private ready: Promise<void> | null = null;
  private closed = false;

  constructor(
    private target: ElectrumTarget,
    private factory: ElectrumSocketFactory,
    private timeoutMs = DEFAULT_TIMEOUT_MS
  ) {}

  /** Rejects the connection attempt in progress, if any. */
  private abortConnect: ((err: Error) => void) | null = null;

  /** Connects and negotiates the protocol version. Safe to call repeatedly. */
  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Connection closed.'));
    if (this.ready) return this.ready;
    let socket: ElectrumSocket;
    try {
      socket = this.factory(this.target);
    } catch (e: any) {
      return Promise.reject(new Error(`Could not open a connection: ${e?.message ?? e}`));
    }
    this.socket = socket;
    this.buffered = '';
    this.ready = new Promise<void>((resolve, reject) => {
      // Only the socket in use may fail the client's requests: a late event
      // from one already replaced settles its own attempt and nothing else.
      // A connection that never came up rejects this promise rather than
      // leaving callers waiting, and the next call opens a fresh socket.
      let settled = false;
      const dropped = (err: Error) => {
        if (this.socket === socket) {
          this.failAll(err);
          this.socket = null;
          this.ready = null;
        }
        if (!settled) {
          settled = true;
          if (this.abortConnect === dropped) this.abortConnect = null;
          try {
            socket.destroy();
          } catch {
            // already gone
          }
          reject(err);
        }
      };
      this.abortConnect = dropped;
      socket.on('data', (chunk: string) => {
        if (this.socket === socket) this.onData(chunk);
      });
      socket.on('error', (err: Error) => dropped(err instanceof Error ? err : new Error(String(err))));
      socket.on('close', () => dropped(new Error('The server closed the connection.')));
      socket.on('connect', () => {
        if (this.socket !== socket) return;
        // Version negotiation doubles as a liveness check.
        this.rpc('server.version', [CLIENT_NAME, PROTOCOL_VERSION]).then(
          () => {
            settled = true;
            if (this.abortConnect === dropped) this.abortConnect = null;
            resolve();
          },
          (e) => dropped(e)
        );
      });
    });
    return this.ready;
  }

  private onData(chunk: string): void {
    const { messages, rest } = feedLines(this.buffered, chunk);
    this.buffered = rest;
    if (this.buffered.length > MAX_LINE_BYTES) {
      // Drop this connection; the next call opens another.
      this.teardown(new Error('The server sent an oversized response.'));
      return;
    }
    for (const message of messages) this.dispatch(message);
  }

  private dispatch(message: RpcResponse): void {
    if (typeof message.id !== 'number') return; // server-pushed notification
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(errorMessage(message.error)));
    else waiter.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  /** Sends one request and resolves with its result. */
  rpc<T = any>(method: string, params: unknown[] = []): Promise<T> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error('Not connected.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The server did not answer "${method}" in time.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.write(encodeRequest({ id, method, params }));
      } catch (e: any) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`Could not send "${method}": ${e?.message ?? e}`));
      }
    });
  }

  /** Connects if needed, then sends. */
  async call<T = any>(method: string, params: unknown[] = []): Promise<T> {
    await this.connect();
    return this.rpc<T>(method, params);
  }

  /** Ends the current connection, failing what was in flight; the client itself stays usable. */
  private teardown(err: Error): void {
    const socket = this.socket;
    this.socket = null;
    this.ready = null;
    this.buffered = '';
    this.failAll(err);
    this.abortConnect?.(err);
    try {
      socket?.destroy();
    } catch {
      // already gone
    }
  }

  /** Ends the connection for good: later calls are refused. */
  close(): void {
    this.closed = true;
    this.teardown(new Error('Connection closed.'));
  }
}
