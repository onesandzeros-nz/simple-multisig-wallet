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

  /** Connects and negotiates the protocol version. Safe to call repeatedly. */
  connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      let socket: ElectrumSocket;
      try {
        socket = this.factory(this.target);
      } catch (e: any) {
        reject(new Error(`Could not open a connection: ${e?.message ?? e}`));
        return;
      }
      this.socket = socket;

      socket.on('data', (chunk: string) => this.onData(chunk));
      socket.on('error', (err: Error) => this.failAll(err instanceof Error ? err : new Error(String(err))));
      socket.on('close', () => {
        if (!this.closed) this.failAll(new Error('The server closed the connection.'));
      });
      socket.on('connect', () => {
        // Version negotiation doubles as a liveness check.
        this.rpc('server.version', [CLIENT_NAME, PROTOCOL_VERSION]).then(
          () => resolve(),
          (e) => reject(e)
        );
      });
    });
    return this.ready;
  }

  private onData(chunk: string): void {
    const { messages, rest } = feedLines(this.buffered, chunk);
    this.buffered = rest;
    if (this.buffered.length > MAX_LINE_BYTES) {
      const error = new Error('The server sent an oversized response.');
      this.buffered = '';
      this.failAll(error);
      this.close();
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

  close(): void {
    this.closed = true;
    this.failAll(new Error('Connection closed.'));
    try {
      this.socket?.destroy();
    } catch {
      // already gone
    }
    this.socket = null;
    this.ready = null;
  }
}
