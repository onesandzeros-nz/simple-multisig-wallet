import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as bitcoin from 'bitcoinjs-lib';
import { deriveAddress, estimateVsize } from '../src/lib/bitcoin';
import { Buffer } from 'buffer';
import { bip48Path, masterFingerprint, rootFromMnemonic } from '../src/lib/bitcoin';
import {
  assertDraftRoom,
  atDraftLimit,
  attachSignatures,
  signingJobsFor,
  buildPsbt,
  combinePsbts,
  finalizeAndExtract,
  isDraftSettled,
  MAX_INCOMING_PSBT_CHARS,
  MAX_PENDING_DRAFTS,
  MAX_PSBT_INPUTS,
  MAX_PSBT_OUTPUTS,
  mergeSignatures,
  removeSignature,
  outpointKeys,
  parseIncomingPsbt,
  parsePsbt,
  signPsbtWithMnemonic,
  summarisePsbt,
  unsignedTxId,
} from '../src/lib/wallet';
import { decodeNdefText, extractPsbt } from '../src/lib/psbtFromBytes';
import { DEST_MAINNET, MNEMONICS, makeSnapshot, makeWallet } from './helpers';

describe('transaction building', () => {
  const wallet = makeWallet(2, MNEMONICS.slice(0, 3));
  const snapshot = makeSnapshot(wallet, [100_000, 50_000]);

  it('builds a PSBT with change and correct fee accounting', () => {
    const result = buildPsbt(wallet, snapshot, DEST_MAINNET, 120_000, 10, false);
    assert.equal(result.usedUtxos.length, 2);
    assert.ok(result.changeSats > 0);
    const summary = summarisePsbt(result.psbt, wallet);
    assert.equal(summary.totalIn, 150_000);
    assert.equal(summary.totalIn - summary.totalOut, result.feeSats);
    assert.equal(summary.outputs.filter((o) => o.isChange).length, 1);
    assert.equal(summary.signedBy.length, 0);
    assert.ok(!summary.complete);
  });

  it('attaches key-origin info for every cosigner on every input', () => {
    const result = buildPsbt(wallet, snapshot, DEST_MAINNET, 60_000, 5, false);
    for (const input of result.psbt.data.inputs) {
      assert.equal(input.bip32Derivation?.length, 3);
      assert.ok(input.witnessScript);
      assert.ok(input.witnessUtxo);
    }
  });

  it('send-max spends everything with a single output and no change', () => {
    const result = buildPsbt(wallet, snapshot, DEST_MAINNET, 0, 5, true);
    assert.equal(result.psbt.txOutputs.length, 1);
    assert.equal(result.changeSats, 0);
    assert.equal(result.psbt.txOutputs[0].value + result.feeSats, 150_000);
  });

  it('folds dust change into the fee', () => {
    const single = makeSnapshot(wallet, [100_000]);
    const result = buildPsbt(wallet, single, DEST_MAINNET, 99_300, 1, false);
    assert.equal(result.changeSats, 0);
    assert.equal(result.psbt.txOutputs.length, 1);
    assert.equal(result.feeSats, 100_000 - 99_300);
  });

  it('supports fractional and sub-1 sat/vB fee rates', () => {
    const single = makeSnapshot(wallet, [200_000]);
    const cheap = buildPsbt(wallet, single, DEST_MAINNET, 100_000, 0.5, false);
    const normal = buildPsbt(wallet, single, DEST_MAINNET, 100_000, 1, false);
    const dear = buildPsbt(wallet, single, DEST_MAINNET, 100_000, 1.5, false);
    assert.ok(cheap.feeSats < normal.feeSats, `${cheap.feeSats} !< ${normal.feeSats}`);
    assert.ok(normal.feeSats < dear.feeSats);
    // A sub-1 rate still pays a whole number of sats, rounded up.
    assert.ok(Number.isInteger(cheap.feeSats) && cheap.feeSats > 0);
    // Roughly half of the 1 sat/vB fee, allowing for rounding.
    assert.ok(Math.abs(cheap.feeSats - normal.feeSats / 2) <= 2);
  });

  it('refuses a zero or negative fee rate', () => {
    const single = makeSnapshot(wallet, [200_000]);
    assert.throws(() => buildPsbt(wallet, single, DEST_MAINNET, 100_000, 0, false), /greater than zero/i);
    assert.throws(() => buildPsbt(wallet, single, DEST_MAINNET, 100_000, -1, false), /greater than zero/i);
    assert.throws(() => buildPsbt(wallet, single, DEST_MAINNET, 0, NaN, true), /greater than zero/i);
  });

  it('prefers confirmed coins and flags a chained spend', () => {
    const mixed = makeSnapshot(wallet, [30_000, 90_000]);
    mixed.utxos[1].confirmed = false; // the bigger coin is still in the mempool
    // Value-first selection would grab the 90k unconfirmed coin; confirmed wins.
    const small = buildPsbt(wallet, mixed, DEST_MAINNET, 20_000, 5, false);
    assert.equal(small.usedUtxos.length, 1);
    assert.equal(small.usedUtxos[0].value, 30_000);
    assert.equal(small.spendsUnconfirmed, false);

    // When the confirmed coins cannot cover it, the unconfirmed one is used
    // and the result says so.
    const big = buildPsbt(wallet, mixed, DEST_MAINNET, 100_000, 5, false);
    assert.ok(big.usedUtxos.some((u) => !u.confirmed));
    assert.equal(big.spendsUnconfirmed, true);
  });

  it('rejects dust sends and insufficient funds', () => {
    assert.throws(() => buildPsbt(wallet, snapshot, DEST_MAINNET, 100, 5, false), /dust/i);
    assert.throws(() => buildPsbt(wallet, snapshot, DEST_MAINNET, 10_000_000, 5, false), /not enough funds/i);
  });

  it('never underpays: real vsize stays at or below the estimate', () => {
    const result = buildPsbt(wallet, snapshot, DEST_MAINNET, 120_000, 10, false);
    const copies = [0, 1].map(() => parsePsbt(result.psbt.toBase64(), 'mainnet'));
    signPsbtWithMnemonic(copies[0], MNEMONICS[0], wallet);
    signPsbtWithMnemonic(copies[1], MNEMONICS[1], wallet);
    const merged = combinePsbts(copies[0], copies[1]);
    const tx = bitcoin.Transaction.fromHex(finalizeAndExtract(merged));
    const estimated = estimateVsize(wallet, 2, [DEST_MAINNET, deriveAddress(wallet, 1, 0).address]);
    assert.ok(tx.virtualSize() <= estimated, `real ${tx.virtualSize()} > estimated ${estimated}`);
  });
});

