import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ecc from '@bitcoinerlab/secp256k1';
import { invert, mod } from '@noble/curves/abstract/modular';
import { x25519 } from '@noble/curves/ed25519';
import { p256 } from '@noble/curves/p256';
import { secp256k1 } from '@noble/curves/secp256k1';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import * as bitcoin from 'bitcoinjs-lib';
import { Buffer } from 'buffer';
import { accountXpub, bip32, bip48Path, btcNetwork, deriveAddress, masterFingerprint, rootFromMnemonic } from '../src/lib/bitcoin';
import { BitBox02Device, BitBox02Options, BITBOX02_MEMORY_KEYS, BITBOX02_PRODUCT_STRINGS, BITBOX02_USB } from '../src/lib/hw/bitbox02';
import { hostCommitment, taggedSha256, validateCompactSignature, verifyAntiklepto } from '../src/lib/hw/bitbox02/antiklepto';
import { ATTESTATION_ROOT_KEYS, verifyAttestation } from '../src/lib/hw/bitbox02/attestation';
import { parseInfo } from '../src/lib/hw/bitbox02/device';
import { decodeResponse, encodeRequest, Request, Response } from '../src/lib/hw/bitbox02/messages';
import { CipherState, keypairFromPrivate, NoiseInitiator, pairingCode, PROTOCOL_NAME } from '../src/lib/hw/bitbox02/noise';
import {
  describeWallet,
  externalPayload,
  formatKeypath,
  isStandardMultisigPath,
  parseKeypath,
  planSigning,
  registrationName,
  walletTag,
  xpubMessage,
} from '../src/lib/hw/bitbox02/signing';
import { encodeFrame, FrameError, HWW_CMD, maxMessageLength, readFrame, writeFrame } from '../src/lib/hw/bitbox02/u2fhid';
import { decodeMessage, encodeMessage, Message } from '../src/lib/hw/protobuf';
import { DeviceMemory, DevicePrompts, PacketTransport, TransportTimeout, UserCancelled } from '../src/lib/hw/types';
import { MultisigWallet, NetworkName, Utxo, WalletSnapshot } from '../src/lib/types';
import { attachSignatures, buildPsbt, finalizeAndExtract, parsePsbt, signingJobsFor, signPsbtWithMnemonic } from '../src/lib/wallet';
import { DEST_MAINNET, makeWallet, MNEMONICS } from './helpers';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (s: string) => Buffer.from(s, 'hex');
const H = 0x80000000;

/**
 * Messages as the manufacturer's own definitions encode them: produced with
 * Google's protobuf library from the compiled .proto files that ship in HWI
 * (hwilib/devices/bitbox02_lib/communication/generated), not by this app's
 * codec — so a field number or type copied wrongly into messages.ts shows up
 * here as a byte that differs.
 */
const REFERENCE: Record<string, string> = {
  'request.fingerprint':
    'c20100',
  'request.device_info':
    '2200',
  'request.restore_from_mnemonic':
    'b201110880f7c4d50610f0e3ffffffffffffff01',
  'request.btc_pub.mainnet':
    '42181214b0808080088080808008808080800882808080081801',
  'request.btc_pub.testnet':
    '421a08011214b0808080088180808008808080800882808080081800',
  'request.is_registered':
    'ca01a8020aa5020aa202128902128602080212540a010412041cf297161882808080082220bba0c7ca160a870efeb940ab90d0f4284fea1b5e0d2117677e823fc37e2d57632a21021a3bf5fbf737d0f36993fd46dc4913093beb532d654fe0dfd98bd27585dc9f2912540a010412040e1fb8ea1882808080082220a74fed325a8dc58b6aa0bc1338951a2b7e699e39a25ae1ddedb5acad098cf0c82a21031634e9c2e75880e32d52bb1074741ffb108fd6201182a7a790a2f42aa3b59b7a12540a01041204ffd9c5191882808080082220a732876f758546f2e3aa40a0ba12c5ea24ee18f9086e854e573bea1e219d172f2a210339710356a496726c84692621b2b6e3645dd35bc0026c587f16411897990a1e1f18011a14b080808008808080800880808080088280808008',
  'request.register':
    'ca01bc0212b9020aa4020801128902128602080212540a010412041cf297161882808080082220bba0c7ca160a870efeb940ab90d0f4284fea1b5e0d2117677e823fc37e2d57632a21021a3bf5fbf737d0f36993fd46dc4913093beb532d654fe0dfd98bd27585dc9f2912540a010412040e1fb8ea1882808080082220a74fed325a8dc58b6aa0bc1338951a2b7e699e39a25ae1ddedb5acad098cf0c82a21031634e9c2e75880e32d52bb1074741ffb108fd6201182a7a790a2f42aa3b59b7a12540a01041204ffd9c5191882808080082220a732876f758546f2e3aa40a0ba12c5ea24ee18f9086e854e573bea1e219d172f2a210339710356a496726c84692621b2b6e3645dd35bc0026c587f16411897990a1e1f18011a14b080808008818080800880808080088280808008120e46616d696c7920736176696e67731801',
  'request.sign_init':
    '4aab0212a202128902128602080212540a010412041cf297161882808080082220bba0c7ca160a870efeb940ab90d0f4284fea1b5e0d2117677e823fc37e2d57632a21021a3bf5fbf737d0f36993fd46dc4913093beb532d654fe0dfd98bd27585dc9f2912540a010412040e1fb8ea1882808080082220a74fed325a8dc58b6aa0bc1338951a2b7e699e39a25ae1ddedb5acad098cf0c82a21031634e9c2e75880e32d52bb1074741ffb108fd6201182a7a790a2f42aa3b59b7a12540a01041204ffd9c5191882808080082220a732876f758546f2e3aa40a0ba12c5ea24ee18f9086e854e573bea1e219d172f2a210339710356a496726c84692621b2b6e3645dd35bc0026c587f16411897990a1e1f18011a14b080808008808080800880808080088280808008200228023002',
  'request.sign_input.pass1':
    '52440a20000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f18f0930920fdffffff0f3216b0808080088080808008808080800882808080080000',
  'request.sign_input.pass2':
    '52700a20000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f10011880809dd085bedd0320ffffffff0f3217b080808008808080800880808080088280808008018f4e42220a20abababababababababababababababababababababababababababababababab',
  'request.sign_output.ours':
    '5a1e080118dbff022a16b0808080088080808008808080800882808080080100',
  'request.sign_output.external':
    '5a1c100318c09a0c22147575757575757575757575757575757575757575',
  'request.prevtx_init':
    'ca010a1a080802100118022064',
  'request.prevtx_input':
    'ca014222400a2040404040404040404040404040404040404040404040404040404040404040401a160014111111111111111111111111111111111111111120feffffff0f',
  'request.prevtx_output':
    'ca011d2a1b08b960121600142222222222222222222222222222222222222222',
  'request.antiklepto_signature':
    'ca01243a220a20cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
  'response.success':
    '0a00',
  'response.error':
    '12170868121361626f72746564206279207468652075736572',
  'response.fingerprint':
    '62060a044c00739d',
  'response.pub':
    '2a710a6f7870756236446476646a43674436487752557a39335737627a4c796e41793244366a4d327334737741556b72335877426d7a4872526a724e55674a5a39346854574267375837626d326f35414a325833465a39516a784d70574176584247787264475a55316579506b465163645561',
  'response.device_info':
    '22230a094d7920426974426f7810011a0776392e32372e31287b3209415445434336303842',
  'response.sign_next.input0':
    '3200',
  'response.sign_next.host_nonce':
    '32290806100132230a21023333333333333333333333333333333333333333333333333333333333333333',
  'response.sign_next.signature':
    '6a481a4608021801224044444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444',
  'response.sign_next.prevtx_output':
    '6a081a06080510012802',
  'response.is_registered':
    '6a0412020801',
  'response.not_registered':
    '6a021200',
  'response.btc_success':
    '6a020a00',
};

/** The cosigner keys inside the reference messages above. */
const REFERENCE_XPUBS = [
  'xpub6DkFAXWQ2dHxq2vatrt9qyA3bXYU4ToWQwCHbf5XB2mSTexcHZCeKS1VZYcPoBd5X8yVcbXFHJR9R8UCVpt82VX1VhR28mCyxUFL4r6KFrf',
  'xpub6DdvdjCgD6HwRUz93W7bzLynAy2D6jM2s4swAUkr3XwBmzHrRjrNUgJZ94hTWBg7X7bm2o5AJ2X3FZ9QjxMpWAvXBGxrdGZU1eyPkFQcdUa',
  'xpub6FQya7zGhR92kacYsNnjreouvnHJMpXYsUXnW6NJJAJRCKsa26TzDy4LdnGhEurr3d6y1J8PJ7EEMKQp74XTqYvmGJNogYXSKDszYHtF8mX',
];

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** Packets written come straight back out: enough to test framing on its own. */
class Loopback implements PacketTransport {
  readonly packetSize = 64;
  readonly packets: Buffer[] = [];
  async write(packet: Uint8Array) {
    this.packets.push(Buffer.from(packet));
  }
  async read(): Promise<Uint8Array> {
    const next = this.packets.shift();
    if (!next) throw new TransportTimeout();
    // A plain Uint8Array, as Hermes would hand one over.
    return Uint8Array.from(next);
  }
  async close() {}
}

class MapMemory implements DeviceMemory {
  readonly values = new Map<string, string>();
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.values.set(key, value);
  }
}

class ScriptedPrompts implements DevicePrompts {
  readonly statuses: string[] = [];
  readonly pairingCodes: string[] = [];
  /** What the person answers when shown the pairing code. */
  pairing: () => Promise<boolean> = async () => true;
  status(message: string) {
    this.statuses.push(message);
  }
  async pinMatrix(): Promise<string> {
    throw new Error('not a BitBox02 prompt');
  }
  async passphrase(): Promise<string | null> {
    throw new Error('not a BitBox02 prompt');
  }
  confirmPairing(code: string) {
    this.pairingCodes.push(code);
    return this.pairing();
  }
}

// --- the device's half of Noise, written from the spec for these tests -------

function noiseHkdf(ck: Uint8Array, material: Uint8Array): [Buffer, Buffer] {
  const temp = hmac(sha256, ck, material);
  const one = hmac(sha256, temp, Uint8Array.from([1]));
  const two = hmac(sha256, temp, Buffer.concat([one, Buffer.from([2])]));
  return [Buffer.from(one), Buffer.from(two)];
}

function noiseNonce(n: number): Buffer {
  const out = Buffer.alloc(12);
  out.writeBigUInt64LE(BigInt(n), 4);
  return out;
}

class TestResponder {
  h: Buffer;
  ck: Buffer;
  k: Buffer | null = null;
  n = 0;
  re: Buffer | null = null;
  rs: Buffer | null = null;
  readonly sPublic: Buffer;
  readonly ePublic: Buffer;

  constructor(
    private readonly s: Buffer,
    private readonly e: Buffer,
    prologue: Buffer
  ) {
    this.sPublic = Buffer.from(x25519.getPublicKey(s));
    this.ePublic = Buffer.from(x25519.getPublicKey(e));
    this.h = Buffer.from('Noise_XX_25519_ChaChaPoly_SHA256', 'ascii');
    assert.equal(this.h.length, 32);
    this.ck = this.h;
    this.mixHash(prologue);
  }
  mixHash(data: Uint8Array) {
    this.h = Buffer.from(sha256(Buffer.concat([this.h, data])));
  }
  mixKey(material: Uint8Array) {
    [this.ck, this.k] = noiseHkdf(this.ck, material);
    this.n = 0;
  }
  seal(plaintext: Uint8Array): Buffer {
    const out = this.k
      ? Buffer.from(chacha20poly1305(this.k, noiseNonce(this.n++), this.h).encrypt(plaintext))
      : Buffer.from(plaintext);
    this.mixHash(out);
    return out;
  }
  open(ciphertext: Uint8Array): Buffer {
    const out = this.k
      ? Buffer.from(chacha20poly1305(this.k, noiseNonce(this.n++), this.h).decrypt(ciphertext))
      : Buffer.from(ciphertext);
    this.mixHash(ciphertext);
    return out;
  }
  /** -> e */
  readFirst(message: Buffer): Buffer {
    this.re = Buffer.from(message.subarray(0, 32));
    this.mixHash(this.re);
    return this.open(message.subarray(32));
  }
  /** <- e, ee, s, es */
  writeSecond(payload: Uint8Array = Buffer.alloc(0)): Buffer {
    this.mixHash(this.ePublic);
    this.mixKey(x25519.getSharedSecret(this.e, this.re!));
    const s = this.seal(this.sPublic);
    this.mixKey(x25519.getSharedSecret(this.s, this.re!));
    return Buffer.concat([this.ePublic, s, this.seal(payload)]);
  }
  /** -> s, se */
  readThird(message: Buffer): Buffer {
    this.rs = this.open(message.subarray(0, 48));
    this.mixKey(x25519.getSharedSecret(this.e, this.rs));
    return this.open(message.subarray(48));
  }
  /** [what the initiator sends with, what the responder sends with] */
  split(): [Buffer, Buffer] {
    return noiseHkdf(this.ck, new Uint8Array(0));
  }
}

class TestCipher {
  n = 0;
  constructor(readonly key: Buffer) {}
  seal(plaintext: Uint8Array) {
    return Buffer.from(chacha20poly1305(this.key, noiseNonce(this.n++)).encrypt(plaintext));
  }
  open(ciphertext: Uint8Array) {
    return Buffer.from(chacha20poly1305(this.key, noiseNonce(this.n++)).decrypt(ciphertext));
  }
}

// --- a device, as far as the cable can tell ----------------------------------

const ATTESTATION_ROOT = secp256k1.utils.randomPrivateKey();
const ATTESTATION_ROOT_PUBLIC = hex(secp256k1.getPublicKey(ATTESTATION_ROOT, false));

const N = secp256k1.CURVE.n;
const big = (b: Uint8Array) => BigInt('0x' + hex(b));
const bytes32 = (n: bigint) => unhex(n.toString(16).padStart(64, '0'));

/** ECDSA with a nonce of the signer's choosing, which no library offers — and an honest device needs. */
function signWithNonce(digest: Uint8Array, privateKey: Uint8Array, k: bigint): Buffer {
  const r = mod(secp256k1.ProjectivePoint.BASE.multiply(k).toAffine().x, N);
  let s = mod(invert(k, N) * (big(digest) + r * big(privateKey)), N);
  if (s > N >> 1n) s = N - s;
  return Buffer.concat([bytes32(r), bytes32(s)]);
}

interface FakeBehaviour {
  version: string;
  platform: number;
  edition: number;
  unlocked: boolean;
  initialized: boolean;
  /** Answer "busy" to this many requests before taking one. */
  busy: number;
  /** Answer "not ready" this many times before each answer. */
  notReady: number;
  /** What the person presses when the device shows the pairing code. */
  acceptPairing: boolean;
  /** Pretend to be in the bootloader: the wallet command is unknown. */
  bootloader: boolean;
  attestation: 'genuine' | 'none' | 'forged-certificate' | 'stolen-certificate';
  /** Press "cancel" when asked to confirm this. */
  cancel: 'nothing' | 'registration' | 'transaction';
  /** Ways a device might cheat or break while signing. */
  signing: 'honest' | 'no-antiklepto' | 'ignores-host-nonce' | 'wrong-key' | 'asks-too-much' | 'never-finishes';
  /** Multisig names already stored, by registration hash. */
  registered: Map<string, string>;
}

