import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveAddress, walletDescriptor } from '../src/lib/bitcoin';
import {
  parseBsms,
  parseWalletImportText,
  parseWalletJson,
  ParsedWallet,
  walletImportTextFromBytes,
} from '../src/lib/walletImport';
import { isSparrowFile, parseSparrowFile } from '../src/lib/sparrowFile';
import { MultisigWallet } from '../src/lib/types';
import { MNEMONICS, makeWallet } from './helpers';

function asWallet(parsed: ParsedWallet): MultisigWallet {
  return { ...parsed, id: 'imported', kind: 'private', name: parsed.name ?? '', scriptType: 'P2WSH', createdAt: 0 };
}

function addresses(wallet: MultisigWallet): string[] {
  return [deriveAddress(wallet, 0, 0).address, deriveAddress(wallet, 0, 1).address, deriveAddress(wallet, 1, 0).address];
}

const wallet = makeWallet(2, MNEMONICS.slice(0, 3));
const other = makeWallet(2, MNEMONICS.slice(2, 5));
const multipath = walletDescriptor(wallet);
const body = multipath.split('#')[0];

describe('BSMS import', () => {
  const bsms = (descriptor: string, paths = '/0/*,/1/*', address = deriveAddress(wallet, 0, 0).address) =>
    ['BSMS 1.0', descriptor, paths, address].join('\n') + '\n';

  it('imports a Sparrow-style record (<0;1>/* keys)', () => {
    for (const parsed of [parseBsms(bsms(body)), parseWalletImportText(bsms(body)), parseWalletImportText(bsms(multipath))]) {
      assert.equal(parsed.m, 2);
      assert.equal(parsed.n, 3);
      assert.deepEqual(addresses(asWallet(parsed)), addresses(wallet));
      assert.deepEqual(parsed.cosigners.map((c) => c.fingerprint), wallet.cosigners.map((c) => c.fingerprint));
    }
  });

  it('imports a BIP-129 record (/** keys, CRLF line endings)', () => {
    const text = bsms(body.replaceAll('/<0;1>/*', '/**')).replaceAll('\n', '\r\n');
    assert.deepEqual(addresses(asWallet(parseWalletImportText(text))), addresses(wallet));
  });

  it('accepts "No path restrictions" and a record without an address', () => {
    assert.equal(parseBsms(bsms(body, 'No path restrictions')).n, 3);
    assert.equal(parseBsms(`BSMS 1.0\n${body}\n/0/*,/1/*`).n, 3);
  });

  it('refuses a first address that the descriptor does not produce', () => {
    assert.throws(() => parseBsms(bsms(body, '/0/*,/1/*', deriveAddress(other, 0, 0).address)), /does not match/);
  });

  it('refuses unusual paths, other versions and non-BSMS text', () => {
    assert.throws(() => parseBsms(bsms(body, '/2/*,/3/*')), /address paths/);
    assert.throws(() => parseBsms(bsms(body).replace('BSMS 1.0', 'BSMS 2.0')), /version 2\.0/);
    assert.throws(() => parseBsms(body), /not a BSMS/);
    assert.throws(() => parseBsms('BSMS 1.0\n'), /no descriptor/);
  });
});