describe('multi-party signing flows', () => {
  for (const [m, n] of [
    [2, 2],
    [2, 3],
    [3, 5],
  ] as const) {
    it(`${m}-of-${n}: completes with exactly ${m} signatures`, () => {
      const wallet = makeWallet(m, MNEMONICS.slice(0, n));
      const snapshot = makeSnapshot(wallet, [200_000]);
      const built = buildPsbt(wallet, snapshot, DEST_MAINNET, 150_000, 8, false);

      // Each signer signs an independent copy (simulating share → sign → return).
      const copies = Array.from({ length: m }, () => parsePsbt(built.psbt.toBase64(), 'mainnet'));
      copies.forEach((copy, i) => {
        assert.equal(signPsbtWithMnemonic(copy, MNEMONICS[i], wallet), 1);
      });

      // Merge progressively; completeness flips only at the threshold.
      const merged = parsePsbt(built.psbt.toBase64(), 'mainnet');
      copies.forEach((copy, i) => {
        combinePsbts(merged, copy);
        const summary = summarisePsbt(merged, wallet);
        assert.equal(summary.signedBy.length, i + 1);
        assert.equal(summary.complete, i + 1 >= m);
        if (i + 1 < m) assert.throws(() => finalizeAndExtract(parsePsbt(merged.toBase64(), 'mainnet')));
      });

      const tx = bitcoin.Transaction.fromHex(finalizeAndExtract(merged));
      assert.equal(tx.outs.length, 2);
      assert.equal(unsignedTxId(parsePsbt(built.psbt.toBase64(), 'mainnet')), tx.getId());
    });
  }

  it('identifies exactly which cosigners have signed', () => {
    const wallet = makeWallet(2, MNEMONICS.slice(0, 3));
    const built = buildPsbt(wallet, makeSnapshot(wallet, [100_000]), DEST_MAINNET, 50_000, 5, false);
    const psbt = parsePsbt(built.psbt.toBase64(), 'mainnet');
    signPsbtWithMnemonic(psbt, MNEMONICS[2], wallet);
    const summary = summarisePsbt(psbt, wallet);
    assert.deepEqual(summary.signedBy, [wallet.cosigners[2].fingerprint]);
  });

  it('signing twice with the same key adds nothing', () => {
    const wallet = makeWallet(2, MNEMONICS.slice(0, 2));
    const built = buildPsbt(wallet, makeSnapshot(wallet, [100_000]), DEST_MAINNET, 50_000, 5, false);
    const psbt = parsePsbt(built.psbt.toBase64(), 'mainnet');
    assert.equal(signPsbtWithMnemonic(psbt, MNEMONICS[0], wallet), 1);
    assert.equal(signPsbtWithMnemonic(psbt, MNEMONICS[0], wallet), 0);
  });

  it('a non-member key cannot sign', () => {
    const wallet = makeWallet(2, MNEMONICS.slice(0, 2));
    const built = buildPsbt(wallet, makeSnapshot(wallet, [100_000]), DEST_MAINNET, 50_000, 5, false);
    const psbt = parsePsbt(built.psbt.toBase64(), 'mainnet');
    assert.equal(signPsbtWithMnemonic(psbt, MNEMONICS[4], wallet), 0);
  });
});

