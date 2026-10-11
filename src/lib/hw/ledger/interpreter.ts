import { sha256 } from '@noble/hashes/sha256';
import { Buffer } from 'buffer';
import { decodeVarint, encodeVarint, MerkleMap, MerkleTree } from './merkle';
import { serialisePolicy, WalletPolicy } from './policy';

/**
 * Answers the questions the Ledger app asks in the middle of a command.
 *
 * A command only commits to its data by hash. The app then interrupts its own
 * execution to ask for a hash's preimage, a Merkle proof, or the position of a
 * leaf, as often as it needs, and hands back results the same way. This class
 * is a lookup table over everything the command committed to — it does not
 * know what any of the data means.
 *
 * Reference: github.com/LedgerHQ/app-bitcoin-new doc/bitcoin.md, "Client
 * commands reference"
 */

export const CMD_YIELD = 0x10;
export const CMD_GET_PREIMAGE = 0x40;
export const CMD_GET_MERKLE_LEAF_PROOF = 0x41;
export const CMD_GET_MERKLE_LEAF_INDEX = 0x42;
export const CMD_GET_MORE_ELEMENTS = 0xa0;

/** A reply is one APDU's worth of data. */
const MAX_REPLY = 255;

export class ClientCommandInterpreter {
  private readonly preimages = new Map<string, Buffer>();
  private readonly trees = new Map<string, MerkleTree>();
  /** What did not fit in a reply, waiting to be asked for. */
  private queue: Buffer[] = [];
  /** Results the app handed back, in the order they came. */
  readonly yielded: Buffer[] = [];

  constructor(private readonly onYield?: (count: number) => void) {}

  addPreimage(preimage: Uint8Array): void {
    this.preimages.set(Buffer.from(sha256(preimage)).toString('hex'), Buffer.from(preimage));
  }

  addList(elements: readonly Uint8Array[]): void {
    // A leaf is asked for by its hash, which covers the 0x00 prefix too.
    for (const element of elements) this.addPreimage(Buffer.concat([Buffer.from([0x00]), element]));
    const tree = new MerkleTree(elements);
    this.trees.set(tree.root.toString('hex'), tree);
  }

  addMap(map: MerkleMap): void {
    this.addList(map.keys);
    this.addList(map.values);
  }

  addPolicy(policy: WalletPolicy): void {
    this.addPreimage(serialisePolicy(policy));
    this.addPreimage(Buffer.from(policy.template, 'ascii'));
    this.addList(policy.keys.map((k) => Buffer.from(k, 'ascii')));
  }

  /** The answer to one request. Throws on anything the command did not commit to. */
  execute(request: Uint8Array): Buffer {
    const req = Buffer.from(request);
    if (req.length === 0) throw new Error('The Ledger sent an empty request.');
    const body = Buffer.from(req.subarray(1));
    switch (req[0]) {
      case CMD_YIELD:
        this.yielded.push(body);
        this.onYield?.(this.yielded.length);
        return Buffer.alloc(0);
      case CMD_GET_PREIMAGE:
        return this.getPreimage(body);
      case CMD_GET_MERKLE_LEAF_PROOF:
        return this.getLeafProof(body);
      case CMD_GET_MERKLE_LEAF_INDEX:
        return this.getLeafIndex(body);
      case CMD_GET_MORE_ELEMENTS:
        return this.getMoreElements(body);
      default:
        throw new Error(`The Ledger asked for something this app does not understand (0x${req[0].toString(16)}).`);
    }
  }

  private getPreimage(body: Buffer): Buffer {
    // One reserved byte, which must be zero, then the hash.
    if (body.length !== 33 || body[0] !== 0) throw new Error('The Ledger sent a malformed request.');
    const preimage = this.preimages.get(Buffer.from(body.subarray(1)).toString('hex'));
    if (!preimage) throw new Error('The Ledger asked for data that is not part of this request.');

    const length = encodeVarint(preimage.length);
    const fits = Math.min(MAX_REPLY - length.length - 1, preimage.length);
    // The rest goes out a byte at a time.
    for (let i = fits; i < preimage.length; i++) this.queue.push(Buffer.from([preimage[i]]));
    return Buffer.concat([length, Buffer.from([fits]), Buffer.from(preimage.subarray(0, fits))]);
  }

  private getLeafProof(body: Buffer): Buffer {
    if (body.length < 34) throw new Error('The Ledger sent a malformed request.');
    const tree = this.trees.get(Buffer.from(body.subarray(0, 32)).toString('hex'));
    if (!tree) throw new Error('The Ledger asked for data that is not part of this request.');
    const size = decodeVarint(body, 32);
    const index = decodeVarint(body, size.next);
    if (index.next !== body.length) throw new Error('The Ledger sent a malformed request.');
    if (size.value !== tree.size || index.value >= tree.size) {
      throw new Error('The Ledger asked for data that is not part of this request.');
    }
    if (this.queue.length !== 0) throw new Error('The Ledger asked a new question before finishing the last.');

    const proof = tree.proof(index.value);
    const fits = Math.min(Math.floor((MAX_REPLY - 32 - 2) / 32), proof.length);
    this.queue.push(...proof.slice(fits));
    return Buffer.concat([tree.leaves[index.value], Buffer.from([proof.length, fits]), ...proof.slice(0, fits)]);
  }

  private getLeafIndex(body: Buffer): Buffer {
    if (body.length !== 64) throw new Error('The Ledger sent a malformed request.');
    const tree = this.trees.get(Buffer.from(body.subarray(0, 32)).toString('hex'));
    if (!tree) throw new Error('The Ledger asked for data that is not part of this request.');
    const index = tree.indexOf(body.subarray(32));
    // "Not there" is a proper answer: the app probes for fields a map may lack.
    return Buffer.concat([Buffer.from([index < 0 ? 0 : 1]), encodeVarint(Math.max(index, 0))]);
  }

  private getMoreElements(body: Buffer): Buffer {
    if (body.length !== 0) throw new Error('The Ledger sent a malformed request.');
    if (this.queue.length === 0) throw new Error('The Ledger asked for more data than there is.');
    const size = this.queue[0].length;
    const count = Math.min(Math.floor((MAX_REPLY - 2) / size), this.queue.length);
    return Buffer.concat([Buffer.from([count, size]), ...this.queue.splice(0, count)]);
  }
}