describe('Bitcoin Core import', () => {
  const receive = walletDescriptor(wallet, 0);
  const change = walletDescriptor({ ...wallet, cosigners: [...wallet.cosigners].reverse() }, 1);
  const file = [
    '# Receive and change descriptor:',
    multipath,
    '',
    '',
    '# Receive descriptor:',
    receive,
    '',
    '# Change descriptor:',
    change,
    '',
  ].join('\n');

  it("imports Sparrow's Bitcoin Core export (comments, three descriptors)", () => {
    const parsed = parseWalletImportText(file);
    assert.equal(parsed.m, 2);
    assert.deepEqual(addresses(asWallet(parsed)), addresses(wallet));
  });

  it('imports receive and change descriptors on their own lines', () => {
    assert.deepEqual(addresses(asWallet(parseWalletImportText(`${receive}\n${change}`))), addresses(wallet));
  });

  it('still verifies each checksum', () => {
    assert.throws(() => parseWalletImportText(file.replace(/#[a-z0-9]{8}\n/, '#qqqqqqqq\n')), /checksum/);
  });

  it('refuses descriptors of different wallets in one file', () => {
    assert.throws(() => parseWalletImportText(`${receive}\n${walletDescriptor(other, 1)}`), /different wallets/);
    const threshold = walletDescriptor({ ...wallet, m: 3 }, 1);
    assert.throws(() => parseWalletImportText(`${receive}\n${threshold}`), /different wallets/);
  });

  it('imports listdescriptors / importdescriptors JSON', () => {
    const list = [
      { desc: receive, active: true, internal: false, timestamp: 'now' },
      { desc: change, active: true, internal: true, timestamp: 'now' },
    ];
    const listed = parseWalletImportText(JSON.stringify({ wallet_name: 'Vault', descriptors: list }));
    assert.equal(listed.name, 'Vault');
    assert.deepEqual(addresses(asWallet(listed)), addresses(wallet));
    assert.deepEqual(addresses(asWallet(parseWalletImportText(JSON.stringify(list, null, 2)))), addresses(wallet));
    assert.throws(() => parseWalletJson('{"descriptors": []}'), /no descriptors/);
  });
});

// ---------------------------------------------------------------------------
// A minimal writer for H2's MVStore file format, laid out the way Sparrow's
// wallet database is: one map per table, rows as H2 encodes them.
// ---------------------------------------------------------------------------

const BLOCK = 4096;
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
function varInt(n: number): Uint8Array {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Uint8Array.from(out);
}
const mvString = (s: string) => concat([varInt(s.length), ascii(s)]);
/** An H2 row value: short strings carry their length in the type byte. */
const rowString = (s: string) =>
  s.length < 32 ? concat([Uint8Array.of(68 + s.length), ascii(s)]) : concat([Uint8Array.of(13), varInt(s.length), ascii(s)]);

/** Greedy LZF, emitting back-references so the reader's expansion is exercised. */
function lzf(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  let literals: number[] = [];
  const flush = () => {
    for (let i = 0; i < literals.length; i += 32) {
      const run = literals.slice(i, i + 32);
      out.push(run.length - 1, ...run);
    }
    literals = [];
  };
  let i = 0;
  while (i < input.length) {
    let bestLen = 0;
    let bestOff = 0;
    for (let j = Math.max(0, i - 8191); j < i; j++) {
      let len = 0;
      while (len < 264 && i + len < input.length && input[j + len] === input[i + len]) len++;
      if (len > bestLen) {
        bestLen = len;
        bestOff = i - j - 1;
      }
    }
    if (bestLen >= 3) {
      flush();
      const l = bestLen - 2;
      if (l < 7) out.push((l << 5) | (bestOff >> 8), bestOff & 255);
      else out.push((7 << 5) | (bestOff >> 8), l - 7, bestOff & 255);
      i += bestLen;
    } else {
      literals.push(input[i++]);
    }
  }
  flush();
  return Uint8Array.from(out);
}

class ChunkWriter {
  private parts: Uint8Array[] = [];
  private length = 256; // pages start after the header
  constructor(
    readonly id: number,
    readonly block: number
  ) {}

  private add(mapId: number, keyCount: number, type: number, head: Uint8Array, data: Uint8Array, compress: boolean): bigint {
    let payload = data;
    const packed = compress ? lzf(data) : data;
    // Like H2, keep a page compressed only when that makes it smaller.
    if (packed.length < data.length) {
      payload = concat([varInt(data.length - packed.length), packed]);
      type |= 2;
    }
    const rest = concat([Uint8Array.of(0, 0), varInt(this.parts.length), varInt(mapId), varInt(keyCount), Uint8Array.of(type), head, payload]);
    const page = new Uint8Array(4 + rest.length);
    new DataView(page.buffer).setInt32(0, page.length);
    page.set(rest, 4);
    const pos = (BigInt(this.id) << 38n) | (BigInt(this.length) << 6n) | BigInt(type & 1);
    this.parts.push(page);
    this.length += page.length;
    return pos;
  }

  leaf(mapId: number, keyCount: number, data: Uint8Array, compress = true): bigint {
    return this.add(mapId, keyCount, 0, new Uint8Array(0), data, compress);
  }

  node(mapId: number, children: bigint[]): bigint {
    const head = new Uint8Array(children.length * 9);
    const view = new DataView(head.buffer);
    children.forEach((c, i) => view.setBigUint64(i * 8, c));
    head.fill(1, children.length * 8); // per-child entry counts
    // One separator key per child but the last.
    return this.add(mapId, children.length - 1, 1, head, Uint8Array.from(children.slice(1), (_, i) => i + 2), false);
  }

  layout(roots: Record<number, bigint>): bigint {
    const entries = Object.entries(roots).map(([map, pos]) => [`root.${Number(map).toString(16)}`, pos.toString(16)]);
    entries.unshift(['chunk.1', 'chunk:1,block:2,len:1,version:1'], ['meta.id', '1']);
    return this.leaf(0, entries.length, concat([...entries.map(([k]) => mvString(k)), ...entries.map(([, v]) => mvString(v))]));
  }

  bytes(root: bigint, version: number): Uint8Array {
    const blocks = Math.ceil(this.length / BLOCK);
    const out = new Uint8Array(blocks * BLOCK);
    const header = `chunk:${this.id.toString(16)},block:${this.block.toString(16)},len:${blocks.toString(16)},root:${root.toString(16)},version:${version.toString(16)}`;
    out.set(ascii(header.padEnd(255, ' ') + '\n'));
    out.set(concat(this.parts), 256);
    return out;
  }
}

interface Keystore {
  label: string;
  fingerprint: string;
  path: string;
  xpub: string;
}

const keystoreRow = (id: number, k: Keystore) =>
  concat([ascii(String(id)), rowString(k.label), ascii('#!'), rowString(k.fingerprint), rowString(k.path), rowString(k.xpub), Uint8Array.of(0, 0, 0x31)]);
const keystoreLeaf = (firstId: number, keys: Keystore[]) =>
  concat([Uint8Array.from(keys, (_, i) => firstId + i), Uint8Array.of(0), ...keys.map((k, i) => keystoreRow(firstId + i, k))]);
const walletLeaf = (name: string) => concat([Uint8Array.of(1, 0), ascii('1'), rowString(name), Uint8Array.of(0, 0x20, 0x21, 0x27)]);
const policyLeaf = (miniscript: string) => concat([Uint8Array.of(1, 0), ascii('1'), rowString('Default'), rowString(miniscript)]);

const fileHeader = () => {
  const block = new Uint8Array(BLOCK);
  block.set(ascii('H:2,block:2,blockSize:1000,chunk:1,clean:1,created:1a1c8872d7a,format:2,version:3,fletcher:c668720f\n'));
  return concat([block, block]);
};

const keystores: Keystore[] = wallet.cosigners.map((c, i) => ({
  label: ['Alice', 'Bob CCQ', 'Carol'][i],
  fingerprint: c.fingerprint,
  path: c.path,
  xpub: c.xpub,
}));

function sparrowFile(opts: { name?: string; policy?: string; keys?: Keystore[] } = {}): Uint8Array {
  const keys = opts.keys ?? keystores;
  const chunk = new ChunkWriter(1, 2);
  // The keystore table is split over two leaves under a node, as larger tables are.
  const keystoreRoot = chunk.node(0x64, [chunk.leaf(0x64, 2, keystoreLeaf(1, keys.slice(0, 2))), chunk.leaf(0x64, keys.length - 2, keystoreLeaf(3, keys.slice(2)))]);
  const root = chunk.layout({
    0x4e: chunk.leaf(0x4e, 1, policyLeaf(opts.policy ?? `wsh(sortedmulti(2,${keys.map((k) => k.label.replace(/ /g, '')).join(',')}))`), false),
    0x53: 0n, // an empty table
    0x5c: chunk.leaf(0x5c, 1, walletLeaf(opts.name ?? 'Family Vault')),
    0x64: keystoreRoot,
  });
  return concat([fileHeader(), chunk.bytes(root, 3)]);
}

describe('Sparrow wallet file import', () => {
  it('reads the policy, keys, labels and name out of the database', () => {
    const file = sparrowFile();
    assert.ok(isSparrowFile(file));
    const sparrow = parseSparrowFile(file, 'Family Vault.mv.db');
    assert.equal(sparrow.name, 'Family Vault');
    assert.equal(sparrow.m, 2);
    assert.deepEqual(sparrow.keys, keystores);

    const parsed = parseWalletImportText(walletImportTextFromBytes(file, 'whatever.mv.db'));
    assert.equal(parsed.name, 'Family Vault');
    assert.equal(parsed.n, 3);
    assert.deepEqual(parsed.cosigners.map((c) => c.name), ['Alice', 'Bob CCQ', 'Carol']);
    assert.deepEqual(parsed.cosigners.map((c) => c.path), wallet.cosigners.map((c) => c.path));
    assert.deepEqual(addresses(asWallet(parsed)), addresses(wallet));
  });

  it('reads only the newest version of the store', () => {
    // Version 1 held a different third key; version 2 rewrote the keystore
    // table in a new chunk and still points at the old wallet and policy pages.
    const stale = other.cosigners[2];
    const old = new ChunkWriter(1, 2);
    const policy = old.leaf(0x4e, 1, policyLeaf('wsh(sortedmulti(2,Alice,BobCCQ,Carol))'));
    const name = old.leaf(0x5c, 1, walletLeaf('Family Vault'));
    const oldKeys = old.leaf(0x64, 3, keystoreLeaf(1, [...keystores.slice(0, 2), { ...keystores[2], fingerprint: stale.fingerprint, xpub: stale.xpub }]));
    const oldBytes = old.bytes(old.layout({ 0x4e: policy, 0x5c: name, 0x64: oldKeys }), 1);

    const fresh = new ChunkWriter(2, 2 + oldBytes.length / BLOCK);
    const newKeys = fresh.leaf(0x64, 3, keystoreLeaf(1, keystores));
    const freshBytes = fresh.bytes(fresh.layout({ 0x4e: policy, 0x5c: name, 0x64: newKeys }), 2);

    const sparrow = parseSparrowFile(concat([fileHeader(), oldBytes, freshBytes]));
    assert.equal(sparrow.name, 'Family Vault');
    assert.deepEqual(sparrow.keys.map((k) => k.xpub), keystores.map((k) => k.xpub));
  });

  it('passes ordinary text files through untouched', () => {
    const bytes = new TextEncoder().encode(`﻿${multipath}\n`);
    assert.equal(walletImportTextFromBytes(bytes, 'wallet.txt'), `${multipath}\n`);
  });

  it('explains what it cannot import', () => {
    assert.throws(() => walletImportTextFromBytes(ascii('H2encrypt\n' + 'x'.repeat(8000))), /password protected/);
    assert.throws(() => parseSparrowFile(sparrowFile({ policy: 'sh(wsh(sortedmulti(2,Alice,BobCCQ,Carol)))' })), /only wsh\(sortedmulti/);
    assert.throws(() => parseSparrowFile(sparrowFile({ policy: 'wsh(multi(2,Alice,BobCCQ,Carol))' })), /only wsh\(sortedmulti/);
    assert.throws(() => parseSparrowFile(sparrowFile({ policy: 'wpkh(Alice)' })), /not a multisig/);
    assert.throws(() => parseSparrowFile(sparrowFile({ policy: 'wsh(sortedmulti(2,Alice,Bob))' })), /more than one wallet/);
    assert.throws(() => parseSparrowFile(ascii('not a database')), /not a Sparrow/);
  });

  it('fails cleanly on a damaged file', () => {
    const file = sparrowFile();
    assert.throws(() => parseSparrowFile(file.subarray(0, 2 * BLOCK + 600)), /Could not read|empty or damaged/);
    assert.throws(() => parseSparrowFile(file.subarray(0, 2 * BLOCK)), /empty or damaged/);
    const garbled = file.slice();
    garbled.fill(0xff, 2 * BLOCK + 256, 2 * BLOCK + 700);
    assert.throws(() => parseSparrowFile(garbled), /Could not read|No cosigner keys/);
  });
});
