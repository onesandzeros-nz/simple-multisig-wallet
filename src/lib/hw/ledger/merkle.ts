import { sha256 } from '@noble/hashes/sha256';
import { Buffer } from 'buffer';

/**
 * The commitments the Ledger Bitcoin app works from. A Ledger has too little
 * memory to hold a transaction, so the phone sends hashes up front and then
 * reveals the data piece by piece as the app asks — each piece checked
 * against those hashes, so the phone cannot change its story halfway through.
 *
 * Reference: github.com/LedgerHQ/app-bitcoin-new doc/merkle.md
 */

// ---------------------------------------------------------------------------
// Bitcoin-style variable-length integers
// ---------------------------------------------------------------------------

export function encodeVarint(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Cannot encode ${value} as a varint.`);
  if (value < 0xfd) return Buffer.from([value]);
  if (value <= 0xffff) {
    const out = Buffer.alloc(3);
    out[0] = 0xfd;
    out.writeUInt16LE(value, 1);
    return out;
  }
  if (value <= 0xffffffff) {
    const out = Buffer.alloc(5);
    out[0] = 0xfe;
    out.writeUInt32LE(value, 1);
    return out;
  }
  const out = Buffer.alloc(9);
  out[0] = 0xff;
  out.writeUInt32LE(value % 0x100000000, 1);
  out.writeUInt32LE(Math.floor(value / 0x100000000), 5);
  return out;
}

/** Reads a varint at `offset`; `next` is where whatever follows it starts. */
export function decodeVarint(bytes: Uint8Array, offset: number): { value: number; next: number } {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (offset < 0 || offset >= buf.length) throw new Error('Truncated data.');
  const first = buf[offset];
  const size = first < 0xfd ? 0 : first === 0xfd ? 2 : first === 0xfe ? 4 : 8;
  if (offset + 1 + size > buf.length) throw new Error('Truncated data.');
  if (size === 0) return { value: first, next: offset + 1 };
  if (size === 2) return { value: buf.readUInt16LE(offset + 1), next: offset + 3 };
  if (size === 4) return { value: buf.readUInt32LE(offset + 1), next: offset + 5 };
  const high = buf.readUInt32LE(offset + 5);
  if (high > 0x1fffff) throw new Error('Number too large to handle safely.');
  return { value: high * 0x100000000 + buf.readUInt32LE(offset + 1), next: offset + 9 };
}

// ---------------------------------------------------------------------------
// Merkle trees
// ---------------------------------------------------------------------------

const hash = (...parts: Uint8Array[]): Buffer => Buffer.from(sha256(Buffer.concat(parts)));

/** Leaves and inner nodes are hashed under different prefixes, so one can never pass for the other. */
export function leafHash(element: Uint8Array): Buffer {
  return hash(Buffer.from([0x00]), element);
}

function nodeHash(left: Uint8Array, right: Uint8Array): Buffer {
  return hash(Buffer.from([0x01]), left, right);
}

/** The largest power of two strictly below `n` — where a tree of `n` leaves splits. */
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function rootOf(hashes: Buffer[]): Buffer {
  // Unlike RFC 6962, the empty list hashes to 32 zero bytes.
  if (hashes.length === 0) return Buffer.alloc(32);
  if (hashes.length === 1) return hashes[0];
  const k = splitPoint(hashes.length);
  return nodeHash(rootOf(hashes.slice(0, k)), rootOf(hashes.slice(k)));
}

function proofOf(hashes: Buffer[], index: number): Buffer[] {
  if (hashes.length <= 1) return [];
  const k = splitPoint(hashes.length);
  const left = hashes.slice(0, k);
  const right = hashes.slice(k);
  // Deepest sibling first: the order the app consumes them in.
  return index < k ? [...proofOf(left, index), rootOf(right)] : [...proofOf(right, index - k), rootOf(left)];
}

/** A Merkle tree over a list of byte strings, in the order given. */
export class MerkleTree {
  readonly leaves: Buffer[];
  readonly root: Buffer;

  constructor(elements: readonly Uint8Array[]) {
    this.leaves = elements.map(leafHash);
    this.root = rootOf(this.leaves);
  }

  get size(): number {
    return this.leaves.length;
  }

  /** The hashes needed to get from leaf `index` to the root. */
  proof(index: number): Buffer[] {
    if (!Number.isInteger(index) || index < 0 || index >= this.leaves.length) {
      throw new Error('No such leaf.');
    }
    return proofOf(this.leaves, index);
  }

  /** Where a leaf with this hash sits, or -1. */
  indexOf(hashOfLeaf: Uint8Array): number {
    const wanted = Buffer.from(hashOfLeaf);
    return this.leaves.findIndex((leaf) => leaf.equals(wanted));
  }
}

// ---------------------------------------------------------------------------
// Merkleized maps
// ---------------------------------------------------------------------------

/**
 * A key/value map committed to as two trees of the same shape — one over the
 * keys, one over the values. Keys are held in strictly increasing byte order;
 * that is what stops a map from carrying two values under one key.
 */
export class MerkleMap {
  readonly keys: Buffer[];
  readonly values: Buffer[];
  readonly keysTree: MerkleTree;
  readonly valuesTree: MerkleTree;

  constructor(entries: ReadonlyMap<string, Uint8Array> | readonly (readonly [Uint8Array, Uint8Array])[]) {
    const pairs: [Buffer, Buffer][] =
      entries instanceof Map
        ? [...entries].map(([k, v]) => [Buffer.from(k, 'hex'), Buffer.from(v)])
        : (entries as readonly (readonly [Uint8Array, Uint8Array])[]).map(([k, v]) => [
            Buffer.from(k),
            Buffer.from(v),
          ]);
    pairs.sort((a, b) => Buffer.compare(a[0], b[0]));
    for (let i = 1; i < pairs.length; i++) {
      if (pairs[i - 1][0].equals(pairs[i][0])) throw new Error('A map cannot hold the same key twice.');
    }
    this.keys = pairs.map((p) => p[0]);
    this.values = pairs.map((p) => p[1]);
    this.keysTree = new MerkleTree(this.keys);
    this.valuesTree = new MerkleTree(this.values);
  }

  /** How the map is named in a command: its size, then the two roots. 65 to 73 bytes. */
  commitment(): Buffer {
    return Buffer.concat([encodeVarint(this.keys.length), this.keysTree.root, this.valuesTree.root]);
  }
}
