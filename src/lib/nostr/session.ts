import {
  channelId,
  decryptPayload,
  encryptPayload,
  generateSecretKey,
  getPublicKey,
  NostrEvent,
  openFrom,
  sealTo,
  signEvent,
} from './crypto';
import { RelayPool, SocketFactory } from './client';
import { GroupOutbox, OutboxItem, OutboxPublisher } from './outbox';
import { GroupEpoch } from '../types';
import {
  decodeMessage,
  decodeRekey,
  encodeMessage,
  encodeRekey,
  GroupMessage,
  GROUP_EVENT_KIND,
  JoinMessage,
  DELETE_EVENT_KIND,
  MAX_EPOCH,
  needsRotation,
  Refusal,
  REKEY_EVENT_KIND,
  validateMessage,
} from './protocol';

export { MAX_EPOCH };

export interface ReceivedMessage {
  /** Nostr event id — stable, used for dedupe and React keys. */
  id: string;
  /** Author's x-only pubkey; identifies the member. */
  author: string;
  /** True when this device published it. */
  mine: boolean;
  at: number;
  /** Which epoch key opened it — lets the coordinator see who has migrated. */
  epoch: number;
  message: GroupMessage;
}

/** A newly adopted epoch, handed to the app so it can be written to the keystore. */
export interface AdoptedEpoch extends GroupEpoch {
  members: string[];
  /** When the epoch began, ms: the envelope's time, or now for our own rotation. */
  at: number;
}

/**
 * A live connection to one group: subscribes to the channel, decrypts
 * everything it can, and publishes signed encrypted messages.
 *
 * The invite secret is a bearer credential, so the same rule applies in both
 * directions: in a rotating group nothing in `AFTER_ROTATION` is published
 * under epoch 0, and nothing in `AFTER_ROTATION` that *arrives* under epoch 0
 * is believed (`sealedOnly`). Whoever holds the invite can read the lobby and
 * write to it; they must not be able to put keys or transactions in front of
 * the group that way.
 *
 * The group key rotates (REKEY-DESIGN.md). A session holds every epoch secret
 * it has ever been given: it publishes only on the newest, and reads on the
 * newest, the one before it, and epoch 0.
 *
 * Epoch 0 — the secret from the invite — is never retired. It is the group's
 * permanent identity root (see identity.ts) and its lobby: a device restored
 * from a backup arrives holding nothing else, so that is where it announces
 * itself and where the coordinator seals it back in.
 */
export class GroupSession implements OutboxPublisher {
  readonly pubkey: string;
  private pool: RelayPool;
  private outbox: GroupOutbox;
  /** Ascending by epoch; `epochs[0]` is always epoch 0. */
  private epochs: GroupEpoch[];
  /** Channel tag → the epoch whose secret it is derived from. */
  private byChannel = new Map<string, GroupEpoch>();
  private identity: string;
  private coordinatorPubkey?: string;
  private rotation: boolean;
  private onMessage: (m: ReceivedMessage) => void = () => {};
  private onRekey: (e: AdoptedEpoch) => void = () => {};

  constructor(opts: {
    /** Every epoch secret this device holds. Must include epoch 0. */
    epochs: GroupEpoch[];
    relays: string[];
    /** Per-device Nostr identity for this group, derived from the epoch-0 secret. */
    identitySecret: string;
    /** Pinned coordinator. Rotations from anyone else are ignored. */
    coordinatorPubkey?: string;
    /**
     * True when this group's invite advertised rotation. Groups created
     * before rotation existed stay on epoch 0 and must keep working, so the
     * ordering rule below is only enforced where everyone can follow it.
     */
    rotation?: boolean;
    socketFactory?: SocketFactory;
    /**
     * Store-and-forward for everything this session publishes. Shared across
     * a group's live sessions by the app; a session without one gets a
     * private, in-memory outbox that still retries while it is alive.
     */
    outbox?: GroupOutbox;
    /** Backoff between reconnects, ms. Injectable for tests. */
    reconnectDelay?: (attempt: number) => number;
  }) {
    this.epochs = [...opts.epochs].sort((a, b) => a.epoch - b.epoch);
    if (this.epochs.length === 0 || this.epochs[0].epoch !== 0) {
      throw new Error('A group session needs its epoch-0 secret.');
    }
    this.index();
    this.identity = opts.identitySecret;
    this.coordinatorPubkey = opts.coordinatorPubkey;
    this.rotation = opts.rotation ?? false;
    this.pubkey = getPublicKey(opts.identitySecret);
    this.pool = new RelayPool(opts.relays, opts.socketFactory, { reconnectDelay: opts.reconnectDelay });
    this.outbox = opts.outbox ?? new GroupOutbox();
  }