describe('PSBT transport', () => {
  const wallet = makeWallet(2, MNEMONICS.slice(0, 2));
  const snapshot = makeSnapshot(wallet, [100_000]);

  it('parses base64 and hex encodings', () => {
    const built = buildPsbt(wallet, snapshot, DEST_MAINNET, 50_000, 5, false);
    const b64 = built.psbt.toBase64();
    const hex = built.psbt.toHex();
    assert.equal(unsignedTxId(parsePsbt(b64, 'mainnet')), unsignedTxId(parsePsbt(hex, 'mainnet')));
    assert.equal(unsignedTxId(parsePsbt(`  ${b64}\n`, 'mainnet')), unsignedTxId(parsePsbt(b64, 'mainnet')));
  });

  it('rejects text that is not a PSBT', () => {
    assert.throws(() => parsePsbt('definitely not a psbt', 'mainnet'), /valid transaction/i);
    assert.throws(() => parsePsbt('deadbeef', 'mainnet'), /valid transaction/i);
  });

  it('finds the transaction inside a message written around it', () => {
    const built = buildPsbt(wallet, snapshot, DEST_MAINNET, 50_000, 5, false);
    const b64 = built.psbt.toBase64();
    const hex = built.psbt.toHex();
    const want = unsignedTxId(built.psbt);
    const wrapped = `Please sign this in Simple Multisig: open the wallet, tap Import, choose Paste.\n\n${b64}`;
    assert.equal(unsignedTxId(parsePsbt(wrapped, 'mainnet')), want);
    assert.equal(unsignedTxId(parsePsbt(`Here you go: ${hex}. Thanks!`, 'mainnet')), want);
    assert.throws(() => parsePsbt('A message with no transaction in it at all.', 'mainnet'), /valid transaction/i);
  });

  it('distinguishes different transactions by unsigned txid', () => {
    const a = buildPsbt(wallet, snapshot, DEST_MAINNET, 50_000, 5, false);
    const b = buildPsbt(wallet, snapshot, DEST_MAINNET, 60_000, 5, false);
    assert.notEqual(unsignedTxId(a.psbt), unsignedTxId(b.psbt));
  });
});

describe('signature exchange between two people', () => {
  const wallet = makeWallet(2, MNEMONICS.slice(0, 3));
  const built = buildPsbt(wallet, makeSnapshot(wallet, [200_000]), DEST_MAINNET, 120_000, 5, false);

  /** Sign a copy the way one device would, returning the wire format. */
  function signAs(base64: string, mnemonic: string): string {
    const psbt = parsePsbt(base64, 'mainnet');
    signPsbtWithMnemonic(psbt, mnemonic, wallet);
    return psbt.toBase64();
  }

  it("adds the other person's signature and says so", () => {
    const mine = built.psbt.toBase64();
    const theirs = signAs(mine, MNEMONICS[1]);

    const result = mergeSignatures(mine, theirs, 'mainnet');
    assert.equal(result.added, true, 'a new signature must register as added');
    assert.equal(
      summarisePsbt(parsePsbt(result.base64, 'mainnet'), wallet).signedBy.length,
      1
    );
  });

  it('reports nothing added when their copy has no new signatures', () => {
    const mine = signAs(built.psbt.toBase64(), MNEMONICS[0]);
    // They send back a copy carrying only the signature we already have.
    const echo = mergeSignatures(mine, mine, 'mainnet');
    assert.equal(echo.added, false);
    assert.equal(echo.base64, mine, 'an echo must not disturb our copy');

    // An unsigned copy arriving late must not wipe our signature either.
    const stale = mergeSignatures(mine, built.psbt.toBase64(), 'mainnet');
    assert.equal(stale.added, false);
    assert.equal(summarisePsbt(parsePsbt(stale.base64, 'mainnet'), wallet).signedBy.length, 1);
  });

  it('completes a 2-of-3 when each side signs its own copy independently', () => {
    const original = built.psbt.toBase64();
    // Both start from the same unsigned draft, as they would over a relay.
    const alice = signAs(original, MNEMONICS[0]);
    const bob = signAs(original, MNEMONICS[1]);

    // Alice receives Bob's copy.
    const merged = mergeSignatures(alice, bob, 'mainnet');
    assert.equal(merged.added, true);
    const summary = summarisePsbt(parsePsbt(merged.base64, 'mainnet'), wallet);
    assert.equal(summary.signedBy.length, 2);
    assert.ok(summary.complete, 'threshold reached, so it must be ready to broadcast');
    assert.doesNotThrow(() => finalizeAndExtract(parsePsbt(merged.base64, 'mainnet')));
  });

  it('refuses a copy of a different transaction', () => {
    const other = buildPsbt(wallet, makeSnapshot(wallet, [200_000]), DEST_MAINNET, 99_000, 5, false);
    assert.throws(
      () => mergeSignatures(built.psbt.toBase64(), other.psbt.toBase64(), 'mainnet'),
      /different transaction/i
    );
  });

  it('merging is order independent and repeatable', () => {
    const original = built.psbt.toBase64();
    const a = signAs(original, MNEMONICS[0]);
    const b = signAs(original, MNEMONICS[2]);

    const ab = mergeSignatures(a, b, 'mainnet').base64;
    const ba = mergeSignatures(b, a, 'mainnet').base64;
    assert.equal(ab, ba, 'whoever merges first must reach the same result');

    // Re-delivering the same message (relays repeat) changes nothing.
    assert.equal(mergeSignatures(ab, b, 'mainnet').added, false);
  });
});

