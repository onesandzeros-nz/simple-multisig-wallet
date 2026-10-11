import { NostrEvent, verifyEvent } from './crypto';

/**
 * Minimal multi-relay Nostr client (NIP-01 over WebSocket).
 * The socket factory is injectable so tests can drive a fake relay.
 *
 * A relay that drops the connection is reopened with backoff, the
 * subscription is sent again, and anything queued meanwhile goes out. Every
 * `OK` a relay sends about one of our events is reported, so the session's
 * outbox can tell "stored somewhere" from "fire and forget".
 */

export interface Filter {
  kinds?: number[];
  '#t'?: string[];
  since?: number;
  limit?: number;
}

export type SocketFactory = (url: string) => WebSocketLike;

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev?: any) => void) | null;
  onmessage: ((ev: { data: any }) => void) | null;
  onerror: ((ev?: any) => void) | null;
  onclose: ((ev?: any) => void) | null;
}

/** What one relay said about an event we published (NIP-01 `OK`). */
export interface RelayAck {
  url: string;
  ok: boolean;
  /** The relay's reason, machine-prefixed per NIP-01 (`blocked:`, `rate-limited:`…), or ''. */
  reason: string;
}

const defaultFactory: SocketFactory = (url) => new WebSocket(url) as unknown as WebSocketLike;

/** The first retry is quick; later ones back off to about half a minute. */
export function defaultReconnectDelay(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
}

/** A timer must not keep a Node process (the tests) alive; React Native has no unref. */
export function unrefTimer(t: unknown): void {
  const h = t as { unref?: () => void } | null;
  if (h && typeof h.unref === 'function') h.unref();
}

/** Events kept per relay while it is down. The oldest go when it is full. */
const MAX_QUEUED = 200;

// --- Inbound bounds ----------------------------------------------------------
// A relay is anyone's server. One that streams validly signed junk matching
// our filter must cost us bounded memory and CPU, so everything it sends is
// checked for size and shape before it is parsed or verified, counted against
// a budget, and remembered only up to a cap.

/**
 * The largest frame a relay may hand us, in characters, before it is parsed.
 * Our biggest legitimate event is a `psbt` message at `MAX_PSBT_CHARS` of
 * base64: padded to the next 128 KiB, sealed, base64'd again and wrapped in
 * an event — a little over 1,050,000 characters. `tests/client.test.ts`
 * checks that one still fits.
 */
export const MAX_FRAME_CHARS = 1_200_000;
/** Event ids remembered for dedupe. The oldest are forgotten first. */
export const MAX_SEEN = 5_000;
/** Ids of our own events whose `OK` we still care about. The oldest are forgotten first. */
export const MAX_PUBLISHED = 1_000;
/**
 * Events accepted from one relay per window; the rest of the window is
 * dropped. A subscription replays at most `limit` (500) stored events, and a
 * live group produces a few a minute, so this is far above honest traffic.
 */
export const DEFAULT_INBOUND_BUDGET = { events: 1_000, windowMs: 60_000 };

export interface InboundBudget {
  events: number;
  windowMs: number;
}