  static newIdentity(): string {
    return generateSecretKey();
  }

  /** The epoch everything is published under. */
  get current(): GroupEpoch {
    return this.epochs[this.epochs.length - 1];
  }

  get epoch(): number {
    return this.current.epoch;
  }

  /** The invite secret — the identity root and the lobby channel. */
  private get root(): GroupEpoch {
    return this.epochs[0];
  }

  /** The channel this session publishes on. */
  get channel(): string {
    return channelId(this.current.secret);
  }

  /**
   * What we listen on: the current epoch, the one before it (so a member who
   * has not migrated yet is still heard), and epoch 0 (the lobby).
   */
  get channels(): string[] {
    const previous = this.epochs[this.epochs.length - 2];
    return [
      ...new Set([
        this.channel,
        ...(previous ? [channelId(previous.secret)] : []),
        channelId(this.root.secret),
      ]),
    ];
  }

  start(handlers: {
    onMessage: (m: ReceivedMessage) => void;
    onStatus?: (connected: number, total: number) => void;
    /** A new epoch arrived and has been adopted — persist it. */
    onRekey?: (e: AdoptedEpoch) => void;
  }): void {
    this.onMessage = handlers.onMessage;
    if (handlers.onRekey) this.onRekey = handlers.onRekey;
    this.pool.connect({
      onStatus: handlers.onStatus,
      onEvent: (event) => this.handleEvent(event),
      onAck: (id, ack) => this.outbox.acked(id, ack),
    });
    this.subscribe();
    this.outbox.attach(this);
  }

  /** Messages published by this group not yet confirmed stored by any relay. */
  get pending(): OutboxItem[] {
    return this.outbox.pending;
  }

  private subscribe(): void {
    this.pool.subscribe({
      kinds: [GROUP_EVENT_KIND, REKEY_EVENT_KIND],
      '#t': this.channels,
      limit: 500,
    });
  }

  private handleEvent(event: NostrEvent): void {
    if (event.kind === REKEY_EVENT_KIND) {
      this.handleRekey(event);
      return;
    }
    // Decrypt under the epoch the event is tagged for, and only that one.
    // Every event we publish carries its epoch's channel tag, so one tagged
    // for a channel we never derived is a relay misbehaving — and trying
    // every key we hold on it would be work done for whoever is feeding it.
    const epoch = this.epochFor(event);
    if (!epoch) return;
    let message: GroupMessage;
    try {
      message = decodeMessage(decryptPayload(epoch.secret, event.content));
    } catch {
      // Not ours, damaged, or outside the protocol's bounds — ignore quietly;
      // the channel is public.
      return;
    }
    // Mirror of the send guard. No member ever publishes these under the
    // invite key, so one that arrives that way was written by someone who
    // holds only the invite — drop it before any consumer can ingest it.
    if (this.sealedOnly(message.type, epoch.epoch)) return;
    this.onMessage({
      id: event.id,
      author: event.pubkey,
      mine: event.pubkey === this.pubkey,
      at: event.created_at * 1000,
      epoch: epoch.epoch,
      message,
    });
  }

  private index(): void {
    this.byChannel = new Map(this.epochs.map((e) => [channelId(e.secret), e]));
  }

  /** The epoch an event's channel tag names, if it is one of ours. */
  private epochFor(event: NostrEvent): GroupEpoch | undefined {
    for (const tag of event.tags) {
      if (tag[0] !== 't') continue;
      const epoch = this.byChannel.get(tag[1]);
      if (epoch) return epoch;
    }
    return undefined;
  }

