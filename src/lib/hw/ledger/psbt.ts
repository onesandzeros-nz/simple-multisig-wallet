import * as bitcoin from 'bitcoinjs-lib';
import { Buffer } from 'buffer';
import { decodeVarint, encodeVarint } from './merkle';

/**
 * A PSBT as the Ledger app wants it: version 2 (BIP-370), one key/value map
 * for the transaction as a whole and one for each input and output.
 *
 * This app builds version 0 PSBTs, where the transaction travels whole in a
 * single global field. Version 2 spreads the same facts over the maps, so the
 * conversion is mechanical: every field is carried across byte for byte, and
 * the unsigned transaction is replaced by the fields that describe it.
 */

/** Hex of the key (type byte, then key data) → value. */
export type KeyValueMap = Map<string, Buffer>;

export interface PsbtMaps {
  global: KeyValueMap;
  inputs: KeyValueMap[];
  outputs: KeyValueMap[];
}

const PSBT_MAGIC = Buffer.from('70736274ff', 'hex');

const GLOBAL_UNSIGNED_TX = 0x00;
const GLOBAL_TX_VERSION = 0x02;
const GLOBAL_FALLBACK_LOCKTIME = 0x03;
const GLOBAL_INPUT_COUNT = 0x04;
const GLOBAL_OUTPUT_COUNT = 0x05;
const GLOBAL_VERSION = 0xfb;
const IN_PREVIOUS_TXID = 0x0e;
const IN_OUTPUT_INDEX = 0x0f;
const IN_SEQUENCE = 0x10;
const OUT_AMOUNT = 0x03;
const OUT_SCRIPT = 0x04;

const key = (type: number) => Buffer.from([type]).toString('hex');

function uint32LE(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0, 0);
  return out;
}

function uint64LE(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('An amount must be a whole number of sats.');
  const out = Buffer.alloc(8);
  out.writeUInt32LE(value % 0x100000000, 0);
  out.writeUInt32LE(Math.floor(value / 0x100000000), 4);
  return out;
}

/** Reads one map off the wire, up to and including the zero byte that ends it. */
function readMap(bytes: Buffer, start: number): { map: KeyValueMap; next: number } {
  const map: KeyValueMap = new Map();
  let at = start;
  for (;;) {
    const keyLength = decodeVarint(bytes, at);
    at = keyLength.next;
    if (keyLength.value === 0) return { map, next: at };
    if (at + keyLength.value > bytes.length) throw new Error('Truncated PSBT.');
    const name = Buffer.from(bytes.subarray(at, at + keyLength.value)).toString('hex');
    at += keyLength.value;
    const valueLength = decodeVarint(bytes, at);
    at = valueLength.next;
    if (at + valueLength.value > bytes.length) throw new Error('Truncated PSBT.');
    if (map.has(name)) throw new Error('This PSBT repeats a field.');
    map.set(name, Buffer.from(bytes.subarray(at, at + valueLength.value)));
    at += valueLength.value;
  }
}

/** Splits a serialised version 0 PSBT into its maps and rewrites them as version 2. */
export function psbtBytesToV2Maps(serialised: Uint8Array): PsbtMaps {
  const bytes = Buffer.from(serialised);
  if (bytes.length < 5 || !Buffer.from(bytes.subarray(0, 5)).equals(PSBT_MAGIC)) {
    throw new Error('That is not a PSBT.');
  }
  const first = readMap(bytes, 5);
  const global = first.map;
  if (global.has(key(GLOBAL_VERSION))) {
    throw new Error('Only version 0 PSBTs can be sent to a Ledger from here.');
  }
  const rawTx = global.get(key(GLOBAL_UNSIGNED_TX));
  if (!rawTx) throw new Error('This PSBT has no transaction in it.');
  const tx = bitcoin.Transaction.fromBuffer(rawTx);

  let at = first.next;
  const inputs: KeyValueMap[] = [];
  for (let i = 0; i < tx.ins.length; i++) {
    const read = readMap(bytes, at);
    inputs.push(read.map);
    at = read.next;
  }
  const outputs: KeyValueMap[] = [];
  for (let i = 0; i < tx.outs.length; i++) {
    const read = readMap(bytes, at);
    outputs.push(read.map);
    at = read.next;
  }
  if (at !== bytes.length) throw new Error('This PSBT has data after its end.');

  global.delete(key(GLOBAL_UNSIGNED_TX));
  global.set(key(GLOBAL_VERSION), uint32LE(2));
  global.set(key(GLOBAL_TX_VERSION), uint32LE(tx.version));
  global.set(key(GLOBAL_FALLBACK_LOCKTIME), uint32LE(tx.locktime));
  global.set(key(GLOBAL_INPUT_COUNT), encodeVarint(tx.ins.length));
  global.set(key(GLOBAL_OUTPUT_COUNT), encodeVarint(tx.outs.length));

  tx.ins.forEach((input, i) => {
    // Kept in the byte order the transaction itself uses, not the reversed
    // form a txid is written in.
    inputs[i].set(key(IN_PREVIOUS_TXID), Buffer.from(input.hash));
    inputs[i].set(key(IN_OUTPUT_INDEX), uint32LE(input.index));
    inputs[i].set(key(IN_SEQUENCE), uint32LE(input.sequence));
  });
  tx.outs.forEach((output, i) => {
    outputs[i].set(key(OUT_AMOUNT), uint64LE(output.value));
    outputs[i].set(key(OUT_SCRIPT), Buffer.from(output.script));
  });

  return { global, inputs, outputs };
}

export function psbtToV2Maps(psbt: bitcoin.Psbt): PsbtMaps {
  return psbtBytesToV2Maps(psbt.toBuffer());
}