describe('finished drafts', () => {
  const wallet = makeWallet(2, MNEMONICS.slice(0, 2));
  const snapshot = makeSnapshot(wallet, [200_000, 60_000]);
  const built = buildPsbt(wallet, snapshot, DEST_MAINNET, 120_000, 5, false);
  const draft = built.psbt.toBase64();
  const spent = outpointKeys(snapshot.utxos);
  const none = new Set<string>();

  it('leaves a draft alone while its coins are still spendable', () => {
    assert.equal(isDraftSettled(draft, 'mainnet', spent, none), false);
  });

  it('settles once the transaction is in our history', () => {
    const history = new Set([unsignedTxId(built.psbt)]);
    assert.equal(isDraftSettled(draft, 'mainnet', spent, history), true);
  });

  it('settles the moment its coin stops being unspent', () => {
    // What broadcasting does: the input leaves the UTXO set immediately,
    // before any confirmation and before history catches up.
    const afterBroadcast = new Set(
      [...spent].filter((k) => k !== `${built.usedUtxos[0].txid}:${built.usedUtxos[0].vout}`)
    );
    assert.equal(isDraftSettled(draft, 'mainnet', afterBroadcast, none), true);
  });

  it('settles when a different transaction spends the same coin', () => {
    // A competing spend the wallet never signed still kills this draft.
    assert.equal(isDraftSettled(draft, 'mainnet', new Set(), none), true);
  });

  it('signed and unsigned copies share a txid, so matching works either way', () => {
    const signed = parsePsbt(draft, 'mainnet');
    signPsbtWithMnemonic(signed, MNEMONICS[0], wallet);
    assert.equal(unsignedTxId(signed), unsignedTxId(built.psbt));
    const history = new Set([unsignedTxId(built.psbt)]);
    assert.equal(isDraftSettled(signed.toBase64(), 'mainnet', spent, history), true);
  });
});

