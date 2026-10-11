import { Buffer } from 'buffer';
import { NetworkName } from '../types';

/**
 * Group coordination protocol carried inside encrypted Nostr events.
 * Every payload is JSON with a `type` discriminator.
 */

export const GROUP_EVENT_KIND = 9797;
/** Carries an epoch secret sealed to one member. See REKEY-DESIGN.md. */
export const REKEY_EVENT_KIND = 9798;
/** NIP-09 deletion request. */
export const DELETE_EVENT_KIND = 5;

export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
];

export interface JoinMessage {
  type: 'join';
  /** Display name of the member. */
  name: string;
  /**
   * True when this member's app understands epoch rotation. The coordinator
   * will not rotate until everyone who joined has said so, because a member
   * that cannot follow would simply stop seeing the group.
   */
  rekey?: boolean;
  /**
   * The epoch the sender holds. Set only when answering a coordinator that
   * has lost the group key (RECOVERY-DESIGN.md), so it can re-secure the group
   * above the epoch members are on.
   */
  epoch?: number;
}

export interface KeyMessage {
  type: 'key';
  name: string;
  /** Descriptor key expression: [fingerprint/path]xpub */
  keyExpression: string;
}

/**
 * The coordinator's current pick of which contributed keys go into the
 * wallet. Advisory: it lets every member see live whether their key made
 * it in. The wallet itself is still verified against the agreed policy
 * when it arrives.
 */
export interface SelectionMessage {
  type: 'selection';
  /** Account xpubs chosen, in the order they will appear in the wallet. */
  xpubs: string[];
}

export interface WalletMessage {
  type: 'wallet';
  name: string;
  /** wsh(sortedmulti(...)) descriptor with checksum. */
  descriptor: string;
  /**
   * Who holds each key, in the descriptor's key order — the names the keys
   * were shared under — so the wallet arrives as "Alice, Bob, Rob's phone"
   * rather than cosigners 1, 2 and 3. Absent from older builds.
   */
  names?: string[];
}

/**
 * A member's answer to the wallet the coordinator shared: added to their
 * phone, or declined. Carries the descriptor it answers, so an answer to an
 * earlier build is never read as an answer to the current one.
 */
export interface WalletReplyMessage {
  type: 'wallet-reply';
  name: string;
  accepted: boolean;
  descriptor: string;
}

export interface PsbtMessage {
  type: 'psbt';
  base64: string;
  memo?: string;
}

/**
 * A member saying a shared transaction reached their wallet. Keyed on the
 * unsigned txid rather than an event id, so it survives the sender's copy
 * being re-signed and re-sent.
 */
export interface PsbtAckMessage {
  type: 'psbt-ack';
  txid: string;
}

export interface ChatMessage {
  type: 'chat';
  name: string;
  text: string;
}

/** Announces that the transaction was broadcast, so the group can stop signing it. */
export interface BroadcastMessage {
  type: 'broadcast';
  /** The broadcast txid — for P2WSH this equals the unsigned template's txid. */
  txid: string;
  memo?: string;
}

/**
 * Says an epoch exists, without carrying it. Published on the OLD channel so
 * a member who never received a sealed copy learns it was left behind rather
 * than watching the group apparently fall silent.
 */
export interface RekeyNoticeMessage {
  type: 'rekey-notice';
  epoch: number;
}

export type GroupMessage =
  | JoinMessage
  | KeyMessage
  | SelectionMessage
  | WalletMessage
  | WalletReplyMessage
  | PsbtMessage
  | PsbtAckMessage
  | ChatMessage
  | BroadcastMessage
  | RekeyNoticeMessage;

/**
 * Messages that must never cross epoch 0. The invite secret is a bearer
 * credential sent through WhatsApp and the like, and relays keep events
 * forever, so anything published under it is readable by whoever obtains the
 * link later. Account xpubs and descriptors are the worst of it — an xpub
 * exposes a wallet's whole address history — so they wait for a rotated key.
 */
const AFTER_ROTATION: GroupMessage['type'][] = ['key', 'selection', 'wallet', 'wallet-reply', 'psbt', 'psbt-ack', 'broadcast'];

export function needsRotation(type: GroupMessage['type']): boolean {
  return AFTER_ROTATION.includes(type);
}

