/**
 * Reads the public wallet policy out of a Sparrow wallet file (`*.mv.db`).
 *
 * Sparrow keeps each wallet in an H2 database, stored in H2's MVStore
 * format: 4 KiB blocks holding chunks of B-tree pages, most of them LZF
 * compressed. This is a deliberately small reader — it walks only the pages
 * that are live in the newest version of the store, expands them, and picks
 * the keystore rows (fingerprint, derivation, xpub) and the policy
 * (`wsh(sortedmulti(2,…))`) out of the row bytes. Nothing else in the file —
 * seeds, transactions, labels — is interpreted.
 */

const BLOCK_SIZE = 4096;
const PAGE_TYPE_NODE = 1;
const PAGE_COMPRESSED = 2;
const PAGE_COMPRESSED_HIGH = 6;
const MAX_PAGES = 200_000;

export interface SparrowWallet {
  name?: string;
  /** Signatures required, from the wallet's policy. */
  m: number;
  keys: { label?: string; fingerprint: string; path: string; xpub: string }[];
}

/** True when the bytes are an (unencrypted) H2 MVStore file, as Sparrow writes. */
export function isSparrowFile(bytes: Uint8Array): boolean {
  return latin1(bytes, 0, 4) === 'H:2,';
}

/** True for a wallet file Sparrow has encrypted with a password. */
export function isEncryptedSparrowFile(bytes: Uint8Array): boolean {
  return latin1(bytes, 0, 9) === 'H2encrypt';
}

function latin1(bytes: Uint8Array, start: number, end: number): string {
  let out = '';
  const stop = Math.min(end, bytes.length);
  for (let i = start; i < stop; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

class Reader {
  constructor(
    readonly buf: Uint8Array,
    public pos: number,
    readonly end: number
  ) {}
  byte(): number {
    if (this.pos >= this.end) throw new Error('Unexpected end of page.');
    return this.buf[this.pos++];
  }
  varInt(): number {
    let result = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const b = this.byte();
      result += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return result;
    }
    throw new Error('Bad variable-length number.');
  }
  /** H2's string encoding: a char count, then 1–3 bytes per UTF-16 unit. */
  string(): string {
    const len = this.varInt();
    let out = '';
    for (let i = 0; i < len; i++) {
      const x = this.byte();
      if (x < 0x80) out += String.fromCharCode(x);
      else if (x >= 0xe0) out += String.fromCharCode(((x & 0xf) << 12) | ((this.byte() & 0x3f) << 6) | (this.byte() & 0x3f));
      else out += String.fromCharCode(((x & 0x1f) << 6) | (this.byte() & 0x3f));
    }
    return out;
  }
}

/** LZF as implemented by H2's CompressLZF. */
function expandLzf(input: Uint8Array, start: number, end: number, outLen: number): Uint8Array {
  const out = new Uint8Array(outLen);
  let inPos = start;
  let outPos = 0;
  while (outPos < outLen) {
    if (inPos >= end) throw new Error('Compressed page is truncated.');
    const ctrl = input[inPos++];
    if (ctrl < 32) {
      const n = ctrl + 1;
      if (inPos + n > end || outPos + n > outLen) throw new Error('Compressed page is corrupt.');
      out.set(input.subarray(inPos, inPos + n), outPos);
      inPos += n;
      outPos += n;
    } else {
      let len = ctrl >> 5;
      if (len === 7) len += input[inPos++];
      len += 2;
      let from = outPos - ((ctrl & 0x1f) << 8) - 1 - input[inPos++];
      if (from < 0 || outPos + len > outLen || inPos > end) throw new Error('Compressed page is corrupt.');
      // Byte by byte: the source may overlap what is being written.
      for (let i = 0; i < len; i++) out[outPos++] = out[from++];
    }
  }
  return out;
}

interface Chunk {
  id: number;
  block: number;
  version: number;
  /** Position of the layout map's root page. */
  root: bigint;
}

/** `key:value,key:value` as MVStore writes its headers (values are hex). */
function parseHeader(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of text.split(',')) {
    const colon = pair.indexOf(':');
    if (colon > 0) map.set(pair.slice(0, colon).trim(), pair.slice(colon + 1).trim());
  }
  return map;
}