describe('signing with an external card', () => {
  const wallet = makeWallet(2, MNEMONICS.slice(0, 2));
  const built = buildPsbt(wallet, makeSnapshot(wallet, [200_000, 90_000]), DEST_MAINNET, 250_000, 5, false);
  const draft = built.psbt.toBase64();

  /** Stands in for the card: signs the digest with the real key. */
  function cardSign(job: { digest: Buffer; subpath: [number, number] }, mnemonic: string): Buffer {
    const root = rootFromMnemonic(mnemonic, 'mainnet');
    const node = root.derivePath(bip48Path('mainnet')).derive(job.subpath[0]).derive(job.subpath[1]);
    return Buffer.from(node.sign(job.digest));
  }

  it('asks for one job per input the key owns', () => {
    const jobs = signingJobsFor(draft, masterFingerprint(MNEMONICS[0]), 'mainnet');
    assert.equal(jobs.length, 2, 'both inputs belong to this wallet');
    for (const job of jobs) {
      assert.equal(job.digest.length, 32);
      assert.equal(job.subpath.length, 2);
      assert.ok(job.subpath.every((s) => s >= 0 && s < 0x80000000), 'subpaths must be unhardened');
      assert.equal(job.pubkey.length, 33);
    }
  });

  it('produces digests a real key signs into a valid transaction', () => {
    // Both cosigners sign only the digests the jobs describe — exactly what a
    // card does — and the result must finalize.
    let base64 = draft;
    for (const mnemonic of [MNEMONICS[0], MNEMONICS[1]]) {
      const jobs = signingJobsFor(base64, masterFingerprint(mnemonic), 'mainnet');
      base64 = attachSignatures(
        base64,
        'mainnet',
        jobs.map((job) => ({ job, signature: cardSign(job, mnemonic) }))
      );
    }
    const summary = summarisePsbt(parsePsbt(base64, 'mainnet'), wallet);
    assert.equal(summary.signedBy.length, 2);
    assert.ok(summary.complete);
    assert.doesNotThrow(() => finalizeAndExtract(parsePsbt(base64, 'mainnet')));
  });

  it('skips inputs the key has already signed', () => {
    const jobs = signingJobsFor(draft, masterFingerprint(MNEMONICS[0]), 'mainnet');
    const partly = attachSignatures(draft, 'mainnet', [
      { job: jobs[0], signature: cardSign(jobs[0], MNEMONICS[0]) },
    ]);
    assert.equal(signingJobsFor(partly, masterFingerprint(MNEMONICS[0]), 'mainnet').length, 1);
  });

  it('asks nothing of a key that is not in the wallet', () => {
    assert.equal(signingJobsFor(draft, masterFingerprint(MNEMONICS[4]), 'mainnet').length, 0);
  });

  it('refuses a signature that does not match the transaction', () => {
    const jobs = signingJobsFor(draft, masterFingerprint(MNEMONICS[0]), 'mainnet');
    // A signature over the wrong input — the card slipped, or a hostile reply.
    const wrong = cardSign(jobs[1], MNEMONICS[0]);
    assert.throws(
      () => attachSignatures(draft, 'mainnet', [{ job: jobs[0], signature: wrong }]),
      /does not match this transaction/
    );
  });
});

describe('reading a signed transaction back off a card', () => {
  // Mirrors what readPsbtFromTag does with each NDEF payload, so the
  // recognition rules are pinned without needing a card.
  const PSBT_MAGIC = Buffer.from([0x70, 0x73, 0x62, 0x74, 0xff]);
  const wallet = makeWallet(2, MNEMONICS.slice(0, 2));
  const built = buildPsbt(wallet, makeSnapshot(wallet, [100_000]), DEST_MAINNET, 50_000, 5, false);
  const base64 = built.psbt.toBase64();
  const raw = Buffer.from(base64, 'base64');

  it('a serialised PSBT starts with the magic the reader looks for', () => {
    assert.ok(raw.subarray(0, 5).equals(PSBT_MAGIC));
    assert.ok(base64.startsWith('cHNidP'), 'and its base64 always starts cHNidP');
  });

  it('binary, base64 and hex forms all round-trip to the same transaction', () => {
    const fromBinary = raw.toString('base64');
    const fromHex = Buffer.from(raw.toString('hex'), 'hex').toString('base64');
    for (const candidate of [fromBinary, base64, fromHex]) {
      assert.equal(unsignedTxId(parsePsbt(candidate, 'mainnet')), unsignedTxId(built.psbt));
    }
  });

  it('finds the PSBT even when a record carries a prefix before it', () => {
    // Some writers put a header ahead of the payload; the reader seeks the magic.
    const prefixed = Buffer.concat([Buffer.from('junk'), raw]);
    const at = prefixed.indexOf(PSBT_MAGIC);
    assert.ok(at > 0);
    assert.equal(
      unsignedTxId(parsePsbt(prefixed.subarray(at).toString('base64'), 'mainnet')),
      unsignedTxId(built.psbt)
    );
  });

  it('a signed copy read back merges into the draft', () => {
    const signed = parsePsbt(base64, 'mainnet');
    signPsbtWithMnemonic(signed, MNEMONICS[0], wallet);
    // What comes off the tag is bytes; the app hands the base64 to the merge.
    const offTag = Buffer.from(signed.toBase64(), 'base64').toString('base64');
    const merged = mergeSignatures(base64, offTag, 'mainnet');
    assert.equal(merged.added, true);
  });
});

