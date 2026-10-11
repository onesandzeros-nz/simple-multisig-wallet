import { x25519 } from '@noble/curves/ed25519';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { Buffer } from 'buffer';

/**
 * The initiator's half of Noise_XX_25519_ChaChaPoly_SHA256 — the encrypted
 * channel every BitBox02 command travels through, so that nothing on the USB
 * cable (or pretending to be it) can read or alter what the device is asked.
 * Reference: noiseprotocol.org/noise.html, revision 34.
 *
 * Only the protocol's bookkeeping lives here. The curve, the cipher and the
 * hash are @noble's.
 *
 *   -> e
 *   <- e, ee, s, es
 *   -> s, se
 */

export const PROTOCOL_NAME = 'Noise_XX_25519_ChaChaPoly_SHA256';

const DH_LEN = 32;
const TAG_LEN = 16;
/** The last nonce is reserved by the protocol; reaching it means the channel must be rebuilt. */
const MAX_NONCE = Number.MAX_SAFE_INTEGER;

export interface NoiseKeypair {
  privateKey: Buffer;
  publicKey: Buffer;
}

export function keypairFromPrivate(privateKey: Uint8Array): NoiseKeypair {
  if (privateKey.length !== DH_LEN) throw new Error('A Noise key must be 32 bytes.');
  return {
    privateKey: Buffer.from(Uint8Array.from(privateKey)),
    publicKey: Buffer.from(x25519.getPublicKey(privateKey)),
  };
}

export function generateKeypair(): NoiseKeypair {
  const secret = new Uint8Array(DH_LEN);
  crypto.getRandomValues(secret);
  return keypairFromPrivate(secret);
}

function dh(privateKey: Uint8Array, publicKey: Uint8Array): Buffer {
  // noble refuses the low-order points that would make the shared secret
  // all zeroes, which is the check the Noise spec leaves to the DH function.
  return Buffer.from(x25519.getSharedSecret(privateKey, publicKey));
}

/** Noise's HKDF with two outputs. */
function hkdf2(chainingKey: Uint8Array, material: Uint8Array): [Buffer, Buffer] {
  const temp = hmac(sha256, chainingKey, material);
  const first = hmac(sha256, temp, Uint8Array.from([0x01]));
  const second = hmac(sha256, temp, Buffer.concat([Buffer.from(first), Buffer.from([0x02])]));
  return [Buffer.from(first), Buffer.from(second)];
}

function nonceBytes(n: number): Uint8Array {
  // 32 bits of zeroes, then the counter as 64 bits little endian.
  const out = Buffer.alloc(12);
  out.writeUInt32LE(n % 0x100000000, 4);
  out.writeUInt32LE(Math.floor(n / 0x100000000), 8);
  return out;
}

/** One direction of the finished channel: a key and a counter that must never repeat. */
export class CipherState {
  private n = 0;

  constructor(private readonly key: Uint8Array) {
    if (key.length !== 32) throw new Error('A Noise cipher key must be 32 bytes.');
  }

  private nextNonce(): Uint8Array {
    if (this.n >= MAX_NONCE) throw new Error('The encrypted channel is used up — reconnect the BitBox02.');
    return nonceBytes(this.n);
  }

  encrypt(plaintext: Uint8Array, associated: Uint8Array = new Uint8Array(0)): Buffer {
    const out = chacha20poly1305(this.key, this.nextNonce(), associated).encrypt(plaintext);
    this.n++;
    return Buffer.from(out);
  }

  /** Throws when the message was not sealed by the other end of this channel, in this order. */
  decrypt(ciphertext: Uint8Array, associated: Uint8Array = new Uint8Array(0)): Buffer {
    if (ciphertext.length < TAG_LEN) throw new Error('The encrypted message is too short.');
    let out: Uint8Array;
    try {
      out = chacha20poly1305(this.key, this.nextNonce(), associated).decrypt(ciphertext);
    } catch {
      throw new Error('Could not decrypt what the BitBox02 sent — the secure channel is out of step.');
    }
    // Only a message that authenticated moves the counter on, as the spec requires.
    this.n++;
    return Buffer.from(out);
  }
}

export interface HandshakeResult {
  /** The third handshake message, to send to the device. */
  message: Buffer;
  /** Encrypts what we send. */
  send: CipherState;
  /** Decrypts what the device sends. */
  receive: CipherState;
  /** Binds the channel to this handshake; the pairing code is read off it. */
  handshakeHash: Buffer;
  /** The device's long-term key — how it is recognised next time. */
  remoteStatic: Buffer;
}

export class NoiseInitiator {
  private h: Buffer;
  private ck: Buffer;
  private k: Buffer | null = null;
  private n = 0;
  private readonly e: NoiseKeypair;
  private re: Buffer | null = null;
  private rs: Buffer | null = null;
  private step = 0;