/** Adds to an insertion-ordered set, forgetting the oldest once it is full. */
function remember(set: Set<string>, id: string, cap: number): void {
  set.add(id);
  while (set.size > cap) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

const HEX64 = /^[0-9a-f]{64}$/i;
const HEX128 = /^[0-9a-f]{128}$/i;

/**
 * Cheap structural checks before the signature is verified: is this even
 * shaped like an event, and is it one we asked for? A relay sending events
 * outside our filter is misbehaving, and verifying them would be work done
 * for whoever is feeding it.
 */
export function eventShaped(event: any, filter: Filter | null = null): event is NostrEvent {
  if (!event || typeof event !== 'object') return false;
  if (!HEX64.test(event.id) || !HEX64.test(event.pubkey) || !HEX128.test(event.sig)) return false;
  if (!Number.isInteger(event.kind) || !Number.isInteger(event.created_at)) return false;
  if (typeof event.content !== 'string' || !Array.isArray(event.tags)) return false;
  if (!event.tags.every((t: unknown) => Array.isArray(t) && t.every((x) => typeof x === 'string'))) return false;
  if (!filter) return true;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  const channels = filter['#t'];
  if (channels && !event.tags.some((t: string[]) => t[0] === 't' && channels.includes(t[1]))) return false;
  return true;
}

interface RelayState {
  url: string;
  socket: WebSocketLike | null;
  open: boolean;
  /** Events waiting for the socket — the newest copy of each, by id. */
  pending: Map<string, string>;
  /** Reconnects scheduled since the socket was last open. */
  attempts: number;
  reconnect: ReturnType<typeof setTimeout> | null;
  /** Events accepted from this relay in the current budget window. */
  window: { start: number; count: number };
}

export class RelayPool {
  private relays: RelayState[];
  private factory: SocketFactory;
  private subId: string;
  private filter: Filter | null = null;
  private seen = new Set<string>();
  /** Ids we published, so a stray `OK` about someone else's event is ignored. */
  private published = new Set<string>();
  private onEvent: (e: NostrEvent) => void = () => {};
  private onStatus: (connected: number, total: number) => void = () => {};
  private onAck: (eventId: string, ack: RelayAck) => void = () => {};
  private reconnectDelay: (attempt: number) => number;
  private budget: InboundBudget;
  private closed = false;
  /** What the inbound bounds have turned away — for diagnostics and the tests. */
  readonly stats = { oversized: 0, malformed: 0, throttled: 0 };

  constructor(
    urls: string[],
    factory: SocketFactory = defaultFactory,
    opts: { reconnectDelay?: (attempt: number) => number; inboundBudget?: InboundBudget } = {}
  ) {
    this.relays = urls.map((url) => ({
      url,
      socket: null,
      open: false,
      pending: new Map(),
      attempts: 0,
      reconnect: null,
      window: { start: 0, count: 0 },
    }));
    this.factory = factory;
    this.reconnectDelay = opts.reconnectDelay ?? defaultReconnectDelay;
    this.budget = opts.inboundBudget ?? DEFAULT_INBOUND_BUDGET;
    this.subId = `sm-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }

  /** Charges one event to the relay's window; false once the window is spent. */
  private withinBudget(relay: RelayState, now = Date.now()): boolean {
    if (now - relay.window.start >= this.budget.windowMs) relay.window = { start: now, count: 0 };
    if (relay.window.count >= this.budget.events) return false;
    relay.window.count += 1;
    return true;
  }

  get connectedCount(): number {
    return this.relays.filter((r) => r.open).length;
  }

  get relayCount(): number {
    return this.relays.length;
  }

  connect(
    handlers: {
      onEvent?: (e: NostrEvent) => void;
      onStatus?: (c: number, t: number) => void;
      onAck?: (eventId: string, ack: RelayAck) => void;
    } = {}
  ): void {
    if (handlers.onEvent) this.onEvent = handlers.onEvent;
    if (handlers.onStatus) this.onStatus = handlers.onStatus;
    if (handlers.onAck) this.onAck = handlers.onAck;
    for (const relay of this.relays) this.openRelay(relay);
  }

  private openRelay(relay: RelayState): void {
    if (this.closed || relay.socket) return;
    let socket: WebSocketLike;
    try {
      socket = this.factory(relay.url);
    } catch {
      this.scheduleReconnect(relay);
      return;
    }
    relay.socket = socket;

    socket.onopen = () => {
      relay.open = true;
      relay.attempts = 0;
      if (this.filter) socket.send(JSON.stringify(['REQ', this.subId, this.filter]));
      for (const msg of relay.pending.values()) socket.send(msg);
      relay.pending.clear();
      this.onStatus(this.connectedCount, this.relays.length);
    };
    socket.onmessage = (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : String(ev.data);
      if (data.length > MAX_FRAME_CHARS) {
        this.stats.oversized += 1;
        return;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      if (!Array.isArray(parsed)) return;
      if (parsed[0] === 'EVENT' && parsed[2]) {
        const event = parsed[2];
        if (!eventShaped(event, this.filter)) {
          this.stats.malformed += 1;
          return;
        }
        // Duplicates are cheap to turn away and never charged; verifying a
        // signature is the cost worth budgeting.
        if (this.seen.has(event.id)) return;
        if (!this.withinBudget(relay)) {
          this.stats.throttled += 1;
          return;
        }
        if (!verifyEvent(event)) {
          this.stats.malformed += 1;
          return;
        }
        remember(this.seen, event.id, MAX_SEEN);
        this.onEvent(event);
      } else if (parsed[0] === 'OK' && typeof parsed[1] === 'string') {
        if (!this.published.has(parsed[1])) return;
        this.onAck(parsed[1], {
          url: relay.url,
          ok: parsed[2] === true,
          reason: typeof parsed[3] === 'string' ? parsed[3] : '',
        });
      }
    };
    socket.onerror = () => {
      relay.open = false;
      this.onStatus(this.connectedCount, this.relays.length);
    };
    socket.onclose = () => {
      relay.open = false;
      relay.socket = null;
      this.onStatus(this.connectedCount, this.relays.length);
      this.scheduleReconnect(relay);
    };
  }

  private scheduleReconnect(relay: RelayState): void {
    if (this.closed || relay.reconnect) return;
    const delay = this.reconnectDelay(relay.attempts);
    relay.attempts += 1;
    relay.reconnect = setTimeout(() => {
      relay.reconnect = null;
      this.openRelay(relay);
    }, delay);
    unrefTimer(relay.reconnect);
  }

  subscribe(filter: Filter): void {
    this.filter = filter;
    const req = JSON.stringify(['REQ', this.subId, filter]);
    for (const relay of this.relays) {
      if (relay.open && relay.socket) relay.socket.send(req);
    }
  }

  /**
   * Sends an event to every relay, or queues it for the ones that are down.
   * Publishing the same event again replaces its queued copy, so retries
   * never pile up behind a dead socket.
   */
  publish(event: NostrEvent): void {
    remember(this.published, event.id, MAX_PUBLISHED);
    // Our own events never come back to us as duplicates.
    remember(this.seen, event.id, MAX_SEEN);
    const msg = JSON.stringify(['EVENT', event]);
    for (const relay of this.relays) {
      if (relay.open && relay.socket) {
        relay.socket.send(msg);
        continue;
      }
      relay.pending.delete(event.id);
      relay.pending.set(event.id, msg);
      while (relay.pending.size > MAX_QUEUED) {
        const oldest = relay.pending.keys().next().value;
        if (oldest === undefined) break;
        relay.pending.delete(oldest);
      }
    }
  }

  close(): void {
    this.closed = true;
    for (const relay of this.relays) {
      if (relay.reconnect) clearTimeout(relay.reconnect);
      relay.reconnect = null;
      try {
        if (relay.socket && relay.open) relay.socket.send(JSON.stringify(['CLOSE', this.subId]));
        relay.socket?.close();
      } catch {
        // socket already gone
      }
      relay.socket = null;
      relay.open = false;
    }
  }
}