class FakeBitBox02 implements PacketTransport {
  readonly packetSize = 64;
  readonly behaviour: FakeBehaviour = {
    version: 'v9.27.1',
    platform: 0x00,
    edition: 0x01,
    unlocked: true,
    initialized: true,
    busy: 0,
    notReady: 0,
    acceptPairing: true,
    bootloader: false,
    attestation: 'genuine',
    cancel: 'nothing',
    signing: 'honest',
    registered: new Map(),
  };
  /** Every request as the device understood it, for tests to inspect. */
  readonly seen: string[] = [];
  readonly requests: Message[] = [];
  /** Screens a person would have been shown. */
  readonly screens: string[] = [];
  /** Phones this device has paired with. */
  readonly pairedPhones = new Set<string>();
  closed = false;
  rawRequests = 0;

  private readonly root;
  private readonly staticKey = Buffer.from(x25519.utils.randomPrivateKey());
  private readonly attestationKey = p256.utils.randomPrivateKey();
  private incoming: Buffer[] = [];
  private expected = 0;
  private outgoing: Buffer[] = [];
  private pending: { polls: number; answer: Buffer } | null = null;
  private noise: TestResponder | null = null;
  private channel: { receive: TestCipher; send: TestCipher; phone: string; hash: Buffer; verified: boolean } | null = null;
  private tx: SigningSession | null = null;

  constructor(
    readonly mnemonic: string,
    behaviour: Partial<FakeBehaviour> = {}
  ) {
    Object.assign(this.behaviour, behaviour);
    this.root = rootFromMnemonic(mnemonic, 'mainnet');
  }

  get staticPublic(): string {
    return hex(x25519.getPublicKey(this.staticKey));
  }
  get pairingCodeShown(): string | undefined {
    return this.screens.filter((s) => s.startsWith('Pairing code: ')).pop()?.slice('Pairing code: '.length);
  }

  // --- the cable ---

  async write(packet: Uint8Array) {
    assert.equal(packet.length, 64, 'every packet is a whole one');
    const p = Buffer.from(packet);
    assert.equal(p.readUInt32BE(0), 0xff000000);
    if (this.incoming.length === 0) {
      this.expected = p.readUInt16BE(5);
      this.incoming.push(p);
    } else {
      assert.equal(p[4], this.incoming.length - 1, 'continuation packets count up from zero');
      this.incoming.push(p);
    }
    const have = 57 + (this.incoming.length - 1) * 59;
    if (have < this.expected) return;
    const cmd = this.incoming[0][4];
    const message = Buffer.concat([
      this.incoming[0].subarray(7),
      ...this.incoming.slice(1).map((c) => c.subarray(5)),
    ]).subarray(0, this.expected);
    this.incoming = [];
    this.respond(cmd, this.frame(cmd, Buffer.from(message)));
  }

  async read(): Promise<Uint8Array> {
    if (this.closed) throw new Error('The device was unplugged.');
    const next = this.outgoing.shift();
    if (!next) throw new TransportTimeout();
    return Uint8Array.from(next);
  }

  async close() {
    this.closed = true;
  }

  private respond(cmd: number, answer: Buffer | { error: number }) {
    if (Buffer.isBuffer(answer)) {
      this.outgoing.push(...encodeFrame(cmd, answer));
    } else {
      const packet = Buffer.alloc(64);
      packet.writeUInt32BE(0xff000000, 0);
      packet[4] = 0xbf;
      packet.writeUInt16BE(1, 5);
      packet[7] = answer.error;
      this.outgoing.push(packet);
    }
  }

  // --- the request/response wrapper ---

  private frame(cmd: number, message: Buffer): Buffer | { error: number } {
    if (this.behaviour.bootloader) return cmd === 0xc3 ? Buffer.from([0x76, 0x00]) : { error: 0x01 };
    if (cmd !== HWW_CMD) return { error: 0x01 };
    if (message[0] === 0x69) {
      const b = this.behaviour;
      return Buffer.concat([
        Buffer.from([b.version.length]),
        Buffer.from(b.version, 'ascii'),
        Buffer.from([b.platform, b.edition, b.unlocked ? 1 : 0, b.initialized ? 1 : 0]),
      ]);
    }
    if (message[0] === 0x00) {
      this.rawRequests++;
      if (this.behaviour.busy > 0) {
        this.behaviour.busy--;
        return Buffer.from([0x02]);
      }
      assert.equal(this.pending, null, 'one request at a time');
      this.pending = { polls: this.behaviour.notReady, answer: this.operation(Buffer.from(message.subarray(1))) };
    } else if (message[0] !== 0x01 || message.length !== 1) {
      return Buffer.from([0x03]);
    }
    if (!this.pending) return Buffer.from([0x03]);
    if (this.pending.polls-- > 0) return Buffer.from([0x01]);
    const answer = this.pending.answer;
    this.pending = null;
    return Buffer.concat([Buffer.from([0x00]), answer]);
  }

  // --- what a request is ---

  private operation(message: Buffer): Buffer {
    const op = String.fromCharCode(message[0]);
    const rest = Buffer.from(message.subarray(1));
    this.seen.push(op);
    switch (op) {
      case 'a':
        return this.attest(rest);
      case 'u':
        return Buffer.from([this.behaviour.initialized ? 0 : 2]);
      case 'h':
        this.channel = null;
        this.noise = new TestResponder(
          this.staticKey,
          Buffer.from(x25519.utils.randomPrivateKey()),
          Buffer.from('Noise_XX_25519_ChaChaPoly_SHA256', 'ascii')
        );
        return Buffer.from([0]);
      case 'H': {
        if (!this.noise) return Buffer.from([1]);
        if (!this.noise.re) {
          this.noise.readFirst(rest);
          return Buffer.concat([Buffer.from([0]), this.noise.writeSecond()]);
        }
        try {
          this.noise.readThird(rest);
        } catch {
          return Buffer.from([1]);
        }
        const [fromPhone, toPhone] = this.noise.split();
        const phone = hex(this.noise.rs!);
        const known = this.pairedPhones.has(phone);
        this.channel = {
          receive: new TestCipher(fromPhone),
          send: new TestCipher(toPhone),
          phone,
          hash: this.noise.h,
          verified: known,
        };
        this.noise = null;
        return Buffer.from([0, known ? 0 : 1]);
      }
      case 'v': {
        if (!this.channel) return Buffer.from([1]);
        this.screens.push(`Pairing code: ${fakePairingCode(this.channel.hash)}`);
        if (!this.behaviour.acceptPairing) {
          this.channel = null;
          return Buffer.from([1]);
        }
        this.channel.verified = true;
        this.pairedPhones.add(this.channel.phone);
        return Buffer.from([0]);
      }
      case 'n': {
        if (!this.channel?.verified) return Buffer.from([1]);
        let request: Message;
        try {
          request = decodeMessage(Request, this.channel.receive.open(rest));
        } catch {
          return Buffer.from([1]);
        }
        this.requests.push(request);
        let response: Message;
        try {
          response = this.api(request);
        } catch (e) {
          if (!(e instanceof DeviceRefusal)) throw e;
          this.tx = null;
          response = { error: { code: e.code, message: e.message } };
        }
        return Buffer.concat([Buffer.from([0]), this.channel.send.seal(encodeMessage(Response, response))]);
      }
      default:
        return Buffer.from([1]);
    }
  }

  private attest(challenge: Buffer): Buffer {
    const how = this.behaviour.attestation;
    if (how === 'none' || challenge.length !== 32) return Buffer.from([1]);
    const bootloaderHash = Buffer.from(sha256(Buffer.from('bootloader')));
    const deviceKey = Buffer.from(p256.getPublicKey(this.attestationKey, false).subarray(1));
    // A certificate is the factory's signature over the bootloader and the device's key.
    const certifiedKey =
      how === 'stolen-certificate' ? Buffer.from(p256.getPublicKey(p256.utils.randomPrivateKey(), false).subarray(1)) : deviceKey;
    const signer = how === 'forged-certificate' ? secp256k1.utils.randomPrivateKey() : ATTESTATION_ROOT;
    const certificate = secp256k1
      .sign(sha256(Buffer.concat([bootloaderHash, certifiedKey])), signer)
      .toCompactRawBytes();
    const proof = p256.sign(sha256(challenge), this.attestationKey).toCompactRawBytes();
    return Buffer.concat([
      Buffer.from([0]),
      bootloaderHash,
      // A device holding someone else's certificate presents their key, but can only sign with its own.
      certifiedKey,
      Buffer.from(certificate),
      Buffer.from(sha256(unhex(ATTESTATION_ROOT_PUBLIC))),
      Buffer.from(proof),
    ]);
  }

  // --- the encrypted API ---

  private node(keypath: number[]) {
    return keypath.reduce((node, step) => (step >= H ? node.deriveHardened(step - H) : node.derive(step)), this.root);
  }

  private registrationHash(registration: Message): string {
    return hex(sha256(encodeMessage(Request, { btc: { is_script_config_registered: { registration } } })));
  }

  /** What the firmware checks of a multisig account: its shape, and that the key named as ours is. */
  private checkMultisig(config: Message, keypath: number[]): Message {
    const multisig = config?.multisig;
    if (!multisig) throw new DeviceRefusal(101, 'invalid input');
    const n = multisig.xpubs.length;
    const m = multisig.threshold ?? 0;
    const ours = multisig.xpubs[multisig.our_xpub_index ?? 0];
    if (n < 2 || n > 15 || m < 1 || m > n || !ours) throw new DeviceRefusal(101, 'invalid input');
    if (!Buffer.from(ours.public_key).equals(Buffer.from(this.node(keypath).publicKey))) {
      throw new DeviceRefusal(101, 'invalid input');
    }
    return multisig;
  }

  private api(request: Message): Message {
    if (this.tx) return this.tx.next(request);
    if (request.device_info) {
      return { device_info: { name: 'My BitBox', initialized: this.behaviour.initialized, version: this.behaviour.version } };
    }
    if (request.fingerprint) return { fingerprint: { fingerprint: Buffer.from(this.root.fingerprint) } };
    if (request.btc_pub) {
      const { coin, keypath, xpub_type } = request.btc_pub;
      if (xpub_type === undefined) throw new DeviceRefusal(101, 'invalid input');
      const network: NetworkName = (coin ?? 0) === 0 ? 'mainnet' : 'testnet';
      if (!isStandardMultisigPath(keypath, network)) this.screens.push(`Warning: unusual keypath ${formatKeypath(keypath)}`);
      const node = this.node(keypath).neutered();
      // The version prefix follows what was asked for, as on the device.
      const asked = xpub_type === 1 ? 'mainnet' : 'testnet';
      const prefixed = bip32.fromPublicKey(Buffer.from(node.publicKey), Buffer.from(node.chainCode), btcNetwork(asked));
      Object.assign(prefixed as any, { __DEPTH: node.depth, __INDEX: node.index, __PARENT_FINGERPRINT: node.parentFingerprint });
      return { pub: { pub: prefixed.toBase58() } };
    }
    if (request.btc?.is_script_config_registered) {
      const { registration } = request.btc.is_script_config_registered;
      this.checkMultisig(registration.script_config, registration.keypath);
      return { btc: { is_script_config_registered: { is_registered: this.behaviour.registered.has(this.registrationHash(registration)) } } };
    }
    if (request.btc?.register_script_config) {
      const { registration, name, xpub_type } = request.btc.register_script_config;
      const multisig = this.checkMultisig(registration.script_config, registration.keypath);
      if (!name || name.length > 30 || !/^[\x20-\x7e]+$/.test(name) || name.startsWith(' ') || name.endsWith(' ')) {
        throw new DeviceRefusal(101, 'invalid input');
      }
      assert.equal(xpub_type, 1, 'cosigners are shown as xpub/tpub, the form the app itself shows');
      this.screens.push(`Register: ${multisig.threshold}-of-${multisig.xpubs.length}`, `Register: ${name}`);
      if (this.behaviour.cancel === 'registration') throw new DeviceRefusal(104, 'aborted by the user');
      const hash = this.registrationHash(registration);
      for (const [otherHash, otherName] of this.behaviour.registered) {
        if (otherName === name && otherHash !== hash) throw new DeviceRefusal(107, 'duplicate entry');
      }
      this.behaviour.registered.set(hash, name);
      return { btc: { success: {} } };
    }
    if (request.btc_sign_init) {
      const init = request.btc_sign_init;
      const config = init.script_configs[0];
      if (init.script_configs.length !== 1) throw new DeviceRefusal(101, 'invalid input');
      const multisig = this.checkMultisig(config.script_config, config.keypath);
      const name = this.behaviour.registered.get(
        this.registrationHash({ coin: init.coin, script_config: config.script_config, keypath: config.keypath })
      );
      if (!name) throw new DeviceRefusal(101, 'invalid input');
      this.screens.push(`Spend from: ${name}`);
      this.tx = new SigningSession(this, init, multisig, config.keypath, (keypath) => this.node(keypath));
      return this.tx.start();
    }
    throw new DeviceRefusal(105, "can't call this endpoint: wrong state");
  }

  finishSigning() {
    this.tx = null;
  }
}

class DeviceRefusal extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
  }
}

/** Base32 of the first twenty characters, in the device's layout — written separately from the driver's. */
function fakePairingCode(hash: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...hash].map((b) => b.toString(2).padStart(8, '0')).join('');
  const chars = Array.from({ length: 20 }, (_, i) => alphabet[parseInt(bits.slice(i * 5, i * 5 + 5), 2)]).join('');
  return `${chars.slice(0, 5)} ${chars.slice(5, 10)}\n${chars.slice(10, 15)} ${chars.slice(15, 20)}`;
}

/**
 * The firmware's side of signing: it is told the transaction piece by piece,
 * rebuilds it, derives its own scripts for whatever is called the wallet's,
 * and signs what it rebuilt — so a driver that misdescribes the transaction
 * gets signatures that do not fit it.
 */
class SigningSession {
  private readonly inputs: Message[] = [];
  private readonly outputs: Message[] = [];
  private pass = 1;
  private at = 0;
  private prev: { tx: bitcoin.Transaction; init: Message } | null = null;
  private commitment: { nonce: bigint; hostCommitment: Buffer } | null = null;
  private extraAsked = false;

  constructor(
    private readonly device: FakeBitBox02,
    private readonly init: Message,
    private readonly multisig: Message,
    private readonly account: number[],
    private readonly node: (keypath: number[]) => ReturnType<typeof rootFromMnemonic>
  ) {}

  private get network(): bitcoin.Network {
    return btcNetwork((this.init.coin ?? 0) === 0 ? 'mainnet' : 'testnet');
  }

  start(): Message {
    return { btc_sign_next: { type: 0, index: 0 } };
  }

