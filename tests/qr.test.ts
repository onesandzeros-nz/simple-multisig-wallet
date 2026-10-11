import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UR, UREncoder } from '@ngraveio/bc-ur';
import * as bs58check from 'bs58check';
import { Buffer } from 'buffer';
import { createQrAssembler } from '../src/lib/qrParts';
import { createPsbtUrEncoder, urFrameCount } from '../src/lib/qrExport';
import { buildPsbt } from '../src/lib/wallet';
import { makeSnapshot, DEST_MAINNET } from './helpers';
import { deriveAddress, walletDescriptor } from '../src/lib/bitcoin';
import { encodeCbor, decodeCbor, Tagged } from '../src/lib/cbor';
import {
  cryptoAccountToText,
  cryptoHdkeyToKeyExpression,
  cryptoOutputToDescriptor,
  cryptoOutputToText,
} from '../src/lib/cryptoOutput';
import { parseKeyImportText } from '../src/lib/keyImport';
import { parseWalletImportText } from '../src/lib/walletImport';
import { MultisigWallet } from '../src/lib/types';
import { MNEMONICS, makeWallet } from './helpers';

const wallet = makeWallet(2, MNEMONICS.slice(0, 3));
const descriptor = walletDescriptor(wallet);

/** Build the BCR-2020-010 crypto-output CBOR exactly as Sparrow exports it. */
function cryptoOutputCbor(w: MultisigWallet, multisigTag: 406 | 407 = 407): Buffer {
  const keys = w.cosigners.map((c) => {
    const raw = Buffer.from(bs58check.decode(c.xpub));
    const depth = raw[4];
    const parentFp = raw.readUInt32BE(5);
    const chainCode = Buffer.from(raw.subarray(13, 45));
    const keyData = Buffer.from(raw.subarray(45, 78));
    // origin components: pairs of [index, hardened] from the path
    const components: any[] = [];
    for (const step of c.path.replace(/^m\//, '').split('/')) {
      components.push(parseInt(step, 10), step.endsWith("'"));
    }
    const hdkey = new Map<number, any>([
      [3, keyData],
      [4, chainCode],
      [6, new Tagged(304, new Map<number, any>([
        [1, components],
        [2, parseInt(c.fingerprint, 16)],
        [3, depth],
      ]))],
      [8, parentFp],
    ]);
    if (w.network === 'testnet') {
      hdkey.set(5, new Tagged(305, new Map<number, any>([[2, 1]])));
    }
    return new Tagged(303, hdkey);
  });
  const multisig = new Tagged(multisigTag, new Map<number, any>([[1, w.m], [2, keys]]));
  return encodeCbor(new Tagged(401, multisig));
}

describe('QR assembly', () => {
  it('passes a single plain QR straight through', () => {
    const asm = createQrAssembler();
    const result = asm.receive(descriptor);
    assert.ok(result.done);
    assert.equal(result.text, descriptor);
  });

  it('assembles Specter-style pNofM parts, out of order and with duplicates', () => {
    const third = Math.ceil(descriptor.length / 3);
    const chunks = [descriptor.slice(0, third), descriptor.slice(third, 2 * third), descriptor.slice(2 * third)];
    const asm = createQrAssembler();
    assert.equal(asm.receive(`p2of3 ${chunks[1]}`).done, false);
    assert.equal(asm.receive(`p2of3 ${chunks[1]}`).done, false); // duplicate frame
    const after2 = asm.receive(`p1of3 ${chunks[0]}`);
    assert.equal(after2.done, false);
    assert.match(after2.progress!, /2 of 3/);
    const final = asm.receive(`p3of3 ${chunks[2]}`);
    assert.ok(final.done);
    assert.equal(final.text, descriptor);
  });

  it('decodes a BC-UR animated transfer (ur:bytes fountain frames)', () => {
    const message = Buffer.from(descriptor, 'utf8');
    const ur = UR.fromBuffer(message);
    const encoder = new UREncoder(ur, 40); // small fragments → many frames
    const asm = createQrAssembler();
    let result;
    // Fountain codes may need more frames than the pure part count.
    for (let i = 0; i < 100; i++) {
      result = asm.receive(encoder.nextPart());
      if (result.done) break;
    }
    assert.ok(result?.done, 'UR transfer never completed');
    assert.equal(result!.text, descriptor);
    assert.equal(parseWalletImportText(result!.text!).m, 2);
  });

  it('a single-frame UR also decodes', () => {
    const ur = UR.fromBuffer(Buffer.from('Policy: 2 of 2', 'utf8'));
    const encoder = new UREncoder(ur, 10_000);
    const result = createQrAssembler().receive(encoder.nextPart());
    assert.ok(result.done);
    assert.equal(result.text, 'Policy: 2 of 2');
  });

  it('decodes a Sparrow-style ur:crypto-output descriptor QR', () => {
    const payload = cryptoOutputCbor(wallet);
    const ur = new UR(payload, 'crypto-output');
    const encoder = new UREncoder(ur, 10_000); // single frame
    const result = createQrAssembler().receive(encoder.nextPart());
    assert.ok(result.done);
    const parsed = parseWalletImportText(result.text!);
    assert.equal(parsed.m, 2);
    assert.equal(parsed.n, 3);
    const imported: MultisigWallet = { ...wallet, cosigners: parsed.cosigners };
    assert.equal(deriveAddress(imported, 0, 0).address, deriveAddress(wallet, 0, 0).address);
    assert.deepEqual(
      parsed.cosigners.map((c) => c.fingerprint).sort(),
      wallet.cosigners.map((c) => c.fingerprint).sort()
    );
  });

  it('decodes a multi-frame animated crypto-output transfer', () => {
    const testnet = makeWallet(2, MNEMONICS.slice(0, 2), 'testnet');
    const encoder = new UREncoder(new UR(cryptoOutputCbor(testnet), 'crypto-output'), 40);
    const asm = createQrAssembler();
    let result;
    for (let i = 0; i < 100; i++) {
      result = asm.receive(encoder.nextPart());
      if (result.done) break;
    }
    assert.ok(result?.done, 'transfer never completed');
    const parsed = parseWalletImportText(result!.text!);
    assert.equal(parsed.network, 'testnet');
    const imported: MultisigWallet = { ...testnet, cosigners: parsed.cosigners };
    assert.equal(deriveAddress(imported, 0, 0).address, deriveAddress(testnet, 0, 0).address);
  });

  it('rejects unsorted multi() and non-P2WSH crypto-outputs with clear messages', () => {
    assert.throws(() => cryptoOutputToDescriptor(cryptoOutputCbor(wallet, 406)), /sortedmulti/);
    const shWrapped = encodeCbor(new Tagged(400, new Tagged(407, new Map<number, any>([[1, 2], [2, []]]))));
    assert.throws(() => cryptoOutputToDescriptor(shWrapped), /P2WSH/);
  });

  it('CBOR codec round-trips the structures it emits', () => {
    const payload = cryptoOutputCbor(wallet);
    const decoded = decodeCbor(payload);
    assert.equal(decoded.tag, 401);
    assert.deepEqual(encodeCbor(decoded), payload);
  });

  it('rejects mixing transfer types mid-scan', () => {
    const asm = createQrAssembler();
    asm.receive('p1of2 hello');
    assert.throws(() => asm.receive('ur:bytes/whatever'), /different transfer/i);
  });

  it('rejects mismatched part counts', () => {
    const asm = createQrAssembler();
    asm.receive('p1of2 hello');
    assert.throws(() => asm.receive('p1of3 hello'), /different transfer/i);
  });

  it('ignores stray plain frames during a numbered transfer', () => {
    const asm = createQrAssembler();
    asm.receive('p1of2 hello');
    const stray = asm.receive('some unrelated qr');
    assert.equal(stray.done, false);
    const final = asm.receive('p2of2 world');
    assert.ok(final.done);
    assert.equal(final.text, 'helloworld');
  });
});

describe('PSBT over animated QR', () => {
  const psbtWallet = makeWallet(2, MNEMONICS.slice(0, 3));
  const built = buildPsbt(psbtWallet, makeSnapshot(psbtWallet, [200_000]), DEST_MAINNET, 120_000, 5, false);
  const base64 = built.psbt.toBase64();

  it('round-trips a real PSBT through crypto-psbt frames', () => {
    const encoder = createPsbtUrEncoder(base64);
    assert.ok(urFrameCount(encoder) > 1, 'a real PSBT should need several frames');

    const asm = createQrAssembler();
    let result;
    for (let i = 0; i < 200; i++) {
      const frame = encoder.nextPart();
      assert.match(frame, /^ur:crypto-psbt\//, 'frames must be crypto-psbt');
      result = asm.receive(frame);
      if (result.done) break;
    }
    assert.ok(result?.done, 'transfer never completed');
    assert.equal(result!.text, base64);
  });

  it('scanners tolerate the uppercase form QR encoders produce', () => {
    const encoder = createPsbtUrEncoder(base64);
    const asm = createQrAssembler();
    let result;
    for (let i = 0; i < 200; i++) {
      result = asm.receive(encoder.nextPart().toUpperCase());
      if (result.done) break;
    }
    assert.equal(result!.text, base64);
  });

  it('a tiny payload still produces a usable single-frame sequence', () => {
    const encoder = createPsbtUrEncoder(Buffer.from('psbt-ish').toString('base64'), 10_000);
    assert.equal(urFrameCount(encoder), 1);
    const result = createQrAssembler().receive(encoder.nextPart());
    assert.ok(result.done);
    assert.equal(Buffer.from(result.text!, 'base64').toString(), 'psbt-ish');
  });

  it('refuses to build frames from nothing', () => {
    assert.throws(() => createPsbtUrEncoder(''), /nothing to show/i);
  });
});

describe('single-key QR exports (Jade, Keystone, Passport)', () => {
  const key = wallet.cosigners[0];

  /** A BCR-2020-007 crypto-hdkey for one account key. */
  function hdkeyMap(): Map<number, any> {
    const raw = Buffer.from(bs58check.decode(key.xpub));
    const components: any[] = [];
    for (const step of key.path.replace(/^m\//, '').split('/')) {
      components.push(parseInt(step, 10), step.endsWith("'"));
    }
    return new Map<number, any>([
      [3, Buffer.from(raw.subarray(45, 78))],
      [4, Buffer.from(raw.subarray(13, 45))],
      [6, new Tagged(304, new Map<number, any>([
        [1, components],
        [2, parseInt(key.fingerprint, 16)],
        [3, raw[4]],
      ]))],
      [8, raw.readUInt32BE(5)],
    ]);
  }

  it('reads a bare ur:crypto-hdkey into an importable key', () => {
    const encoder = new UREncoder(new UR(encodeCbor(hdkeyMap()), 'crypto-hdkey'), 10_000);
    const result = createQrAssembler().receive(encoder.nextPart());
    assert.ok(result.done);
    const parsed = parseKeyImportText(result.text!);
    assert.equal(parsed.xpub, key.xpub);
    assert.equal(parsed.fingerprint, key.fingerprint);
    assert.equal(parsed.path, key.path);
  });

  it('reads a wsh-wrapped single key, which used to be rejected', () => {
    // Jade wraps the key in a script type; that is not a multisig wallet.
    const wrapped = encodeCbor(new Tagged(401, new Tagged(303, hdkeyMap())));
    const parsed = parseKeyImportText(cryptoOutputToText(wrapped));
    assert.equal(parsed.xpub, key.xpub);
    // The old wallet-only path still refuses it, as it should.
    assert.throws(() => cryptoOutputToDescriptor(wrapped), /multisig/i);
  });

  it('reads a ur:crypto-account, preferring the native-segwit key', () => {
    const account = encodeCbor(
      new Map<number, any>([
        [1, parseInt(key.fingerprint, 16)],
        [2, [
          new Tagged(404, new Tagged(303, hdkeyMap())), // wpkh — not ours
          new Tagged(401, new Tagged(303, hdkeyMap())), // wsh — the one we want
        ]],
      ])
    );
    const encoder = new UREncoder(new UR(account, 'crypto-account'), 10_000);
    const result = createQrAssembler().receive(encoder.nextPart());
    assert.ok(result.done);
    assert.equal(parseKeyImportText(result.text!).xpub, key.xpub);
  });

  it('survives being split across an animated sequence', () => {
    const encoder = new UREncoder(new UR(encodeCbor(hdkeyMap()), 'crypto-hdkey'), 30);
    const asm = createQrAssembler();
    let result;
    for (let i = 0; i < 100; i++) {
      result = asm.receive(encoder.nextPart());
      if (result.done) break;
    }
    assert.ok(result?.done, 'animated key transfer never completed');
    assert.equal(parseKeyImportText(result!.text!).xpub, key.xpub);
  });

  it('still refuses a key QR with no extended key in it', () => {
    const rawPubkeyOnly = new Map<number, any>([[3, Buffer.alloc(33, 2)]]);
    assert.throws(() => cryptoHdkeyToKeyExpression(encodeCbor(rawPubkeyOnly)), /raw public key/i);
  });
});
