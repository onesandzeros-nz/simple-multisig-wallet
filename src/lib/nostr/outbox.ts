import { NostrEvent, verifyEvent } from './crypto';
import { eventShaped, RelayAck, unrefTimer } from './client';
import { GroupMessage, MAX_EPOCH, MAX_PSBT_CHARS, Refusal, validateMessage } from './protocol';

/**
 * Store-and-forward for group messages. Relays are fire-and-forget by
 * default: a publish that lands on a closed socket, or that a relay quietly
 * refuses, is simply gone and the sender never knows. The outbox holds every
 * message until at least one relay has said `OK`, retrying with backoff while
 * a session is live and across restarts when it is persisted.
 *
 * It is shared by every live session a group has (the list's syncer, the
 * screen, its chat), so a message is retried once, not once per session.
 *
 * Rules that keep retry from undoing key rotation (REKEY-DESIGN.md):
 * - A message is stored as plaintext and encrypted again, under the current
 *   epoch, when the epoch has moved since it was last sent. A ciphertext from
 *   an old epoch is never replayed after a re-secure: it would be readable by
 *   whoever that epoch was sealed to and the new one deliberately is not.
 * - Every retry goes back through the session's guards, so nothing that must
 *   wait for rotation can slip out under the invite key, and only a `join`
 *   ever goes on the lobby.
 * - The original timestamp is kept when re-signing, so a stale retry can
 *   never overtake a newer message of a latest-wins type; and queued messages
 *   of those types are coalesced, so only the newest is ever retried.
 * - Rekey envelopes (sealed to one member, refused by anyone already above
 *   that epoch) are safe to republish as they are, and are never persisted.
 */

export interface OutboxItem {
  /** The id of the first event published for it — stable for screens. */
  id: string;
  /** A group message, or a sealed rekey envelope retried as it is. */
  kind: 'message' | 'envelope';
  message?: GroupMessage;
  /** Original `created_at` (seconds), kept on every re-sign. */
  createdAt: number;
  /** The epoch `event` was encrypted under (0 for the lobby). */
  epoch: number;
  /** On the lobby — the epoch-0 channel; only a `join` may be. */
  lobby: boolean;
  /** Retry the identical event only, never re-encrypt. */
  pinned: boolean;
  /** Publishes so far this launch. */
  attempts: number;
  /** Relays that have confirmed storing it. */
  storedOn: string[];
  /** The latest reason a relay gave for refusing it. */
  rejected?: string;
  /** The signed event last published. */
  event?: NostrEvent;
}

export interface OutboxStorage {
  /** Whatever is on disk, as parsed; `resumable` decides what is believed. */
  load(): Promise<unknown>;
  save(items: OutboxItem[]): Promise<void>;
}

// --- Resuming from disk --------------------------------------------------------
// App storage is not the keystore: a backup can bring it back altered, and
// what is resumed is published as this user, after the guards. So nothing
// read back is believed further than it can be checked.

/** Items resumed from disk: more than this is not a backlog, it is a tampered store. */
export const MAX_RESUMED_ITEMS = 100;
/** The most an outbox on disk may be before it is parsed — about four of the largest transactions. */
export const MAX_RESUMED_CHARS = 4 * MAX_PSBT_CHARS;

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * One stored item, believed only as far as it can be checked: the message
 * passes the same validation as one arriving from a relay, the flags are
 * typed, and the signed copy is kept only when it verifies and is the event
 * the item says it is — otherwise the item is signed afresh on its next
 * publish, back through the session's guards.
 */
export function validateOutboxItem(value: unknown): OutboxItem {
  const v = value as any;
  if (!v || typeof v !== 'object' || v.kind !== 'message') throw new Error('Not a stored message.');
  const message = validateMessage(v.message);
  if (typeof v.id !== 'string' || !HEX64.test(v.id)) throw new Error('Stored message has no event id.');
  if (!Number.isInteger(v.createdAt) || v.createdAt <= 0) throw new Error('Stored message has no time.');
  if (!Number.isInteger(v.epoch) || v.epoch < 0 || v.epoch >= MAX_EPOCH) {
    throw new Error('Stored message has an impossible epoch.');
  }
  if (typeof v.lobby !== 'boolean' || typeof v.pinned !== 'boolean') throw new Error('Stored message is malformed.');
  if (v.lobby && message.type !== 'join') throw new Error('Only a join belongs on the lobby.');
  const item: OutboxItem = {
    id: v.id,
    kind: 'message',
    message,
    createdAt: v.createdAt,
    epoch: v.epoch,
    lobby: v.lobby,
    pinned: v.pinned,
    attempts: 0,
    storedOn: Array.isArray(v.storedOn) ? v.storedOn.filter((u: unknown): u is string => typeof u === 'string').slice(0, 64) : [],
  };
  if (typeof v.rejected === 'string') item.rejected = v.rejected.slice(0, 200);
  const event = v.event;
  if (eventShaped(event) && event.id === v.id && event.created_at === v.createdAt && verifyEvent(event)) {
    item.event = event;
  }
  return item;
}

