import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ecc from '@bitcoinerlab/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import * as bitcoin from 'bitcoinjs-lib';
import { Buffer } from 'buffer';
import {
  LedgerDevice,
  LedgerStatusError,
  ledgerModel,
  multisigPolicy,
  parseAppAndVersion,
  parseYieldedSignature,
  policyId,
  policyKey,
  policyName,
  serialisePolicy,
} from '../src/lib/hw/ledger';
import {
  ApduChannel,
  buildApdu,
  checkStatus,
  describeStatus,
  frameApdu,
  ResponseAssembler,
} from '../src/lib/hw/ledger/framing';
import { ClientCommandInterpreter } from '../src/lib/hw/ledger/interpreter';
import { decodeVarint, encodeVarint, leafHash, MerkleMap, MerkleTree } from '../src/lib/hw/ledger/merkle';
import { psbtBytesToV2Maps, psbtToV2Maps } from '../src/lib/hw/ledger/psbt';
import { ledgerMemoryKeys } from '../src/lib/hw/ledger';
import { PacketTransport, TransportTimeout, UserCancelled } from '../src/lib/hw/types';
import { accountXpub, bip48Path, deriveAddress, masterFingerprint } from '../src/lib/bitcoin';
import {
  attachSignatures,
  finalizeAndExtract,
  parsePsbt,
  signingJobsFor,
  signPsbtWithMnemonic,
  summarisePsbt,
} from '../src/lib/wallet';
import { MultisigWallet } from '../src/lib/types';
import { DEST_MAINNET, makeWallet, MNEMONICS } from './helpers';
import {
  connectSpeculos,
  conversations,
  FakeAppOptions,
  FakeLedgerApp,
  fundedSpend,
  mapMemory,
  packetTransport,
  recordingPrompts,
  rootFromProof,
} from './hwLedgerHarness';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const digest = (lines: string[]) => hex(sha256(Buffer.from(lines.join('\n'), 'utf8')));

const DEST_TESTNET = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';

/** A driver wired to a fake app, with everything a test wants to look at afterwards. */
function connect(options: Partial<FakeAppOptions> = {}, memory = mapMemory()) {
  const app = new FakeLedgerApp({ mnemonic: MNEMONICS[0], ...options });
  const prompts = recordingPrompts();
  const transport = packetTransport(app.exchange);
  const device = new LedgerDevice(transport, { prompts, memory }, { productId: 0x5011 });
  return { app, prompts, memory, transport, device };
}

/** Adds a device's signatures to the stored draft, then a second cosigner's, and extracts the transaction. */
function finish(
  stored: string,
  wallet: MultisigWallet,
  signer: number,
  signatures: { index: number; pubkey: Buffer; signature: Buffer }[],
  others: number[]
): bitcoin.Transaction {
  const jobs = signingJobsFor(stored, wallet.cosigners[signer].fingerprint, wallet.network);
  assert.equal(signatures.length, jobs.length, 'one signature per input');
  const base64 = attachSignatures(
    stored,
    wallet.network,
    jobs.map((job) => {
      const mine = signatures.find((s) => s.index === job.index)!;
      assert.ok(mine, `input ${job.index} signed`);
      assert.equal(hex(mine.pubkey), hex(job.pubkey));
      return { job, signature: mine.signature };
    })
  );
  const psbt = parsePsbt(base64, wallet.network);
  for (const other of others) signPsbtWithMnemonic(psbt, MNEMONICS[other], wallet);
  assert.ok(summarisePsbt(psbt, wallet).complete);
  return bitcoin.Transaction.fromHex(finalizeAndExtract(psbt));
}

// ---------------------------------------------------------------------------

describe('Ledger USB framing', () => {
  it('puts a short command in one zero-padded packet', () => {
    const packets = frameApdu(Buffer.from('b001000000', 'hex'));
    assert.equal(packets.length, 1);
    assert.equal(packets[0].length, 64);
    // channel 0101, tag 05, sequence 0000, length 0005, then the APDU
    assert.equal(hex(packets[0].subarray(0, 12)), '01010500000005b001000000');
    assert.ok(packets[0].subarray(12).every((b) => b === 0));
  });

  it('splits at 59 bytes of payload and numbers the packets', () => {
    // 2 bytes of length + 57 of APDU fill the first packet exactly.
    assert.equal(frameApdu(Buffer.alloc(57, 1)).length, 1);
    const two = frameApdu(Buffer.alloc(58, 1));
    assert.equal(two.length, 2);
    assert.equal(hex(two[1].subarray(0, 6)), '010105000101');
    assert.ok(two[1].subarray(6).every((b) => b === 0));

    const apdu = Buffer.from(Array.from({ length: 260 }, (_, i) => i & 0xff));
    const packets = frameApdu(apdu);
    assert.equal(packets.length, 5);
    packets.forEach((p, i) => assert.equal(p.readUInt16BE(3), i));
    const body = Buffer.concat(packets.map((p) => p.subarray(5)));
    assert.equal(body.readUInt16BE(0), 260);
    assert.equal(hex(body.subarray(2, 262)), hex(apdu));
  });

  it('honours the packet size of the endpoint', () => {
    const packets = frameApdu(Buffer.alloc(40, 9), 32);
    assert.ok(packets.every((p) => p.length === 32));
    assert.equal(packets.length, 2);
  });

  it('refuses a command that cannot be framed', () => {
    assert.throws(() => buildApdu(0xe1, 0x04, 0, 1, Buffer.alloc(256)), /too large/);
    assert.throws(() => frameApdu(Buffer.alloc(0x10000)), /too large/);
  });

  it('puts a reply back together and drops the padding', () => {
    const reply = Buffer.concat([Buffer.from(Array.from({ length: 150 }, (_, i) => i)), Buffer.from('9000', 'hex')]);
    const framed = Buffer.concat([Buffer.from([0, reply.length]), reply]);
    const assembler = new ResponseAssembler();
    let out: Buffer | null = null;
    for (let i = 0; i * 59 < framed.length; i++) {
      assert.equal(out, null);
      const packet = Buffer.alloc(64);
      packet.set([1, 1, 5, 0, i], 0);
      framed.copy(packet, 5, i * 59, (i + 1) * 59);
      out = assembler.push(Uint8Array.from(packet));
    }
    assert.equal(hex(out!), hex(reply));
  });

  it('refuses packets that are not a reply, or are out of order', () => {
    const packet = (header: number[]) => Uint8Array.from([...header, 0, 2, 0x90, 0x00, ...new Array(55).fill(0)]);
    assert.throws(() => new ResponseAssembler().push(packet([1, 2, 5, 0, 0])), /not a reply/);
    assert.throws(() => new ResponseAssembler().push(packet([1, 1, 2, 0, 0])), /not a reply/);
    assert.throws(() => new ResponseAssembler().push(packet([1, 1, 5, 0, 1])), /out of order/);
    assert.throws(() => new ResponseAssembler().push(Uint8Array.from([1, 1, 5, 0, 0, 0])), /too short/);
    assert.throws(
      () => new ResponseAssembler().push(Uint8Array.from([1, 1, 5, 0, 0, 0, 1, ...new Array(57).fill(0)])),
      /empty reply/
    );
  });
});

describe('Ledger APDU exchange', () => {
  it('sends a command and returns data and status word apart', async () => {
    const seen: string[] = [];
    const channel = new ApduChannel(
      packetTransport(async (apdu) => {
        seen.push(hex(apdu));
        return Buffer.from('deadbeef9000', 'hex');
      })
    );
    const reply = await channel.exchange(buildApdu(0xe1, 0x05, 0, 1), 1000);
    assert.deepEqual(seen, ['e105000100']);
    assert.equal(hex(reply.data), 'deadbeef');
    assert.equal(reply.sw, 0x9000);
  });

  it('carries commands and replies longer than a packet', async () => {
    const big = Buffer.from(Array.from({ length: 253 }, (_, i) => i));
    const channel = new ApduChannel(packetTransport(async (apdu) => Buffer.concat([apdu.subarray(5), Buffer.from([0xe0, 0])])));
    const reply = await channel.exchange(buildApdu(0xf8, 0x01, 0, 1, big), 1000);
    assert.equal(hex(reply.data), hex(big));
    assert.equal(reply.sw, 0xe000);
  });

  it('keeps exchanges from overlapping', async () => {
    const order: string[] = [];
    const channel = new ApduChannel(
      packetTransport(async (apdu) => {
        order.push(`start ${apdu[1]}`);
        await new Promise((resolve) => setTimeout(resolve, apdu[1] === 1 ? 30 : 0));
        order.push(`end ${apdu[1]}`);
        return Buffer.from([apdu[1], 0x90, 0x00]);
      })
    );
    const [a, b] = await Promise.all([
      channel.exchange(buildApdu(0xe1, 1, 0, 1), 1000),
      channel.exchange(buildApdu(0xe1, 2, 0, 1), 1000),
    ]);
    assert.deepEqual(order, ['start 1', 'end 1', 'start 2', 'end 2']);
    assert.equal(a.data[0], 1);
    assert.equal(b.data[0], 2);
  });

  it('never mistakes a late reply for the answer to the next command', async () => {
    let delay = 80;
    const channel = new ApduChannel(
      packetTransport(async (apdu) => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return Buffer.from([apdu[1], 0x90, 0x00]);
      })
    );
    await assert.rejects(channel.exchange(buildApdu(0xe1, 7, 0, 1), 20), (e: any) => {
      assert.ok(e instanceof TransportTimeout);
      assert.match(e.message, /did not answer in time/);
      return true;
    });
    // The answer to command 7 arrives while nobody is waiting for it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    delay = 0;
    const reply = await channel.exchange(buildApdu(0xe1, 8, 0, 1), 1000);
    assert.equal(reply.data[0], 8);
  });

  it('passes on a failure of the connection itself', async () => {
    const transport = packetTransport(async () => Buffer.from('9000', 'hex'));
    await transport.close();
    await assert.rejects(new ApduChannel(transport).exchange(buildApdu(0xe1, 5, 0, 1), 100), /unplugged/);
  });
});