export function encodeMessage(message: GroupMessage): string {
  return JSON.stringify(message);
}

// --- Bounds ------------------------------------------------------------------
// Everything a message carries is attacker-controlled once it has left the
// phone that wrote it: the invite is a bearer credential and relays are
// anyone's. So every field is bounded, on the way in (`decodeMessage`) and on
// the way out (`GroupSession` runs `validateMessage` in its send guard), and
// a hostile member cannot fill the store or stall the screen.

/**
 * Epoch numbers at or above this are not believed anywhere: not in a sealed
 * rekey, a notice, or a member's answer to a lost coordinator, and `rotate`
 * refuses to issue one. Climbing towards where integers stop being exact is
 * where "higher than yours" stops holding.
 */
export const MAX_EPOCH = 1_000_000;
/**
 * A member's, key's or wallet's display name. Generous on purpose: the inputs
 * cap lower (`NAME_INPUT_CHARS` in naming.ts), and a contributed key is named
 * `member · key`, which has to fit too.
 */
export const MAX_NAME_CHARS = 128;
/** One chat line. The chat screen caps input at the same number. */
export const MAX_CHAT_CHARS = 2_000;
/** A memo on a transaction or broadcast. */
export const MAX_MEMO_CHARS = 280;
/** One descriptor key expression — `[fp/path]xpub/<0;1>/*` is well under 200. */
export const MAX_KEY_EXPRESSION_CHARS = 256;
/** A wallet descriptor: `MAX_COSIGNERS` key expressions plus the wrapper and checksum. */
export const MAX_DESCRIPTOR_CHARS = 8_192;
/** A PSBT in base64 — `wallet.ts` puts the same bound on anything it parses. */
export const MAX_PSBT_CHARS = 750_000;
/** Pubkeys a rekey envelope may list. */
export const MAX_ROSTER = 64;

const HEX64 = /^[0-9a-f]{64}$/i;

/** 1 ≤ epoch < MAX_EPOCH. */
export function isEpoch(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v < MAX_EPOCH;
}

/** A required string field, bounded. The errors read well on the sender's own screen. */
/**
 * A message refused by the sender's own rules — malformed, over a bound, or
 * not allowed on this channel yet. Told apart from everything else that can
 * go wrong on the way to a relay: the outbox drops what is refused and keeps
 * trying the rest.
 */
export class Refusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Refusal';
  }
}

function text(v: unknown, max: number, kind: string, what: string): string {
  if (typeof v !== 'string') throw new Refusal(`Malformed ${kind}.`);
  if (v.length > max) throw new Refusal(`${what} is too long: ${v.length} characters, the most is ${max}.`);
  return v;
}

function optionalText(v: unknown, max: number, kind: string, what: string): string | undefined {
  return v === undefined ? undefined : text(v, max, kind, what);
}

function txid(v: unknown, kind: string): string {
  if (typeof v !== 'string' || !HEX64.test(v)) throw new Refusal(`Malformed ${kind}.`);
  return v;
}

/**
 * Checks a decoded message field by field and returns a copy holding only the
 * fields the protocol knows. Throws on anything missing, mistyped, out of
 * bounds, or of a type that does not exist.
 */