/**
 * What an outbox resumes from whatever was on disk: every item that passes
 * `validateOutboxItem`, each with a fresh attempt budget, in their original
 * order — and at most `MAX_RESUMED_ITEMS` of them, the newest.
 */
export function resumable(stored: unknown): OutboxItem[] {
  if (!Array.isArray(stored)) return [];
  const items: OutboxItem[] = [];
  for (const raw of stored) {
    try {
      items.push(validateOutboxItem(raw));
    } catch {
      // Not believed, so not resumed.
    }
  }
  if (items.length <= MAX_RESUMED_ITEMS) return items;
  const newest = new Set([...items].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_RESUMED_ITEMS));
  return items.filter((i) => newest.has(i));
}

/** What the outbox needs from a session to put an item on the wire. */
export interface OutboxPublisher {
  readonly epoch: number;
  /** Throws when the session's rules no longer allow the item on the wire. */
  check(item: OutboxItem): void;
  /**
   * Encrypts under the current epoch (or the lobby), signs with the item's
   * own timestamp and publishes. Throws when a guard refuses.
   */
  publishItem(item: OutboxItem): NostrEvent;
  /** Sends an already-signed event again. */
  republish(event: NostrEvent): void;
}

export interface OutboxOptions {
  storage?: OutboxStorage;
  /** Delay before the n-th retry, ms. Injectable for tests. */
  retryDelay?: (attempt: number) => number;
  /** Publishes per launch before an item is left for the next one. */
  maxAttempts?: number;
  onChange?: (items: OutboxItem[]) => void;
}

/** Message types where the newest from an author replaces the rest. */
const LATEST_WINS: GroupMessage['type'][] = ['selection', 'wallet', 'wallet-reply', 'join'];

/** 3s, 6s, 12s … capped at a minute: about four minutes of trying per launch. */
export function defaultRetryDelay(attempt: number): number {
  return Math.min(60_000, 3000 * 2 ** Math.max(0, attempt - 1));
}

export const DEFAULT_MAX_ATTEMPTS = 8;

/** `OK` with a `duplicate:` reason is a relay saying it already has it. */
function storedAlready(ack: RelayAck): boolean {
  return ack.ok || ack.reason.startsWith('duplicate:');
}

export class GroupOutbox {
  private items: OutboxItem[] = [];
  private publishers = new Set<OutboxPublisher>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Acks that arrived before their item was recorded (a relay answering within `publish`). */
  private earlyAcks = new Map<string, RelayAck[]>();
  private storage?: OutboxStorage;
  private retryDelay: (attempt: number) => number;
  private maxAttempts: number;
  private onChange: (items: OutboxItem[]) => void;
  /** Resolves once anything persisted has been read back. */
  readonly ready: Promise<void>;

  constructor(opts: OutboxOptions = {}) {
    this.storage = opts.storage;
    this.retryDelay = opts.retryDelay ?? defaultRetryDelay;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.onChange = opts.onChange ?? (() => {});
    this.ready = this.storage
      ? this.storage
          .load()
          .then((stored) => {
            const known = new Set(this.items.map((i) => i.id));
            const resumed = resumable(stored).filter((i) => !known.has(i.id));
            this.items = [...resumed, ...this.items];
            this.changed(false);
            this.schedule(0);
          })
          .catch(() => undefined)
      : Promise.resolve();
  }

  /** Everything not yet confirmed stored by a relay. */
  get pending(): OutboxItem[] {
    return this.items.map((i) => ({ ...i }));
  }

  attach(publisher: OutboxPublisher): void {
    this.publishers.add(publisher);
    // Anything resumed from storage is still waiting for its first publish.
    this.schedule(this.items.some((i) => i.attempts === 0) ? 0 : undefined);
  }