describe('Ledger status words', () => {
  const reply = (sw: number, data = '') => ({ sw, data: Buffer.from(data, 'hex') });

  it('accepts success, and interruption where that is expected', () => {
    checkStatus(reply(0x9000), 'testing');
    checkStatus(reply(0xe000), 'testing', [0x9000, 0xe000]);
    assert.throws(() => checkStatus(reply(0xe000), 'testing'));
  });

  it('treats a refusal on the device as a cancellation', () => {
    assert.throws(
      () => checkStatus(reply(0x6985), 'testing'),
      (e: any) => e instanceof UserCancelled && /Rejected on the Ledger/.test(e.message)
    );
  });

  it('explains the refusals a person can do something about', () => {
    assert.match(describeStatus(0x5515, 'x'), /locked/);
    assert.match(describeStatus(0x6e00, 'x'), /Bitcoin app is not open/);
    assert.match(describeStatus(0x6d00, 'x'), /Bitcoin app is not open/);
    assert.match(describeStatus(0x6a82, 'reading a key'), /does not support reading a key/);
    assert.match(describeStatus(0xb007, 'signing'), /reopen the Bitcoin app/);
    assert.match(describeStatus(0x6faa, 'x'), /Unplug/);
  });

  it('keeps the code for anything it has no words for', () => {
    assert.throws(
      () => checkStatus(reply(0x6f42, 'abcd'), 'signing the transaction'),
      (e: any) => {
        assert.ok(e instanceof LedgerStatusError);
        assert.equal(e.sw, 0x6f42);
        assert.equal(e.detail, 0xabcd);
        assert.match(e.message, /while signing the transaction \(0x6f42\)/);
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------

describe('Ledger Merkle commitments', () => {
  it('encodes and decodes varints at every width', () => {
    const cases: [number, string][] = [
      [0, '00'],
      [0xfc, 'fc'],
      [0xfd, 'fdfd00'],
      [0xffff, 'fdffff'],
      [0x10000, 'fe00000100'],
      [0xffffffff, 'feffffffff'],
      [0x100000000, 'ff0000000001000000'],
      [2_100_000_000_000_000, 'ff0040075af0750700'],
    ];
    for (const [value, encoded] of cases) {
      assert.equal(hex(encodeVarint(value)), encoded);
      assert.deepEqual(decodeVarint(Buffer.from(`aa${encoded}bb`, 'hex'), 1), {
        value,
        next: 1 + encoded.length / 2,
      });
    }
    assert.throws(() => encodeVarint(-1));
    assert.throws(() => encodeVarint(1.5));
    assert.throws(() => decodeVarint(Buffer.from('fd00', 'hex'), 0), /Truncated/);
    assert.throws(() => decodeVarint(Buffer.from('ffffffffffffffffff', 'hex'), 0), /too large/);
  });

  // Roots computed by Ledger's own client (@ledgerhq/ledger-bitcoin 0.3.1)
  // over the elements [i, i+1] for i < n.
  it('matches the roots Ledger’s own client computes', () => {
    const roots: Record<number, string> = {
      0: '0000000000000000000000000000000000000000000000000000000000000000',
      1: 'cf7605ed1bc735f6c825554154627467e1cac9df54cee8699218ed434603c568',
      2: 'e7ac27c41f6103bc27ff1da4ed49a12831e8c7cf0bfe67a3fbfe6ce6b88ef0cb',
      3: '75bab4d7375e041be7dba5e040bf2cd358a37f2d0de06798ccac92a5071cb8fd',
      5: 'cc17e464783d9195a6bf00f6050ba40f85ebb7e043bb6a2ff45f1c3aca374d3b',
      8: '16f0fd577615602f6dd45d0ebe4516237698f2a011e326ab57fe27a37fd53b5d',
      13: 'f3e1001f2c6fabfeef74ce287a9657329eb98f3640a0d3595b3cdf912a0d6c78',
    };
    for (const [n, root] of Object.entries(roots)) {
      const elements = Array.from({ length: Number(n) }, (_, i) => Buffer.from([i, i + 1]));
      assert.equal(hex(new MerkleTree(elements).root), root, `${n} leaves`);
    }
  });

  it('separates leaves from inner nodes', () => {
    assert.equal(hex(leafHash(Buffer.from('ab', 'hex'))), hex(sha256(Buffer.from('00ab', 'hex'))));
    const [a, b] = [Buffer.from('01', 'hex'), Buffer.from('02', 'hex')];
    const expected = sha256(Buffer.concat([Buffer.from([1]), leafHash(a), leafHash(b)]));
    assert.equal(hex(new MerkleTree([a, b]).root), hex(expected));
  });

  it('gives proofs that verify, for every leaf of every size of tree', () => {
    for (let n = 1; n <= 70; n++) {
      const tree = new MerkleTree(Array.from({ length: n }, (_, i) => Buffer.from(`leaf ${i}`)));
      for (let i = 0; i < n; i++) {
        // Checked top-down by code that shares nothing with the tree's own.
        assert.equal(hex(rootFromProof(tree.leaves[i], i, n, tree.proof(i))), hex(tree.root), `${i} of ${n}`);
      }
    }
    const tree = new MerkleTree([Buffer.from('a'), Buffer.from('b')]);
    assert.throws(() => tree.proof(2), /No such leaf/);
    assert.throws(() => tree.proof(-1), /No such leaf/);
  });

  it('finds a leaf by its hash', () => {
    const tree = new MerkleTree([Buffer.from('a'), Buffer.from('b'), Buffer.from('c')]);
    assert.equal(tree.indexOf(leafHash(Buffer.from('c'))), 2);
    assert.equal(tree.indexOf(leafHash(Buffer.from('d'))), -1);
  });

  it('commits to a map by its sorted keys', () => {
    const map = new MerkleMap(
      new Map([
        ['06aa', Buffer.from('03', 'hex')],
        ['01', Buffer.from('01', 'hex')],
        ['06', Buffer.from('02', 'hex')],
      ])
    );
    assert.deepEqual(map.keys.map(hex), ['01', '06', '06aa']);
    assert.deepEqual(map.values.map(hex), ['01', '02', '03']);
    const commitment = map.commitment();
    assert.equal(commitment.length, 65);
    assert.equal(commitment[0], 3);
    assert.equal(hex(commitment.subarray(1, 33)), hex(map.keysTree.root));
    assert.equal(hex(commitment.subarray(33)), hex(map.valuesTree.root));
  });

  it('refuses a map with a repeated key', () => {
    assert.throws(
      () => new MerkleMap([[Buffer.from('01', 'hex'), Buffer.from('aa', 'hex')], [Buffer.from('01', 'hex'), Buffer.from('bb', 'hex')]]),
      /same key twice/
    );
  });
});

// ---------------------------------------------------------------------------

describe('Ledger wallet policies', () => {
  const wallet = makeWallet(2, MNEMONICS.slice(0, 3));

  it('describes a wallet as a sortedmulti template and its keys', () => {
    const policy = multisigPolicy(wallet);
    assert.equal(policy.name, 'Test wallet');
    assert.equal(policy.template, 'wsh(sortedmulti(2,@0/**,@1/**,@2/**))');
    assert.deepEqual(policy.keys, [
      "[73c5da0a/48'/0'/0'/2']xpub6DkFAXWQ2dHxq2vatrt9qyA3bXYU4ToWQwCHbf5XB2mSTexcHZCeKS1VZYcPoBd5X8yVcbXFHJR9R8UCVpt82VX1VhR28mCyxUFL4r6KFrf",
      "[b8688df1/48'/0'/0'/2']xpub6FQya7zGhR92kacYsNnjreouvnHJMpXYsUXnW6NJJAJRCKsa26TzDy4LdnGhEurr3d6y1J8PJ7EEMKQp74XTqYvmGJNogYXSKDszYHtF8mX",
      "[28645006/48'/0'/0'/2']xpub6DnEBNkSJKBYQmsbhS1sP9cNdtU5c9PLFGCjTJmxicxc13WB8zNNGQazabQpyFAGW5bV9tMko4uBxDxjUKL6dSAcx1tEbgEHtgSqyRsekh6",
    ]);
  });

  // Both values as produced by Ledger's own client for the same policy.
  it('serialises and names a policy exactly as Ledger’s own client does', () => {
    const policy = multisigPolicy(wallet);
    assert.equal(
      hex(serialisePolicy(policy)),
      '020b546573742077616c6c65742545cff6017af8edc8b6bb6cdb8634ff05e1a82a7f7962d114045d2bd666e1a16e' +
        '03877f187ced602d3b770c49c38f56610d4298f5ee12117bced136654ea3e04412'
    );
    assert.equal(hex(policyId(policy)), '8374c252d4ec041d53332e98bf7eed1018d8285a8e9290054e90b57e472dd0ab');
  });

  it('writes key origins the only way the app reads them', () => {
    const key = { fingerprint: 'DEADBEEF', path: 'm/48h/1H/0h/2h', xpub: wallet.cosigners[0].xpub };
    assert.equal(policyKey(key), `[deadbeef/48'/1'/0'/2']${key.xpub}`);
    assert.equal(policyKey({ ...key, path: 'm' }), `[deadbeef]${key.xpub}`);
    assert.equal(policyKey({ ...key, path: "m/45'/7" }), `[deadbeef/45'/7]${key.xpub}`);
    assert.throws(() => policyKey({ ...key, fingerprint: 'deadbee' }), /not a key fingerprint/);
    assert.throws(() => policyKey({ ...key, path: 'm/48x' }), /Cannot read the key path/);
    assert.throws(() => policyKey({ ...key, path: 'm/2147483648' }), /Cannot read the key path/);
    assert.throws(() => policyKey({ ...key, path: 'm/1/2/3/4/5/6/7/8/9' }), /longer than a Ledger accepts/);
  });

  it('keeps the cosigners in the wallet’s own order', () => {
    const reversed = { ...wallet, cosigners: [...wallet.cosigners].reverse() };
    const policy = multisigPolicy(reversed);
    assert.match(policy.keys[0], /^\[28645006/);
    assert.notEqual(hex(policyId(policy)), hex(policyId(multisigPolicy(wallet))));
  });

  it('turns any wallet name into one the device accepts', () => {
    const name = (n: string) => policyName({ name: n, m: 2, n: 3 });
    assert.equal(name('Family savings'), 'Family savings');
    assert.equal(name('  Épargne   famille ₿ '), 'pargne famille');
    assert.equal(name('家族'), '2 of 3 Multisig');
    assert.equal(name(''), '2 of 3 Multisig');
    assert.equal(name('x'.repeat(100)).length, 64);
    // Cutting to length must not leave a space at the end.
    assert.equal(name(`${'x'.repeat(63)} yz`), 'x'.repeat(63));
    for (const n of ['Family savings', '  Épargne   famille ₿ ', '家族', `${'x'.repeat(63)} yz`]) {
      assert.match(name(n), /^[\x21-\x7e]([\x20-\x7e]{0,62}[\x21-\x7e])?$/);
    }
  });

  it('refuses wallets a policy cannot describe', () => {
    assert.throws(() => multisigPolicy({ ...wallet, m: 4 }), /not valid/);
    assert.throws(() => multisigPolicy({ ...wallet, m: 0 }), /not valid/);
    assert.throws(() => multisigPolicy({ ...wallet, scriptType: 'P2SH' as any }), /P2WSH/);
    assert.throws(() => serialisePolicy({ name: 'x'.repeat(65), template: 'wpkh(@0/**)', keys: [] }), /too long/);
  });
});

// ---------------------------------------------------------------------------

describe('Ledger PSBT conversion', () => {
  const wallet = makeWallet(2, MNEMONICS.slice(0, 3));
  const { psbt, funding } = fundedSpend(wallet, [60000, 50000], DEST_MAINNET, 70000);
  const maps = psbtToV2Maps(psbt);
  const tx = bitcoin.Transaction.fromBuffer((psbt.data.globalMap.unsignedTx as any).toBuffer());

  it('replaces the unsigned transaction with the fields that describe it', () => {
    assert.equal(maps.global.has('00'), false);
    assert.equal(hex(maps.global.get('fb')!), '02000000');
    assert.equal(hex(maps.global.get('02')!), '02000000');
    assert.equal(hex(maps.global.get('03')!), '00000000');
    assert.equal(hex(maps.global.get('04')!), '02');
    assert.equal(hex(maps.global.get('05')!), '02');
    assert.equal(maps.inputs.length, 2);
    assert.equal(maps.outputs.length, 2);

    maps.inputs.forEach((input, i) => {
      assert.equal(hex(input.get('0e')!), hex(tx.ins[i].hash));
      assert.equal(hex(input.get('0e')!), hex(funding.getHash()));
      assert.equal(input.get('0f')!.readUInt32LE(0), i);
      assert.equal(input.get('10')!.readUInt32LE(0), 0xfffffffd);
    });
    maps.outputs.forEach((output, i) => {
      assert.equal(output.get('03')!.readUInt32LE(0), tx.outs[i].value);
      assert.equal(output.get('03')!.readUInt32LE(4), 0);
      assert.equal(hex(output.get('04')!), hex(tx.outs[i].script));
    });
  });

  it('carries every other field across untouched', () => {
    psbt.data.inputs.forEach((input, i) => {
      const map = maps.inputs[i];
      assert.equal(hex(map.get('00')!), hex(input.nonWitnessUtxo!));
      assert.equal(hex(map.get('05')!), hex(input.witnessScript!));
      const utxo = map.get('01')!;
      assert.equal(utxo.readUInt32LE(0), input.witnessUtxo!.value);
      assert.equal(hex(utxo.subarray(9)), hex(input.witnessUtxo!.script));
      for (const d of input.bip32Derivation!) {
        const value = map.get(`06${hex(d.pubkey)}`)!;
        assert.equal(hex(value.subarray(0, 4)), hex(d.masterFingerprint));
        const steps = [];
        for (let at = 4; at < value.length; at += 4) steps.push(value.readUInt32LE(at));
        assert.deepEqual(steps, [0x80000030, 0x80000000, 0x80000000, 0x80000002, 0, i]);
      }
      // previous txid, index, sequence + utxo ×2, script, three derivations
      assert.equal(map.size, 9);
    });
    // The payment has only what version 2 adds; the change also says whose it is.
    assert.equal(maps.outputs[0].size, 2);
    assert.equal(maps.outputs[1].size, 6);
    assert.equal(hex(maps.outputs[1].get('01')!), hex(psbt.data.outputs[1].witnessScript!));
  });

  it('keeps signatures already on the draft', () => {
    const signed = parsePsbt(psbt.toBase64(), 'mainnet');
    signPsbtWithMnemonic(signed, MNEMONICS[1], wallet);
    const withSig = psbtToV2Maps(signed);
    const sig = signed.data.inputs[0].partialSig![0];
    assert.equal(hex(withSig.inputs[0].get(`02${hex(sig.pubkey)}`)!), hex(sig.signature));
  });

  it('handles amounts beyond 32 bits', () => {
    const big = new bitcoin.Psbt();
    big.addInput({ hash: 'aa'.repeat(32), index: 0 });
    big.addOutput({ script: Buffer.from('0014' + '11'.repeat(20), 'hex'), value: 2_100_000_000_000_000 });
    assert.equal(hex(psbtToV2Maps(big).outputs[0].get('03')!), '0040075af0750700');
  });

  it('refuses what is not a version 0 PSBT', () => {
    assert.throws(() => psbtBytesToV2Maps(Buffer.from('hello')), /not a PSBT/);
    const bytes = psbt.toBuffer();
    assert.throws(() => psbtBytesToV2Maps(bytes.subarray(0, bytes.length - 40)), /Truncated/);
    assert.throws(() => psbtBytesToV2Maps(Buffer.concat([bytes, Buffer.from([0])])), /after its end/);
    // magic, then a global map holding only PSBT_GLOBAL_VERSION = 2
    assert.throws(() => psbtBytesToV2Maps(Buffer.from('70736274ff01fb040200000000', 'hex')), /version 0/);
    assert.throws(() => psbtBytesToV2Maps(Buffer.from('70736274ff00', 'hex')), /no transaction/);
  });
});

// ---------------------------------------------------------------------------

describe('Ledger client commands', () => {
  const GET_PREIMAGE = 0x40;
  const GET_PROOF = 0x41;
  const GET_INDEX = 0x42;
  const GET_MORE = 0xa0;
  const request = (code: number, ...parts: Uint8Array[]) => Buffer.concat([Buffer.from([code]), ...parts]);

  it('reveals a short preimage in one answer', () => {
    const interpreter = new ClientCommandInterpreter();
    const preimage = Buffer.from('some data');
    interpreter.addPreimage(preimage);
    const answer = interpreter.execute(request(GET_PREIMAGE, Buffer.from([0]), sha256(preimage)));
    assert.equal(hex(answer), hex(Buffer.concat([Buffer.from([9, 9]), preimage])));
  });

  it('sends a long preimage in pieces, a byte at a time after the first', () => {
    const interpreter = new ClientCommandInterpreter();
    const preimage = Buffer.from(Array.from({ length: 700 }, (_, i) => (i * 7) & 0xff));
    interpreter.addPreimage(preimage);
    const first = interpreter.execute(request(GET_PREIMAGE, Buffer.from([0]), sha256(preimage)));
    assert.equal(first.length, 255);
    // a three-byte varint for 700, then how much of it follows
    assert.equal(hex(first.subarray(0, 4)), 'fdbc02fb');
    let got = Buffer.from(first.subarray(4));
    while (got.length < preimage.length) {
      const more = interpreter.execute(request(GET_MORE));
      assert.ok(more.length <= 255);
      assert.equal(more[1], 1);
      assert.equal(more.length, 2 + more[0]);
      got = Buffer.concat([got, more.subarray(2)]);
    }
    assert.equal(hex(got), hex(preimage));
    assert.throws(() => interpreter.execute(request(GET_MORE)), /more data than there is/);
  });

  it('proves leaves, queueing what does not fit', () => {
    const interpreter = new ClientCommandInterpreter();
    const elements = Array.from({ length: 200 }, (_, i) => Buffer.from(`element ${i}`));
    interpreter.addList(elements);
    const tree = new MerkleTree(elements);
    for (const index of [0, 77, 199]) {
      const answer = interpreter.execute(request(GET_PROOF, tree.root, encodeVarint(200), encodeVarint(index)));
      assert.equal(hex(answer.subarray(0, 32)), hex(tree.leaves[index]));
      const proof: Buffer[] = [];
      for (let i = 0; i < answer[33]; i++) proof.push(Buffer.from(answer.subarray(34 + 32 * i, 66 + 32 * i)));
      // 200 leaves make proofs of up to eight hashes; six fit beside the leaf.
      if (answer[32] > 6) {
        assert.equal(answer[33], 6);
        const more = interpreter.execute(request(GET_MORE));
        assert.equal(more[1], 32);
        for (let i = 0; i < more[0]; i++) proof.push(Buffer.from(more.subarray(2 + 32 * i, 34 + 32 * i)));
      }
      assert.equal(proof.length, answer[32]);
      assert.equal(hex(rootFromProof(tree.leaves[index], index, 200, proof)), hex(tree.root));
    }
    // and the leaf itself is there for the asking
    const leaf = interpreter.execute(request(GET_PREIMAGE, Buffer.from([0]), tree.leaves[77]));
    assert.equal(hex(leaf.subarray(2)), hex(Buffer.concat([Buffer.from([0]), elements[77]])));
  });

  it('says where a leaf is, and says so when it is nowhere', () => {
    const interpreter = new ClientCommandInterpreter();
    const elements = [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')];
    interpreter.addList(elements);
    const root = new MerkleTree(elements).root;
    assert.equal(hex(interpreter.execute(request(GET_INDEX, root, leafHash(elements[2])))), '0102');
    assert.equal(hex(interpreter.execute(request(GET_INDEX, root, leafHash(Buffer.from('z'))))), '0000');
  });

  it('collects what the app hands back', () => {
    const counts: number[] = [];
    const interpreter = new ClientCommandInterpreter((n) => counts.push(n));
    assert.equal(interpreter.execute(Buffer.from('10aabb', 'hex')).length, 0);
    assert.equal(interpreter.execute(Buffer.from('10cc', 'hex')).length, 0);
    assert.deepEqual(interpreter.yielded.map(hex), ['aabb', 'cc']);
    assert.deepEqual(counts, [1, 2]);
  });

  it('reveals nothing the command did not commit to', () => {
    const interpreter = new ClientCommandInterpreter();
    const elements = [Buffer.from('a'), Buffer.from('b')];
    interpreter.addList(elements);
    const root = new MerkleTree(elements).root;
    const unknown = Buffer.alloc(32, 9);
    assert.throws(() => interpreter.execute(request(GET_PREIMAGE, Buffer.from([0]), unknown)), /not part of this request/);
    assert.throws(() => interpreter.execute(request(GET_PROOF, unknown, Buffer.from([2, 0]))), /not part of this request/);
    assert.throws(() => interpreter.execute(request(GET_INDEX, unknown, unknown)), /not part of this request/);
    // the right tree, but the wrong size or a leaf it does not have
    assert.throws(() => interpreter.execute(request(GET_PROOF, root, Buffer.from([3, 0]))), /not part of this request/);
    assert.throws(() => interpreter.execute(request(GET_PROOF, root, Buffer.from([2, 2]))), /not part of this request/);
  });

  it('refuses requests it cannot read', () => {
    const interpreter = new ClientCommandInterpreter();
    const hash = sha256(Buffer.from('x'));
    interpreter.addPreimage(Buffer.from('x'));
    assert.throws(() => interpreter.execute(new Uint8Array(0)), /empty request/);
    assert.throws(() => interpreter.execute(Buffer.from([0x99])), /does not understand \(0x99\)/);
    // the reserved byte must be zero
    assert.throws(() => interpreter.execute(request(GET_PREIMAGE, Buffer.from([1]), hash)), /malformed/);
    assert.throws(() => interpreter.execute(request(GET_PREIMAGE, Buffer.from([0]), hash, Buffer.from([0]))), /malformed/);
    assert.throws(() => interpreter.execute(request(GET_INDEX, hash)), /malformed/);
    assert.throws(() => interpreter.execute(request(GET_MORE, Buffer.from([0]))), /malformed/);
  });
});

// ---------------------------------------------------------------------------

describe('Ledger device: connecting', () => {
  it('reports the model and the app it found', async () => {
    const { device } = connect({ version: '2.4.2' });
    assert.deepEqual(await device.connect(), { model: 'Ledger Nano S Plus', firmware: 'Bitcoin 2.4.2' });
    assert.equal(device.kind, 'ledger');
  });

  it('names models from the USB product id', () => {
    assert.equal(ledgerModel(0x1011), 'Ledger Nano S');
    assert.equal(ledgerModel(0x4015), 'Ledger Nano X');
    assert.equal(ledgerModel(0x5011), 'Ledger Nano S Plus');
    assert.equal(ledgerModel(0x6011), 'Ledger Stax');
    assert.equal(ledgerModel(0x7011), 'Ledger Flex');
    assert.equal(ledgerModel(0x0001), 'Ledger Nano S');
    assert.equal(ledgerModel(0x0004), 'Ledger Nano X');
    assert.equal(ledgerModel(0x9911), 'Ledger');
    assert.equal(ledgerModel(undefined), 'Ledger');
  });

  it('reads the answer to "which app is open?"', () => {
    const answer = (name: string, version: string) =>
      Buffer.concat([Buffer.from([1, name.length]), Buffer.from(name), Buffer.from([version.length]), Buffer.from(version), Buffer.from([1, 0])]);
    assert.deepEqual(parseAppAndVersion(answer('Bitcoin', '2.4.2')), {
      name: 'Bitcoin',
      version: '2.4.2',
      network: 'mainnet',
      legacy: false,
    });
    assert.equal(parseAppAndVersion(answer('Bitcoin Test', '2.1.0')).network, 'testnet');
    assert.equal(parseAppAndVersion(answer('Bitcoin Test', '2.1.0')).legacy, false);
    assert.equal(parseAppAndVersion(answer('Bitcoin Recovery', '2.4.5')).network, 'mainnet');
    assert.equal(parseAppAndVersion(answer('Bitcoin', '2.0.6')).legacy, true);
    assert.equal(parseAppAndVersion(answer('Bitcoin', '1.6.5')).legacy, true);
    assert.equal(parseAppAndVersion(answer('Bitcoin Legacy', '2.1.3')).legacy, true);
    assert.equal(parseAppAndVersion(answer('Bitcoin', '3.0.0')).legacy, false);
    assert.equal(parseAppAndVersion(answer('Ethereum', '1.10.0')).network, null);
    assert.equal(parseAppAndVersion(answer('BOLOS', '1.1.1')).network, null);
    assert.throws(() => parseAppAndVersion(Buffer.from([2, 0])), /unreadable/);
    assert.throws(() => parseAppAndVersion(Buffer.from([1, 9, 66])), /unreadable/);
  });

  it('asks for the Bitcoin app when the device is on its home screen', async () => {
    const { device } = connect({ name: 'BOLOS', version: '1.1.1' });
    await assert.rejects(device.connect(), /^Error: Open the Bitcoin app on the Ledger \(“Bitcoin Test” for a testnet wallet\)/);
  });

  it('names the app that is open instead', async () => {
    const { device } = connect({ name: 'Ethereum', version: '1.10.4' });
    await assert.rejects(device.connect(), /has its Ethereum app open\. Open the Bitcoin app/);
  });

  it('asks for the device to be unlocked', async () => {
    const { device } = connect({ locked: true });
    await assert.rejects(device.connect(), /The Ledger is locked\. Unlock it with its PIN/);
  });

  it('says when the Bitcoin app is too old', async () => {
    await assert.rejects(connect({ version: '2.0.6' }).device.connect(), /Bitcoin 2\.0\.6, which is too old.*2\.1\.0 or later\.$/);
    await assert.rejects(connect({ version: '1.6.5' }).device.connect(), /too old/);
    await assert.rejects(
      connect({ name: 'Bitcoin Legacy', version: '2.1.3' }).device.connect(),
      /Bitcoin Legacy 2\.1\.3.*open that rather than the Legacy app/
    );
  });

  it('will not be used before it is connected', async () => {
    const { device } = connect();
    await assert.rejects(device.getKey('mainnet'), /not been connected/);
  });

  it('closes the connection it was given', async () => {
    const { device, transport } = connect();
    await device.connect();
    await device.close();
    assert.equal(transport.closed, true);
  });
});

describe('Ledger device: reading keys', () => {
  it('reads the fingerprint and the multisig account key', async () => {
    const { device, app, prompts } = connect();
    await device.connect();
    assert.equal(await device.masterFingerprint(), masterFingerprint(MNEMONICS[0]));
    assert.deepEqual(await device.getKey('mainnet'), {
      xpub: accountXpub(MNEMONICS[0], 'mainnet'),
      fingerprint: masterFingerprint(MNEMONICS[0]),
      path: "m/48'/0'/0'/2'",
      network: 'mainnet',
    });
    // display off, four steps, big-endian
    assert.ok(app.commands.some((c) => hex(c) === 'e1000001120004800000308000000080000000' + '80000002'));
    assert.deepEqual(prompts.lines, []);
  });

  it('reads testnet keys from the testnet app', async () => {
    const { device } = connect({ network: 'testnet' });
    assert.deepEqual(await device.connect(), { model: 'Ledger Nano S Plus', firmware: 'Bitcoin Test 2.4.2' });
    const key = await device.getKey('testnet');
    assert.equal(key.xpub, accountXpub(MNEMONICS[0], 'testnet'));
    assert.match(key.xpub, /^tpub/);
    assert.equal(key.path, "m/48'/1'/0'/2'");
  });

  it('explains an app open for the wrong network', async () => {
    const test = connect({ network: 'testnet' });
    await test.device.connect();
    await assert.rejects(test.device.getKey('mainnet'), /Bitcoin Test app open, which only handles testnet\. Open the Bitcoin app/);
    const main = connect();
    await main.device.connect();
    await assert.rejects(main.device.getKey('testnet'), /this is a testnet wallet\. Open the Bitcoin Test app/);
    // Nothing was asked of the device beyond which app it is running.
    assert.equal(main.app.commands.length, 1);
  });

  it('has the device show a path it will not export unasked', async () => {
    const { device, app, prompts } = connect();
    await device.connect();
    // An account number beyond what the app takes to be ordinary.
    const key = await device.getKey('mainnet', 'm/48h/0h/200h/2h');
    assert.equal(key.path, "m/48'/0'/200'/2'");
    assert.deepEqual(prompts.lines, ["Approve exporting the key at m/48'/0'/200'/2' on the Ledger."]);
    const asks = app.commands.filter((c) => c[0] === 0xe1 && c[1] === 0x00).map((c) => c[5]);
    assert.deepEqual(asks, [0, 1]);
    // A second request for the same key does not bother the device again.
    await device.getKey('mainnet', "m/48'/0'/200'/2'");
    assert.equal(app.commands.filter((c) => c[0] === 0xe1 && c[1] === 0x00).length, 2);
  });

  it('explains a path the app cannot reach at all', async () => {
    const { device } = connect();
    await device.connect();
    // A testnet path, asked of the mainnet app.
    await assert.rejects(device.getKey('mainnet', "m/48'/1'/0'/2'"), (e: any) => {
      assert.ok(e instanceof LedgerStatusError);
      assert.equal(
        e.message,
        "The Ledger will not hand out the key at m/48'/1'/0'/2'. Its Bitcoin app only exports keys for " +
          "mainnet wallets, from paths such as m/48'/0'/0'/2'."
      );
      return true;
    });
  });

  it('refuses a path it cannot encode', async () => {
    const { device } = connect();
    await device.connect();
    await assert.rejects(device.getKey('mainnet', 'm/48x/0'), /Cannot read the key path/);
  });
});

// ---------------------------------------------------------------------------

describe('Ledger device: signing', () => {
  const wallet = makeWallet(2, MNEMONICS.slice(0, 3));
  const spend = () => fundedSpend(wallet, [60000, 50000], DEST_MAINNET, 70000);
  const fingerprint = wallet.cosigners[0].fingerprint;

  it('registers the wallet, signs, and the transaction completes', async () => {
    const { stored, psbt } = spend();
    const { device, app, prompts, memory } = connect();
    await device.connect();
    const signatures = await device.signMultisig({ wallet, psbt, fingerprint });

    const tx = finish(stored, wallet, 0, signatures, [1]);
    assert.equal(tx.ins.length, 2);
    assert.equal(tx.outs[0].value, 70000);

    assert.equal(app.registrations.length, 1);
    assert.deepEqual(app.registrations[0], multisigPolicy(wallet));
    assert.deepEqual(prompts.lines, [
      'The Ledger needs to approve this wallet before it will sign for it. Check the name “Test wallet”, ' +
        'the policy (2 of 3) and every cosigner key on its screen, then approve.',
      'Review the transaction on the Ledger — the amount, the address and the fee — then approve it.',
      'Signing on the Ledger… 1 of 2',
      'Signing on the Ledger… 2 of 2',
    ]);
    assert.deepEqual([...memory.store.keys()], [`ledger.hmac.${fingerprint}.${hex(policyId(multisigPolicy(wallet)))}`]);
    assert.ok(ledgerMemoryKeys(wallet).includes([...memory.store.keys()][0]), 'a name the wipe knows to erase');
    assert.match([...memory.store.values()][0], /^[0-9a-f]{64}$/);
  });

  it('shows the app the very transaction it was given', async () => {
    const { psbt } = spend();
    const { device, app } = connect();
    await device.connect();
    await device.signMultisig({ wallet, psbt, fingerprint });

    // What the app pieced together from proofs and preimages, against what
    // bitcoinjs-lib makes of the same PSBT — no driver code in between.
    const seen = app.signed[0];
    assert.deepEqual(seen.policy, multisigPolicy(wallet));
    const tx = bitcoin.Transaction.fromBuffer((psbt.data.globalMap.unsignedTx as any).toBuffer());
    assert.equal(seen.psbt.inputs.length, psbt.data.inputs.length);
    assert.equal(seen.psbt.outputs.length, psbt.txOutputs.length);
    assert.equal(seen.psbt.global.get('02')!.readUInt32LE(0), tx.version);
    assert.equal(seen.psbt.global.get('03')!.readUInt32LE(0), tx.locktime);
    seen.psbt.inputs.forEach((input, i) => {
      const source = psbt.data.inputs[i];
      assert.equal(hex(input.get('0e')!), hex(tx.ins[i].hash));
      assert.equal(input.get('0f')!.readUInt32LE(0), tx.ins[i].index);
      assert.equal(input.get('10')!.readUInt32LE(0), tx.ins[i].sequence);
      assert.equal(hex(input.get('00')!), hex(source.nonWitnessUtxo!));
      assert.equal(hex(input.get('05')!), hex(source.witnessScript!));
      assert.equal(input.get('01')!.readUInt32LE(0), source.witnessUtxo!.value);
      for (const d of source.bip32Derivation!) assert.ok(input.has(`06${hex(d.pubkey)}`));
    });
    seen.psbt.outputs.forEach((output, i) => {
      assert.equal(output.get('03')!.readUInt32LE(0), tx.outs[i].value);
      assert.equal(hex(output.get('04')!), hex(tx.outs[i].script));
    });
    // Every kind of question was asked, and answered to the app's satisfaction.
    for (const code of [0x10, 0x40, 0x41, 0x42]) assert.ok(app.asked[code] > 0, `0x${code.toString(16)}`);
  });

  it('does not ask for the wallet to be approved twice', async () => {
    const memory = mapMemory();
    const first = connect({}, memory);
    await first.device.connect();
    await first.device.signMultisig({ wallet, psbt: spend().psbt, fingerprint });

    const { stored, psbt } = spend();
    const second = connect({}, memory);
    await second.device.connect();
    const signatures = await second.device.signMultisig({ wallet, psbt, fingerprint });
    finish(stored, wallet, 0, signatures, [2]);
    assert.equal(second.app.registrations.length, 0);
    assert.ok(!second.app.commands.some((c) => c[0] === 0xe1 && (c[1] === 0x02 || c[1] === 0x03)));
    assert.match(second.prompts.lines[0], /^Review the transaction/);
  });

  it('registers again when the device no longer honours its approval', async () => {
    const memory = mapMemory();
    const before = connect({}, memory);
    await before.device.connect();
    await before.device.signMultisig({ wallet, psbt: spend().psbt, fingerprint });
    const old = [...memory.store.values()][0];

    // The same seed on a device that was wiped and restored.
    const { stored, psbt } = spend();
    const after = connect({ hmacSecret: 'device two' }, memory);
    await after.device.connect();
    const signatures = await after.device.signMultisig({ wallet, psbt, fingerprint });
    finish(stored, wallet, 0, signatures, [1]);
    assert.equal(after.app.registrations.length, 1);
    assert.equal(memory.store.size, 1);
    assert.notEqual([...memory.store.values()][0], old);
    assert.match(after.prompts.lines[0], /^Review the transaction/);
    assert.match(after.prompts.lines[1], /needs to approve this wallet/);
    assert.match(after.prompts.lines[2], /^Review the transaction/);
  });

  it('ignores an approval on file that is not one', async () => {
    const key = `ledger.hmac.${fingerprint}.${hex(policyId(multisigPolicy(wallet)))}`;
    const { stored, psbt } = spend();
    const { device, app, memory } = connect({}, mapMemory({ [key]: 'not hex at all' }));
    await device.connect();
    finish(stored, wallet, 0, await device.signMultisig({ wallet, psbt, fingerprint }), [1]);
    assert.equal(app.registrations.length, 1);
    assert.match(memory.store.get(key)!, /^[0-9a-f]{64}$/);
  });

  it('signs even when the approval cannot be kept', async () => {
    const broken = {
      get: () => Promise.reject(new Error('keystore locked')),
      set: () => Promise.reject(new Error('keystore locked')),
    };
    const { stored, psbt } = spend();
    const app = new FakeLedgerApp({ mnemonic: MNEMONICS[0] });
    const device = new LedgerDevice(packetTransport(app.exchange), { prompts: recordingPrompts(), memory: broken });
    await device.connect();
    finish(stored, wallet, 0, await device.signMultisig({ wallet, psbt, fingerprint }), [1]);
    assert.equal(app.registrations.length, 1);
  });

  it('keeps each device’s approval apart', async () => {
    // Two Ledgers in one wallet: same policy, different approvals.
    const memory = mapMemory();
    const one = connect({ mnemonic: MNEMONICS[0] }, memory);
    await one.device.connect();
    await one.device.signMultisig({ wallet, psbt: spend().psbt, fingerprint: wallet.cosigners[0].fingerprint });
    const two = connect({ mnemonic: MNEMONICS[1], hmacSecret: 'device two' }, memory);
    await two.device.connect();
    await two.device.signMultisig({ wallet, psbt: spend().psbt, fingerprint: wallet.cosigners[1].fingerprint });
    assert.equal(memory.store.size, 2);
    assert.equal(new Set(memory.store.values()).size, 2);
  });

  it('two devices can complete a transaction between them', async () => {
    const { stored, psbt } = spend();
    let base64 = stored;
    for (const signer of [0, 2]) {
      const { device } = connect({ mnemonic: MNEMONICS[signer], hmacSecret: `device ${signer}` });
      await device.connect();
      const signatures = await device.signMultisig({ wallet, psbt, fingerprint: wallet.cosigners[signer].fingerprint });
      const jobs = signingJobsFor(base64, wallet.cosigners[signer].fingerprint, 'mainnet');
      base64 = attachSignatures(
        base64,
        'mainnet',
        jobs.map((job) => ({ job, signature: signatures.find((s) => s.index === job.index)!.signature }))
      );
    }
    const done = parsePsbt(base64, 'mainnet');
    assert.ok(summarisePsbt(done, wallet).complete);
    finalizeAndExtract(done);
  });

  it('signs a draft that already carries another cosigner’s signature', async () => {
    const { stored, psbt } = spend();
    signPsbtWithMnemonic(psbt, MNEMONICS[1], wallet);
    const { device } = connect();
    await device.connect();
    const signatures = await device.signMultisig({ wallet, psbt, fingerprint });
    finish(stored, wallet, 0, signatures, [1]);
  });

  it('signs for larger wallets and transactions', async () => {
    const big = makeWallet(3, MNEMONICS, 'mainnet', 'Five keys');
    const coins = [11000, 12000, 13000, 14000, 15000, 16000, 17000];
    const { stored, psbt } = fundedSpend(big, coins, DEST_MAINNET, 90000, 2);
    assert.equal(psbt.data.inputs.length, 7);
    const { device, app, prompts } = connect({ mnemonic: MNEMONICS[3] });
    await device.connect();
    const signatures = await device.signMultisig({ wallet: big, psbt, fingerprint: big.cosigners[3].fingerprint });
    assert.equal(signatures.length, 7);
    finish(stored, big, 3, signatures, [0, 4]);
    assert.equal(app.registrations[0].template, 'wsh(sortedmulti(3,@0/**,@1/**,@2/**,@3/**,@4/**))');
    assert.equal(prompts.lines[prompts.lines.length - 1], 'Signing on the Ledger… 7 of 7');
  });

  it('signs for a testnet wallet with the testnet app', async () => {
    const test = makeWallet(2, MNEMONICS.slice(0, 3), 'testnet');
    const { stored, psbt } = fundedSpend(test, [90000], DEST_TESTNET, 40000);
    const { device } = connect({ network: 'testnet' });
    await device.connect();
    const signatures = await device.signMultisig({ wallet: test, psbt, fingerprint: test.cosigners[0].fingerprint });
    finish(stored, test, 0, signatures, [1]);
  });

  it('will not sign a testnet wallet with the mainnet app', async () => {
    const test = makeWallet(2, MNEMONICS.slice(0, 3), 'testnet');
    const { psbt } = fundedSpend(test, [90000], DEST_TESTNET, 40000);
    const { device, app } = connect();
    await device.connect();
    await assert.rejects(
      device.signMultisig({ wallet: test, psbt, fingerprint: test.cosigners[0].fingerprint }),
      /Open the Bitcoin Test app/
    );
    assert.equal(app.commands.length, 1);
  });

  it('gives a name the device accepts to a wallet whose own it would not', async () => {
    const named = { ...wallet, name: 'Épargne ₿ de la famille' };
    const { stored, psbt } = fundedSpend(named, [60000], DEST_MAINNET, 20000);
    const { device, app } = connect();
    await device.connect();
    finish(stored, named, 0, await device.signMultisig({ wallet: named, psbt, fingerprint }), [1]);
    assert.equal(app.registrations[0].name, 'pargne de la famille');
  });
});

describe('Ledger device: refusing to sign', () => {
  const wallet = makeWallet(2, MNEMONICS.slice(0, 3));
  const spend = () => fundedSpend(wallet, [60000, 50000], DEST_MAINNET, 70000);
  const fingerprint = wallet.cosigners[0].fingerprint;

  it('reports a wallet turned down on the device as a cancellation', async () => {
    const { device, memory, app } = connect({ approveRegistration: false });
    await device.connect();
    await assert.rejects(device.signMultisig({ wallet, psbt: spend().psbt, fingerprint }), (e: any) => {
      assert.ok(e instanceof UserCancelled);
      assert.equal(e.message, 'Rejected on the Ledger.');
      return true;
    });
    assert.equal(memory.store.size, 0);
    assert.ok(!app.commands.some((c) => c[0] === 0xe1 && c[1] === 0x04));
  });

  it('reports a transaction turned down on the device as a cancellation', async () => {
    const { device, memory } = connect({ approveTransaction: false });
    await device.connect();
    await assert.rejects(
      device.signMultisig({ wallet, psbt: spend().psbt, fingerprint }),
      (e: any) => e instanceof UserCancelled
    );
    // The wallet itself was approved, and that is worth keeping.
    assert.equal(memory.store.size, 1);
  });

  it('names the wrong device before asking it anything', async () => {
    const { device, app } = connect({ mnemonic: MNEMONICS[3] });
    await device.connect();
    await assert.rejects(
      device.signMultisig({ wallet, psbt: spend().psbt, fingerprint }),
      new RegExp(`different Ledger\\. It holds key ${masterFingerprint(MNEMONICS[3])}, but this signature needs ${fingerprint}`)
    );
    assert.deepEqual(
      app.commands.map((c) => hex(c.subarray(0, 2))),
      ['b001', 'e105']
    );
  });

  it('will not sign as a key the wallet does not have', async () => {
    const { device } = connect({ mnemonic: MNEMONICS[3] });
    await device.connect();
    await assert.rejects(
      device.signMultisig({ wallet, psbt: spend().psbt, fingerprint: masterFingerprint(MNEMONICS[3]) }),
      /not one of this wallet’s cosigners/
    );
  });

  it('catches a wallet built with another key under this device’s fingerprint', async () => {
    const forged: MultisigWallet = {
      ...wallet,
      cosigners: [{ ...wallet.cosigners[0], xpub: accountXpub(MNEMONICS[4], 'mainnet') }, ...wallet.cosigners.slice(1)],
    };
    const { psbt } = fundedSpend(forged, [60000], DEST_MAINNET, 20000);
    const { device, app } = connect();
    await device.connect();
    await assert.rejects(
      device.signMultisig({ wallet: forged, psbt, fingerprint }),
      /right fingerprint \(73c5da0a\) but a different key at m\/48'\/0'\/0'\/2'/
    );
    assert.ok(!app.commands.some((c) => c[0] === 0xe1 && c[1] === 0x02));
  });

  it('will not rely on a device that derives different addresses', async () => {
    const { device, memory, app } = connect({ faults: { wrongAddresses: true } });
    await device.connect();
    await assert.rejects(
      device.signMultisig({ wallet, psbt: spend().psbt, fingerprint }),
      new RegExp(`disagree about the wallet’s first address \\(${deriveAddress(wallet, 0, 1).address} against ${deriveAddress(wallet, 0, 0).address}\\)`)
    );
    assert.equal(memory.store.size, 0);
    assert.ok(!app.commands.some((c) => c[0] === 0xe1 && c[1] === 0x04));
  });

  it('explains a transaction sent without the coins’ own transactions', async () => {
    const bare = parsePsbt(spend().stored, 'mainnet');
    const { device } = connect();
    await device.connect();
    await assert.rejects(device.signMultisig({ wallet, psbt: bare, fingerprint }), (e: any) => {
      assert.ok(e instanceof LedgerStatusError);
      assert.equal(e.sw, 0x6a80);
      assert.equal(e.detail, 3);
      assert.match(e.message, /needs the coins being spent described/);
      return true;
    });
  });

  it('passes on the device’s refusal of an input that is not what it claims', async () => {
    const { psbt } = spend();
    // The amount the draft claims for the first coin, raised by a sat.
    const lying = parsePsbt(psbt.toBase64(), 'mainnet');
    (lying.data.inputs[0].witnessUtxo as any).value += 1;
    const { device } = connect();
    await device.connect();
    await assert.rejects(device.signMultisig({ wallet, psbt: lying, fingerprint }), /does not match the transaction it is said to come from\. Nothing was signed/);
  });

  it('refuses a signature that does not cover the whole transaction', async () => {
    const { device } = connect({ faults: { sighashType: bitcoin.Transaction.SIGHASH_NONE } });
    await device.connect();
    await assert.rejects(
      device.signMultisig({ wallet, psbt: spend().psbt, fingerprint }),
      /does not cover the whole transaction/
    );
  });

  it('refuses a signature for an input the transaction does not have', async () => {
    const { device } = connect({ faults: { inputIndex: 9 } });
    await device.connect();
    await assert.rejects(
      device.signMultisig({ wallet, psbt: spend().psbt, fingerprint }),
      /signed an input this transaction does not have/
    );
  });

  it('says so when the device approves but signs nothing', async () => {
    const { device } = connect({ faults: { signNothing: true } });
    await device.connect();
    await assert.rejects(device.signMultisig({ wallet, psbt: spend().psbt, fingerprint }), /signed nothing/);
  });

  it('reads the signatures the app hands back', () => {
    const der = bitcoin.script.signature.encode(Buffer.concat([Buffer.alloc(32, 1), Buffer.alloc(32, 2)]), 1);
    const pubkey = Buffer.from(ecc.pointFromScalar(Buffer.alloc(32, 5), true)!);
    const parsed = parseYieldedSignature(Buffer.concat([Buffer.from([3, 33]), pubkey, der]));
    assert.equal(parsed.index, 3);
    assert.equal(hex(parsed.pubkey), hex(pubkey));
    assert.equal(hex(parsed.signature), '01'.repeat(32) + '02'.repeat(32));
    // a three-byte varint for the index
    assert.equal(parseYieldedSignature(Buffer.concat([Buffer.from('fd2c01', 'hex'), Buffer.from([33]), pubkey, der])).index, 300);

    // an x-only key is a taproot signature, which this wallet never asks for
    assert.throws(() => parseYieldedSignature(Buffer.concat([Buffer.from([0, 32]), pubkey.subarray(1), der])), /kind of key/);
    // tags above 65535 announce MuSig2 rounds
    assert.throws(() => parseYieldedSignature(Buffer.concat([Buffer.from('feffffffff', 'hex'), pubkey])), /kind of signature/);
    assert.throws(() => parseYieldedSignature(Buffer.concat([Buffer.from([0, 33]), pubkey, Buffer.from('3001', 'hex')])), /cannot be read/);
    assert.throws(() => parseYieldedSignature(Buffer.concat([Buffer.from([0, 33]), pubkey.subarray(0, 20)])), /kind of key/);
  });
});

// ---------------------------------------------------------------------------
// Against Ledger's own client
// ---------------------------------------------------------------------------

/**
 * The spend every comparison below uses, written out so that nothing the
 * wallet engine does differently tomorrow can move it. 2 of 3 from
 * MNEMONICS[0..2], two coins, one payment and change.
 */
const REFERENCE_PSBT =
  'cHNidP8BAKYCAAAAAmj4YsQVu0ANnpEMro+uTTWT35uvy4Ahunn8TBGJkNntAAAAAAD9////aPhixBW7QA2ekQyuj65NNZPfm6/LgCG6efxMEYmQ2e0BAAAAAP3///8CcBEBAAAAAAAWABR1HnboGZGW1FSUHEXRs6Mj8UM71n2WAAAAAAAAIgAgI8HS/M+tn/sX42VpVU25vz5YBtjqWrwFrInAbSV0ttUAAAAAAAEAigIAAAABBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcAAAAAAVH/////AmDqAAAAAAAAIgAg3WM/TnllD9lGYxTEo0MIYU6/IMTAKB2FT+0YJIaLeBVQwwAAAAAAACIAILvkZ2W5G8SXCjqMudgdl+s0Gra33bRDesG7YoYn2ipEAAAAAAEBK2DqAAAAAAAAIgAg3WM/TnllD9lGYxTEo0MIYU6/IMTAKB2FT+0YJIaLeBUBBWlSIQKOgY32PW8tzpMI10Vf1MhcuznXA2CLj77WR9deJiMi2CEDIpyzT+PrGvQ7bdKi4bMWgQObcdkwPe02sxKO81njeb0hA9wZU8J1bHxY1PSMobu6dn9BT9I2v01mK2dyGsYmxRTgU64iBgKOgY32PW8tzpMI10Vf1MhcuznXA2CLj77WR9deJiMi2By4aI3xMAAAgAAAAIAAAACAAgAAgAAAAAAAAAAAIgYDIpyzT+PrGvQ7bdKi4bMWgQObcdkwPe02sxKO81njeb0cKGRQBjAAAIAAAACAAAAAgAIAAIAAAAAAAAAAACIGA9wZU8J1bHxY1PSMobu6dn9BT9I2v01mK2dyGsYmxRTgHHPF2gowAACAAAAAgAAAAIACAACAAAAAAAAAAAAAAQCKAgAAAAEHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwAAAAABUf////8CYOoAAAAAAAAiACDdYz9OeWUP2UZjFMSjQwhhTr8gxMAoHYVP7Rgkhot4FVDDAAAAAAAAIgAgu+RnZbkbxJcKOoy52B2X6zQatrfdtEN6wbtihifaKkQAAAAAAQErUMMAAAAAAAAiACC75GdluRvElwo6jLnYHZfrNBq2t920Q3rBu2KGJ9oqRAEFaVIhAgVVuR4P6cspkWerq4Y22MmX8AY4CgCnARPsrKw+sxc9IQMQo3utZFRp3JAljoybnDcH3FOJWEJBNWNcHC9wIDvRZyEDIlwFcSDKh8Dt4k1JIo8rKjiniTHUKxeQZKLGwtSBs/ZTriIGAgVVuR4P6cspkWerq4Y22MmX8AY4CgCnARPsrKw+sxc9HHPF2gowAACAAAAAgAAAAIACAACAAAAAAAEAAAAiBgMQo3utZFRp3JAljoybnDcH3FOJWEJBNWNcHC9wIDvRZxy4aI3xMAAAgAAAAIAAAACAAgAAgAAAAAABAAAAIgYDIlwFcSDKh8Dt4k1JIo8rKjiniTHUKxeQZKLGwtSBs/YcKGRQBjAAAIAAAACAAAAAgAIAAIAAAAAAAQAAAAAAAQFpUiECnBCbiCi9prcmm5VLy3vWlJeUk/xPGFezHhihymiwL4YhA0gcNoWLVV9NIyTAVRvi6ZONgoo8UAAVVJqYW72Nb6/+IQOq4m/6wefwcy4ChH8ELvWyNSwt4X1H01ZMbkmKNM353VOuIgICnBCbiCi9prcmm5VLy3vWlJeUk/xPGFezHhihymiwL4YcuGiN8TAAAIAAAACAAAAAgAIAAIABAAAAAAAAACICA0gcNoWLVV9NIyTAVRvi6ZONgoo8UAAVVJqYW72Nb6/+HHPF2gowAACAAAAAgAAAAIACAACAAQAAAAAAAAAiAgOq4m/6wefwcy4ChH8ELvWyNSwt4X1H01ZMbkmKNM353RwoZFAGMAAAgAAAAIAAAACAAgAAgAEAAAAAAAAAAA==';

/** The three conversations that matter, as the driver holds them with the fake app. */
async function driverConversations(): Promise<{ commands: string[][]; signatures: string[] }> {
  const wallet = makeWallet(2, MNEMONICS.slice(0, 3));
  const { device, app } = connect();
  await device.connect();
  const signatures = await device.signMultisig({
    wallet,
    psbt: parsePsbt(REFERENCE_PSBT, 'mainnet'),
    fingerprint: wallet.cosigners[0].fingerprint,
  });
  return {
    commands: conversations(app.commands).filter((c) => /^e10[234]/.test(c[0])),
    signatures: signatures.map((s) => `${s.index}:${hex(s.pubkey)}:${hex(s.signature)}`),
  };
}

describe('Ledger driver against Ledger’s own client', () => {
  // Recorded from @ledgerhq/ledger-bitcoin 0.3.1 driving the same fake app
  // with the same policy and PSBT: every command it sent, in order, hashed.
  // (Its CONTINUE commands carry P2 = 0 where the app's documentation, its
  // current source and HWI all send 1; the app reads neither. They are
  // compared with that byte set to 1.) Run with LEDGER_REFERENCE_CLIENT set
  // to check the recording against the live client.
  const RECORDED = {
    register: 'aab487661bb3fcd247bd42c8a3f38d9e29e319dd8e6a1fd8c4e0632348ea2da6',
    address: '36c336ec1bcb1a4d8515d49b4db2e617928760f435e0dd84cbfbdfa1829f0253',
    sign: '6fbc3415b4b65b750673423bd41480b31b6261fa0793fa969db1832e778a3ed9',
    firstApdus: [
      'e1020001504f020b546573742077616c6c65742545cff6017af8edc8b6bb6cdb8634ff05e1a82a7f7962d114045d2bd666e1a16e' +
        '03877f187ced602d3b770c49c38f56610d4298f5ee12117bced136654ea3e04412',
    ],
  };

  it('sends command for command what Ledger’s client sends', async () => {
    const { commands } = await driverConversations();
    assert.deepEqual(
      commands.map((c) => c[0].slice(0, 4)),
      ['e102', 'e103', 'e104']
    );
    assert.equal(commands[0][0], RECORDED.firstApdus[0]);
    assert.equal(digest(commands[0]), RECORDED.register);
    assert.equal(digest(commands[1]), RECORDED.address);
    assert.equal(digest(commands[2]), RECORDED.sign);
  });

  const reference = process.env.LEDGER_REFERENCE_CLIENT;
  it(
    'agrees with the live client',
    { skip: reference ? false : 'set LEDGER_REFERENCE_CLIENT to the installed @ledgerhq/ledger-bitcoin' },
    async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const ledger = require(reference!);
      const wallet = makeWallet(2, MNEMONICS.slice(0, 3));
      const policy = multisigPolicy(wallet);
      const app = new FakeLedgerApp({ mnemonic: MNEMONICS[0] });
      const client = new ledger.AppClient({
        send: (cla: number, ins: number, p1: number, p2: number, data: Buffer = Buffer.alloc(0)) =>
          app.exchange(Buffer.concat([Buffer.from([cla, ins, p1, p2, data.length]), data])),
      });
      const theirs = new ledger.WalletPolicy(policy.name, policy.template, policy.keys);
      assert.equal(hex(theirs.serialize()), hex(serialisePolicy(policy)));
      assert.equal(hex(theirs.getId()), hex(policyId(policy)));

      const [, hmac] = await client.registerWallet(theirs);
      const signed: [number, { pubkey: Buffer; signature: Buffer }][] = await client.signPsbt(REFERENCE_PSBT, theirs, hmac);

      const withP2 = (c: string) => (c.startsWith('f801') ? `f8010001${c.slice(8)}` : c);
      const theirCommands = conversations(app.commands)
        .filter((c) => /^e10[234]/.test(c[0]))
        .map((c) => c.map(withP2));
      const mine = await driverConversations();
      assert.deepEqual(mine.commands, theirCommands);
      assert.deepEqual(
        mine.signatures,
        signed.map(([index, s]) => `${index}:${hex(s.pubkey)}:${hex(bitcoin.script.signature.decode(s.signature).signature)}`)
      );

      // And the two agree on the trees underneath, size by size.
      const merkle = require(`${reference}/build/main/lib/merkle.js`);
      for (let n = 0; n <= 40; n++) {
        const elements = Array.from({ length: n }, (_, i) => Buffer.from(`element ${i}`));
        const theirTree = new merkle.Merkle(elements.map((e) => merkle.hashLeaf(e)));
        const myTree = new MerkleTree(elements);
        assert.equal(hex(myTree.root), hex(theirTree.getRoot()));
        for (let i = 0; i < n; i++) assert.deepEqual(myTree.proof(i).map(hex), theirTree.getProof(i).map(hex));
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Against the real app
// ---------------------------------------------------------------------------

/**
 * These run the driver against the Ledger Bitcoin app itself, under Ledger's
 * Speculos emulator, started with the seed MNEMONICS[0]. Skipped unless told
 * where to find it:
 *
 *   LEDGER_SPECULOS=127.0.0.1:9999,http://127.0.0.1:5000          (Bitcoin app)
 *   LEDGER_SPECULOS_TESTNET=127.0.0.1:9998,http://127.0.0.1:5001  (Bitcoin Test app)
 */
function speculosTests(network: 'mainnet' | 'testnet', where: string | undefined) {
  const skip = where ? false : `set ${network === 'mainnet' ? 'LEDGER_SPECULOS' : 'LEDGER_SPECULOS_TESTNET'} to run`;
  const destination = network === 'mainnet' ? DEST_MAINNET : DEST_TESTNET;
  const approve = ['Register account', 'Sign transaction'];

  const open = async (memory = mapMemory()) => {
    const [apdu, api] = where!.split(',');
    const speculos = await connectSpeculos(apdu, api);
    const log = { sent: [] as Buffer[], received: [] as Buffer[] };
    const prompts = recordingPrompts();
    const device = new LedgerDevice(packetTransport(speculos.exchange, { log }), { prompts, memory }, { productId: 0x5011 });
    return { speculos, device, prompts, memory, log };
  };

  describe(`Ledger Bitcoin app under Speculos (${network})`, { skip }, () => {
    it('says what it is and hands over its key', async () => {
      const { speculos, device } = await open();
      try {
        const info = await device.connect();
        assert.equal(info.model, 'Ledger Nano S Plus');
        assert.match(info.firmware!, network === 'mainnet' ? /^Bitcoin \d+\.\d+\.\d+/ : /^Bitcoin Test \d+\.\d+\.\d+/);
        assert.equal(await device.masterFingerprint(), masterFingerprint(MNEMONICS[0]));
        assert.deepEqual(await device.getKey(network), {
          xpub: accountXpub(MNEMONICS[0], network),
          fingerprint: masterFingerprint(MNEMONICS[0]),
          path: bip48Path(network),
          network,
        });
        const other = network === 'mainnet' ? 'testnet' : 'mainnet';
        await assert.rejects(device.getKey(other), /Open the Bitcoin( Test)? app/);
      } finally {
        speculos.close();
      }
    });

    it('shows an unusual path for approval, and refuses one outside its network', async () => {
      const coin = network === 'mainnet' ? 0 : 1;
      const { speculos, device, prompts } = await open();
      try {
        await device.connect();
        const unusual = `m/48'/${coin}'/200'/2'`;
        const key = await speculos.during(['Approve public key'], () => device.getKey(network, unusual));
        assert.match(key.xpub, network === 'mainnet' ? /^xpub/ : /^tpub/);
        assert.deepEqual(prompts.lines, [`Approve exporting the key at ${unusual} on the Ledger.`]);
        await assert.rejects(device.getKey(network, `m/48'/${1 - coin}'/0'/2'`), /will not hand out the key/);
      } finally {
        speculos.close();
      }
    });

    it('registers a wallet, signs, and signs again without registering', async () => {
      const wallet = makeWallet(2, MNEMONICS.slice(0, 3), network, 'Speculos 2of3');
      const fingerprint = wallet.cosigners[0].fingerprint;
      const { speculos, device, memory, log } = await open();
      try {
        await device.connect();
        const first = fundedSpend(wallet, [60000, 50000], destination, 70000);
        const signatures = await speculos.during(approve, () =>
          device.signMultisig({ wallet, psbt: first.psbt, fingerprint })
        );
        finish(first.stored, wallet, 0, signatures, [1]);
        assert.equal(memory.store.size, 1);
        assert.equal(log.sent.filter((c) => c[0] === 0xe1 && c[1] === 0x02).length, 1);

        const second = fundedSpend(wallet, [33000], destination, 12000);
        const again = await speculos.during(approve, () =>
          device.signMultisig({ wallet, psbt: second.psbt, fingerprint })
        );
        finish(second.stored, wallet, 0, again, [2]);
        assert.equal(log.sent.filter((c) => c[0] === 0xe1 && c[1] === 0x02).length, 1);
      } finally {
        speculos.close();
      }
    });

    it('signs exactly as the stand-in app does', async () => {
      // Ties the fake app every other test leans on to the real one.
      const wallet = makeWallet(2, MNEMONICS.slice(0, 3), network);
      const fingerprint = wallet.cosigners[0].fingerprint;
      const { psbt } = fundedSpend(wallet, [60000, 50000], destination, 70000);
      const { speculos, device } = await open();
      try {
        await device.connect();
        const real = await speculos.during(approve, () => device.signMultisig({ wallet, psbt, fingerprint }));
        const fake = connect({ network });
        await fake.device.connect();
        const stood = await fake.device.signMultisig({ wallet, psbt, fingerprint });
        assert.deepEqual(
          real.map((s) => [s.index, hex(s.pubkey), hex(s.signature)]),
          stood.map((s) => [s.index, hex(s.pubkey), hex(s.signature)])
        );
      } finally {
        speculos.close();
      }
    });

    it('registers again when its approval on file is not the device’s', async () => {
      const wallet = makeWallet(2, MNEMONICS.slice(0, 3), network, 'Stale approval');
      const fingerprint = wallet.cosigners[0].fingerprint;
      const key = `ledger.hmac.${fingerprint}.${hex(policyId(multisigPolicy(wallet)))}`;
      const { speculos, device, memory, log } = await open(mapMemory({ [key]: 'ab'.repeat(32) }));
      try {
        await device.connect();
        const { stored, psbt } = fundedSpend(wallet, [60000], destination, 20000);
        const signatures = await speculos.during(approve, () => device.signMultisig({ wallet, psbt, fingerprint }));
        finish(stored, wallet, 0, signatures, [1]);
        assert.notEqual(memory.store.get(key), 'ab'.repeat(32));
        assert.equal(log.sent.filter((c) => c[0] === 0xe1 && c[1] === 0x02).length, 1);
      } finally {
        speculos.close();
      }
    });

    it('signs for a 3 of 5 with several coins', async () => {
      const wallet = makeWallet(3, MNEMONICS, network, 'Speculos 3of5');
      const { speculos, device } = await open();
      try {
        await device.connect();
        const { stored, psbt } = fundedSpend(wallet, [11000, 12000, 13000, 14000, 15000], destination, 50000, 2);
        const signatures = await speculos.during(approve, () =>
          device.signMultisig({ wallet, psbt, fingerprint: wallet.cosigners[0].fingerprint })
        );
        assert.equal(signatures.length, psbt.data.inputs.length);
        finish(stored, wallet, 0, signatures, [2, 4]);
      } finally {
        speculos.close();
      }
    });

    it('reports a refusal on the device as a cancellation', async () => {
      const wallet = makeWallet(2, MNEMONICS.slice(0, 3), network, 'Refused');
      const { speculos, device, memory } = await open();
      try {
        await device.connect();
        const { psbt } = fundedSpend(wallet, [60000], destination, 20000);
        await assert.rejects(
          speculos.during(['Reject'], () =>
            device.signMultisig({ wallet, psbt, fingerprint: wallet.cosigners[0].fingerprint })
          ),
          (e: any) => e instanceof UserCancelled
        );
        assert.equal(memory.store.size, 0);
      } finally {
        speculos.close();
      }
    });

    it('is refused a transaction whose coin is not what the draft says', async () => {
      const wallet = makeWallet(2, MNEMONICS.slice(0, 3), network, 'Speculos 2of3');
      const { speculos, device } = await open();
      try {
        await device.connect();
        const { psbt } = fundedSpend(wallet, [60000], destination, 20000);
        (psbt.data.inputs[0].witnessUtxo as any).value += 1;
        await assert.rejects(
          speculos.during(approve, () =>
            device.signMultisig({ wallet, psbt, fingerprint: wallet.cosigners[0].fingerprint })
          ),
          (e: any) => e instanceof LedgerStatusError && e.sw === 0x6a80
        );
      } finally {
        speculos.close();
      }
    });
  });
}

speculosTests('mainnet', process.env.LEDGER_SPECULOS);
speculosTests('testnet', process.env.LEDGER_SPECULOS_TESTNET);