function findChunks(bytes: Uint8Array): Map<number, Chunk> {
  const chunks = new Map<number, Chunk>();
  for (let offset = 2 * BLOCK_SIZE; offset + 6 <= bytes.length; offset += BLOCK_SIZE) {
    if (latin1(bytes, offset, offset + 6) !== 'chunk:') continue;
    const head = latin1(bytes, offset, offset + 1024);
    const newline = head.indexOf('\n');
    if (newline === -1) continue;
    const fields = parseHeader(head.slice(0, newline));
    const id = parseInt(fields.get('chunk') ?? '', 16);
    const version = parseInt(fields.get('version') ?? '0', 16);
    let root = 0n;
    try {
      root = BigInt(`0x${fields.get('root') ?? '0'}`);
    } catch {
      continue;
    }
    if (!Number.isFinite(id)) continue;
    const known = chunks.get(id);
    if (!known || version >= known.version) {
      chunks.set(id, { id, block: offset / BLOCK_SIZE, version, root });
    }
  }
  return chunks;
}

interface Page {
  node: boolean;
  keyCount: number;
  children: bigint[];
  /** Expanded keys-and-values area. */
  data: Uint8Array;
}

function readPage(bytes: Uint8Array, chunks: Map<number, Chunk>, pos: bigint): Page {
  const chunk = chunks.get(Number(pos >> 38n));
  if (!chunk) throw new Error('The file refers to a part that is missing.');
  const start = chunk.block * BLOCK_SIZE + Number((pos >> 6n) & 0xffffffffn);
  if (start + 10 > bytes.length) throw new Error('The file is cut short.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pageLength = view.getInt32(start);
  if (pageLength < 10 || start + pageLength > bytes.length) throw new Error('The file is cut short.');
  const r = new Reader(bytes, start + 6, start + pageLength); // skip length + check value
  r.varInt(); // page number
  r.varInt(); // map id
  const keyCount = r.varInt();
  const type = r.byte();
  const node = (type & 1) === PAGE_TYPE_NODE;
  const children: bigint[] = [];
  if (node) {
    for (let i = 0; i <= keyCount; i++) {
      if (r.pos + 8 > r.end) throw new Error('Unexpected end of page.');
      children.push(view.getBigUint64(r.pos));
      r.pos += 8;
    }
    for (let i = 0; i <= keyCount; i++) {
      // Per-child entry counts: variable-length longs we do not need.
      while (r.byte() >= 0x80);
    }
  }
  let data: Uint8Array;
  if (type & PAGE_COMPRESSED) {
    if ((type & PAGE_COMPRESSED_HIGH) === PAGE_COMPRESSED_HIGH) {
      throw new Error('This Sparrow file uses a compression this app cannot read.');
    }
    const lenAdd = r.varInt();
    data = expandLzf(bytes, r.pos, r.end, r.end - r.pos + lenAdd);
  } else {
    data = bytes.subarray(r.pos, r.end);
  }
  return { node, keyCount, children, data };
}

/** Calls `visit` with every leaf page reachable from `root`. */
function walk(
  bytes: Uint8Array,
  chunks: Map<number, Chunk>,
  root: bigint,
  budget: { pages: number },
  visit: (page: Page) => void
): void {
  const stack = [root];
  while (stack.length) {
    const pos = stack.pop()!;
    if (pos === 0n) continue;
    if (++budget.pages > MAX_PAGES) throw new Error('This Sparrow file is too large to read.');
    const page = readPage(bytes, chunks, pos);
    if (page.node) stack.push(...[...page.children].reverse()); // popped left to right
    else visit(page);
  }
}

const KEYSTORE_ROW =
  /([0-9a-fA-F]{8})[\s\S]{1,3}?(m(?:\/\d+['hH]?)+)[\s\S]{1,4}?([xyztuvYZUV]pub[1-9A-HJ-NP-Za-km-z]{100,110})/g;
const POLICY = /\b((?:[a-z]+\()+)(\d+),([^()]*)\)/g;
/** A table's only row: key, then a small id and a short string (68 + length). */
const SINGLE_ROW_NAME = /^[\x01-\x7f]\x00?[\x31-\x37]([\x45-\x63])/;

/**
 * Extracts the wallet's policy and cosigner keys from a Sparrow wallet file.
 * Throws a readable error for encrypted files, non-multisig wallets and
 * files holding more than one wallet.
 */
export function parseSparrowFile(bytes: Uint8Array, fileName?: string): SparrowWallet {
  if (isEncryptedSparrowFile(bytes)) {
    throw new Error(
      'This Sparrow wallet file is password protected. In Sparrow, use File › Export Wallet › Output Descriptor and import that instead.'
    );
  }
  if (!isSparrowFile(bytes)) throw new Error('This is not a Sparrow wallet file.');

  const chunks = findChunks(bytes);
  const newest = [...chunks.values()].sort((a, b) => b.version - a.version)[0];
  if (!newest || newest.root === 0n) throw new Error('This Sparrow wallet file is empty or damaged.');

  const budget = { pages: 0 };
  const keys = new Map<string, SparrowWallet['keys'][number]>();
  const policies = new Map<string, number>();
  const names: string[] = [];

  try {
    // The layout map lists the root page of every other map (H2 table or index).
    const roots: bigint[] = [];
    walk(bytes, chunks, newest.root, budget, (page) => {
      const r = new Reader(page.data, 0, page.data.length);
      const mapKeys: string[] = [];
      for (let i = 0; i < page.keyCount; i++) mapKeys.push(r.string());
      for (let i = 0; i < page.keyCount; i++) {
        const value = r.string();
        if (mapKeys[i].startsWith('root.')) roots.push(BigInt(`0x${value}`));
      }
    });

    for (const root of roots) {
      walk(bytes, chunks, root, budget, (page) => {
        const text = latin1(page.data, 0, page.data.length);
        let named = false; // a keystore or policy row, whose leading string is not the wallet's name
        for (const row of text.matchAll(KEYSTORE_ROW)) {
          named = true;
          const [, fingerprint, path, xpub] = row;
          if (keys.has(xpub)) continue;
          keys.set(xpub, { label: labelBefore(text, row.index), fingerprint: fingerprint.toLowerCase(), path, xpub });
        }
        for (const pol of text.matchAll(POLICY)) {
          if (!/multi\($/.test(pol[1])) continue;
          named = true;
          policies.set(`${pol[1]}${pol[2]}`, pol[3].split(',').length);
        }
        // The wallet table holds one row, opening with the wallet's name.
        const single = page.keyCount === 1 && !named && text.match(SINGLE_ROW_NAME);
        if (single) {
          const len = single[1].charCodeAt(0) - 68;
          const candidate = text.slice(single[0].length, single[0].length + len);
          if (candidate.length === len && /^[\x20-\x7e]+$/.test(candidate)) names.push(candidate);
        }
      });
    }
  } catch (e: any) {
    throw new Error(`Could not read this Sparrow wallet file. ${e?.message ?? e}`);
  }

  if (keys.size === 0) throw new Error('No cosigner keys were found in this Sparrow wallet file.');
  if (policies.size > 1) {
    throw new Error(
      'This Sparrow file holds more than one wallet. In Sparrow, use File › Export Wallet › Output Descriptor and import that instead.'
    );
  }
  const policy = [...policies.keys()][0];
  if (!policy) throw new Error('This Sparrow wallet is not a multisig wallet.');
  if (policies.get(policy) !== keys.size) {
    throw new Error(
      'This Sparrow file holds more than one wallet. In Sparrow, use File › Export Wallet › Output Descriptor and import that instead.'
    );
  }
  const shape = policy.match(/^(.*\()(\d+)$/)!;
  if (shape[1] !== 'wsh(sortedmulti(') {
    throw new Error(
      `This Sparrow wallet is ${shape[1]}…)) — only wsh(sortedmulti(…)) (native segwit multisig) is supported.`
    );
  }
  // Sparrow names a wallet after its file, so the file name settles any doubt.
  const base = fileName?.replace(/\.mv(\.db)?$/i, '') ?? '';
  const name = names.find((n) => base.startsWith(n)) ?? (names.length === 1 ? names[0] : undefined);
  return { name, m: parseInt(shape[2], 10), keys: [...keys.values()] };
}

/**
 * The keystore's label sits just before its fingerprint in the row, as a
 * short string prefixed by (68 + length). Best effort — undefined if the
 * bytes there do not look like one.
 */
function labelBefore(text: string, fingerprintIndex: number): string | undefined {
  // Skip the fingerprint's own length byte, then look back for the label.
  for (let gap = 1; gap <= 6; gap++) {
    const end = fingerprintIndex - gap;
    for (let len = 1; len <= 31 && end - len - 1 >= 0; len++) {
      if (text.charCodeAt(end - len - 1) !== 68 + len) continue;
      const label = text.slice(end - len, end);
      if (/^[\x20-\x7e]+$/.test(label)) return label;
    }
  }
  return undefined;
}
