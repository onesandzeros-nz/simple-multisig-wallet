import ecc from '@bitcoinerlab/secp256k1';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import * as bitcoin from 'bitcoinjs-lib';
import { Buffer } from 'buffer';
import { bip32, btcNetwork, deriveAddress, rootFromMnemonic } from '../src/lib/bitcoin';
import { DeviceMemory, DevicePrompts, PacketTransport, TransportTimeout } from '../src/lib/hw/types';
import { MultisigWallet, NetworkName, WalletSnapshot } from '../src/lib/types';
import { buildPsbt, parsePsbt } from '../src/lib/wallet';

/**
 * Test doubles for the Ledger driver. Nothing here is shared with the driver:
 * framing, varints, Merkle proofs and the PSBT layout are all written out
 * again from the app's documentation, so that a mistake in the driver cannot
 * be cancelled out by the same mistake in its test.
 */

// ---------------------------------------------------------------------------
// Prompts and memory
// ---------------------------------------------------------------------------

export function recordingPrompts(): DevicePrompts & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    status: (message) => void lines.push(message),
    pinMatrix: () => Promise.reject(new Error('A Ledger never asks for a PIN on the phone.')),
    passphrase: () => Promise.reject(new Error('A Ledger never asks for a passphrase on the phone.')),
    confirmPairing: () => Promise.reject(new Error('A Ledger never pairs.')),
  };
}

export function mapMemory(initial: Record<string, string> = {}): DeviceMemory & { store: Map<string, string> } {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => void store.set(key, value),
  };
}

// ---------------------------------------------------------------------------
// USB packets ⇄ APDUs
// ---------------------------------------------------------------------------

export type ApduExchange = (apdu: Buffer) => Promise<Buffer>;

/**
 * A packet transport over anything that answers whole APDUs. Packets written
 * are reassembled into an APDU, handed over, and the reply cut back into
 * packets for reading — the job the USB stack does on a real device.
 */
export function packetTransport(
  exchange: ApduExchange,
  options: { packetSize?: number; log?: { sent: Buffer[]; received: Buffer[] } } = {}
): PacketTransport & { closed: boolean } {
  const packetSize = options.packetSize ?? 64;
  const room = packetSize - 5;
  let incoming: Buffer[] = [];
  let expected = -1;
  const outgoing: Buffer[] = [];
  const waiting: { resolve: (p: Uint8Array) => void; reject: (e: Error) => void; timer: any }[] = [];
  let failure: Error | null = null;

  const deliver = () => {
    while (waiting.length > 0 && outgoing.length > 0) {
      const next = waiting.shift()!;
      clearTimeout(next.timer);
      next.resolve(Uint8Array.from(outgoing.shift()!));
    }
  };

  const transport = {
    packetSize,
    closed: false,
    async write(packet: Uint8Array): Promise<void> {
      if (transport.closed) throw new Error('The device was unplugged.');
      const buf = Buffer.from(packet);
      if (buf.length !== packetSize) throw new Error(`A packet must be ${packetSize} bytes, got ${buf.length}.`);
      if (buf[0] !== 0x01 || buf[1] !== 0x01 || buf[2] !== 0x05) throw new Error('Bad packet header.');
      const seq = (buf[3] << 8) | buf[4];
      if (seq !== incoming.length) throw new Error(`Packet ${seq} arrived where ${incoming.length} was due.`);
      let body = buf.subarray(5);
      if (seq === 0) {
        expected = (body[0] << 8) | body[1];
        body = body.subarray(2);
      }
      incoming.push(Buffer.from(body));
      const soFar = Buffer.concat(incoming);
      if (soFar.length < expected) return;
      // Whatever follows the APDU in the last packet must be padding.
      if (!soFar.subarray(expected).every((b) => b === 0)) throw new Error('Packet padding is not zeros.');
      const apdu = Buffer.from(soFar.subarray(0, expected));
      incoming = [];
      expected = -1;
      options.log?.sent.push(apdu);
      // Answered in the background, as a device would: the write returns first.
      exchange(apdu).then(
        (reply) => {
          options.log?.received.push(reply);
          const framed = Buffer.concat([Buffer.from([reply.length >> 8, reply.length & 0xff]), reply]);
          for (let i = 0; i * room < framed.length; i++) {
            const out = Buffer.alloc(packetSize);
            out.set([0x01, 0x01, 0x05, i >> 8, i & 0xff], 0);
            framed.copy(out, 5, i * room, (i + 1) * room);
            outgoing.push(out);
          }
          deliver();
        },
        (e) => {
          failure = e instanceof Error ? e : new Error(String(e));
          for (const w of waiting.splice(0)) {
            clearTimeout(w.timer);
            w.reject(failure);
          }
        }
      );
    },
    read(timeoutMs: number): Promise<Uint8Array> {
      if (transport.closed) return Promise.reject(new Error('The device was unplugged.'));
      if (failure) return Promise.reject(failure);
      if (outgoing.length > 0) return Promise.resolve(Uint8Array.from(outgoing.shift()!));
      return new Promise((resolve, reject) => {
        const entry = {
          resolve,
          reject,
          timer: setTimeout(() => {
            waiting.splice(waiting.indexOf(entry), 1);
            reject(new TransportTimeout());
          }, timeoutMs),
        };
        waiting.push(entry);
      });
    },
    async close(): Promise<void> {
      transport.closed = true;
      for (const w of waiting.splice(0)) {
        clearTimeout(w.timer);
        w.reject(new Error('The device was unplugged.'));
      }
    },
  };
  return transport;
}

