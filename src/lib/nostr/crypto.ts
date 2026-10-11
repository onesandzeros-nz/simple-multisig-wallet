import ecc from '@bitcoinerlab/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { Buffer } from 'buffer';

/**
 * Nostr event signing (NIP-01) and group payload encryption.
 * Group members share a 32-byte secret; the channel id and the encryption
 * key are derived from it, so a relay only ever sees opaque ciphertext
 * tagged with a random-looking channel id.
 *
 * That secret is rotated — see REKEY-DESIGN.md. The invite carries epoch 0,
 * which is only ever used for the handshake; the epoch that carries real
 * traffic is sealed to each member individually with `sealTo` below, so it
 * never travels anywhere the invite can read.
 */

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export type UnsignedEvent = Omit<NostrEvent, 'id' | 'pubkey' | 'sig'>;

export function randomBytes(length: number): Buffer {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return Buffer.from(out);
}

export function generateSecretKey(): string {
  let key: Buffer;
  do {
    key = randomBytes(32);
  } while (!ecc.isPrivate(key));
  return key.toString('hex');
}

/** x-only public key (32 bytes hex), as Nostr uses. */
export function getPublicKey(secretKeyHex: string): string {
  const pub = ecc.xOnlyPointFromScalar(Buffer.from(secretKeyHex, 'hex'));
  return Buffer.from(pub).toString('hex');
}

/** Canonical NIP-01 serialisation → sha256 → event id. */
export function eventId(pubkey: string, e: UnsignedEvent): string {
  const serialised = JSON.stringify([0, pubkey, e.created_at, e.kind, e.tags, e.content]);
  return Buffer.from(sha256(Buffer.from(serialised, 'utf8'))).toString('hex');
}

export function signEvent(secretKeyHex: string, e: UnsignedEvent): NostrEvent {
  const pubkey = getPublicKey(secretKeyHex);
  const id = eventId(pubkey, e);
  const sig = Buffer.from(
    ecc.signSchnorr(Buffer.from(id, 'hex'), Buffer.from(secretKeyHex, 'hex'))
  ).toString('hex');
  return { ...e, id, pubkey, sig };
}

export function verifyEvent(e: NostrEvent): boolean {
  try {
    if (eventId(e.pubkey, e) !== e.id) return false;
    return ecc.verifySchnorr(
      Buffer.from(e.id, 'hex'),
      Buffer.from(e.pubkey, 'hex'),
      Buffer.from(e.sig, 'hex')
    );
  } catch {
    return false;
  }
}

// --- Group secret derivation -------------------------------------------------

function derive(secret: Buffer, label: string): Buffer {
  return Buffer.from(sha256(Buffer.concat([secret, Buffer.from(label, 'utf8')])));
}

/** Public channel tag — what events are tagged with and subscribed to. */
export function channelId(secretHex: string): string {
  return derive(Buffer.from(secretHex, 'hex'), 'simple-multisig/channel').toString('hex').slice(0, 32);
}

export function encryptionKey(secretHex: string): Buffer {
  return derive(Buffer.from(secretHex, 'hex'), 'simple-multisig/encryption');
}

/**
 * Plaintext is padded to a fixed set of sizes before encryption so a relay
 * cannot tell a chat line from a key from a PSBT by ciphertext length.
 * Layout: [4-byte BE length][utf8 payload][zero padding].
 */
const PAD_BUCKETS = [512, 2048, 8192, 32768, 131072];

export function paddedLength(byteLength: number): number {
  const needed = byteLength + 4;
  for (const bucket of PAD_BUCKETS) {
    if (needed <= bucket) return bucket;
  }
  // Beyond the largest bucket, round up to a whole multiple of it.
  const largest = PAD_BUCKETS[PAD_BUCKETS.length - 1];
  return Math.ceil(needed / largest) * largest;
}

function pad(plaintext: string): Buffer {
  const body = Buffer.from(plaintext, 'utf8');
  const out = Buffer.alloc(paddedLength(body.length)); // zero-filled
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

function unpad(buf: Buffer): string {
  if (buf.length < 4) throw new Error('Malformed message.');
  const length = buf.readUInt32BE(0);
  if (length > buf.length - 4) throw new Error('Malformed message.');
  return buf.toString('utf8', 4, 4 + length);
}

/** XChaCha20-Poly1305 over the padded plaintext; output is base64(nonce ‖ sealed). */
function seal(key: Buffer, plaintext: string): string {
  const nonce = randomBytes(24);
  const sealed = xchacha20poly1305(key, nonce).encrypt(pad(plaintext));
  return Buffer.concat([nonce, Buffer.from(sealed)]).toString('base64');
}

function open(key: Buffer, content: string): string {
  const raw = Buffer.from(content, 'base64');
  if (raw.length < 25) throw new Error('Message too short to decrypt.');
  const nonce = Buffer.from(raw.subarray(0, 24));
  const opened = xchacha20poly1305(key, nonce).decrypt(Buffer.from(raw.subarray(24)));
  return unpad(Buffer.from(opened));
}

export function encryptPayload(secretHex: string, plaintext: string): string {
  return seal(encryptionKey(secretHex), plaintext);
}

export function decryptPayload(secretHex: string, content: string): string {
  return open(encryptionKey(secretHex), content);
}

// --- Pairwise sealing --------------------------------------------------------
// Used only to hand a member a new epoch secret. Broadcasting that secret under
// the *old* epoch key would be pointless: relays keep events, so anyone who
// later obtains the invite would replay the announcement and learn the new key
// too. Sealing it to each member's own public key is what makes rotation mean
// anything.

/**
 * Shared key for one pair of members: ECDH over secp256k1, then HKDF.
 *
 * Nostr pubkeys are x-only, so the parity of the sender's point is unknown —
 * as in NIP-44 we assume even-Y. That is safe here because negating a point
 * leaves its x coordinate unchanged, so both sides derive the same secret
 * whichever parity each key actually had.
 */
export function conversationKey(ourSecretHex: string, theirPubkeyHex: string): Buffer {
  const product = ecc.pointMultiply(
    Buffer.from('02' + theirPubkeyHex, 'hex'),
    Buffer.from(ourSecretHex, 'hex'),
    true
  );
  if (!product) throw new Error('Could not derive a shared key for that member.');
  // Byte 0 is the parity prefix; only the x coordinate is secret material.
  return Buffer.from(hkdf(sha256, Buffer.from(product).subarray(1, 33), undefined, 'simple-multisig/pairwise', 32));
}

/** Seals a payload so only `theirPubkeyHex` can open it. Same framing as a group payload. */
export function sealTo(ourSecretHex: string, theirPubkeyHex: string, plaintext: string): string {
  return seal(conversationKey(ourSecretHex, theirPubkeyHex), plaintext);
}

/** Opens a payload sealed by `theirPubkeyHex` to us. Throws if it was not. */
export function openFrom(ourSecretHex: string, theirPubkeyHex: string, content: string): string {
  return open(conversationKey(ourSecretHex, theirPubkeyHex), content);
}