  /**
   * A sealed epoch secret. Only the pinned coordinator may move the group —
   * otherwise anyone holding the invite could rotate it onto a key of their
   * own and split the group away from its real coordinator.
   */
  private handleRekey(event: NostrEvent): void {
    // A group from before rotation existed stays on epoch 0 for good, so a
    // rekey aimed at one is never legitimate. This is not belt and braces:
    // those invites carry no coordinator pubkey, so there would be nothing to
    // check the author against and any invite-holder could move the group.
    if (!this.rotation) return;
    // Required, not merely checked when present. Every invite that advertises
    // rotation also carries `c=`, so a missing pin means something is wrong
    // and accepting the rotation would be trusting an unauthenticated author.
    if (!this.coordinatorPubkey || event.pubkey !== this.coordinatorPubkey) return;
    let adopted: AdoptedEpoch;
    try {
      const rekey = decodeRekey(openFrom(this.identity, event.pubkey, event.content));
      adopted = { epoch: rekey.epoch, secret: rekey.secret, members: rekey.members, at: event.created_at * 1000 };
    } catch {
      // Sealed to someone else, or not a rekey at all.
      return;
    }
    // Never go backwards. A replayed envelope from an earlier epoch would
    // otherwise drag the group onto a key an old leak already covers. And
    // never past the ceiling: recovery stops believing numbers there, so a
    // group moved onto one could not be re-secured again.
    if (adopted.epoch <= this.epoch || adopted.epoch >= MAX_EPOCH) return;
    this.adopt(adopted);
    this.onRekey(adopted);
  }

  private adopt(next: GroupEpoch): void {
    if (this.epochs.some((e) => e.epoch === next.epoch)) return;
    this.epochs = [...this.epochs, { epoch: next.epoch, secret: next.secret }].sort(
      (a, b) => a.epoch - b.epoch
    );
    this.index();
    this.subscribe();
  }

  /**
   * Closes the roster and moves the group onto a fresh key: one sealed
   * envelope per member, then a notice on the old channel so anyone left out
   * can see what happened. Coordinator only.
   *
   * The new secret is never published under the old one. Relays keep events
   * forever, so an announcement carrying the key would hand it to whoever
   * obtains the invite next year along with everything it protects.
   *
   * `above` is the highest epoch the members are known to hold. It matters
   * only to a coordinator restored without its own copy of the current key
   * (RECOVERY-DESIGN.md): it sits at epoch 0, and members ignore any epoch
   * that is not higher than theirs.
   */
  rotate(members: string[], above = 0): AdoptedEpoch {
    // Rotating a legacy group would strand it: nobody else would accept the
    // new epoch, and this session would walk off the channel on its own.
    if (!this.rotation) throw new Error('This group was created before key rotation and cannot be secured.');
    // Epoch numbers reported by members are not authenticated. Refuse an
    // absurd one rather than climb towards where integers stop being exact
    // and "higher than yours" stops holding.
    if (!Number.isInteger(above) || above < 0 || above >= MAX_EPOCH) {
      throw new Error('The group reported an impossible key number.');
    }
    const roster = [...new Set(members.filter((m) => /^[0-9a-f]{64}$/i.test(m)))];
    const epoch = Math.max(this.epoch, above) + 1;
    // The same ceiling on the result. A session already sitting high must
    // not climb past where the rest of the protocol stops believing numbers.
    if (epoch >= MAX_EPOCH) throw new Error('This group has run out of key numbers and cannot be secured again.');
    const secret = generateSecretKey();
    const rekey = { type: 'rekey' as const, epoch, secret, members: roster };
    // Always on the lobby: every member listens there whatever epoch they are
    // on, so a device that missed several rotations still catches up. The
    // envelopes are sealed, so the lobby learns only that a rotation happened
    // — which the notice says in the clear anyway.
    const lobby = channelId(this.root.secret);
    // Sealed to ourselves as well: a group can have a second live session on
    // this same device (a list syncing behind the open screen), and it shares
    // our identity, so that is how it hears about the rotation.
    for (const member of roster) {
      this.outbox.enqueueEnvelope(
        signEvent(this.identity, {
          created_at: Math.floor(Date.now() / 1000),
          kind: REKEY_EVENT_KIND,
          tags: [['t', lobby]],
          content: sealTo(this.identity, member, encodeRekey(rekey)),
        }),
        this
      );
    }
    // On the OLD channel, before we move — that is where the members who have
    // not caught up are still listening.
    this.send({ type: 'rekey-notice', epoch });
    this.adopt({ epoch, secret });
    return { epoch, secret, members: roster, at: Date.now() };
  }