describe('pulling a PSBT off an NFC tag', () => {
  const wallet = makeWallet(2, MNEMONICS.slice(0, 2));
  const built = buildPsbt(wallet, makeSnapshot(wallet, [100_000]), DEST_MAINNET, 50_000, 5, false);
  const base64 = built.psbt.toBase64();
  const raw = Buffer.from(base64, 'base64');

  /** An NDEF text record: status byte, language code, then the text. */
  function textRecord(text: string, lang = 'en'): Buffer {
    return Buffer.concat([
      Buffer.from([lang.length]),
      Buffer.from(lang, 'ascii'),
      Buffer.from(text, 'utf8'),
    ]);
  }

  it('reads a binary record, which is what a card writes', () => {
    assert.equal(extractPsbt([raw], 'mainnet'), base64);
  });

  it('reads base64 or hex from a text record, language header and all', () => {
    assert.equal(extractPsbt([textRecord(base64)], 'mainnet'), base64);
    assert.equal(extractPsbt([textRecord(raw.toString('hex'))], 'mainnet'), base64);
    // Some writers wrap long text; whitespace must not defeat it.
    assert.equal(extractPsbt([textRecord(base64.replace(/(.{40})/g, '$1\n'))], 'mainnet'), base64);
  });

  it('finds the transaction among several records', () => {
    const filename = textRecord('signed-abc123.psbt');
    assert.equal(extractPsbt([filename, raw], 'mainnet'), base64);
  });

  it('skips a header in front of the transaction', () => {
    assert.equal(extractPsbt([Buffer.concat([Buffer.from('HDR!'), raw])], 'mainnet'), base64);
  });

  it('never returns something that will not parse', () => {
    // The old reader handed back the first thing that merely looked right.
    const truncated = raw.subarray(0, 20);
    assert.throws(() => extractPsbt([truncated], 'mainnet'), /Could not read the transaction/);
  });

  it('says what was on the tag when it finds nothing usable', () => {
    const junk = Buffer.from('nothing here', 'utf8');
    // The reason names the record and what it held, so a failure is diagnosable.
    assert.throws(() => extractPsbt([junk], 'mainnet'), /#0: no transaction in it \(12 bytes/);
    assert.throws(() => extractPsbt([], 'mainnet'), /Nothing to read/);
  });

  it('decodes NDEF text headers of any language length', () => {
    assert.equal(decodeNdefText(textRecord('hello', 'en')), 'hello');
    assert.equal(decodeNdefText(textRecord('hello', 'en-GB')), 'hello');
    assert.equal(decodeNdefText(Buffer.alloc(0)), '');
  });
});

describe('removing a surplus signature', () => {
  const wallet = makeWallet(2, MNEMONICS.slice(0, 3));
  const snapshot = makeSnapshot(wallet, [100_000]);

  /** A 2-of-3 draft that every one of the three keys has signed. */
  function overSigned(): string {
    const { psbt } = buildPsbt(wallet, snapshot, DEST_MAINNET, 50_000, 5, false);
    for (const m of MNEMONICS.slice(0, 3)) signPsbtWithMnemonic(psbt, m, wallet);
    return psbt.toBase64();
  }

  it('cannot be finalised while over-signed', () => {
    const summary = summarisePsbt(parsePsbt(overSigned(), 'mainnet'), wallet);
    assert.equal(summary.sigCounts[0], 3);
    assert.ok(summary.overSigned);
    assert.throws(() => finalizeAndExtract(parsePsbt(overSigned(), 'mainnet')), /Too many signatures/i);
  });

  it('broadcasts once the surplus is removed', () => {
    const trimmed = removeSignature(overSigned(), 'mainnet', masterFingerprint(MNEMONICS[2]));
    const psbt = parsePsbt(trimmed, 'mainnet');
    const summary = summarisePsbt(psbt, wallet);
    assert.equal(summary.sigCounts[0], 2);
    assert.ok(!summary.overSigned);
    assert.ok(summary.complete);
    assert.ok(!summary.signedBy.includes(masterFingerprint(MNEMONICS[2])));
    assert.ok(finalizeAndExtract(psbt).length > 0);
  });

  it('leaves the other signatures verifiable', () => {
    const trimmed = removeSignature(overSigned(), 'mainnet', masterFingerprint(MNEMONICS[0]));
    const psbt = parsePsbt(trimmed, 'mainnet');
    assert.deepEqual(summarisePsbt(psbt, wallet).signedBy.sort(), [
      masterFingerprint(MNEMONICS[1]),
      masterFingerprint(MNEMONICS[2]),
    ].sort());
    // The remaining signatures still satisfy the script.
    assert.ok(finalizeAndExtract(psbt).length > 0);
  });

  it('drops the field rather than leaving an empty one behind', () => {
    const { psbt } = buildPsbt(wallet, snapshot, DEST_MAINNET, 50_000, 5, false);
    signPsbtWithMnemonic(psbt, MNEMONICS[0], wallet);
    const trimmed = removeSignature(psbt.toBase64(), 'mainnet', masterFingerprint(MNEMONICS[0]));
    const after = parsePsbt(trimmed, 'mainnet');
    assert.equal(after.data.inputs[0].partialSig, undefined);
    assert.equal(summarisePsbt(after, wallet).signedBy.length, 0);
  });

  it('refuses to remove a signature that is not there', () => {
    const { psbt } = buildPsbt(wallet, snapshot, DEST_MAINNET, 50_000, 5, false);
    signPsbtWithMnemonic(psbt, MNEMONICS[0], wallet);
    assert.throws(
      () => removeSignature(psbt.toBase64(), 'mainnet', masterFingerprint(MNEMONICS[1])),
      /has not signed/i
    );
  });
});

describe('coin control', () => {
  const wallet = makeWallet(2, MNEMONICS.slice(0, 3));
  const snapshot = makeSnapshot(wallet, [100_000, 50_000, 20_000]);
  const outpoint = (u: { txid: string; vout: number }) => `${u.txid}:${u.vout}`;
  const of = (value: number) => outpoint(snapshot.utxos.find((u) => u.value === value)!);

  it('spends every chosen coin, even when one would do', () => {
    // 100k alone covers a 10k send; choosing two must still spend both.
    const { psbt, usedUtxos, changeSats } = buildPsbt(
      wallet, snapshot, DEST_MAINNET, 10_000, 5, false, [of(100_000), of(20_000)]
    );
    assert.equal(usedUtxos.length, 2);
    assert.deepEqual(usedUtxos.map((u) => u.value).sort((a, b) => b - a), [100_000, 20_000]);
    assert.equal(psbt.data.inputs.length, 2);
    assert.ok(changeSats > 0);
  });

  it('ignores coins that were not chosen', () => {
    const { usedUtxos } = buildPsbt(wallet, snapshot, DEST_MAINNET, 10_000, 5, false, [of(50_000)]);
    assert.deepEqual(usedUtxos.map((u) => u.value), [50_000]);
  });

  it('picks coins itself when none are chosen', () => {
    const { usedUtxos } = buildPsbt(wallet, snapshot, DEST_MAINNET, 10_000, 5, false);
    assert.equal(usedUtxos.length, 1);
  });

  it('sends the max of the chosen coins, not the whole balance', () => {
    const { psbt, feeSats, usedUtxos } = buildPsbt(
      wallet, snapshot, DEST_MAINNET, 0, 5, true, [of(50_000), of(20_000)]
    );
    assert.equal(usedUtxos.length, 2);
    assert.equal(psbt.txOutputs.length, 1, 'send-max leaves no change');
    assert.equal(psbt.txOutputs[0].value, 70_000 - feeSats);
  });

  it('refuses an amount the chosen coins cannot cover', () => {
    assert.throws(
      () => buildPsbt(wallet, snapshot, DEST_MAINNET, 60_000, 5, false, [of(50_000)]),
      /Not enough in the chosen coins/
    );
  });

  it('refuses to build when a chosen coin has since been spent', () => {
    assert.throws(
      () => buildPsbt(wallet, snapshot, DEST_MAINNET, 10_000, 5, false, [of(50_000), 'deadbeef:0']),
      /no longer available/
    );
  });

  it('produces a spendable transaction from the chosen coins', () => {
    const { psbt } = buildPsbt(wallet, snapshot, DEST_MAINNET, 25_000, 5, false, [of(50_000)]);
    for (const m of MNEMONICS.slice(0, 2)) signPsbtWithMnemonic(psbt, m, wallet);
    assert.ok(summarisePsbt(psbt, wallet).complete);
    assert.ok(finalizeAndExtract(psbt).length > 0);
  });
});

describe('hostile PSBT defences', () => {
  const wallet = makeWallet(2, MNEMONICS.slice(0, 3));

  // A prevout the wallet actually owns, for a believable input.
  function walletInput(psbt: bitcoin.Psbt, branch: number, index: number, value: number) {
    const d = deriveAddress(wallet, branch, index);
    psbt.addInput({
      hash: Buffer.alloc(32, 1),
      index: 0,
      witnessUtxo: { script: d.script, value },
      witnessScript: d.witnessScript,
      bip32Derivation: d.derivations,
    });
  }

  it('does not accept a payment as change just because it carries a derivation', () => {
    const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });
    walletInput(psbt, 0, 0, 100_000);

    // An address controlled by someone else, dressed up with the derivation
    // metadata copied from the wallet's real change path.
    const attacker = deriveAddress(makeWallet(2, MNEMONICS.slice(2, 5)), 1, 0);
    const realChange = deriveAddress(wallet, 1, 0);
    psbt.addOutput({ script: attacker.script, value: 90_000 });
    psbt.data.outputs[0].bip32Derivation = realChange.derivations;

    const summary = summarisePsbt(psbt, wallet);
    assert.equal(summary.outputs[0].isChange, false);
    assert.equal(summary.amountLeaving, 90_000);
    assert.equal(summary.changeTotal, 0);
    assert.ok(summary.allInputsOurs);
  });

  it('recognises genuine change re-derived from the wallet', () => {
    const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });
    walletInput(psbt, 0, 0, 100_000);
    const change = deriveAddress(wallet, 1, 3);
    psbt.addOutput({ script: change.script, value: 90_000 });
    psbt.data.outputs[0].bip32Derivation = change.derivations;

    const summary = summarisePsbt(psbt, wallet);
    assert.equal(summary.outputs[0].isChange, true);
    assert.equal(summary.changeTotal, 90_000);
    assert.equal(summary.amountLeaving, 0);
  });

  it('flags a draft that spends coins the wallet cannot re-derive', () => {
    const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });
    // Input belonging to a different wallet — not ours.
    const foreign = deriveAddress(makeWallet(2, MNEMONICS.slice(2, 5)), 0, 0);
    psbt.addInput({
      hash: Buffer.alloc(32, 2),
      index: 0,
      witnessUtxo: { script: foreign.script, value: 100_000 },
      witnessScript: foreign.witnessScript,
      bip32Derivation: foreign.derivations,
    });
    psbt.addOutput({ script: deriveAddress(wallet, 0, 0).script, value: 90_000 });

    assert.equal(summarisePsbt(psbt, wallet).allInputsOurs, false);
  });
})