  private script(branch: number, index: number): { witnessScript: Buffer; output: Buffer } {
    const pubkeys = (this.multisig.xpubs as Message[])
      .map((x) => bip32.fromPublicKey(Buffer.from(x.public_key), Buffer.from(x.chain_code)).derive(branch).derive(index))
      .map((n) => Buffer.from(n.publicKey))
      .sort((a, b) => a.compare(b));
    const p2ms = bitcoin.payments.p2ms({ m: this.multisig.threshold, pubkeys, network: this.network });
    const p2wsh = bitcoin.payments.p2wsh({ redeem: p2ms, network: this.network });
    return { witnessScript: p2ms.output!, output: p2wsh.output! };
  }

  private checkKeypath(keypath: number[]): [number, number] {
    const ok =
      keypath.length === this.account.length + 2 && this.account.every((step, i) => keypath[i] === step);
    if (!ok) throw new DeviceRefusal(101, 'invalid input');
    return [keypath[keypath.length - 2], keypath[keypath.length - 1]];
  }

  private outputScript(output: Message): Buffer {
    if (output.ours) {
      const [branch, index] = this.checkKeypath(output.keypath);
      if (index > 9999) throw new DeviceRefusal(101, 'invalid input');
      return this.script(branch, index).output;
    }
    const payload = Buffer.from(output.payload ?? []);
    switch (output.type) {
      case 1:
        return Buffer.concat([unhex('76a914'), payload, unhex('88ac')]);
      case 2:
        return Buffer.concat([unhex('a914'), payload, unhex('87')]);
      case 3:
      case 4:
        return Buffer.concat([Buffer.from([0x00, payload.length]), payload]);
      case 5:
        return Buffer.concat([Buffer.from([0x51, payload.length]), payload]);
      default:
        throw new DeviceRefusal(101, 'invalid input');
    }
  }

  private transaction(): bitcoin.Transaction {
    const tx = new bitcoin.Transaction();
    tx.version = this.init.version;
    tx.locktime = this.init.locktime ?? 0;
    for (const input of this.inputs) tx.addInput(Buffer.from(input.prevOutHash), input.prevOutIndex ?? 0, input.sequence);
    for (const output of this.outputs) tx.addOutput(this.outputScript(output), output.value ?? 0);
    return tx;
  }

  next(request: Message): Message {
    const how = this.device.behaviour.signing;
    const btc = request.btc ?? {};
    const wrapped = (next: Message) => ({ btc: { sign_next: next } });

    if (request.btc_sign_input && this.pass === 1) {
      const input = request.btc_sign_input;
      assert.equal(input.host_nonce_commitment, undefined, 'nothing is committed to before the transaction is known');
      this.checkKeypath(input.keypath);
      if (!input.prevOutValue) throw new DeviceRefusal(101, 'invalid input');
      if (![0xffffffff, 0xfffffffe, 0xfffffffd].includes(input.sequence)) throw new DeviceRefusal(101, 'invalid input');
      this.inputs.push(input);
      return { btc_sign_next: { type: 3, index: this.at } };
    }
    if (btc.prevtx_init) {
      const tx = new bitcoin.Transaction();
      tx.version = btc.prevtx_init.version;
      tx.locktime = btc.prevtx_init.locktime ?? 0;
      this.prev = { tx, init: btc.prevtx_init };
      return wrapped({ type: 4, index: this.at, prev_index: 0 });
    }
    if (btc.prevtx_input && this.prev) {
      const part = btc.prevtx_input;
      this.prev.tx.addInput(
        Buffer.from(part.prev_out_hash),
        part.prev_out_index ?? 0,
        part.sequence,
        Buffer.from(part.signature_script ?? [])
      );
      const more = this.prev.tx.ins.length < this.prev.init.num_inputs;
      return wrapped({ type: more ? 4 : 5, index: this.at, prev_index: more ? this.prev.tx.ins.length : 0 });
    }
    if (btc.prevtx_output && this.prev) {
      const part = btc.prevtx_output;
      this.prev.tx.addOutput(Buffer.from(part.pubkey_script), part.value ?? 0);
      if (this.prev.tx.outs.length < this.prev.init.num_outputs) {
        return wrapped({ type: 5, index: this.at, prev_index: this.prev.tx.outs.length });
      }
      // The point of the exercise: the coin is what the previous transaction says it is.
      const input = this.inputs[this.at];
      const spent = this.prev.tx.outs[input.prevOutIndex ?? 0];
      if (!Buffer.from(this.prev.tx.getHash()).equals(Buffer.from(input.prevOutHash)) || spent?.value !== input.prevOutValue) {
        throw new DeviceRefusal(101, 'invalid input');
      }
      this.prev = null;
      this.at++;
      if (this.at < this.init.num_inputs) return wrapped({ type: 0, index: this.at });
      this.at = 0;
      return wrapped({ type: 1, index: 0 });
    }
    if (request.btc_sign_output) {
      const output = request.btc_sign_output;
      const script = this.outputScript(output);
      const change = output.ours && output.keypath[output.keypath.length - 2] === 1;
      if (!change) {
        const address = bitcoin.address.fromOutputScript(script, this.network);
        this.device.screens.push(`${output.ours ? 'This BitBox02: ' : ''}${output.value ?? 0} to ${address}`);
      }
      this.outputs.push(output);
      this.at++;
      if (this.at < this.init.num_outputs) return { btc_sign_next: { type: 1, index: this.at } };
      if (how === 'asks-too-much' && !this.extraAsked) {
        this.extraAsked = true;
        return { btc_sign_next: { type: 1, index: this.init.num_outputs } };
      }
      const spent = this.inputs.reduce((s, i) => s + i.prevOutValue, 0);
      const sent = this.outputs.reduce((s, o) => s + (o.value ?? 0), 0);
      this.device.screens.push(`Fee: ${spent - sent}`);
      if (this.device.behaviour.cancel === 'transaction') throw new DeviceRefusal(104, 'aborted by the user');
      this.pass = 2;
      this.at = 0;
      return { btc_sign_next: { type: 0, index: 0 } };
    }
    if (request.btc_sign_input && this.pass === 2) {
      const input = request.btc_sign_input;
      const first = this.inputs[this.at];
      assert.deepEqual({ ...input, host_nonce_commitment: undefined }, { ...first, host_nonce_commitment: undefined });
      if (how === 'no-antiklepto') return this.signed(bytes32(big(sha256(Buffer.from(`nonce ${this.at}`)))));
      const committed = input.host_nonce_commitment?.commitment;
      if (!committed || committed.length !== 32) throw new DeviceRefusal(101, 'invalid input');
      const nonce = mod(big(sha256(Buffer.concat([Buffer.from(`nonce ${this.at}`), committed]))), N);
      this.commitment = { nonce, hostCommitment: Buffer.from(committed) };
      return {
        btc_sign_next: {
          type: 6,
          index: this.at,
          anti_klepto_signer_commitment: {
            commitment: Buffer.from(secp256k1.ProjectivePoint.BASE.multiply(nonce).toRawBytes(true)),
          },
        },
      };
    }
    if (btc.antiklepto_signature && this.commitment) {
      const hostNonce = Buffer.from(btc.antiklepto_signature.host_nonce);
      // The phone must reveal what it committed to, or it could steer the nonce.
      if (!taggedHash('s2c/ecdsa/data', hostNonce).equals(this.commitment.hostCommitment)) {
        throw new DeviceRefusal(101, 'invalid input');
      }
      const point = Buffer.from(secp256k1.ProjectivePoint.BASE.multiply(this.commitment.nonce).toRawBytes(true));
      const tweak = mod(big(taggedHash('s2c/ecdsa/point', Buffer.concat([point, hostNonce]))), N);
      const k = how === 'ignores-host-nonce' ? this.commitment.nonce : mod(this.commitment.nonce + tweak, N);
      this.commitment = null;
      return wrapped(this.signed(bytes32(k)).btc_sign_next);
    }
    throw new DeviceRefusal(105, "can't call this endpoint: wrong state");
  }

  private signed(nonce: Buffer): { btc_sign_next: Message } {
    const input = this.inputs[this.at];
    const [branch, index] = this.checkKeypath(input.keypath);
    const digest = this.transaction().hashForWitnessV0(
      this.at,
      this.script(branch, index).witnessScript,
      input.prevOutValue,
      bitcoin.Transaction.SIGHASH_ALL
    );
    const keypath = this.device.behaviour.signing === 'wrong-key' ? [...this.account, branch, index + 1] : input.keypath;
    const signature = signWithNonce(digest, this.node(keypath).privateKey!, big(nonce));
    this.at++;
    const done = this.at >= this.init.num_inputs && this.device.behaviour.signing !== 'never-finishes';
    if (done) this.device.finishSigning();
    else if (this.at >= this.init.num_inputs) this.at = 0;
    return { btc_sign_next: { type: done ? 2 : 0, index: done ? 0 : this.at, has_signature: true, signature } };
  }
}

function taggedHash(tag: string, message: Uint8Array): Buffer {
  const t = sha256(Buffer.from(tag, 'ascii'));
  return Buffer.from(sha256(Buffer.concat([t, t, message])));
}

// --- wallets and coins ---------------------------------------------------------

const DEVICE_MNEMONIC = MNEMONICS[1];
const DEVICE_FINGERPRINT = masterFingerprint(DEVICE_MNEMONIC);

function walletWith(network: NetworkName = 'mainnet', name = 'Family savings', m = 2): MultisigWallet {
  return makeWallet(m, [MNEMONICS[0], DEVICE_MNEMONIC, MNEMONICS[2]], network, name);
}

/** One genuine funding transaction per coin, so previous transactions hash to what the inputs spend. */
function fund(wallet: MultisigWallet, values: number[]): { snapshot: WalletSnapshot; funding: Map<string, Buffer> } {
  const funding = new Map<string, Buffer>();
  const utxos: Utxo[] = values.map((value, i) => {
    const address = deriveAddress(wallet, 0, i);
    const tx = new bitcoin.Transaction();
    tx.version = 2;
    tx.locktime = 100 + i;
    tx.addInput(Buffer.alloc(32, 0x40 + i), i, 0xfffffffe, unhex('0014' + '11'.repeat(20)));
    tx.addInput(Buffer.alloc(32, 0x50 + i), 7, 0xffffffff);
    tx.addOutput(unhex('0014' + '22'.repeat(20)), 12_345);
    tx.addOutput(address.script, value);
    funding.set(tx.getId(), tx.toBuffer());
    return { txid: tx.getId(), vout: 1, value, address: address.address, branch: 0, index: i, confirmed: true };
  });
  return {
    funding,
    snapshot: {
      confirmedSats: values.reduce((s, v) => s + v, 0),
      unconfirmedSats: 0,
      utxos,
      usedAddresses: [],
      nextReceiveIndex: values.length,
      nextChangeIndex: 0,
      scannedAt: 0,
    },
  };
}

function spend(wallet: MultisigWallet, values: number[], amount: number, to = DEST_MAINNET) {
  const { snapshot, funding } = fund(wallet, values);
  const built = buildPsbt(wallet, snapshot, to, amount, 3, amount === 0);
  const draft = built.psbt.toBase64();
  const psbt = parsePsbt(draft, wallet.network);
  psbt.txInputs.forEach((input, i) => {
    psbt.updateInput(i, { nonWitnessUtxo: funding.get(Buffer.from(input.hash).reverse().toString('hex'))! });
  });
  return { draft, psbt, snapshot, funding, built };
}