export function validateMessage(value: unknown): GroupMessage {
  const p = value as Record<string, unknown> | null;
  if (!p || typeof p !== 'object' || typeof p.type !== 'string') throw new Refusal('Malformed group message.');
  switch (p.type) {
    case 'join': {
      const m: JoinMessage = { type: 'join', name: text(p.name, MAX_NAME_CHARS, 'join', 'The name') };
      if (p.rekey !== undefined) {
        if (typeof p.rekey !== 'boolean') throw new Refusal('Malformed join.');
        m.rekey = p.rekey;
      }
      if (p.epoch !== undefined) {
        if (!isEpoch(p.epoch)) throw new Refusal('Malformed join.');
        m.epoch = p.epoch;
      }
      return m;
    }
    case 'key':
      return {
        type: 'key',
        name: text(p.name, MAX_NAME_CHARS, 'key share', 'The name'),
        keyExpression: text(p.keyExpression, MAX_KEY_EXPRESSION_CHARS, 'key share', 'The key'),
      };
    case 'selection': {
      if (!Array.isArray(p.xpubs)) throw new Refusal('Malformed selection.');
      if (p.xpubs.length > MAX_COSIGNERS) {
        throw new Refusal(`The selection lists too many keys: ${p.xpubs.length}, the most is ${MAX_COSIGNERS}.`);
      }
      return {
        type: 'selection',
        xpubs: p.xpubs.map((x) => text(x, MAX_KEY_EXPRESSION_CHARS, 'selection', 'A selected key')),
      };
    }
    case 'wallet': {
      const wallet: WalletMessage = {
        type: 'wallet',
        name: text(p.name, MAX_NAME_CHARS, 'wallet', 'The wallet name'),
        descriptor: text(p.descriptor, MAX_DESCRIPTOR_CHARS, 'wallet', 'The wallet descriptor'),
      };
      if (p.names !== undefined) {
        if (!Array.isArray(p.names)) throw new Refusal('Malformed wallet.');
        if (p.names.length > MAX_COSIGNERS) {
          throw new Refusal(`The wallet names too many keys: ${p.names.length}, the most is ${MAX_COSIGNERS}.`);
        }
        wallet.names = p.names.map((n: unknown) => text(n, MAX_NAME_CHARS, 'wallet', 'A key holder’s name'));
      }
      return wallet;
    }
    case 'wallet-reply':
      if (typeof p.accepted !== 'boolean') throw new Refusal('Malformed wallet reply.');
      return {
        type: 'wallet-reply',
        name: text(p.name, MAX_NAME_CHARS, 'wallet reply', 'The name'),
        accepted: p.accepted,
        descriptor: text(p.descriptor, MAX_DESCRIPTOR_CHARS, 'wallet reply', 'The wallet descriptor'),
      };
    case 'psbt': {
      const m: PsbtMessage = { type: 'psbt', base64: text(p.base64, MAX_PSBT_CHARS, 'transaction', 'The transaction') };
      const memo = optionalText(p.memo, MAX_MEMO_CHARS, 'transaction', 'The memo');
      if (memo !== undefined) m.memo = memo;
      return m;
    }
    case 'psbt-ack':
      return { type: 'psbt-ack', txid: txid(p.txid, 'transaction receipt') };
    case 'chat':
      return {
        type: 'chat',
        name: text(p.name, MAX_NAME_CHARS, 'chat message', 'The name'),
        text: text(p.text, MAX_CHAT_CHARS, 'chat message', 'The message'),
      };
    case 'broadcast': {
      const m: BroadcastMessage = { type: 'broadcast', txid: txid(p.txid, 'broadcast') };
      const memo = optionalText(p.memo, MAX_MEMO_CHARS, 'broadcast', 'The memo');
      if (memo !== undefined) m.memo = memo;
      return m;
    }
    case 'rekey-notice':
      if (!isEpoch(p.epoch)) throw new Refusal('Malformed rekey notice.');
      return { type: 'rekey-notice', epoch: p.epoch };
    default:
      throw new Refusal(`Unknown group message type "${p.type}".`);
  }
}

export function decodeMessage(json: string): GroupMessage {
  return validateMessage(JSON.parse(json));
}

// --- Epoch rotation ----------------------------------------------------------

/**
 * A new epoch secret. Deliberately NOT part of `GroupMessage`: it is only ever
 * sealed pairwise to one member, and keeping it out of that union means the
 * type system refuses to hand it to `GroupSession.send`, which would publish
 * it under the very key it is meant to replace.
 */
export interface RekeyMessage {
  type: 'rekey';
  /** The epoch this secret opens. Monotonic, starts at 1. */
  epoch: number;
  /** 32 bytes, hex. */
  secret: string;
  /** The roster it was sealed to — x-only pubkeys, so members can see who is in. */
  members: string[];
}

export function encodeRekey(message: RekeyMessage): string {
  return JSON.stringify(message);
}