  /**
   * Hands the current epoch to one member again — a phone restored from a
   * backup, which arrives holding only the invite. Safe because the caller
   * only ever does this for a pubkey already on the roster, and that pubkey
   * cannot be produced without the member's own seed.
   */
  reseal(member: string, roster: string[]): void {
    if (this.epoch === 0) return;
    this.outbox.enqueueEnvelope(
      signEvent(this.identity, {
        created_at: Math.floor(Date.now() / 1000),
        kind: REKEY_EVENT_KIND,
        tags: [['t', channelId(this.root.secret)]],
        content: sealTo(
          this.identity,
          member,
          encodeRekey({ type: 'rekey', epoch: this.epoch, secret: this.current.secret, members: roster })
        ),
      }),
      this
    );
  }

  /**
   * Publishes a `join` on the lobby whatever epoch this session is on. It is
   * how a member answers a coordinator that has lost the key: a coordinator
   * on epoch 0 hears only the lobby. Nothing but `join` may go out this way —
   * everything else under the invite key is readable by whoever gets the
   * link.
   */
  announce(message: JoinMessage): string {
    if (message.type !== 'join') throw new Refusal('Only a join can be announced on the lobby.');
    const event = this.outbox.enqueue(message, { lobby: true, pinned: true }, this);
    this.handleEvent(event);
    return event.id;
  }

  /**
   * Encrypts, signs and publishes a message, and keeps it in the outbox until
   * a relay confirms it. Returns the event id.
   */
  send(message: GroupMessage): string {
    this.guard(message, false);
    // A rekey notice belongs on the channel it was sent on — the old one,
    // where the members who have not caught up are listening.
    const event = this.outbox.enqueue(message, { lobby: false, pinned: message.type === 'rekey-notice' }, this);
    // Reflect our own message immediately — relays may not echo it back.
    this.handleEvent(event);
    return event.id;
  }

  /**
   * The rules every publish — first or retried — has to pass. Checked again
   * on each retry because the outbox re-encrypts under whatever epoch the
   * session is on by then.
   */
  private guard(message: GroupMessage, lobby: boolean): void {
    // The bounds the receiving side enforces, applied here first: a message
    // too long to be believed is refused with a reason, not dropped in silence
    // by everyone else's phone.
    validateMessage(message);
    if (lobby) {
      if (message.type !== 'join') throw new Refusal('Only a join can be announced on the lobby.');
      return;
    }
    if (this.sealedOnly(message.type, this.epoch)) {
      throw new Refusal(
        'This group is not secured yet. The coordinator has to close the roster before keys and transactions can be shared.'
      );
    }
  }

  /**
   * Whether a message of this type may only ever travel under a rotated key.
   * One predicate for both directions, so what we refuse to send is exactly
   * what we refuse to believe. Groups from before rotation stay on epoch 0
   * for good and carry everything there.
   */
  private sealedOnly(type: GroupMessage['type'], epoch: number): boolean {
    return this.rotation && epoch === 0 && needsRotation(type);
  }

  /** For the outbox: whether an item may still go on the wire from this session. */
  check(item: OutboxItem): void {
    if (!item.message) throw new Refusal('Nothing to publish.');
    this.guard(item.message, item.lobby);
  }

  /** For the outbox: encrypt under the epoch the item belongs on, sign with its own time, publish. */
  publishItem(item: OutboxItem): NostrEvent {
    if (!item.message) throw new Refusal('Nothing to publish.');
    this.guard(item.message, item.lobby);
    const epoch = item.lobby ? this.root : this.current;
    const event = signEvent(this.identity, {
      created_at: item.createdAt,
      kind: GROUP_EVENT_KIND,
      tags: [['t', channelId(epoch.secret)]],
      content: encryptPayload(epoch.secret, encodeMessage(item.message)),
    });
    this.pool.publish(event);
    return event;
  }

  /** For the outbox: the same signed event again. Relays dedupe by id. */
  republish(event: NostrEvent): void {
    this.pool.publish(event);
  }

  /**
   * Asks the relays to forget events we published (NIP-09). Relays only
   * honour deletions signed by the original author, so this can only ever
   * remove our own messages — and honouring it at all is voluntary, so
   * treat it as best-effort cleanup, not a guarantee.
   */
  requestDeletion(eventIds: string[]): void {
    if (eventIds.length === 0) return;
    const event = signEvent(this.identity, {
      created_at: Math.floor(Date.now() / 1000),
      kind: DELETE_EVENT_KIND,
      tags: eventIds.map((id) => ['e', id]),
      content: '',
    });
    this.pool.publish(event);
  }

  get connected(): number {
    return this.pool.connectedCount;
  }

  stop(): void {
    this.outbox.detach(this);
    this.pool.close();
  }
}