function connectTo(fake: FakeBitBox02, overrides: Partial<BitBox02Options> = {}) {
  const prompts = new ScriptedPrompts();
  const memory = new MapMemory();
  const sleeps: number[] = [];
  const options: BitBox02Options = {
    prompts,
    memory,
    testing: {
      attestationRoots: [ATTESTATION_ROOT_PUBLIC],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
    ...overrides,
  };
  return { device: new BitBox02Device(fake, options), prompts, memory, sleeps, options };
}

async function readyDevice(behaviour: Partial<FakeBehaviour> = {}) {
  const fake = new FakeBitBox02(DEVICE_MNEMONIC, behaviour);
  const session = connectTo(fake);
  await session.device.connect();
  session.prompts.statuses.length = 0;
  return { fake, ...session };
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

describe('BitBox02 framing (U2F-HID)', () => {
  it('sends a short message as one padded packet', () => {
    const packets = encodeFrame(HWW_CMD, unhex('00aabb'));
    assert.equal(packets.length, 1);
    assert.equal(hex(packets[0]), 'ff000000' + 'c1' + '0003' + '00aabb' + 'ee'.repeat(54));
  });

  it('splits a long message into numbered packets of 64 bytes', () => {
    const message = Buffer.from(Array.from({ length: 57 + 59 + 10 }, (_, i) => i % 251));
    const packets = encodeFrame(HWW_CMD, message);
    assert.equal(packets.length, 3);
    for (const p of packets) assert.equal(p.length, 64);
    assert.equal(hex(packets[0].subarray(0, 7)), 'ff000000c1007e');
    assert.equal(hex(packets[1].subarray(0, 5)), 'ff00000000');
    assert.equal(hex(packets[2].subarray(0, 5)), 'ff00000001');
    assert.equal(hex(packets[0].subarray(7)), hex(message.subarray(0, 57)));
    assert.equal(hex(packets[1].subarray(5)), hex(message.subarray(57, 116)));
    assert.equal(hex(packets[2].subarray(5, 15)), hex(message.subarray(116)));
    assert.equal(hex(packets[2].subarray(15)), 'ee'.repeat(49));
  });

  it('fills the last packet exactly, without an empty one after it', () => {
    assert.equal(encodeFrame(HWW_CMD, Buffer.alloc(57, 1)).length, 1);
    assert.equal(encodeFrame(HWW_CMD, Buffer.alloc(58, 1)).length, 2);
    assert.equal(encodeFrame(HWW_CMD, Buffer.alloc(57 + 59, 1)).length, 2);
    assert.equal(encodeFrame(HWW_CMD, Buffer.alloc(57 + 59 + 1, 1)).length, 3);
  });

  it('reads back what it wrote, at every awkward length', async () => {
    for (const length of [1, 56, 57, 58, 115, 116, 117, 1000, maxMessageLength(64)]) {
      const wire = new Loopback();
      const message = Buffer.from(Array.from({ length }, (_, i) => (i * 7) % 256));
      await writeFrame(wire, HWW_CMD, message);
      assert.ok((await readFrame(wire, HWW_CMD, 10)).equals(message), `length ${length}`);
      assert.equal(wire.packets.length, 0);
    }
  });

  it('refuses a message too large for the protocol, and an empty one', () => {
    assert.equal(maxMessageLength(64), 7609);
    assert.throws(() => encodeFrame(HWW_CMD, Buffer.alloc(7610)), /too large/);
    assert.throws(() => encodeFrame(HWW_CMD, Buffer.alloc(0)), /empty/);
  });

  it('refuses packets from another channel, command or place in the sequence', async () => {
    const message = Buffer.alloc(200, 5);
    const tampered = async (change: (packets: Buffer[]) => void) => {
      const wire = new Loopback();
      await writeFrame(wire, HWW_CMD, message);
      change(wire.packets);
      return readFrame(wire, HWW_CMD, 10);
    };
    await assert.rejects(tampered((p) => p[0].writeUInt32BE(0xff000001, 0)), /unexpected channel/);
    await assert.rejects(tampered((p) => p[2].writeUInt32BE(0x01000000, 0)), /unexpected channel/);
    await assert.rejects(tampered((p) => (p[0][4] = 0xc3)), /different command/);
    await assert.rejects(tampered((p) => (p[1][4] = 1)), /out of order/);
    await assert.rejects(tampered((p) => p.splice(1, 1)), /out of order/);
    await assert.rejects(tampered((p) => p.pop()), TransportTimeout);
  });

  it('reports the device’s own framing errors with their code', async () => {
    const wire = new Loopback();
    wire.packets.push(Buffer.concat([unhex('ff000000bf000101'), Buffer.alloc(56)]));
    await assert.rejects(readFrame(wire, HWW_CMD, 10), (e: any) => e instanceof FrameError && e.code === 1);
  });
});

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

describe('BitBox02 secure channel (Noise XX)', () => {
  // The cacophony test vector for Noise_XX_25519_ChaChaPoly_SHA256
  // (github.com/haskell-cryptography/cacophony, vectors/cacophony.txt).
  const vector = {
    prologue: '4a6f686e2047616c74',
    initStatic: 'e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1',
    initEphemeral: '893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a',
    respStatic: '4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893',
    handshakeHash: 'c8e5f64e846193be2a834104c2a009868d6c9f3bd3c186299888b488b2f1f58e',
    messages: [
      ['4c756477696720766f6e204d69736573', 'ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c79444c756477696720766f6e204d69736573'],
      ['4d757272617920526f746862617264', '95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f14480884381cbad1f276e038c48378ffce2b65285e08d6b68aaa3629a5a8639392490e5b9bd5269c2f1e4f488ed8831161f19b7815528f8982ffe09be9b5c412f8a0db50f8814c7194e83f23dbd8d162c9326ad'],
      ['462e20412e20486179656b', 'c7195ffacac1307ff99046f219750fc47693e23c3cb08b89c2af808b444850a80ae475b9df0f169ae80a89be0865b57f58c9fea0d4ec82a286427402f113e4b6ae769a1d95941d49b25030'],
      ['4361726c204d656e676572', '96763ed773f8e47bb3712f0e29b3060ffc956ffc146cee53d5e1df'],
      ['4a65616e2d426170746973746520536179', '3e40f15f6f3a46ae446b253bf8b1d9ffb6ed9b174d272328ff91a7e2e5c79c07f5'],
      ['457567656e2042f6686d20766f6e2042617765726b', 'eb3f3515110702e047a6c9da4478b6ead94873c11c0f2d710ddb3f09fce024b3a58502ae3f'],
    ],
  };

  it('reproduces the published test vector', () => {
    const initiator = new NoiseInitiator(
      keypairFromPrivate(unhex(vector.initStatic)),
      unhex(vector.prologue),
      keypairFromPrivate(unhex(vector.initEphemeral))
    );
    const [m0, m1, m2, m3, m4, m5] = vector.messages;
    assert.equal(hex(initiator.writeFirst(unhex(m0[0]))), m0[1]);
    assert.equal(hex(initiator.readSecond(unhex(m1[1]))), m1[0]);
    const channel = initiator.writeThird(unhex(m2[0]));
    assert.equal(hex(channel.message), m2[1]);
    assert.equal(hex(channel.handshakeHash), vector.handshakeHash);
    assert.equal(hex(channel.remoteStatic), hex(x25519.getPublicKey(unhex(vector.respStatic))));
    // Then the channel itself, a message each way in turn.
    assert.equal(hex(channel.receive.decrypt(unhex(m3[1]))), m3[0]);
    assert.equal(hex(channel.send.encrypt(unhex(m4[0]))), m4[1]);
    assert.equal(hex(channel.receive.decrypt(unhex(m5[1]))), m5[0]);
  });

  const handshake = () => {
    const phone = keypairFromPrivate(x25519.utils.randomPrivateKey());
    const prologue = Buffer.from(PROTOCOL_NAME, 'ascii');
    const initiator = new NoiseInitiator(phone, prologue);
    const responder = new TestResponder(
      Buffer.from(x25519.utils.randomPrivateKey()),
      Buffer.from(x25519.utils.randomPrivateKey()),
      prologue
    );
    return { phone, initiator, responder };
  };

  it('agrees with an independent responder on keys, hash and identities', () => {
    const { phone, initiator, responder } = handshake();
    responder.readFirst(initiator.writeFirst());
    initiator.readSecond(responder.writeSecond());
    const channel = initiator.writeThird();
    assert.equal(channel.message.length, 64, 'an encrypted key and an empty payload');
    responder.readThird(channel.message);

    assert.equal(hex(channel.handshakeHash), hex(responder.h));
    assert.equal(hex(channel.remoteStatic), hex(responder.sPublic));
    assert.equal(hex(responder.rs!), hex(phone.publicKey));

    const [fromPhone, toPhone] = responder.split();
    const deviceReceives = new TestCipher(fromPhone);
    const deviceSends = new TestCipher(toPhone);
    for (const text of ['first', 'second', '']) {
      assert.equal(deviceReceives.open(channel.send.encrypt(Buffer.from(text))).toString(), text);
      assert.equal(channel.receive.decrypt(deviceSends.seal(Buffer.from(`re: ${text}`))).toString(), `re: ${text}`);
    }
  });

  it('never sends the same bytes twice for the same message', () => {
    const { initiator, responder } = handshake();
    responder.readFirst(initiator.writeFirst());
    initiator.readSecond(responder.writeSecond());
    const channel = initiator.writeThird();
    assert.notEqual(hex(channel.send.encrypt(Buffer.from('same'))), hex(channel.send.encrypt(Buffer.from('same'))));
  });

  it('refuses a handshake that was tampered with', () => {
    const { initiator, responder } = handshake();
    responder.readFirst(initiator.writeFirst());
    const second = responder.writeSecond();
    second[40] ^= 1;
    assert.throws(() => initiator.readSecond(second), /failed the secure-channel handshake/);
  });

  it('refuses handshake messages out of order or cut short', () => {
    const { initiator, responder } = handshake();
    assert.throws(() => initiator.readSecond(Buffer.alloc(96)), /out of order/);
    assert.throws(() => initiator.writeThird(), /out of order/);
    responder.readFirst(initiator.writeFirst());
    assert.throws(() => initiator.writeFirst(), /out of order/);
    assert.throws(() => initiator.readSecond(responder.writeSecond().subarray(0, 95)), /too short/);
  });

  it('refuses a message that was altered, replayed or reordered', () => {
    const key = Buffer.alloc(32, 9);
    const sender = new CipherState(key);
    const first = sender.encrypt(Buffer.from('one'));
    const second = sender.encrypt(Buffer.from('two'));

    const altered = Buffer.from(first);
    altered[0] ^= 1;
    const receiver = new CipherState(key);
    assert.throws(() => receiver.decrypt(altered), /out of step/);
    // A failed message does not advance the counter: the genuine one still opens.
    assert.equal(receiver.decrypt(first).toString(), 'one');
    assert.throws(() => receiver.decrypt(first), /out of step/, 'replayed');
    assert.equal(receiver.decrypt(second).toString(), 'two');

    assert.throws(() => new CipherState(key).decrypt(second), /out of step/, 'out of order');
    assert.throws(() => new CipherState(key).decrypt(Buffer.alloc(15)), /too short/);
  });

  it('formats the pairing code as the device draws it', () => {
    // From the firmware's own test (workflow/pairing.rs).
    const hash = unhex('59289bdbbbb6b68e8f127f49a525b03013500b3c1af2626f4007ebe44f09c86b');
    assert.equal(pairingCode(hash), 'LEUJX W53W2\n3I5DY SP5E2');
    assert.equal(pairingCode(Buffer.alloc(32)), 'AAAAA AAAAA\nAAAAA AAAAA');
    assert.equal(pairingCode(Buffer.alloc(32, 0xff)), '77777 77777\n77777 77777');
    for (let i = 0; i < 20; i++) {
      const random = Buffer.from(sha256(Buffer.from(`hash ${i}`)));
      assert.equal(pairingCode(random), fakePairingCode(random));
    }
    assert.throws(() => pairingCode(Buffer.alloc(31)));
  });
});

// ---------------------------------------------------------------------------
// Attestation
// ---------------------------------------------------------------------------

describe('BitBox02 attestation', () => {
  const root = unhex('15608dfed8e876bed1cf2599574ce853f7a2a017d19ba0aabd4bcba033a70880');
  const rootPublic = hex(secp256k1.getPublicKey(root, false));
  const deviceKey = unhex('9b1a4d293a6eef1960d8afab5e58dd581b135152ec3399bde9268fa23051321b');
  const devicePublic = Buffer.from(p256.getPublicKey(deviceKey, false).subarray(1));
  const bootloaderHash = unhex('3fdf2ff2dcbd31d161a525a88cb57641209c7eac2bc014564a03d34a825144f0');
  const challenge = unhex('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff');

  const attestation = (
    parts: Partial<{ bootloaderHash: Buffer; devicePublic: Buffer; certificate: Buffer; rootId: Buffer; proof: Buffer }> = {}
  ) =>
    Buffer.concat([
      parts.bootloaderHash ?? bootloaderHash,
      parts.devicePublic ?? devicePublic,
      parts.certificate ??
        Buffer.from(secp256k1.sign(sha256(Buffer.concat([bootloaderHash, devicePublic])), root).toCompactRawBytes()),
      parts.rootId ?? Buffer.from(sha256(unhex(rootPublic))),
      parts.proof ?? Buffer.from(p256.sign(sha256(challenge), deviceKey).toCompactRawBytes()),
    ]);

  it('uses the same root key as the official library’s test', () => {
    // bitbox02-api-go, TestPerformAttestation: the identifier of this root key.
    assert.equal(hex(sha256(unhex(rootPublic))), '11554d841e74066eebc3556ed6dea4d6ceef3940009222c77c3b966349989de1');
  });

  it('accepts a device certified by a trusted root that signs the challenge', () => {
    assert.doesNotThrow(() => verifyAttestation(challenge, attestation(), [rootPublic]));
  });

  it('accepts signatures whether or not S was normalised', () => {
    const flip = (curveOrder: bigint, signature: Uint8Array) =>
      Buffer.concat([Buffer.from(signature.subarray(0, 32)), bytes32(curveOrder - big(signature.subarray(32)))]);
    const certificate = flip(N, secp256k1.sign(sha256(Buffer.concat([bootloaderHash, devicePublic])), root).toCompactRawBytes());
    const proof = flip(p256.CURVE.n, p256.sign(sha256(challenge), deviceKey).toCompactRawBytes());
    assert.doesNotThrow(() => verifyAttestation(challenge, attestation({ certificate, proof }), [rootPublic]));
  });

  it('refuses a certificate from a key the manufacturer does not hold', () => {
    assert.throws(() => verifyAttestation(challenge, attestation()), /not issued by the manufacturer/);
    assert.throws(() => verifyAttestation(challenge, attestation(), []), /not issued by the manufacturer/);
  });

  it('refuses a certificate that does not cover this device', () => {
    const other = Buffer.from(p256.getPublicKey(p256.utils.randomPrivateKey(), false).subarray(1));
    assert.throws(() => verifyAttestation(challenge, attestation({ devicePublic: other }), [rootPublic]), /certificate does not verify/);
    assert.throws(
      () => verifyAttestation(challenge, attestation({ bootloaderHash: Buffer.alloc(32, 1) }), [rootPublic]),
      /certificate does not verify/
    );
    assert.throws(
      () => verifyAttestation(challenge, attestation({ certificate: Buffer.alloc(64) }), [rootPublic]),
      /certificate does not verify/
    );
  });

  it('refuses a device that cannot sign the challenge with its certified key', () => {
    const stale = Buffer.from(p256.sign(sha256(Buffer.alloc(32, 7)), deviceKey).toCompactRawBytes());
    const foreign = Buffer.from(p256.sign(sha256(challenge), p256.utils.randomPrivateKey()).toCompactRawBytes());
    for (const proof of [stale, foreign, Buffer.alloc(64)]) {
      assert.throws(() => verifyAttestation(challenge, attestation({ proof }), [rootPublic]), /could not prove/);
    }
    // The same answer to a different question is no answer.
    assert.throws(() => verifyAttestation(Buffer.alloc(32, 7), attestation(), [rootPublic]), /could not prove/);
  });

  it('refuses an answer of the wrong size', () => {
    assert.throws(() => verifyAttestation(challenge, attestation().subarray(1), [rootPublic]), /wrong size/);
    assert.throws(() => verifyAttestation(challenge.subarray(1), attestation(), [rootPublic]), /32 bytes/);
  });

  it('trusts exactly the manufacturer’s published keys', () => {
    assert.equal(ATTESTATION_ROOT_KEYS.length, 110);
    assert.equal(new Set(ATTESTATION_ROOT_KEYS).size, 110);
    for (const key of ATTESTATION_ROOT_KEYS) {
      assert.match(key, /^04[0-9a-f]{128}$/);
      assert.doesNotThrow(() => secp256k1.ProjectivePoint.fromHex(key).assertValidity());
    }
    // The list as a whole, so that an edit to any one key is noticed.
    assert.equal(
      hex(sha256(Buffer.from(ATTESTATION_ROOT_KEYS.join('\n'), 'ascii'))),
      '49c77bafdeba2656e039e855e4e5e8549c38584184a0c555670efeede7159088'
    );
  });
});

// ---------------------------------------------------------------------------
// Anti-klepto
// ---------------------------------------------------------------------------

describe('BitBox02 anti-klepto', () => {
  // Fixtures from bitbox02-api-go, api/firmware/secp256k1_test.go.
  const fixtures = [
    {
      hostNonce: '8b4c26aa2695a34bdbc34235f6c91be14b93037a063b13f7c814101359561092',
      commitment: '0236ff92fe02c08d0d04851e0ce1516104085215f05a178307de60ea53e207f971',
      signature:
        '7fd66b48ffea2fe048869880bbb3a1819e262af14980e8885df1e5765750cb8f47e01eca356377870356d54853573a955076228e5044cd3dd3a049abe70d5585',
    },
    {
      hostNonce: '9c9471aa529fbad96396b9379938e56195c5aa8e1e22b6e87d226e49d8b1f581',
      commitment: '034e2979d398ce029996ffe99dc310a0f2cf9a5411b166f57a85fc3a24985f16be',
      signature:
        '48cb61d08c730e36b0285dfd9ece91e88a5ec0898d1c80b93e85b967e0ddcd195ab807640347e8f96e3fad67a971fc52eb4f15b4fa65577bcf4a053e598d057d',
    },
  ];

  it('hashes with the tags the firmware uses', () => {
    assert.equal(
      hex(taggedSha256('test tag', Buffer.from('test message'))),
      '025ee06f5a2db377bd9d7040bae8f6e0ab49784f9c68a1380fba5465d8a99928'
    );
    assert.equal(
      hex(hostCommitment(unhex('e8011345fe4851538c30c1fc1a215395e8063fcf6fbdcf8fab9a42e466a74f4a'))),
      '70a8934f41a1679b4c715c3e6db17f785b67da4e398107a0a00c828980a4be2f'
    );
  });

  it('accepts signatures recorded from a real device', () => {
    for (const f of fixtures) {
      assert.doesNotThrow(() => verifyAntiklepto(unhex(f.hostNonce), unhex(f.commitment), unhex(f.signature)));
    }
  });

  it('refuses a signature that did not use the phone’s randomness', () => {
    for (const f of fixtures) {
      const nonce = unhex(f.hostNonce);
      nonce[0]++;
      assert.throws(() => verifyAntiklepto(nonce, unhex(f.commitment), unhex(f.signature)), /did not use this phone’s randomness/);
    }
    const [a, b] = fixtures;
    assert.throws(() => verifyAntiklepto(unhex(a.hostNonce), unhex(b.commitment), unhex(a.signature)), /randomness/);
    assert.throws(() => verifyAntiklepto(unhex(a.hostNonce), unhex(a.commitment), unhex(b.signature)), /randomness/);
    assert.throws(() => verifyAntiklepto(unhex(a.hostNonce), Buffer.alloc(33, 2), unhex(a.signature)), /randomness/);
  });

  it('refuses signatures Bitcoin would not accept', () => {
    const f = fixtures[0];
    const valid = unhex(f.signature);
    const highS = unhex(
      '7fd66b48ffea2fe048869880bbb3a1819e262af14980e8885df1e5765750cb8fb81fe135ca9c8878fca92ab7aca8c5696a38ba585f03d2fdec3214e0e928ebbc'
    );
    assert.throws(() => verifyAntiklepto(unhex(f.hostNonce), unhex(f.commitment), highS), /high S/);
    const replace = (offset: number, scalar: Buffer) => {
      const out = Buffer.from(valid);
      scalar.copy(out, offset);
      return out;
    };
    for (const bad of [
      valid.subarray(0, 63),
      Buffer.concat([valid, Buffer.alloc(1)]),
      replace(0, Buffer.alloc(32)),
      replace(0, bytes32(N)),
      replace(32, Buffer.alloc(32)),
      replace(32, bytes32(N)),
    ]) {
      assert.throws(() => validateCompactSignature(bad));
      assert.throws(() => verifyAntiklepto(unhex(f.hostNonce), unhex(f.commitment), bad));
    }
  });
});

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

describe('BitBox02 messages', () => {
  const account = [48 + H, 0 + H, 0 + H, 2 + H];
  const xpubs = REFERENCE_XPUBS.map(xpubMessage);
  const config = { multisig: { threshold: 2, xpubs, our_xpub_index: 1, script_type: 0 } };
  const registration = { coin: 0, script_config: config, keypath: account };

  // What the driver passes in — zeroes and all — and what must go over the cable.
  const requests: Record<string, Message> = {
    'request.fingerprint': { fingerprint: {} },
    'request.device_info': { device_info: {} },
    'request.restore_from_mnemonic': { restore_from_mnemonic: { timestamp: 1790000000, timezone_offset: -3600 } },
    'request.btc_pub.mainnet': { btc_pub: { coin: 0, keypath: account, xpub_type: 1, display: false } },
    'request.btc_pub.testnet': { btc_pub: { coin: 1, keypath: [48 + H, 1 + H, 0 + H, 2 + H], xpub_type: 0, display: false } },
    'request.is_registered': { btc: { is_script_config_registered: { registration } } },
    'request.register': {
      btc: {
        register_script_config: {
          registration: { coin: 1, script_config: config, keypath: [48 + H, 1 + H, 0 + H, 2 + H] },
          name: 'Family savings',
          xpub_type: 1,
        },
      },
    },
    'request.sign_init': {
      btc_sign_init: {
        coin: 0,
        script_configs: [{ script_config: config, keypath: account }],
        version: 2,
        num_inputs: 2,
        num_outputs: 2,
        locktime: 0,
        format_unit: 0,
      },
    },
    'request.sign_input.pass1': {
      btc_sign_input: {
        prevOutHash: Buffer.from(Array.from({ length: 32 }, (_, i) => i)),
        prevOutIndex: 0,
        prevOutValue: 150_000,
        sequence: 0xfffffffd,
        keypath: [...account, 0, 0],
        script_config_index: 0,
      },
    },
    'request.sign_input.pass2': {
      btc_sign_input: {
        prevOutHash: Buffer.from(Array.from({ length: 32 }, (_, i) => i)),
        prevOutIndex: 1,
        prevOutValue: 2_100_000_000_000_000,
        sequence: 0xffffffff,
        keypath: [...account, 1, 9999],
        script_config_index: 0,
        host_nonce_commitment: { commitment: Buffer.alloc(32, 0xab) },
      },
    },
    'request.sign_output.ours': {
      btc_sign_output: { ours: true, value: 49_115, keypath: [...account, 1, 0], script_config_index: 0 },
    },
    'request.sign_output.external': {
      btc_sign_output: { ours: false, type: 3, value: 200_000, payload: Buffer.alloc(20, 0x75) },
    },
    'request.prevtx_init': { btc: { prevtx_init: { version: 2, num_inputs: 1, num_outputs: 2, locktime: 100 } } },
    'request.prevtx_input': {
      btc: {
        prevtx_input: {
          prev_out_hash: Buffer.alloc(32, 0x40),
          prev_out_index: 0,
          signature_script: unhex('0014' + '11'.repeat(20)),
          sequence: 0xfffffffe,
        },
      },
    },
    'request.prevtx_output': { btc: { prevtx_output: { value: 12_345, pubkey_script: unhex('0014' + '22'.repeat(20)) } } },
    'request.antiklepto_signature': { btc: { antiklepto_signature: { host_nonce: Buffer.alloc(32, 0xcd) } } },
  };

  it('encodes every request byte for byte as the official library does', () => {
    for (const [name, request] of Object.entries(requests)) {
      assert.equal(hex(encodeRequest(request)), REFERENCE[name], name);
    }
    assert.equal(
      Object.keys(requests).length,
      Object.keys(REFERENCE).filter((k) => k.startsWith('request.')).length,
      'every reference request is covered'
    );
  });

  it('keeps a zero that is an answer in itself', () => {
    // xpub_type sits in a oneof: TPUB is 0, and leaving it out asks for nothing.
    assert.ok(REFERENCE['request.btc_pub.testnet'].endsWith('1800'));
    assert.equal(decodeMessage(Request, unhex(REFERENCE['request.btc_pub.testnet'])).btc_pub.xpub_type, 0);
  });

  it('reads every response the official library would send', () => {
    const read = (name: string) => decodeResponse(unhex(REFERENCE[name]));
    assert.deepEqual(read('response.success'), { success: {} });
    assert.deepEqual(read('response.error'), { error: { code: 104, message: 'aborted by the user' } });
    assert.deepEqual(read('response.fingerprint'), { fingerprint: { fingerprint: unhex('4c00739d') } });
    assert.deepEqual(read('response.pub'), { pub: { pub: REFERENCE_XPUBS[1] } });
    assert.deepEqual(read('response.device_info'), {
      device_info: { name: 'My BitBox', initialized: true, version: 'v9.27.1' },
    });
    assert.deepEqual(read('response.sign_next.input0'), { btc_sign_next: {} });
    assert.deepEqual(read('response.sign_next.host_nonce'), {
      btc_sign_next: {
        type: 6,
        index: 1,
        anti_klepto_signer_commitment: { commitment: Buffer.concat([Buffer.from([2]), Buffer.alloc(32, 0x33)]) },
      },
    });
    assert.deepEqual(read('response.sign_next.signature'), {
      btc: { sign_next: { type: 2, has_signature: true, signature: Buffer.alloc(64, 0x44) } },
    });
    assert.deepEqual(read('response.sign_next.prevtx_output'), {
      btc: { sign_next: { type: 5, index: 1, prev_index: 2 } },
    });
    assert.deepEqual(read('response.is_registered'), { btc: { is_script_config_registered: { is_registered: true } } });
    assert.deepEqual(read('response.not_registered'), { btc: { is_script_config_registered: {} } });
    assert.deepEqual(read('response.btc_success'), { btc: { success: {} } });
  });

  it('takes an extended key apart into the fields the device wants', () => {
    const xpub = accountXpub(MNEMONICS[0], 'mainnet');
    const node = bip32.fromBase58(xpub);
    const message = xpubMessage(xpub);
    assert.equal(hex(message.depth), '04');
    assert.equal(hex(message.parent_fingerprint), node.parentFingerprint.toString(16).padStart(8, '0'));
    assert.equal(message.child_num, 2 + H);
    assert.equal(hex(message.chain_code), hex(node.chainCode));
    assert.equal(hex(message.public_key), hex(node.publicKey));
    // The version prefix is not part of the key: a tpub of the same key reads the same.
    const asTestnet = bip32.fromPublicKey(Buffer.from(node.publicKey), Buffer.from(node.chainCode), btcNetwork('testnet'));
    Object.assign(asTestnet as any, { __DEPTH: 4, __INDEX: node.index, __PARENT_FINGERPRINT: node.parentFingerprint });
    assert.deepEqual(xpubMessage(asTestnet.toBase58()), message);
    assert.throws(() => xpubMessage('xpub661MyMwAqRbcFtXgS5'), /./);
  });

  it('reads the device’s description of itself', () => {
    const info = (version: string, tail: number[]) =>
      parseInfo(Buffer.concat([Buffer.from([version.length]), Buffer.from(version), Buffer.from(tail)]));
    assert.deepEqual(info('v9.27.1', [0, 1, 1, 1]), {
      version: [9, 27, 1],
      platform: 0,
      edition: 1,
      unlocked: true,
      initialized: true,
    });
    assert.deepEqual(info('v9.4.0-rc1', [2, 0, 0]), {
      version: [9, 4, 0],
      platform: 2,
      edition: 0,
      unlocked: false,
      initialized: undefined,
    });
    assert.throws(() => info('nonsense', [0, 0, 0]), /cannot read/);
    assert.throws(() => info('v9.27.1', [0, 0]), /did not say/);
    assert.throws(() => info('v9.27.1', [0, 0, 5]), /cannot read/);
    assert.throws(() => parseInfo(Buffer.alloc(0)), /did not say/);
  });

  it('says how the phone finds the device on the bus', () => {
    assert.deepEqual(BITBOX02_USB, {
      vendorId: 0x03eb,
      productIds: [0x2403],
      interface: 0,
      endpointIn: 0x81,
      endpointOut: 0x02,
      packetSize: 64,
    });
    assert.equal(BITBOX02_PRODUCT_STRINGS['BitBox02BTC'].bootloader, false);
    assert.equal(BITBOX02_PRODUCT_STRINGS['bb02btc-bootloader'].bootloader, true);
    assert.equal(BITBOX02_PRODUCT_STRINGS['BitBox02 Nova BTC-only bl'].bootloader, true);
    assert.equal(Object.keys(BITBOX02_PRODUCT_STRINGS).length, 8);
  });
});

// ---------------------------------------------------------------------------
// Describing a wallet and a transaction
// ---------------------------------------------------------------------------

describe('BitBox02 wallet and transaction description', () => {
  const abilities = { ownReceiveOutputs: true, opReturnOutputs: true };

  it('reads and writes key paths', () => {
    assert.deepEqual(parseKeypath("m/48'/0'/0'/2'"), [48 + H, H, H, 2 + H]);
    assert.deepEqual(parseKeypath('m/48h/1h/3h/2h/1/7'), [48 + H, 1 + H, 3 + H, 2 + H, 1, 7]);
    assert.deepEqual(parseKeypath('48H/0'), [48 + H, 0]);
    assert.deepEqual(parseKeypath('m'), []);
    assert.equal(formatKeypath([48 + H, H, H, 2 + H, 1, 7]), "m/48'/0'/0'/2'/1/7");
    for (const bad of ['m/x', "m/48''", 'm/-1', 'm/2147483648', 'm/1.5', "m/48'/0'/0 '"]) {
      assert.throws(() => parseKeypath(bad), /Cannot read the key path/, bad);
    }
  });

  it('knows which paths the device gives out without a warning', () => {
    assert.ok(isStandardMultisigPath(parseKeypath("m/48'/0'/0'/2'"), 'mainnet'));
    assert.ok(isStandardMultisigPath(parseKeypath("m/48'/0'/99'/1'"), 'mainnet'));
    assert.ok(isStandardMultisigPath(parseKeypath("m/48'/1'/5'"), 'testnet'));
    assert.ok(!isStandardMultisigPath(parseKeypath("m/48'/1'/0'/2'"), 'mainnet'), 'testnet coin on mainnet');
    assert.ok(!isStandardMultisigPath(parseKeypath("m/48'/0'/100'/2'"), 'mainnet'), 'account too high');
    assert.ok(!isStandardMultisigPath(parseKeypath("m/48'/0'/0'/3'"), 'mainnet'), 'unknown script type');
    assert.ok(!isStandardMultisigPath(parseKeypath("m/48'/0'/0/2'"), 'mainnet'), 'account not hardened');
    assert.ok(!isStandardMultisigPath(parseKeypath("m/45'"), 'mainnet'));
  });

  it('describes the wallet with this device’s key marked as its own', () => {
    const wallet = walletWith('testnet');
    const described = describeWallet(wallet, DEVICE_FINGERPRINT.toUpperCase());
    assert.equal(described.coin, 1);
    assert.deepEqual(described.accountKeypath, [48 + H, 1 + H, H, 2 + H]);
    assert.equal(described.cosigner.xpub, accountXpub(DEVICE_MNEMONIC, 'testnet'));
    assert.equal(described.scriptConfig.multisig.threshold, 2);
    assert.equal(described.scriptConfig.multisig.our_xpub_index, 1);
    assert.equal(described.scriptConfig.multisig.script_type, 0);
    assert.deepEqual(
      described.scriptConfig.multisig.xpubs,
      wallet.cosigners.map((c) => xpubMessage(c.xpub))
    );
  });

  it('refuses wallets the device could not sign for', () => {
    const wallet = walletWith();
    assert.throws(() => describeWallet(wallet, 'deadbeef'), /not one of this wallet’s cosigners/);
    assert.throws(() => describeWallet({ ...wallet, cosigners: wallet.cosigners.slice(1, 2), n: 1 }, DEVICE_FINGERPRINT), /2 to 15/);
    const sixteen = Array.from({ length: 16 }, (_, i) => ({
      ...wallet.cosigners[1],
      fingerprint: i === 0 ? DEVICE_FINGERPRINT : `0000000${i.toString(16)}`,
      xpub: rootFromMnemonic(DEVICE_MNEMONIC, 'mainnet').derivePath(`m/48'/0'/${i}'/2'`).neutered().toBase58(),
    }));
    assert.throws(() => describeWallet({ ...wallet, cosigners: sixteen, n: 16 }, DEVICE_FINGERPRINT), /2 to 15/);
    assert.throws(() => describeWallet({ ...wallet, m: 4 }, DEVICE_FINGERPRINT), /4 of 3/);
    assert.throws(() => describeWallet({ ...wallet, m: 0 }, DEVICE_FINGERPRINT), /0 of 3/);
    const twice = [wallet.cosigners[0], wallet.cosigners[1], { ...wallet.cosigners[0], fingerprint: 'aabbccdd' }];
    assert.throws(() => describeWallet({ ...wallet, cosigners: twice }, DEVICE_FINGERPRINT), /same key twice/);
  });

  it('names the wallet within what the device will store', () => {
    const named = (name: string, distinct = false) => registrationName({ ...walletWith(), name }, distinct);
    assert.equal(named('Family savings'), 'Family savings');
    assert.equal(named('  Família   savings ₿ '), 'Famlia savings');
    assert.equal(named('A wallet with a name that goes on and on'), 'A wallet with a name that goes');
    assert.equal(named('A wallet with a name that goes on and on').length, 30);
    // Cutting must not leave a space at the end, which the device refuses.
    assert.equal(named('Twenty-nine characters long.. and more'), 'Twenty-nine characters long..');
    assert.equal(named('₿₿₿'), '2-of-3 multisig');
    assert.equal(named(''), '2-of-3 multisig');
    for (const name of ['Family savings', 'A wallet with a name that goes on and on', '', '₿ ₿']) {
      for (const distinct of [false, true]) {
        const result = named(name, distinct);
        assert.match(result, /^[\x21-\x7e]([\x20-\x7e]{0,28}[\x21-\x7e])?$/, JSON.stringify(result));
      }
    }
    const tag = walletTag(walletWith());
    assert.match(tag, /^[0-9a-f]{4}$/);
    assert.equal(named('Family savings', true), `Family savings ${tag}`);
    assert.equal(named('A wallet with a name that goes on and on', true), `A wallet with a name that ${tag}`);
    // The tag follows the keys, not their order or the wallet's name.
    const wallet = walletWith();
    assert.equal(walletTag({ ...wallet, name: 'Other', cosigners: [...wallet.cosigners].reverse() }), tag);
    assert.notEqual(walletTag({ ...wallet, m: 3 }), tag);
    assert.notEqual(walletTag(walletWith('testnet')), tag);
  });

  it('describes each kind of address by its type and the hash inside it', () => {
    const payload = (address: string, network = bitcoin.networks.bitcoin) =>
      externalPayload(Buffer.from(bitcoin.address.toOutputScript(address, network)), abilities);
    assert.deepEqual(payload('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'), {
      type: 1,
      payload: unhex('77bff20c60e522dfaa3350c39b030a5d004e839a'),
    });
    assert.deepEqual(payload('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'), {
      type: 2,
      payload: unhex('b472a266d0bd89c13706a4132ccfb16f7c3b9fcb'),
    });
    assert.deepEqual(payload('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'), {
      type: 3,
      payload: unhex('751e76e8199196d454941c45d1b3a323f1433bd6'),
    });
    assert.deepEqual(payload('bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3'), {
      type: 4,
      payload: unhex('1863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262'),
    });
    assert.deepEqual(payload('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr'), {
      type: 5,
      payload: unhex('a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c'),
    });
    assert.deepEqual(externalPayload(unhex('6a0568656c6c6f'), abilities), { type: 6, payload: Buffer.from('hello') });
    assert.deepEqual(externalPayload(unhex('6a00'), abilities), { type: 6, payload: Buffer.alloc(0) });
    assert.throws(() => externalPayload(unhex('6a0568656c6c6f'), { ...abilities, opReturnOutputs: false }), /too old/);
    // Two pushes, a bare OP_RETURN, a bare multisig, a future witness version.
    for (const script of ['6a01aa01bb', '6a', '5121' + '02'.repeat(33) + '51ae', '5220' + '00'.repeat(32), '']) {
      assert.throws(() => externalPayload(unhex(script), abilities), /cannot show|too old/, script);
    }
  });

  it('walks through a spend: inputs with their histories, then outputs', () => {
    const wallet = walletWith();
    const { psbt, funding, snapshot } = spend(wallet, [150_000, 90_000], 200_000);
    const plan = planSigning({ wallet, psbt, fingerprint: DEVICE_FINGERPRINT }, abilities);

    assert.deepEqual(plan.init, {
      coin: 0,
      script_configs: [{ script_config: describeWallet(wallet, DEVICE_FINGERPRINT).scriptConfig, keypath: [48 + H, H, H, 2 + H] }],
      version: 2,
      num_inputs: 2,
      num_outputs: 2,
      locktime: 0,
      format_unit: 0,
    });

    const tx = bitcoin.Transaction.fromBuffer((psbt.data.globalMap.unsignedTx as any).toBuffer());
    plan.inputs.forEach((input, i) => {
      const utxo = snapshot.utxos.find((u) => u.txid === Buffer.from(tx.ins[i].hash).reverse().toString('hex'))!;
      assert.deepEqual(input.request, {
        prevOutHash: Buffer.from(tx.ins[i].hash),
        prevOutIndex: 1,
        prevOutValue: utxo.value,
        sequence: 0xfffffffd,
        keypath: [48 + H, H, H, 2 + H, 0, utxo.index],
        script_config_index: 0,
      });
      const previous = bitcoin.Transaction.fromBuffer(funding.get(utxo.txid)!);
      assert.deepEqual(input.prevTx.init, { version: 2, num_inputs: 2, num_outputs: 2, locktime: 100 + utxo.index });
      assert.deepEqual(input.prevTx.inputs[0], {
        prev_out_hash: Buffer.alloc(32, 0x40 + utxo.index),
        prev_out_index: utxo.index,
        signature_script: unhex('0014' + '11'.repeat(20)),
        sequence: 0xfffffffe,
      });
      assert.deepEqual(input.prevTx.inputs[1].signature_script, Buffer.alloc(0));
      assert.deepEqual(input.prevTx.outputs, [
        { value: 12_345, pubkey_script: unhex('0014' + '22'.repeat(20)) },
        { value: utxo.value, pubkey_script: Buffer.from(previous.outs[1].script) },
      ]);
      // The key and digest a signature will be held to are the wallet's own.
      const [job] = signingJobsFor(psbt.toBase64(), DEVICE_FINGERPRINT, 'mainnet').filter((j) => j.index === i);
      assert.equal(hex(input.pubkey), hex(job.pubkey));
      assert.equal(hex(input.sighash), hex(job.digest));
    });

    assert.deepEqual(plan.outputs, [
      { ours: false, type: 3, value: 200_000, payload: unhex('751e76e8199196d454941c45d1b3a323f1433bd6') },
      { ours: true, value: tx.outs[1].value, keypath: [48 + H, H, H, 2 + H, 1, 0], script_config_index: 0 },
    ]);
  });

  /** A copy of a spend with its second output rewritten. */
  const withOutput = (wallet: MultisigWallet, change: (honest: { script: Buffer; value: number; derivation: any }) => any) => {
    const { psbt: honest } = spend(wallet, [150_000], 50_000);
    const psbt = new bitcoin.Psbt({ network: btcNetwork(wallet.network) });
    psbt.setVersion(2);
    psbt.addInput({
      hash: Buffer.from(honest.txInputs[0].hash),
      index: honest.txInputs[0].index,
      sequence: honest.txInputs[0].sequence,
      witnessUtxo: honest.data.inputs[0].witnessUtxo!,
      witnessScript: honest.data.inputs[0].witnessScript!,
      bip32Derivation: honest.data.inputs[0].bip32Derivation!,
      nonWitnessUtxo: honest.data.inputs[0].nonWitnessUtxo!,
    });
    psbt.addOutput({ script: honest.txOutputs[0].script, value: honest.txOutputs[0].value });
    psbt.addOutput(
      change({
        script: Buffer.from(honest.txOutputs[1].script),
        value: honest.txOutputs[1].value,
        derivation: honest.data.outputs[1].bip32Derivation!,
      })
    );
    return psbt;
  };
  const thief = Buffer.from(bitcoin.address.toOutputScript('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'));

  it('does not take the PSBT’s word for what is change', () => {
    const wallet = walletWith();
    const plan = (psbt: bitcoin.Psbt) => planSigning({ wallet, psbt, fingerprint: DEVICE_FINGERPRINT }, abilities).outputs[1];

    // Honest change is the wallet's own.
    assert.equal(plan(withOutput(wallet, (h) => ({ script: h.script, value: h.value, bip32Derivation: h.derivation }))).ours, true);

    // Someone else's address carrying the wallet's change derivation is a payment.
    assert.deepEqual(plan(withOutput(wallet, (h) => ({ script: thief, value: h.value, bip32Derivation: h.derivation }))), {
      ours: false,
      type: 3,
      value: 99_430,
      payload: Buffer.from(thief.subarray(2)),
    });

    // The wallet's change address at index 0, claimed to sit at index 5: no match, so a payment.
    const moved = (h: any) => ({
      script: h.script,
      value: h.value,
      bip32Derivation: h.derivation.map((d: any) => ({ ...d, path: d.path.replace(/\/1\/0$/, '/1/5') })),
    });
    assert.equal(plan(withOutput(wallet, moved)).ours, false);

    // A derivation that only names other cosigners says nothing about this device.
    const others = (h: any) => ({
      script: h.script,
      value: h.value,
      bip32Derivation: h.derivation.filter((d: any) => hex(d.masterFingerprint) !== DEVICE_FINGERPRINT),
    });
    assert.equal(plan(withOutput(wallet, others)).ours, false);

    // No derivation at all.
    assert.equal(plan(withOutput(wallet, (h) => ({ script: h.script, value: h.value }))).ours, false);

    // A path outside the account, or deeper than branch and index.
    for (const path of ["m/48'/0'/1'/2'/1/0", "m/48'/0'/0'/2'/1/0/0", "m/48'/0'/0'/2'/2/0", "m/48'/0'/0'/2'/1/0'", 'nonsense']) {
      const elsewhere = (h: any) => ({
        script: h.script,
        value: h.value,
        bip32Derivation: h.derivation.map((d: any) => ({ ...d, path })),
      });
      assert.equal(plan(withOutput(wallet, elsewhere)).ours, false, path);
    }
  });

  it('shows a payment to the wallet’s own receive address as such only where the firmware can', () => {
    const wallet = walletWith();
    const receive = deriveAddress(wallet, 0, 3);
    const toSelf = withOutput(wallet, (h) => ({
      script: receive.script,
      value: h.value,
      witnessScript: receive.witnessScript,
      bip32Derivation: receive.derivations,
    }));
    const request = { wallet, psbt: toSelf, fingerprint: DEVICE_FINGERPRINT };
    assert.deepEqual(planSigning(request, abilities).outputs[1], {
      ours: true,
      value: 99_430,
      keypath: [48 + H, H, H, 2 + H, 0, 3],
      script_config_index: 0,
    });
    assert.deepEqual(planSigning(request, { ...abilities, ownReceiveOutputs: false }).outputs[1], {
      ours: false,
      type: 4,
      value: 99_430,
      payload: Buffer.from(receive.script.subarray(2)),
    });

    // Past the last index the device will derive for an output, it is shown as a plain address.
    const far = deriveAddress(wallet, 1, 10_000);
    const beyond = withOutput(wallet, (h) => ({ script: far.script, value: h.value, bip32Derivation: far.derivations }));
    assert.equal(planSigning({ ...request, psbt: beyond }, abilities).outputs[1].ours, false);
  });

  it('refuses inputs that are not what they claim', () => {
    const wallet = walletWith();
    const plan = (psbt: bitcoin.Psbt, fingerprint = DEVICE_FINGERPRINT) => planSigning({ wallet, psbt, fingerprint }, abilities);
    const fresh = () => spend(wallet, [150_000, 90_000], 200_000);

    {
      const { draft } = fresh();
      assert.throws(() => plan(parsePsbt(draft, 'mainnet')), /Input 1 is missing its previous transaction/);
    }
    {
      // The right kind of transaction, but not the one this input spends.
      const { psbt, funding } = fresh();
      const [first, second] = [...funding.values()];
      const swapped = Buffer.from(psbt.data.inputs[0].nonWitnessUtxo!).equals(first) ? second : first;
      (psbt.data.inputs[0] as any).nonWitnessUtxo = swapped;
      assert.throws(() => plan(psbt), /Input 1 comes with a previous transaction that is not the one it spends/);
    }
    {
      // An amount the previous transaction does not bear out — the lie the device exists to catch.
      const { psbt } = fresh();
      psbt.data.inputs[1].witnessUtxo = { ...psbt.data.inputs[1].witnessUtxo!, value: 1_000_000 };
      assert.throws(() => plan(psbt), /Input 2 does not match the coin in its previous transaction/);
    }
    {
      const { psbt } = fresh();
      psbt.data.inputs[0].bip32Derivation = psbt.data.inputs[0].bip32Derivation!.filter(
        (d) => hex(d.masterFingerprint) !== DEVICE_FINGERPRINT
      );
      assert.throws(() => plan(psbt), /Input 1 is not one this BitBox02’s key can sign/);
    }
    {
      // A coin of the wallet's, claimed to sit at another index.
      const { psbt } = fresh();
      psbt.data.inputs[0].bip32Derivation = psbt.data.inputs[0].bip32Derivation!.map((d) => ({
        ...d,
        path: d.path.replace(/\/0\/\d+$/, '/0/9'),
      }));
      assert.throws(() => plan(psbt), /Input 1 spends a coin that does not belong to this wallet/);
    }
    {
      // Another wallet's coin entirely, dressed in this wallet's derivations.
      const other = makeWallet(2, [MNEMONICS[3], DEVICE_MNEMONIC, MNEMONICS[4]]);
      const { psbt } = spend(other, [150_000], 50_000);
      assert.throws(() => plan(psbt), /Input 1 spends a coin that does not belong to this wallet/);
    }
    {
      const { psbt } = fresh();
      delete psbt.data.inputs[1].witnessScript;
      assert.throws(() => plan(psbt), /Input 2 is missing the details of the coin it spends/);
    }
    {
      const { psbt } = fresh();
      psbt.data.inputs[0].sighashType = bitcoin.Transaction.SIGHASH_NONE;
      assert.throws(() => plan(psbt), /Input 1 asks for an unusual signature type/);
    }
    {
      const { psbt } = fresh();
      assert.throws(() => plan(psbt, 'deadbeef'), /not one of this wallet’s cosigners/);
    }
  });

  it('refuses transactions the device would not sign', () => {
    const wallet = walletWith();
    const { psbt: honest } = spend(wallet, [150_000], 50_000);
    const rebuilt = (edit: (psbt: bitcoin.Psbt) => void, sequence = 0xfffffffd) => {
      const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });
      psbt.setVersion(2);
      edit(psbt);
      psbt.addInput({
        hash: Buffer.from(honest.txInputs[0].hash),
        index: honest.txInputs[0].index,
        sequence,
        witnessUtxo: honest.data.inputs[0].witnessUtxo!,
        witnessScript: honest.data.inputs[0].witnessScript!,
        bip32Derivation: honest.data.inputs[0].bip32Derivation!,
        nonWitnessUtxo: honest.data.inputs[0].nonWitnessUtxo!,
      });
      psbt.addOutput({ script: honest.txOutputs[0].script, value: honest.txOutputs[0].value });
      return { wallet, psbt, fingerprint: DEVICE_FINGERPRINT };
    };
    assert.doesNotThrow(() => planSigning(rebuilt(() => {}), abilities));
    assert.doesNotThrow(() => planSigning(rebuilt((p) => p.setLocktime(499_999_999)), abilities));
    assert.throws(() => planSigning(rebuilt((p) => p.setLocktime(500_000_000)), abilities), /calendar time/);
    assert.throws(() => planSigning(rebuilt((p) => p.setVersion(3)), abilities), /version 3/);
    assert.throws(() => planSigning(rebuilt(() => {}, 5), abilities), /Input 1 uses a sequence number/);

    const empty = rebuilt(() => {});
    empty.psbt.addOutput({ script: thief, value: 0 });
    assert.throws(() => planSigning(empty, abilities), /Output 2 sends nothing/);

    const odd = rebuilt(() => {});
    odd.psbt.addOutput({ script: unhex('5220' + '00'.repeat(32)), value: 1_000 });
    assert.throws(() => planSigning(odd, abilities), /cannot show one of this transaction’s outputs/);

    const nothing = new bitcoin.Psbt();
    nothing.addOutput({ script: thief, value: 1_000 });
    assert.throws(() => planSigning({ wallet, psbt: nothing, fingerprint: DEVICE_FINGERPRINT }, abilities), /nothing to sign/);
  });
});