export function decodeRekey(json: string): RekeyMessage {
  const parsed = JSON.parse(json);
  if (!parsed || parsed.type !== 'rekey') throw new Error('Not a rekey message.');
  // Only the pinned coordinator can produce one of these, but its number is
  // still bounded: an epoch at the ceiling could never be re-secured again.
  if (!isEpoch(parsed.epoch)) throw new Error('Rekey has an invalid epoch.');
  if (typeof parsed.secret !== 'string' || !HEX64.test(parsed.secret)) {
    throw new Error('Rekey has an invalid secret.');
  }
  const members = Array.isArray(parsed.members)
    ? parsed.members.filter((x: unknown): x is string => typeof x === 'string' && HEX64.test(x)).slice(0, MAX_ROSTER)
    : [];
  return { type: 'rekey', epoch: parsed.epoch, secret: parsed.secret.toLowerCase(), members };
}

// --- Invites -----------------------------------------------------------------

/** Largest cosigner count an invite may claim — bounds render work / DoS. */
export const MAX_COSIGNERS = 20;
/** Relays an invite may list, or a phone may be configured with: each is a connection every group keeps open. */
export const MAX_RELAYS = 20;

export interface Invite {
  secret: string;
  relays: string[];
  /** Group name chosen by the coordinator. */
  name: string;
  /** The coordinator's per-group Nostr pubkey (x-only hex), if the invite carries it. */
  coordinatorPubkey?: string;
  /** Agreed policy — how many signatures, out of how many keys. */
  m: number;
  n: number;
  /** Everyone must build on the same network. */
  network: NetworkName;
  /**
   * True when the coordinator's app rotates the group key once the roster
   * closes. Absent on invites from builds before rotation existed, which stay
   * on epoch 0 for the life of the group.
   */
  rekey?: boolean;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Buffer {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64');
}

/**
 * Invite URI. Compact enough for a single QR code:
 *   multisig:join?v=1&s=<base64url secret>&n=<name>&r=<relay>&r=<relay>
 */
export function encodeInvite(invite: Invite): string {
  const params = [
    'v=1',
    `s=${base64url(Buffer.from(invite.secret, 'hex'))}`,
    `n=${encodeURIComponent(invite.name)}`,
    `m=${invite.m}`,
    `t=${invite.n}`,
    ...(invite.coordinatorPubkey ? [`c=${invite.coordinatorPubkey}`] : []),
    ...(invite.rekey ? ['k=1'] : []),
    ...(invite.network === 'testnet' ? ['net=t'] : []),
    ...invite.relays.map((r) => `r=${encodeURIComponent(r)}`),
  ];
  return `multisig:join?${params.join('&')}`;
}

/** A relay URL is only accepted from an invite if it is a real ws(s) endpoint. */
function isRelayUrl(url: string): boolean {
  return /^wss?:\/\/[^\s]+$/i.test(url);
}

export function parseInvite(uri: string): Invite {
  const text = uri.trim();
  const match = text.match(/^multisig:join\?(.*)$/i);
  if (!match) throw new Error('That is not a group invite link.');
  const relays: string[] = [];
  let secret = '';
  let name = '';
  let coordinatorPubkey: string | undefined;
  let m = 2;
  let total = 3;
  let rekey = false;
  let network: NetworkName = 'mainnet';
  for (const part of match[1].split('&')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === 's') secret = fromBase64url(value).toString('hex');
    else if (key === 'n') name = decodeURIComponent(value);
    else if (key === 'c') coordinatorPubkey = /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : undefined;
    else if (key === 'k') rekey = value === '1';
    else if (key === 'm') m = parseInt(value, 10);
    else if (key === 't') total = parseInt(value, 10);
    else if (key === 'net') network = value === 't' ? 'testnet' : 'mainnet';
    // Reject anything that is not a genuine ws(s):// relay, and never let a
    // hostile invite open an unbounded number of connections.
    else if (key === 'r' && relays.length < MAX_RELAYS) {
      const decoded = decodeURIComponent(value);
      if (isRelayUrl(decoded)) relays.push(decoded);
    }
  }
  if (secret.length !== 64) throw new Error('This invite link is missing or has a damaged secret.');
  if (
    !Number.isInteger(m) ||
    !Number.isInteger(total) ||
    m < 1 ||
    total < 2 ||
    m > total ||
    total > MAX_COSIGNERS
  ) {
    throw new Error('This invite has an invalid policy.');
  }
  return {
    secret,
    relays: relays.length ? relays : DEFAULT_RELAYS,
    name: name || 'Shared wallet',
    coordinatorPubkey,
    m,
    n: total,
    network,
    rekey,
  };
}
