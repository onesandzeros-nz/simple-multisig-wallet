import { WebSocketLike } from '../src/lib/nostr/client';

/**
 * An in-memory relay for the tests: every socket opened through `factory`
 * joins the same room. Events are fanned out to the other subscribed
 * sockets, and — like a real relay — answered with `OK`, unless the test
 * wants a relay that keeps quiet or refuses.
 */
export function makeFakeRelay(
  opts: {
    /** Keep events and replay them to later subscriptions. */
    retain?: boolean;
    /** Answer `OK` to publishes (default true). */
    ack?: boolean;
    /** A reason to refuse an event with, or null to accept it. */
    reject?: (event: any) => string | null;
  } = {}
) {
  const sockets: FakeSocket[] = [];
  const log: any[] = [];
  let stored: any[] = [];
  const matches = (filter: any, event: any) =>
    (!filter.kinds || filter.kinds.includes(event.kind)) &&
    (!filter['#t'] || event.tags.some((t: string[]) => t[0] === 't' && filter['#t'].includes(t[1])));

  class FakeSocket implements WebSocketLike {
    onopen: ((ev?: any) => void) | null = null;
    onmessage: ((ev: { data: any }) => void) | null = null;
    onerror: ((ev?: any) => void) | null = null;
    onclose: ((ev?: any) => void) | null = null;
    subscribed = false;
    closed = false;

    constructor() {
      sockets.push(this);
      setTimeout(() => this.onopen?.(), 0);
    }
    send(data: string): void {
      if (this.closed) return;
      const msg = JSON.parse(data);
      log.push(msg);
      if (msg[0] === 'REQ') {
        this.subscribed = true;
        for (const event of stored) {
          if (matches(msg[2], event)) this.onmessage?.({ data: JSON.stringify(['EVENT', msg[1], event]) });
        }
      } else if (msg[0] === 'EVENT') {
        const event = msg[1];
        const reason = opts.reject?.(event) ?? null;
        if (reason === null) {
          if (opts.retain && !stored.some((e) => e.id === event.id)) stored.push(event);
          for (const peer of sockets) {
            if (peer === this || peer.closed || !peer.subscribed) continue;
            peer.onmessage?.({ data: JSON.stringify(['EVENT', 'sub', event]) });
          }
        }
        if (opts.ack !== false) {
          // Real relays answer on the wire, never inside the caller's `send`.
          setTimeout(() => {
            if (!this.closed) this.onmessage?.({ data: JSON.stringify(['OK', event.id, reason === null, reason ?? '']) });
          }, 0);
        }
      }
    }
    close(): void {
      if (this.closed) return;
      this.closed = true;
      this.onclose?.();
    }
  }

  return {
    factory: () => new FakeSocket(),
    log,
    sockets,
    /** Published events, in order. */
    events: () => log.filter((m) => m[0] === 'EVENT').map((m) => m[1]),
    prune: (drop: (event: any) => boolean) => {
      stored = stored.filter((e) => !drop(e));
    },
  };
}