/** Groups commands into conversations: each command with the CONTINUEs that followed it, as hex. */
export function conversations(commands: Buffer[]): string[][] {
  const out: string[][] = [];
  for (const command of commands) {
    if (command[0] === 0xf8 && out.length > 0) out[out.length - 1].push(command.toString('hex'));
    else out.push([command.toString('hex')]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The app's side of the protocol
// ---------------------------------------------------------------------------

function readVarint(buf: Buffer, at: number): [number, number] {
  const first = buf[at];
  if (first === undefined) throw new Error('fake app: truncated varint');
  if (first < 0xfd) return [first, at + 1];
  if (first === 0xfd) return [buf.readUInt16LE(at + 1), at + 3];
  if (first === 0xfe) return [buf.readUInt32LE(at + 1), at + 5];
  return [Number(buf.readBigUInt64LE(at + 1)), at + 9];
}

function writeVarint(n: number): Buffer {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) return Buffer.from([0xfd, n & 0xff, n >> 8]);
  const out = Buffer.alloc(5);
  out[0] = 0xfe;
  out.writeUInt32LE(n, 1);
  return out;
}

const sha = (...parts: Uint8Array[]) => Buffer.from(sha256(Buffer.concat(parts)));

/** Root of the tree a leaf belongs to, worked out from the top down from its proof. */
export function rootFromProof(leaf: Buffer, index: number, size: number, proof: Buffer[]): Buffer {
  if (size === 1) {
    if (proof.length !== 0) throw new Error('fake app: Merkle proof too long');
    return leaf;
  }
  if (proof.length === 0) throw new Error('fake app: Merkle proof too short');
  let k = 1;
  while (k * 2 < size) k *= 2;
  const sibling = proof[proof.length - 1];
  const rest = proof.slice(0, -1);
  return index < k
    ? sha(Buffer.from([1]), rootFromProof(leaf, index, k, rest), sibling)
    : sha(Buffer.from([1]), sibling, rootFromProof(leaf, index - k, size - k, rest));
}

class Refusal extends Error {
  constructor(
    readonly sw: number,
    readonly data: Buffer = Buffer.alloc(0)
  ) {
    super(`fake app refuses with 0x${sw.toString(16)}`);
  }
}

interface Commitment {
  size: number;
  keysRoot: Buffer;
  valuesRoot: Buffer;
}

export interface ReconstructedPolicy {
  name: string;
  template: string;
  keys: string[];
}

export interface ReconstructedPsbt {
  global: Map<string, Buffer>;
  inputs: Map<string, Buffer>[];
  outputs: Map<string, Buffer>[];
}

export interface FakeAppOptions {
  mnemonic: string;
  network?: NetworkName;
  name?: string;
  version?: string;
  /** Status word for everything, as a locked device gives. */
  locked?: boolean;
  /** What the user does when shown a wallet to register. */
  approveRegistration?: boolean;
  /** What the user does when shown a transaction. */
  approveTransaction?: boolean;
  /** Bytes the device's approvals are keyed with; change it to play a wiped device. */
  hmacSecret?: string;
  /** Misbehaviour, for checking the driver does not take the device's word for things. */
  faults?: {
    /** Derive addresses one index along from where they should be. */
    wrongAddresses?: boolean;
    /** Sign with this sighash type instead of the one asked for. */
    sighashType?: number;
    /** Approve the transaction, then return no signatures. */
    signNothing?: boolean;
    /** Claim this input index for every signature. */
    inputIndex?: number;
  };
}

/**
 * A stand-in for the Ledger Bitcoin app that plays the protocol by the book:
 * it knows only what the first APDU of a command commits to, asks the client
 * for everything else, and checks every answer against those commitments
 * before using it. What it pieced together is kept for the test to inspect.
 */
export class FakeLedgerApp {
  readonly options: Required<FakeAppOptions>;
  /** Commands as they arrived, client-command answers included. */
  readonly commands: Buffer[] = [];
  registrations: ReconstructedPolicy[] = [];
  signed: { policy: ReconstructedPolicy; psbt: ReconstructedPsbt }[] = [];
  /** How many times each client command was used. */
  asked: Record<number, number> = {};

  private resume: ((answer: Buffer) => void) | null = null;
  private respond: ((reply: Buffer) => void) | null = null;

  constructor(options: FakeAppOptions) {
    this.options = {
      network: 'mainnet',
      name: (options.network ?? 'mainnet') === 'mainnet' ? 'Bitcoin' : 'Bitcoin Test',
      version: '2.4.2',
      locked: false,
      approveRegistration: true,
      approveTransaction: true,
      hmacSecret: 'device one',
      faults: {},
      ...options,
    };
  }

  private get root() {
    return rootFromMnemonic(this.options.mnemonic, this.options.network);
  }

  get fingerprint(): string {
    return Buffer.from(this.root.fingerprint).toString('hex');
  }

  /** One APDU in, one reply (data then status word) out. */
  exchange = (apdu: Buffer): Promise<Buffer> => {
    this.commands.push(Buffer.from(apdu));
    return new Promise((resolve) => {
      this.respond = resolve;
      const [cla, ins, p1, p2, lc] = apdu;
      const data = Buffer.from(apdu.subarray(5));
      if (apdu.length < 5 || data.length !== lc) return this.finish(0x6a87);
      if (this.options.locked) return this.finish(0x5515);

      if (cla === 0xf8 && ins === 0x01) {
        const resume = this.resume;
        this.resume = null;
        if (!resume) return this.finish(0xb007);
        return resume(data);
      }
      // A new command abandons whatever was in progress.
      this.resume = null;
      this.run(cla, ins, p1, p2, data).then(
        (reply) => this.finish(0x9000, reply),
        (e) => {
          if (e instanceof Refusal) return this.finish(e.sw, e.data);
          // A client that fails a check gets the same answer a real app gives.
          this.lastFailure = e;
          this.finish(0x6a80);
        }
      );
    });
  };

  /** Why the app last answered 0x6a80, for test failure messages. */
  lastFailure: unknown = null;

  private finish(sw: number, data: Buffer = Buffer.alloc(0)): void {
    const respond = this.respond;
    this.respond = null;
    respond?.(Buffer.concat([data, Buffer.from([sw >> 8, sw & 0xff])]));
  }

  private ask(request: Buffer): Promise<Buffer> {
    this.asked[request[0]] = (this.asked[request[0]] ?? 0) + 1;
    return new Promise((resolve) => {
      this.resume = resolve;
      this.finish(0xe000, request);
    });
  }

  private async run(cla: number, ins: number, p1: number, p2: number, data: Buffer): Promise<Buffer> {
    if (cla === 0xb0 && ins === 0x01) {
      const name = Buffer.from(this.options.name, 'ascii');
      const version = Buffer.from(this.options.version, 'ascii');
      return Buffer.concat([
        Buffer.from([1, name.length]),
        name,
        Buffer.from([version.length]),
        version,
        Buffer.from([1, 0]),
      ]);
    }
    if (cla !== 0xe1) throw new Refusal(0x6e00);
    if (p1 !== 0 || p2 !== 1) throw new Refusal(0x6a86);
    switch (ins) {
      case 0x05:
        return Buffer.from(this.root.fingerprint);
      case 0x00:
        return this.getExtendedPubkey(data);
      case 0x02:
        return this.registerWallet(data);
      case 0x03:
        return this.getWalletAddress(data);
      case 0x04:
        return this.signPsbt(data);
      default:
        throw new Refusal(0x6d00);
    }
  }

  // --- what the app can ask the client for ---------------------------------

  private async more(elementSize: number, count: number): Promise<Buffer[]> {
    const out: Buffer[] = [];
    while (out.length < count) {
      const reply = await this.ask(Buffer.from([0xa0]));
      const n = reply[0];
      if (n === 0 || reply[1] !== elementSize || reply.length !== 2 + n * elementSize) {
        throw new Error('fake app: bad GET_MORE_ELEMENTS reply');
      }
      for (let i = 0; i < n; i++) out.push(Buffer.from(reply.subarray(2 + i * elementSize, 2 + (i + 1) * elementSize)));
    }
    if (out.length !== count) throw new Error('fake app: GET_MORE_ELEMENTS returned too much');
    return out;
  }

  private async preimage(hash: Buffer): Promise<Buffer> {
    const reply = await this.ask(Buffer.concat([Buffer.from([0x40, 0x00]), hash]));
    const [length, at] = readVarint(reply, 0);
    const partial = reply[at];
    if (reply.length !== at + 1 + partial) throw new Error('fake app: bad GET_PREIMAGE reply');
    let value = Buffer.from(reply.subarray(at + 1));
    if (partial < length) {
      // The client must send as much as fits before falling back to the queue.
      if (reply.length !== 255) throw new Error('fake app: GET_PREIMAGE reply not filled');
      value = Buffer.concat([value, ...(await this.more(1, length - partial))]);
    }
    if (value.length !== length || !sha(value).equals(hash)) throw new Error('fake app: preimage does not match its hash');
    return value;
  }

  /** The hash of leaf `index`, proven to belong to the tree with this root. */
  private async leafHash(root: Buffer, size: number, index: number): Promise<Buffer> {
    const reply = await this.ask(Buffer.concat([Buffer.from([0x41]), root, writeVarint(size), writeVarint(index)]));
    const leaf = Buffer.from(reply.subarray(0, 32));
    const proofLength = reply[32];
    const partial = reply[33];
    if (reply.length !== 34 + 32 * partial) throw new Error('fake app: bad GET_MERKLE_LEAF_PROOF reply');
    const proof: Buffer[] = [];
    for (let i = 0; i < partial; i++) proof.push(Buffer.from(reply.subarray(34 + 32 * i, 66 + 32 * i)));
    if (partial < proofLength) proof.push(...(await this.more(32, proofLength - partial)));
    if (!rootFromProof(leaf, index, size, proof).equals(root)) throw new Error('fake app: Merkle proof does not verify');
    return leaf;
  }

  private async leaf(root: Buffer, size: number, index: number): Promise<Buffer> {
    const value = await this.preimage(await this.leafHash(root, size, index));
    if (value[0] !== 0x00) throw new Error('fake app: leaf preimage lacks its prefix');
    return Buffer.from(value.subarray(1));
  }

  private async leafIndex(root: Buffer, leafHash: Buffer): Promise<number | null> {
    const reply = await this.ask(Buffer.concat([Buffer.from([0x42]), root, leafHash]));
    const [index, next] = readVarint(reply, 1);
    if (next !== reply.length) throw new Error('fake app: bad GET_MERKLE_LEAF_INDEX reply');
    return reply[0] === 1 ? index : null;
  }

  private parseCommitment(buf: Buffer, at: number): [Commitment, number] {
    const [size, next] = readVarint(buf, at);
    if (next + 64 > buf.length) throw new Error('fake app: truncated commitment');
    return [
      {
        size,
        keysRoot: Buffer.from(buf.subarray(next, next + 32)),
        valuesRoot: Buffer.from(buf.subarray(next + 32, next + 64)),
      },
      next + 64,
    ];
  }

  /** A whole map, keys checked to be strictly increasing as the app requires. */
  private async readMap(c: Commitment): Promise<Map<string, Buffer>> {
    const map = new Map<string, Buffer>();
    let previous: Buffer | null = null;
    for (let i = 0; i < c.size; i++) {
      const key = await this.leaf(c.keysRoot, c.size, i);
      if (previous && Buffer.compare(previous, key) >= 0) throw new Error('fake app: map keys out of order');
      previous = key;
      // Look the value up the way the app does: by key, then by position.
      const at = await this.leafIndex(c.keysRoot, sha(Buffer.from([0]), key));
      if (at !== i) throw new Error('fake app: client misplaced a key');
      map.set(key.toString('hex'), await this.leaf(c.valuesRoot, c.size, i));
    }
    return map;
  }

  private async readPolicy(id: Buffer): Promise<ReconstructedPolicy & { serialised: Buffer }> {
    const serialised = await this.preimage(id);
    if (serialised[0] !== 2) throw new Refusal(0x6a82);
    const nameLength = serialised[1];
    const name = serialised.toString('ascii', 2, 2 + nameLength);
    const [templateLength, at] = readVarint(serialised, 2 + nameLength);
    const templateHash = Buffer.from(serialised.subarray(at, at + 32));
    const [keyCount, at2] = readVarint(serialised, at + 32);
    const keysRoot = Buffer.from(serialised.subarray(at2, at2 + 32));
    if (at2 + 32 !== serialised.length) throw new Error('fake app: policy has trailing bytes');

    const template = await this.preimage(templateHash);
    if (template.length !== templateLength) throw new Error('fake app: template length mismatch');
    const keys: string[] = [];
    for (let i = 0; i < keyCount; i++) keys.push((await this.leaf(keysRoot, keyCount, i)).toString('ascii'));
    return { name, template: template.toString('ascii'), keys, serialised };
  }

  // --- wallet policies -----------------------------------------------------

  private hmacFor(id: Buffer): Buffer {
    return Buffer.from(hmac(sha256, Buffer.from(this.options.hmacSecret, 'utf8'), id));
  }

  /** Parses what the real app parses, with the same strictness about how keys are written. */
  private understand(policy: ReconstructedPolicy) {
    const match = /^wsh\(sortedmulti\((\d+),(.*)\)\)$/.exec(policy.template);
    if (!match) throw new Refusal(0x6a82);
    const placeholders = match[2].split(',');
    placeholders.forEach((p, i) => {
      if (p !== `@${i}/**`) throw new Refusal(0x6a80);
    });
    if (placeholders.length !== policy.keys.length) throw new Refusal(0x6a80);
    const threshold = Number(match[1]);
    if (threshold < 1 || threshold > policy.keys.length) throw new Refusal(0x6a80);

    const network = btcNetwork(this.options.network);
    const keys = policy.keys.map((text) => {
      // Lowercase fingerprint, ' for hardened steps, nothing after the xpub.
      const parsed = /^\[([0-9a-f]{8})((?:\/\d+'?)*)\]([1-9A-HJ-NP-Za-km-z]{111,112})$/.exec(text);
      if (!parsed) throw new Refusal(0x6a80);
      const node = bip32.fromBase58(parsed[3], network);
      const path = parsed[2].split('/').filter(Boolean);
      const internal =
        parsed[1] === this.fingerprint &&
        Buffer.from(this.root.derivePath(['m', ...path].join('/')).publicKey).equals(Buffer.from(node.publicKey));
      return { node, fingerprint: parsed[1], path, internal };
    });
    if (!keys.some((k) => k.internal)) throw new Refusal(0x6a80, Buffer.from([0x00, 0x02]));
    return { threshold, keys };
  }

  private scriptsAt(policy: ReturnType<FakeLedgerApp['understand']>, branch: number, index: number) {
    const pubkeys = policy.keys.map((k) => Buffer.from(k.node.derive(branch).derive(index).publicKey));
    const network = btcNetwork(this.options.network);
    const p2ms = bitcoin.payments.p2ms({
      m: policy.threshold,
      pubkeys: [...pubkeys].sort((a, b) => a.compare(b)),
      network,
    });
    const p2wsh = bitcoin.payments.p2wsh({ redeem: p2ms, network });
    return { witnessScript: p2ms.output!, scriptPubKey: p2wsh.output!, address: p2wsh.address!, pubkeys };
  }

  private checkName(name: string): void {
    if (name.length < 1 || name.length > 64 || name.startsWith(' ') || name.endsWith(' ') || !/^[\x20-\x7e]+$/.test(name)) {
      throw new Refusal(0x6a80, Buffer.from([0x00, 0x00]));
    }
  }

  private async registerWallet(data: Buffer): Promise<Buffer> {
    const [length, at] = readVarint(data, 0);
    const serialised = Buffer.from(data.subarray(at));
    if (serialised.length !== length) throw new Refusal(0x6a87);
    const id = sha(serialised);
    const policy = await this.readPolicy(id);
    if (!policy.serialised.equals(serialised)) throw new Error('fake app: policy changed between commit and reveal');
    this.checkName(policy.name);
    this.understand(policy);
    if (!this.options.approveRegistration) throw new Refusal(0x6985);
    this.registrations.push({ name: policy.name, template: policy.template, keys: policy.keys });
    return Buffer.concat([id, this.hmacFor(id)]);
  }

  private async getWalletAddress(data: Buffer): Promise<Buffer> {
    if (data.length !== 1 + 32 + 32 + 1 + 4) throw new Refusal(0x6a87);
    const id = Buffer.from(data.subarray(1, 33));
    if (!Buffer.from(data.subarray(33, 65)).equals(this.hmacFor(id))) throw new Refusal(0xb008);
    const policy = this.understand(await this.readPolicy(id));
    const index = data.readUInt32BE(66) + (this.options.faults.wrongAddresses ? 1 : 0);
    return Buffer.from(this.scriptsAt(policy, data[65], index).address, 'ascii');
  }

  private getExtendedPubkey(data: Buffer): Buffer {
    const display = data[0];
    const steps: number[] = [];
    for (let i = 0; i < data[1]; i++) steps.push(data.readUInt32BE(2 + 4 * i));
    if (data.length !== 2 + 4 * steps.length) throw new Refusal(0x6a87);
    const coin = this.options.network === 'mainnet' ? 0 : 1;
    const hardened = (n: number) => n >= 0x80000000;
    const purpose = steps[0] - 0x80000000;
    const depth = purpose === 48 ? 4 : 3;
    // The paths the real app hands out without asking (get_extended_pubkey.c).
    const standard =
      [44, 45, 48, 49, 84, 86, 87].includes(purpose) &&
      steps.length >= depth &&
      steps.every((s, i) => hardened(s) === i < depth) &&
      steps[1] - 0x80000000 === coin &&
      steps[2] - 0x80000000 <= 100 &&
      (purpose !== 48 || [1, 2].includes(steps[3] - 0x80000000));
    if (!standard && !display) throw new Refusal(0x6a82);
    // Since 2.4.3 the operating system holds the app to its own network's
    // keys (and two historical exceptions), approval or no approval.
    const permitted =
      steps.length >= 2 && (steps[1] === 0x80000000 + coin || purpose === 45 || steps[0] === 0x80000000 + 4541509);
    if (!permitted) throw new Refusal(0x6a82);
    let node = this.root;
    for (const step of steps) node = hardened(step) ? node.deriveHardened(step - 0x80000000) : node.derive(step);
    return Buffer.from(node.neutered().toBase58(), 'ascii');
  }

  // --- signing -------------------------------------------------------------

  private async signPsbt(data: Buffer): Promise<Buffer> {
    let at = 0;
    let global: Commitment;
    [global, at] = this.parseCommitment(data, at);
    let inputCount: number;
    [inputCount, at] = readVarint(data, at);
    const inputsRoot = Buffer.from(data.subarray(at, at + 32));
    at += 32;
    let outputCount: number;
    [outputCount, at] = readVarint(data, at);
    const outputsRoot = Buffer.from(data.subarray(at, at + 32));
    at += 32;
    const id = Buffer.from(data.subarray(at, at + 32));
    const mac = Buffer.from(data.subarray(at + 32, at + 64));
    if (data.length !== at + 64) throw new Refusal(0x6a87);

    if (mac.every((b) => b === 0)) throw new Refusal(0x6a80, Buffer.from([0x00, 0x00]));
    if (!mac.equals(this.hmacFor(id))) throw new Refusal(0xb008);
    const described = await this.readPolicy(id);
    const policy = this.understand(described);

    const globalMap = await this.readMap(global);
    const need = (map: Map<string, Buffer>, key: string, what: string): Buffer => {
      const value = map.get(key);
      if (!value) throw new Error(`fake app: PSBT lacks ${what}`);
      return value;
    };
    if (need(globalMap, 'fb', 'its version').readUInt32LE(0) !== 2) throw new Error('fake app: PSBT is not version 2');
    if (globalMap.has('00')) throw new Error('fake app: a version 2 PSBT cannot carry an unsigned transaction');
    if (readVarint(need(globalMap, '04', 'its input count'), 0)[0] !== inputCount) throw new Error('fake app: input count mismatch');
    if (readVarint(need(globalMap, '05', 'its output count'), 0)[0] !== outputCount) throw new Error('fake app: output count mismatch');

    const readMaps = async (root: Buffer, count: number) => {
      const maps: Map<string, Buffer>[] = [];
      for (let i = 0; i < count; i++) {
        const commitment = await this.leaf(root, count, i);
        const [parsed, end] = this.parseCommitment(commitment, 0);
        if (end !== commitment.length) throw new Error('fake app: commitment has trailing bytes');
        maps.push(await this.readMap(parsed));
      }
      return maps;
    };
    const inputs = await readMaps(inputsRoot, inputCount);
    const outputs = await readMaps(outputsRoot, outputCount);

    // The transaction, put back together from the version 2 fields.
    const tx = new bitcoin.Transaction();
    tx.version = need(globalMap, '02', 'a transaction version').readUInt32LE(0);
    tx.locktime = globalMap.get('03')?.readUInt32LE(0) ?? 0;
    for (const input of inputs) {
      tx.addInput(
        need(input, '0e', 'a previous txid'),
        need(input, '0f', 'an output index').readUInt32LE(0),
        input.get('10')?.readUInt32LE(0) ?? 0xffffffff
      );
    }
    for (const output of outputs) {
      const amount = need(output, '03', 'an amount');
      tx.addOutput(need(output, '04', 'a script'), amount.readUInt32LE(0) + amount.readUInt32LE(4) * 0x100000000);
    }

    const internal = policy.keys.findIndex((k) => k.internal);
    const account = this.root.derivePath(['m', ...policy.keys[internal].path].join('/'));
    const results: Buffer[] = [];
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      const witnessUtxo = need(input, '01', 'a witness UTXO');
      const amount = witnessUtxo.readUInt32LE(0) + witnessUtxo.readUInt32LE(4) * 0x100000000;
      const scriptPubKey = Buffer.from(witnessUtxo.subarray(9, 9 + witnessUtxo[8]));

      // Segwit v0 commits to the amount only by the signer's say-so, so the
      // app insists on the whole previous transaction and checks it.
      const previous = input.get('00');
      if (!previous) throw new Refusal(0x6a80, Buffer.from([0x00, 0x03]));
      const previousTx = bitcoin.Transaction.fromBuffer(previous);
      if (!Buffer.from(previousTx.getHash()).equals(Buffer.from(tx.ins[i].hash))) {
        throw new Refusal(0x6a80, Buffer.from([0x00, 0x04]));
      }
      const spent = previousTx.outs[tx.ins[i].index];
      if (!spent || spent.value !== amount || !Buffer.from(spent.script).equals(scriptPubKey)) {
        throw new Refusal(0x6a80, Buffer.from([0x00, 0x05]));
      }

      // Find our key's derivation among the input's, then hold the input to
      // what the policy derives at that position.
      let ours: { branch: number; index: number } | null = null;
      for (const [key, value] of input) {
        // Not subarray().toString(): on Hermes that is a plain Uint8Array, which ignores 'hex'.
        if (!key.startsWith('06') || value.toString('hex', 0, 4) !== this.fingerprint) continue;
        const steps: number[] = [];
        for (let p = 4; p < value.length; p += 4) steps.push(value.readUInt32LE(p));
        ours = { branch: steps[steps.length - 2], index: steps[steps.length - 1] };
      }
      if (!ours) continue;
      const expected = this.scriptsAt(policy, ours.branch, ours.index);
      if (!expected.scriptPubKey.equals(scriptPubKey)) continue; // not this wallet's coin
      if (!need(input, '05', 'a witness script').equals(expected.witnessScript)) {
        throw new Refusal(0x6a80, Buffer.from([0x00, 0x0a]));
      }

      const sighashType = this.options.faults.sighashType ?? input.get('03')?.readUInt32LE(0) ?? 1;
      const digest = tx.hashForWitnessV0(i, expected.witnessScript, amount, sighashType);
      const key = account.derive(ours.branch).derive(ours.index);
      const signature = bitcoin.script.signature.encode(Buffer.from(ecc.sign(digest, key.privateKey!)), sighashType);
      results.push(
        Buffer.concat([
          writeVarint(this.options.faults.inputIndex ?? i),
          Buffer.from([33]),
          Buffer.from(expected.pubkeys[internal]),
          signature,
        ])
      );
    }
    if (this.options.faults.signNothing) results.length = 0;

    if (!this.options.approveTransaction) throw new Refusal(0x6985);
    this.signed.push({
      policy: { name: described.name, template: described.template, keys: described.keys },
      psbt: { global: globalMap, inputs, outputs },
    });
    for (const result of results) {
      const reply = await this.ask(Buffer.concat([Buffer.from([0x10]), result]));
      if (reply.length !== 0) throw new Error('fake app: YIELD must be answered with nothing');
    }
    return Buffer.alloc(0);
  }
}

// ---------------------------------------------------------------------------
// Transactions to sign
// ---------------------------------------------------------------------------

export interface FundedSpend {
  /** The draft as the app stores it: no previous transactions inside. */
  stored: string;
  /** The same draft as a device is shown it, previous transactions filled in. */
  psbt: bitcoin.Psbt;
  funding: bitcoin.Transaction;
}

/**
 * A spend from `wallet` whose coins come from a real (if unmined) transaction,
 * so the previous transaction every device asks for exists and hashes to the
 * txid the inputs name.
 */
export function fundedSpend(
  wallet: MultisigWallet,
  coins: number[],
  to: string,
  amount: number,
  feeRate = 5
): FundedSpend {
  const funding = new bitcoin.Transaction();
  funding.version = 2;
  funding.addInput(Buffer.alloc(32, 7), 0, 0xffffffff, Buffer.from('51', 'hex'));
  coins.forEach((value, i) => funding.addOutput(deriveAddress(wallet, 0, i).script, value));

  const snapshot: WalletSnapshot = {
    confirmedSats: coins.reduce((s, v) => s + v, 0),
    unconfirmedSats: 0,
    utxos: coins.map((value, i) => ({
      txid: funding.getId(),
      vout: i,
      value,
      address: deriveAddress(wallet, 0, i).address,
      branch: 0,
      index: i,
      confirmed: true,
    })),
    usedAddresses: [],
    nextReceiveIndex: coins.length,
    nextChangeIndex: 0,
    scannedAt: 0,
  };
  const stored = buildPsbt(wallet, snapshot, to, amount, feeRate, false).psbt.toBase64();
  const psbt = parsePsbt(stored, wallet.network);
  psbt.data.inputs.forEach((_, i) => psbt.updateInput(i, { nonWitnessUtxo: funding.toBuffer() }));
  return { stored, psbt, funding };
}

// ---------------------------------------------------------------------------
// The real app, under Ledger's Speculos emulator
// ---------------------------------------------------------------------------

export interface Speculos {
  exchange: ApduExchange;
  /** What the device's screen says right now. */
  screen(): Promise<string>;
  /**
   * Plays the user while `work` runs: pages right through whatever the device
   * shows and presses both buttons on a screen naming one of `choices`.
   */
  during<T>(choices: string[], work: () => Promise<T>): Promise<T>;
  close(): void;
}

/** Connects to a running Speculos: `apdu` is host:port of its APDU server, `api` the URL of its REST API. */
export async function connectSpeculos(apdu: string, api: string): Promise<Speculos> {
  // Loaded here so the rest of this file stays free of Node built-ins.
  const net = require('net') as typeof import('net');
  const [host, port] = apdu.split(':');
  const socket = net.createConnection({ host, port: Number(port) });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  let buffered = Buffer.alloc(0);
  let waiting: { resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  const pump = () => {
    if (!waiting || buffered.length < 4) return;
    // The length counts the data only; the status word follows it.
    const length = buffered.readUInt32BE(0) + 2;
    if (buffered.length < 4 + length) return;
    const reply = Buffer.from(buffered.subarray(4, 4 + length));
    buffered = Buffer.from(buffered.subarray(4 + length));
    const w = waiting;
    waiting = null;
    w.resolve(reply);
  };
  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    pump();
  });
  socket.on('error', (e: Error) => waiting?.reject(e));
  socket.on('close', () => waiting?.reject(new Error('Speculos closed the connection.')));

  const screen = async (): Promise<string> => {
    const res = await fetch(`${api}/events?currentscreenonly=true`);
    const body = (await res.json()) as { events: { text: string }[] };
    return body.events.map((e) => e.text).join(' ');
  };
  const press = (button: 'left' | 'right' | 'both') =>
    fetch(`${api}/button/${button}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'press-and-release' }),
    });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  return {
    exchange: (apdu) =>
      new Promise((resolve, reject) => {
        waiting = { resolve, reject };
        const header = Buffer.alloc(4);
        header.writeUInt32BE(apdu.length, 0);
        socket.write(Buffer.concat([header, apdu]));
        pump();
      }),
    screen,
    async during(choices, work) {
      let running = true;
      const user = (async () => {
        let last = '';
        let sameFor = 0;
        while (running) {
          await sleep(120);
          const text = await screen().catch(() => '');
          // Nothing to decide: the home screen, or the device is thinking.
          if (!text || /is ready|Processing|Loading|Signing/i.test(text)) continue;
          // Give a screen a moment to finish drawing before acting on it.
          sameFor = text === last ? sameFor + 1 : 0;
          last = text;
          if (sameFor < 1) continue;
          await press(choices.some((c) => text.includes(c)) ? 'both' : 'right');
          last = '';
        }
      })();
      try {
        return await work();
      } finally {
        running = false;
        await user;
      }
    },
    close: () => socket.destroy(),
  };
}