// ---------------------------------------------------------------------------
// The device, end to end
// ---------------------------------------------------------------------------

describe('BitBox02 connection', () => {
  it('connects: checks the device is genuine, unlocks, pairs and introduces it', async () => {
    const fake = new FakeBitBox02(DEVICE_MNEMONIC, { unlocked: false });
    const { device, prompts, memory } = connectTo(fake);
    const info = await device.connect();

    assert.deepEqual(info, { model: 'BitBox02 Bitcoin-only', firmware: '9.27.1', label: 'My BitBox' });
    assert.deepEqual(fake.seen, ['a', 'u', 'h', 'H', 'H', 'v', 'n']);
    assert.deepEqual(prompts.statuses, [
      'Enter your password on the BitBox02 to unlock it.',
      'Check that the pairing code on the BitBox02 matches the one shown here, then confirm it on both.',
    ]);

    // The phone shows the code the device shows.
    assert.equal(prompts.pairingCodes.length, 1);
    assert.equal(prompts.pairingCodes[0], fake.pairingCodeShown);
    assert.match(prompts.pairingCodes[0], /^[A-Z2-7]{5} [A-Z2-7]{5}\n[A-Z2-7]{5} [A-Z2-7]{5}$/);

    // Both ends remember each other.
    const key = memory.values.get('bitbox02.noise.key')!;
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.deepEqual([...fake.pairedPhones], [hex(x25519.getPublicKey(unhex(key)))]);
    assert.deepEqual(JSON.parse(memory.values.get('bitbox02.noise.devices')!), [fake.staticPublic]);
    assert.deepEqual([...memory.values.keys()].sort(), ['bitbox02.noise.devices', 'bitbox02.noise.key']);
  });

  it('names each model', async () => {
    for (const [platform, edition, model] of [
      [0, 0, 'BitBox02 Multi'],
      [0, 1, 'BitBox02 Bitcoin-only'],
      [2, 0, 'BitBox02 Nova Multi'],
      [2, 1, 'BitBox02 Nova Bitcoin-only'],
    ] as const) {
      const { device } = connectTo(new FakeBitBox02(DEVICE_MNEMONIC, { platform, edition }));
      assert.equal((await device.connect()).model, model);
    }
    const { device } = connectTo(new FakeBitBox02(DEVICE_MNEMONIC, { platform: 1 }));
    await assert.rejects(device.connect(), /a BitBox model this app does not know/);
  });

  it('does not pair again with a device it knows', async () => {
    const fake = new FakeBitBox02(DEVICE_MNEMONIC);
    const first = connectTo(fake);
    await first.device.connect();
    const key = first.memory.values.get('bitbox02.noise.key');
    assert.ok(
      [...first.memory.values.keys()].every((k) => BITBOX02_MEMORY_KEYS.includes(k)),
      'every name written is one the wipe erases'
    );

    const again = new BitBox02Device(fake, first.options);
    fake.seen.length = 0;
    first.prompts.statuses.length = 0;
    await again.connect();
    assert.deepEqual(fake.seen, ['a', 'u', 'h', 'H', 'H', 'n'], 'no pairing verification');
    assert.equal(first.prompts.pairingCodes.length, 1);
    assert.deepEqual(first.prompts.statuses, []);
    assert.equal(first.memory.values.get('bitbox02.noise.key'), key, 'the phone keeps its identity');
    assert.equal(await again.masterFingerprint(), DEVICE_FINGERPRINT);
  });

  it('pairs again when the device has forgotten the phone', async () => {
    const fake = new FakeBitBox02(DEVICE_MNEMONIC);
    const session = connectTo(fake);
    await session.device.connect();
    fake.pairedPhones.clear(); // a factory reset
    await new BitBox02Device(fake, session.options).connect();
    assert.equal(session.prompts.pairingCodes.length, 2);
    assert.notEqual(session.prompts.pairingCodes[0], session.prompts.pairingCodes[1], 'a code belongs to one handshake');
  });

  it('insists on pairing with a device it has not met, whatever the device says', async () => {
    // What an impostor between phone and device would do: claim to be an old friend.
    const fake = new FakeBitBox02(DEVICE_MNEMONIC);
    const known = connectTo(fake);
    await known.device.connect();

    const newPhone = connectTo(fake);
    newPhone.memory.values.set('bitbox02.noise.key', known.memory.values.get('bitbox02.noise.key')!);
    fake.seen.length = 0;
    await newPhone.device.connect();
    assert.ok(fake.seen.includes('v'), 'pairing was verified although the device did not ask');
    assert.equal(newPhone.prompts.pairingCodes.length, 1);
  });

  it('stops when the code is rejected on the phone', async () => {
    const fake = new FakeBitBox02(DEVICE_MNEMONIC, { notReady: 3 });
    const { device, prompts, memory } = connectTo(fake);
    prompts.pairing = async () => false;
    await assert.rejects(device.connect(), (e: any) => e instanceof UserCancelled && /codes did not match/.test(e.message));
    assert.equal(memory.values.has('bitbox02.noise.devices'), false, 'the device is not remembered');
    await assert.rejects(device.masterFingerprint(), /Connect to the BitBox02 first/);
  });

  it('stops when the code is rejected on the device', async () => {
    const fake = new FakeBitBox02(DEVICE_MNEMONIC, { acceptPairing: false });
    const { device, prompts, memory } = connectTo(fake);
    // The person has not answered on the phone yet, and never will.
    prompts.pairing = () => new Promise(() => {});
    await assert.rejects(device.connect(), (e: any) => e instanceof UserCancelled && /rejected on the BitBox02/.test(e.message));
    assert.equal(memory.values.has('bitbox02.noise.devices'), false);
  });

  it('waits for both answers, whichever comes first', async () => {
    // The device is slow; the phone answers at once.
    const slowDevice = new FakeBitBox02(DEVICE_MNEMONIC, { notReady: 5 });
    await connectTo(slowDevice).device.connect();

    // The phone is slow; the device answers at once.
    const fake = new FakeBitBox02(DEVICE_MNEMONIC);
    const { device, prompts, memory } = connectTo(fake);
    let answer!: (ok: boolean) => void;
    prompts.pairing = () => new Promise((resolve) => (answer = resolve));
    const connecting = device.connect();
    while (!fake.seen.includes('v')) await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(memory.values.has('bitbox02.noise.devices'), false, 'not paired until the phone agrees too');
    assert.equal(fake.seen.includes('n'), false, 'and nothing is asked of the device until then');
    answer(true);
    await connecting;
    assert.ok(memory.values.has('bitbox02.noise.devices'));
  });

  it('passes on a cancellation from the pairing prompt', async () => {
    const { device, prompts } = connectTo(new FakeBitBox02(DEVICE_MNEMONIC, { notReady: 2 }));
    prompts.pairing = async () => {
      throw new UserCancelled();
    };
    await assert.rejects(device.connect(), UserCancelled);
  });

  it('refuses a device that cannot prove it is genuine', async () => {
    for (const attestation of ['none', 'forged-certificate', 'stolen-certificate'] as const) {
      const fake = new FakeBitBox02(DEVICE_MNEMONIC, { attestation });
      const { device, prompts } = connectTo(fake);
      await assert.rejects(device.connect(), /could not prove it is a genuine BitBox02/, attestation);
      assert.deepEqual(fake.seen, ['a'], 'nothing further is asked of it');
      assert.equal(prompts.pairingCodes.length, 0);
    }
    // And a device certified by our test root is no use against the real list.
    const fake = new FakeBitBox02(DEVICE_MNEMONIC);
    const { device } = connectTo(fake, { testing: {} });
    await assert.rejects(device.connect(), /could not prove it is a genuine BitBox02/);
  });

  it('sends a fresh challenge every time', async () => {
    const fake = new FakeBitBox02(DEVICE_MNEMONIC);
    const challenges: string[] = [];
    const write = fake.write.bind(fake);
    fake.write = async (packet) => {
      const p = Buffer.from(packet);
      if (p[4] === HWW_CMD && p[7] === 0x00 && p[8] === 0x61) challenges.push(hex(p.subarray(9, 41)));
      return write(packet);
    };
    const session = connectTo(fake);
    await session.device.connect();
    await new BitBox02Device(fake, session.options).connect();
    assert.equal(challenges.length, 2);
    assert.notEqual(challenges[0], challenges[1]);
    assert.notEqual(challenges[0], '00'.repeat(32));
  });

  it('says so when the device is in bootloader mode', async () => {
    const { device } = connectTo(new FakeBitBox02(DEVICE_MNEMONIC, { bootloader: true }));
    await assert.rejects(device.connect(), /is in bootloader mode/);
  });

  it('says so when the device has not been set up', async () => {
    const fake = new FakeBitBox02(DEVICE_MNEMONIC, { initialized: false, unlocked: false });
    const { device } = connectTo(fake);
    await assert.rejects(device.connect(), /has not been set up yet.*BitBoxApp/);
    assert.deepEqual(fake.seen, [], 'known from its introduction alone');
  });

  it('says so when the firmware is too old, or newer than it knows', async () => {
    for (const [version, message] of [
      ['v9.3.1', /runs firmware 9\.3\.1\. Update it to 9\.4\.0 or newer in the BitBoxApp/],
      ['v4.2.2', /Update it to 9\.4\.0 or newer/],
      ['v10.0.0', /newer than this app knows how to talk to/],
    ] as const) {
      const fake = new FakeBitBox02(DEVICE_MNEMONIC, { version });
      await assert.rejects(connectTo(fake).device.connect(), message);
      assert.deepEqual(fake.seen, []);
    }
    for (const version of ['v9.4.0', 'v9.27.1', 'v9.99.0']) {
      await connectTo(new FakeBitBox02(DEVICE_MNEMONIC, { version })).device.connect();
    }
  });

  it('ignores an answer left over from a request that was given up on', async () => {
    const fake = new FakeBitBox02(DEVICE_MNEMONIC);
    const session = connectTo(fake);
    // Three packets of a stale answer are still waiting when the phone connects.
    await writeFrame(fake, HWW_CMD, Buffer.from([0x69]));
    await writeFrame(fake, HWW_CMD, Buffer.from([0x69]));
    await writeFrame(fake, HWW_CMD, Buffer.from([0x69]));
    const info = await session.device.connect();
    assert.equal(info.firmware, '9.27.1');
    assert.equal(await session.device.masterFingerprint(), DEVICE_FINGERPRINT);
  });

  it('still connects when nothing can be remembered', async () => {
    const fake = new FakeBitBox02(DEVICE_MNEMONIC);
    const forgetful: DeviceMemory = {
      get: async () => null,
      set: async () => {
        throw new Error('keystore unavailable');
      },
    };
    const { device, prompts } = connectTo(fake, { memory: forgetful });
    await device.connect();
    assert.equal(await device.masterFingerprint(), DEVICE_FINGERPRINT);
    // The price is pairing again next time, with a code that is again checked.
    const again = new BitBox02Device(fake, { prompts, memory: forgetful, testing: { attestationRoots: [ATTESTATION_ROOT_PUBLIC] } });
    await again.connect();
    assert.equal(prompts.pairingCodes.length, 2);
  });

  it('ignores what it remembered if that has been damaged', async () => {
    const fake = new FakeBitBox02(DEVICE_MNEMONIC);
    const session = connectTo(fake);
    session.memory.values.set('bitbox02.noise.key', 'not a key');
    session.memory.values.set('bitbox02.noise.devices', '{"not":"a list"');
    await session.device.connect();
    assert.match(session.memory.values.get('bitbox02.noise.key')!, /^[0-9a-f]{64}$/);
    assert.deepEqual(JSON.parse(session.memory.values.get('bitbox02.noise.devices')!), [fake.staticPublic]);
  });

  it('will not send a command before connecting, or after closing', async () => {
    const fake = new FakeBitBox02(DEVICE_MNEMONIC);
    const { device } = connectTo(fake);
    await assert.rejects(device.masterFingerprint(), /Connect to the BitBox02 first/);
    await assert.rejects(device.getKey('mainnet'), /Connect to the BitBox02 first/);
    await device.connect();
    await device.close();
    assert.equal(fake.closed, true);
    await assert.rejects(device.masterFingerprint(), /Connect to the BitBox02 first/);
    await assert.rejects(device.connect(), UserCancelled);
  });
});