  constructor(
    private readonly s: NoiseKeypair,
    prologue: Uint8Array,
    /** Tests pin the ephemeral key to reproduce published vectors; the app never passes one. */
    ephemeral?: NoiseKeypair
  ) {
    this.e = ephemeral ?? generateKeypair();
    // The name is exactly one hash long, so it is used as it stands.
    const name = Buffer.from(PROTOCOL_NAME, 'ascii');
    this.h = name.length <= 32 ? Buffer.concat([name, Buffer.alloc(32 - name.length)]) : Buffer.from(sha256(name));
    this.ck = Buffer.from(this.h);
    this.mixHash(prologue);
  }

  private mixHash(data: Uint8Array): void {
    this.h = Buffer.from(sha256(Buffer.concat([this.h, Buffer.from(data)])));
  }

  private mixKey(material: Uint8Array): void {
    const [ck, k] = hkdf2(this.ck, material);
    this.ck = ck;
    this.k = k;
    this.n = 0;
  }

  private encryptAndHash(plaintext: Uint8Array): Buffer {
    let out: Buffer;
    if (this.k) {
      out = Buffer.from(chacha20poly1305(this.k, nonceBytes(this.n), this.h).encrypt(plaintext));
      this.n++;
    } else {
      out = Buffer.from(Uint8Array.from(plaintext));
    }
    this.mixHash(out);
    return out;
  }

  private decryptAndHash(ciphertext: Uint8Array): Buffer {
    let out: Buffer;
    if (this.k) {
      try {
        out = Buffer.from(chacha20poly1305(this.k, nonceBytes(this.n), this.h).decrypt(ciphertext));
      } catch {
        throw new Error('The BitBox02 failed the secure-channel handshake.');
      }
      this.n++;
    } else {
      out = Buffer.from(Uint8Array.from(ciphertext));
    }
    this.mixHash(ciphertext);
    return out;
  }

  /** -> e */
  writeFirst(payload: Uint8Array = new Uint8Array(0)): Buffer {
    if (this.step !== 0) throw new Error('Handshake messages are out of order.');
    this.step = 1;
    this.mixHash(this.e.publicKey);
    return Buffer.concat([this.e.publicKey, this.encryptAndHash(payload)]);
  }

  /** <- e, ee, s, es. Returns whatever payload the device attached. */
  readSecond(message: Uint8Array): Buffer {
    if (this.step !== 1) throw new Error('Handshake messages are out of order.');
    if (message.length < DH_LEN + DH_LEN + TAG_LEN + TAG_LEN) {
      throw new Error('The BitBox02 sent a handshake message too short to read.');
    }
    this.step = 2;
    const msg = Buffer.from(message);
    this.re = Buffer.from(msg.subarray(0, DH_LEN));
    this.mixHash(this.re);
    this.mixKey(dh(this.e.privateKey, this.re));
    this.rs = this.decryptAndHash(msg.subarray(DH_LEN, DH_LEN + DH_LEN + TAG_LEN));
    this.mixKey(dh(this.e.privateKey, this.rs));
    return this.decryptAndHash(msg.subarray(DH_LEN + DH_LEN + TAG_LEN));
  }

  /** -> s, se. The handshake is complete once the device has read this. */
  writeThird(payload: Uint8Array = new Uint8Array(0)): HandshakeResult {
    if (this.step !== 2 || !this.re || !this.rs) throw new Error('Handshake messages are out of order.');
    this.step = 3;
    const encryptedStatic = this.encryptAndHash(this.s.publicKey);
    this.mixKey(dh(this.s.privateKey, this.re));
    const encryptedPayload = this.encryptAndHash(payload);
    const [first, second] = hkdf2(this.ck, new Uint8Array(0));
    return {
      message: Buffer.concat([encryptedStatic, encryptedPayload]),
      send: new CipherState(first),
      receive: new CipherState(second),
      handshakeHash: Buffer.from(this.h),
      remoteStatic: Buffer.from(this.rs),
    };
  }
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * The pairing code as the device draws it: the first twenty base32 characters
 * of the handshake hash, in four groups of five over two lines. Both ends
 * compute it from their own view of the handshake, so the codes only agree
 * when nobody sits in between.
 */
export function pairingCode(handshakeHash: Uint8Array): string {
  if (handshakeHash.length !== 32) throw new Error('A handshake hash is 32 bytes.');
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of handshakeHash) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 20) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
    if (out.length === 20) break;
  }
  return `${out.slice(0, 5)} ${out.slice(5, 10)}\n${out.slice(10, 15)} ${out.slice(15, 20)}`;
}