  detach(publisher: OutboxPublisher): void {
    this.publishers.delete(publisher);
    if (this.publishers.size === 0 && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Publishes a message now and keeps it until a relay confirms it. */
  enqueue(message: GroupMessage, where: { lobby: boolean; pinned?: boolean }, via: OutboxPublisher): NostrEvent {
    if (LATEST_WINS.includes(message.type)) {
      this.items = this.items.filter(
        (i) => !(i.kind === 'message' && i.message?.type === message.type && i.lobby === where.lobby)
      );
    }
    const item: OutboxItem = {
      id: '',
      kind: 'message',
      message,
      createdAt: Math.floor(Date.now() / 1000),
      epoch: where.lobby ? 0 : via.epoch,
      lobby: where.lobby,
      pinned: where.pinned ?? false,
      attempts: 0,
      storedOn: [],
    };
    const event = via.publishItem(item);
    item.id = event.id;
    item.event = event;
    item.attempts = 1;
    this.items.push(item);
    this.applyEarlyAcks(item);
    this.changed(true);
    this.schedule();
    return event;
  }

  /** Publishes a sealed rekey envelope and retries it unchanged. Never persisted. */
  enqueueEnvelope(event: NostrEvent, via: OutboxPublisher): void {
    const item: OutboxItem = {
      id: event.id,
      kind: 'envelope',
      createdAt: event.created_at,
      epoch: via.epoch,
      lobby: true,
      pinned: true,
      attempts: 1,
      storedOn: [],
      event,
    };
    via.republish(event);
    this.items.push(item);
    this.applyEarlyAcks(item);
    this.changed(false);
    this.schedule();
  }

  /** A relay answered about one of our events. */
  acked(eventId: string, ack: RelayAck): void {
    const item = this.items.find((i) => i.event?.id === eventId);
    if (!item) {
      const list = this.earlyAcks.get(eventId) ?? [];
      list.push(ack);
      this.earlyAcks.set(eventId, list);
      if (this.earlyAcks.size > 100) this.earlyAcks.delete(this.earlyAcks.keys().next().value as string);
      return;
    }
    this.apply(item, ack);
    this.changed(true);
  }

  /**
   * Drops everything, on disk included. For a wipe: the items are plaintext
   * — unsigned transactions, memos, chat — and must not outlive the keys.
   */
  clear(): void {
    this.items = [];
    this.earlyAcks.clear();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.changed(true);
  }

  /** Starts over on everything still waiting — a "try again" button. */
  kick(): void {
    for (const item of this.items) item.attempts = 0;
    this.schedule(0);
  }

  private applyEarlyAcks(item: OutboxItem): void {
    const id = item.event?.id;
    if (!id) return;
    const acks = this.earlyAcks.get(id);
    if (!acks) return;
    this.earlyAcks.delete(id);
    for (const ack of acks) this.apply(item, ack);
  }

  private apply(item: OutboxItem, ack: RelayAck): void {
    if (storedAlready(ack)) {
      if (!item.storedOn.includes(ack.url)) item.storedOn.push(ack.url);
      this.items = this.items.filter((i) => i !== item);
    } else {
      item.rejected = ack.reason || 'refused';
    }
  }

  private retryable(): OutboxItem[] {
    return this.items.filter((i) => i.attempts < this.maxAttempts);
  }

  private schedule(delay?: number): void {
    if (this.timer || this.publishers.size === 0) return;
    const waiting = this.retryable();
    if (waiting.length === 0) return;
    const wait = delay ?? this.retryDelay(Math.min(...waiting.map((i) => i.attempts)));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, wait);
    unrefTimer(this.timer);
  }

  private tick(): void {
    const via = this.best();
    if (!via) return;
    for (const item of this.retryable()) {
      try {
        // Every retry passes the rules again, identical republish included.
        if (item.kind === 'message') via.check(item);
        if (item.event && (item.kind === 'envelope' || item.pinned || item.lobby || item.epoch === via.epoch)) {
          via.republish(item.event);
        } else {
          // The epoch moved on (or the signed copy was never kept): encrypt
          // again under the current key, back through the session's guards.
          item.event = via.publishItem(item);
          item.epoch = via.epoch;
        }
        item.attempts += 1;
        this.applyEarlyAcks(item);
      } catch (e) {
        if (e instanceof Refusal) {
          // A rule refused it — it no longer belongs on the wire.
          this.items = this.items.filter((i) => i !== item);
        } else {
          // Anything else — a socket caught mid-close, say — is a failed
          // attempt, not a verdict: the message is still wanted.
          item.attempts += 1;
        }
      }
    }
    this.changed(true);
    this.schedule();
  }

  /** The session furthest along: the one on the newest epoch. */
  private best(): OutboxPublisher | null {
    let best: OutboxPublisher | null = null;
    for (const p of this.publishers) if (!best || p.epoch > best.epoch) best = p;
    return best;
  }

  private changed(persist: boolean): void {
    this.onChange(this.pending);
    if (persist && this.storage) {
      this.storage.save(this.items.filter((i) => i.kind === 'message')).catch((e) => {
        console.error(`[nostr:outbox] ${e?.message ?? e}`);
      });
    }
  }
}