describe('BitBox02 request handling', () => {
  it('asks again while the device is waiting on a person', async () => {
    const { device, fake, sleeps } = await readyDevice();
    fake.behaviour.notReady = 4;
    fake.rawRequests = 0;
    sleeps.length = 0;
    assert.equal(await device.masterFingerprint(), DEVICE_FINGERPRINT);
    assert.equal(fake.rawRequests, 1, 'the request itself is sent once');
    assert.deepEqual(sleeps, [200, 200, 200, 200]);
  });

  it('sends the same request again when the device was busy', async () => {
    const { device, fake, sleeps } = await readyDevice();
    fake.behaviour.busy = 3;
    fake.rawRequests = 0;
    sleeps.length = 0;
    // Had each retry been encrypted afresh, the device's counter would not match and this would fail.
    assert.equal(await device.masterFingerprint(), DEVICE_FINGERPRINT);
    assert.equal(fake.rawRequests, 4);
    assert.deepEqual(sleeps, [1000, 1000, 1000]);
    assert.equal((await device.getKey('mainnet')).fingerprint, DEVICE_FINGERPRINT, 'and the channel is still in step');
  });

  it('gives up on a device that stays busy', async () => {
    const { device, fake } = await readyDevice();
    fake.behaviour.busy = 1000;
    await assert.rejects(device.masterFingerprint(), /is busy with something else/);
  });

  it('reports a device that lost track of the request', async () => {
    const { device, fake } = await readyDevice();
    const write = fake.write.bind(fake);
    // Turn the next new request into a poll for an answer that was never asked for.
    fake.write = async (packet) => {
      const p = Buffer.from(packet);
      if (p[7] === 0x00) {
        p.writeUInt16BE(1, 5);
        p[7] = 0x01;
      }
      fake.write = write;
      return write(p);
    };
    await assert.rejects(device.masterFingerprint(), /lost track of the request/);
  });

  it('reports a device that stops answering, or is unplugged', async () => {
    const { device, fake } = await readyDevice();
    const write = fake.write.bind(fake);
    fake.write = async () => {};
    await assert.rejects(device.masterFingerprint(), TransportTimeout);
    fake.write = write;
    fake.closed = true;
    await assert.rejects(device.masterFingerprint(), /unplugged/);
  });

  it('runs commands one at a time, in the order they were asked', async () => {
    const { device, fake } = await readyDevice();
    fake.behaviour.notReady = 2;
    fake.requests.length = 0;
    const [fingerprint, mainnet, testnet] = await Promise.all([
      device.masterFingerprint(),
      device.getKey('mainnet'),
      device.getKey('testnet'),
    ]);
    assert.equal(fingerprint, DEVICE_FINGERPRINT);
    assert.equal(mainnet.xpub, accountXpub(DEVICE_MNEMONIC, 'mainnet'));
    assert.equal(testnet.xpub, accountXpub(DEVICE_MNEMONIC, 'testnet'));
    assert.deepEqual(
      fake.requests.map((r) => Object.keys(r)[0]),
      ['fingerprint', 'btc_pub', 'btc_pub']
    );
  });

  it('refuses an answer that was not sealed by the device', async () => {
    const { device, fake } = await readyDevice();
    const read = fake.read.bind(fake);
    fake.read = async () => {
      const packet = Buffer.from(await read());
      packet[12] ^= 1;
      return packet;
    };
    await assert.rejects(device.masterFingerprint(), /secure channel is out of step/);
  });
});