describe('inbound PSBT bounds', () => {
  const wallet = makeWallet(2, MNEMONICS.slice(0, 3));
  const snapshot = makeSnapshot(wallet, [100_000, 50_000]);

  it('accepts a normal draft', () => {
    const { psbt } = buildPsbt(wallet, snapshot, DEST_MAINNET, 120_000, 10, false);
    const roundTripped = parseIncomingPsbt(psbt.toBase64(), 'mainnet');
    assert.equal(unsignedTxId(roundTripped), unsignedTxId(psbt));
  });

  it('refuses an oversized text before parsing it', () => {
    assert.throws(
      () => parseIncomingPsbt('a'.repeat(MAX_INCOMING_PSBT_CHARS + 1), 'mainnet'),
      /far larger/
    );
  });

  it('refuses a draft with an unreasonable number of inputs', () => {
    const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });
    const d = deriveAddress(wallet, 0, 0);
    for (let i = 0; i < MAX_PSBT_INPUTS + 1; i++) {
      psbt.addInput({
        hash: Buffer.alloc(32, 7),
        index: i, // distinct outpoints
        witnessUtxo: { script: d.script, value: 100_000 },
        witnessScript: d.witnessScript,
      });
    }
    assert.throws(() => parseIncomingPsbt(psbt.toBase64(), 'mainnet'), /unreasonable/);
  });

  it('refuses a draft with an unreasonable number of outputs', () => {
    const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });
    const d = deriveAddress(wallet, 0, 0);
    psbt.addInput({
      hash: Buffer.alloc(32, 7),
      index: 0,
      witnessUtxo: { script: d.script, value: 100_000_000 },
      witnessScript: d.witnessScript,
    });
    for (let i = 0; i < MAX_PSBT_OUTPUTS + 1; i++) {
      psbt.addOutput({ script: d.script, value: 1_000 });
    }
    assert.throws(() => parseIncomingPsbt(psbt.toBase64(), 'mainnet'), /unreasonable/);
  });

  it('caps unfinished drafts by one rule, whoever brings them', () => {
    assert.equal(atDraftLimit(MAX_PENDING_DRAFTS - 1), false);
    assert.equal(atDraftLimit(MAX_PENDING_DRAFTS), true);
    assert.doesNotThrow(() => assertDraftRoom(MAX_PENDING_DRAFTS - 1));
    assert.throws(() => assertDraftRoom(MAX_PENDING_DRAFTS), /unfinished transactions/);
  });

  it('refuses to merge signatures from an oversized copy', () => {
    const { psbt } = buildPsbt(wallet, snapshot, DEST_MAINNET, 120_000, 10, false);
    assert.throws(
      () => mergeSignatures(psbt.toBase64(), 'a'.repeat(MAX_INCOMING_PSBT_CHARS + 1), 'mainnet'),
      /far larger/
    );
  });
})