describe('BitBox02 keys', () => {
  it('exports the account key for each network', async () => {
    const { device, fake, prompts } = await readyDevice();
    for (const network of ['mainnet', 'testnet'] as const) {
      assert.deepEqual(await device.getKey(network), {
        xpub: accountXpub(DEVICE_MNEMONIC, network),
        fingerprint: DEVICE_FINGERPRINT,
        path: bip48Path(network),
        network,
      });
    }
    assert.deepEqual(fake.requests.at(-1), {
      btc_pub: { coin: 1, keypath: [48 + H, 1 + H, H, 2 + H], xpub_type: 0 },
    });
    assert.deepEqual(prompts.statuses, [], 'a standard path needs nothing from the person');
  });

  it('exports another account, written either way', async () => {
    const { device } = await readyDevice();
    const key = await device.getKey('mainnet', 'm/48h/0h/7h/2h');
    assert.equal(key.path, "m/48'/0'/7'/2'");
    assert.equal(key.xpub, rootFromMnemonic(DEVICE_MNEMONIC, 'mainnet').derivePath("m/48'/0'/7'/2'").neutered().toBase58());
  });

  it('warns that the device will question an unusual path', async () => {
    const { device, fake, prompts } = await readyDevice();
    await device.getKey('mainnet', "m/45'/0'");
    assert.match(prompts.statuses[0], /unusual key path/);
    assert.match(prompts.statuses[0], /m\/45'\/0'/);
    assert.ok(fake.screens.includes("Warning: unusual keypath m/45'/0'"));
  });

  it('refuses a key from a different place than it asked for', async () => {
    const { device, fake } = await readyDevice();
    const answerWith = (path: string, network: NetworkName = 'mainnet') => {
      const api = (fake as any).api.bind(fake);
      (fake as any).api = (request: Message) =>
        request.btc_pub
          ? { pub: { pub: rootFromMnemonic(DEVICE_MNEMONIC, network).derivePath(path).neutered().toBase58() } }
          : api(request);
    };
    answerWith("m/48'/0'/1'/2'");
    assert.equal((await device.getKey('mainnet', "m/48'/0'/1'/2'")).path, "m/48'/0'/1'/2'");
    answerWith("m/48'/0'/0'");
    await assert.rejects(device.getKey('mainnet'), /from a different path than the one asked for/);
    answerWith("m/48'/0'/0'/1'");
    await assert.rejects(device.getKey('mainnet'), /from a different path than the one asked for/);
    answerWith("m/48'/1'/0'/2'", 'testnet');
    await assert.rejects(device.getKey('mainnet'), /cannot read/);
    (fake as any).api = () => ({ pub: { pub: rootFromMnemonic(DEVICE_MNEMONIC, 'mainnet').derivePath("m/48'/0'/0'/2'").toBase58() } });
    await assert.rejects(device.getKey('mainnet'), /private key, which is never imported/);
    (fake as any).api = () => ({ pub: {} });
    await assert.rejects(device.getKey('mainnet'), /did not return a key/);
  });

  it('refuses a path it cannot read before troubling the device', async () => {
    const { device, fake } = await readyDevice();
    fake.requests.length = 0;
    await assert.rejects(device.getKey('mainnet', 'm/48x'), /Cannot read the key path/);
    await assert.rejects(device.getKey('mainnet', 'm'), /key path is needed/);
    assert.equal(fake.requests.length, 0);
  });
});

describe('BitBox02 signing', () => {
  const sign = async (behaviour: Partial<FakeBehaviour> = {}, network: NetworkName = 'mainnet') => {
    const session = await readyDevice(behaviour);
    const wallet = walletWith(network);
    const to = network === 'mainnet' ? DEST_MAINNET : 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
    const tx = spend(wallet, [150_000, 90_000], 200_000, to);
    const signing = session.device.signMultisig({ wallet, psbt: tx.psbt, fingerprint: DEVICE_FINGERPRINT });
    return { ...session, wallet, ...tx, signing };
  };

  for (const network of ['mainnet', 'testnet'] as const) {
    it(`registers the wallet, signs, and the transaction completes (${network})`, async () => {
      const { signing, fake, prompts, wallet, draft } = await sign({}, network);
      const signatures = await signing;

      assert.deepEqual(
        signatures.map((s) => s.index),
        [0, 1]
      );
      assert.equal(prompts.statuses.length, 2);
      assert.match(prompts.statuses[0], /has not seen this wallet before.*“Family savings”/);
      assert.match(prompts.statuses[1], /Check the transaction on the BitBox02/);
      assert.deepEqual(fake.screens.slice(1), [
        'Register: 2-of-3',
        'Register: Family savings',
        'Spend from: Family savings',
        `200000 to ${network === 'mainnet' ? DEST_MAINNET : 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'}`,
        'Fee: 885',
      ]);

      // What came back goes onto the draft exactly as a card's signatures do.
      const jobs = signingJobsFor(draft, DEVICE_FINGERPRINT, network);
      const signed = attachSignatures(
        draft,
        network,
        jobs.map((job) => ({ job, signature: signatures.find((s) => s.index === job.index)!.signature }))
      );
      const complete = parsePsbt(signed, network);
      assert.equal(signPsbtWithMnemonic(complete, MNEMONICS[2], wallet), 2);
      assert.ok(complete.validateSignaturesOfAllInputs((pubkey, hash, sig) => ecc.verify(hash, pubkey, sig)));
      assert.equal(bitcoin.Transaction.fromHex(finalizeAndExtract(complete)).ins.length, 2);
    });
  }

  it('does not register a wallet the device already has', async () => {
    const { device, fake, prompts, wallet, psbt, signing } = await sign();
    await signing;
    fake.requests.length = 0;
    fake.screens.length = 0;
    prompts.statuses.length = 0;
    await device.signMultisig({ wallet, psbt, fingerprint: DEVICE_FINGERPRINT });
    assert.equal(fake.requests.some((r) => r.btc?.register_script_config), false);
    assert.deepEqual(fake.screens.slice(0, 1), ['Spend from: Family savings']);
    assert.equal(prompts.statuses.length, 1);
  });

  it('asks the device for everything in the order the device wants it', async () => {
    const { fake, signing } = await sign();
    await signing;
    const steps = fake.requests
      .slice(fake.requests.findIndex((r) => r.btc_sign_init))
      .map((r) => Object.keys(r.btc ?? r)[0] + (r.btc_sign_input?.host_nonce_commitment ? '+commitment' : ''));
    const previous = ['prevtx_init', 'prevtx_input', 'prevtx_input', 'prevtx_output', 'prevtx_output'];
    assert.deepEqual(steps, [
      'btc_sign_init',
      'btc_sign_input',
      ...previous,
      'btc_sign_input',
      ...previous,
      'btc_sign_output',
      'btc_sign_output',
      'btc_sign_input+commitment',
      'antiklepto_signature',
      'btc_sign_input+commitment',
      'antiklepto_signature',
    ]);
  });

  it('contributes fresh randomness to every signature', async () => {
    const { fake, signing, device, wallet, psbt } = await sign();
    const first = await signing;
    const second = await device.signMultisig({ wallet, psbt, fingerprint: DEVICE_FINGERPRINT });
    const nonces = fake.requests.filter((r) => r.btc?.antiklepto_signature).map((r) => hex(r.btc.antiklepto_signature.host_nonce));
    assert.equal(nonces.length, 4);
    assert.equal(new Set(nonces).size, 4);
    assert.notEqual(hex(first[0].signature), hex(second[0].signature));
  });

  it('stores a second wallet of the same name under a name of its own', async () => {
    const { device, fake, prompts, signing } = await sign();
    await signing;
    const namesake = makeWallet(2, [MNEMONICS[3], DEVICE_MNEMONIC, MNEMONICS[4]], 'mainnet', 'Family savings');
    const { psbt } = spend(namesake, [150_000], 50_000);
    prompts.statuses.length = 0;
    const signatures = await device.signMultisig({ wallet: namesake, psbt, fingerprint: DEVICE_FINGERPRINT });
    assert.equal(signatures.length, 1);
    const distinct = `Family savings ${walletTag(namesake)}`;
    assert.match(prompts.statuses[1], /already has a different wallet called “Family savings”/);
    assert.ok(prompts.statuses[1].includes(`“${distinct}”`));
    assert.deepEqual([...fake.behaviour.registered.values()], ['Family savings', distinct]);
  });

  it('is not a failure when the person says no on the device', async () => {
    for (const cancel of ['registration', 'transaction'] as const) {
      const { signing, device, fake } = await sign({ cancel });
      await assert.rejects(signing, (e: any) => e instanceof UserCancelled && /Cancelled on the BitBox02/.test(e.message), cancel);
      // And the device is ready for the next thing.
      fake.behaviour.cancel = 'nothing';
      assert.equal(await device.masterFingerprint(), DEVICE_FINGERPRINT);
    }
  });

  it('shows a payment dressed up as change for what it is', async () => {
    const { device, fake } = await readyDevice();
    const wallet = walletWith();
    const { psbt: honest } = spend(wallet, [150_000], 50_000);
    const hostile = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });
    hostile.setVersion(2);
    hostile.addInput({
      hash: Buffer.from(honest.txInputs[0].hash),
      index: honest.txInputs[0].index,
      sequence: honest.txInputs[0].sequence,
      witnessUtxo: honest.data.inputs[0].witnessUtxo!,
      witnessScript: honest.data.inputs[0].witnessScript!,
      bip32Derivation: honest.data.inputs[0].bip32Derivation!,
      nonWitnessUtxo: honest.data.inputs[0].nonWitnessUtxo!,
    });
    hostile.addOutput({ script: honest.txOutputs[0].script, value: honest.txOutputs[0].value });
    hostile.addOutput({
      script: Buffer.from(bitcoin.address.toOutputScript('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')),
      value: honest.txOutputs[1].value,
      bip32Derivation: honest.data.outputs[1].bip32Derivation!,
    });
    const [signature] = await device.signMultisig({ wallet, psbt: hostile, fingerprint: DEVICE_FINGERPRINT });
    assert.ok(fake.screens.includes('99430 to bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'), fake.screens.join('\n'));
    const [job] = signingJobsFor(hostile.toBase64(), DEVICE_FINGERPRINT, 'mainnet');
    assert.ok(ecc.verify(job.digest, job.pubkey, signature.signature));
  });

  it('refuses to sign as a key the device does not hold', async () => {
    const { device, fake } = await readyDevice();
    const wallet = walletWith();
    const { psbt } = spend(wallet, [150_000], 50_000);
    fake.requests.length = 0;
    await assert.rejects(
      device.signMultisig({ wallet, psbt, fingerprint: masterFingerprint(MNEMONICS[0]) }),
      new RegExp(`different device.*holds key ${DEVICE_FINGERPRINT}, but this signature needs ${masterFingerprint(MNEMONICS[0])}`)
    );

    // The right fingerprint in front of a different key.
    const impostor: MultisigWallet = {
      ...wallet,
      cosigners: wallet.cosigners.map((c) =>
        c.fingerprint === DEVICE_FINGERPRINT ? { ...c, xpub: accountXpub(MNEMONICS[3], 'mainnet') } : c
      ),
    };
    const forged = spend(impostor, [150_000], 50_000);
    await assert.rejects(
      device.signMultisig({ wallet: impostor, psbt: forged.psbt, fingerprint: DEVICE_FINGERPRINT }),
      /holds a different key at m\/48'\/0'\/0'\/2' from the one in this wallet/
    );
    assert.equal(fake.requests.some((r) => r.btc_sign_init || r.btc), false, 'the device was never asked to sign or register');
  });

  it('refuses a bad transaction before asking anyone to approve anything', async () => {
    const { device, fake, prompts } = await readyDevice();
    const wallet = walletWith();
    const { draft } = spend(wallet, [150_000], 50_000);
    await assert.rejects(
      device.signMultisig({ wallet, psbt: parsePsbt(draft, 'mainnet'), fingerprint: DEVICE_FINGERPRINT }),
      /missing its previous transaction/
    );
    assert.deepEqual(prompts.statuses, []);
    assert.equal(fake.requests.some((r) => r.btc), false, 'not even a registration');
  });

  it('refuses a signature made without the phone’s randomness', async () => {
    await assert.rejects((await sign({ signing: 'no-antiklepto' })).signing, /skipped a step that protects its key/);
    await assert.rejects((await sign({ signing: 'ignores-host-nonce' })).signing, /did not use this phone’s randomness/);
  });

  it('refuses a signature by the wrong key', async () => {
    await assert.rejects((await sign({ signing: 'wrong-key' })).signing, /signature for input 1 that does not match this transaction/);
  });

  it('does not follow a device that asks for what is not there, or never finishes', async () => {
    await assert.rejects((await sign({ signing: 'asks-too-much' })).signing, /asked for an output this transaction does not have/);
    await assert.rejects((await sign({ signing: 'never-finishes' })).signing, /kept asking for more than this transaction contains/);
  });

  it('explains a refusal by the device', async () => {
    const { device, fake } = await readyDevice();
    const wallet = walletWith();
    const { psbt } = spend(wallet, [150_000], 50_000);
    const api = (fake as any).api.bind(fake);
    const refuse = (when: (r: Message) => boolean, code: number) => {
      (fake as any).api = (request: Message) => {
        if (when(request)) throw new DeviceRefusal(code, 'refused');
        return api(request);
      };
    };
    const attempt = () => device.signMultisig({ wallet, psbt, fingerprint: DEVICE_FINGERPRINT });

    refuse((r) => !!r.btc?.is_script_config_registered, 101);
    await assert.rejects(attempt(), /does not accept this wallet/);
    refuse((r) => !!r.btc?.register_script_config, 103);
    await assert.rejects(attempt(), /no room left for another multisig wallet/);
    refuse((r) => !!r.btc?.register_script_config, 101);
    await assert.rejects(attempt(), /does not accept this wallet/);
    refuse((r) => !!r.btc_sign_output, 101);
    await assert.rejects(attempt(), /refused this transaction/);
    refuse((r) => !!r.btc_sign_init, 102);
    await assert.rejects(attempt(), /reported an error: refused \(code 102\)/);
    refuse((r) => !!r.btc_pub, 101);
    await assert.rejects(attempt(), /would not give out the key at m\/48'\/0'\/0'\/2'/);
  });
});
