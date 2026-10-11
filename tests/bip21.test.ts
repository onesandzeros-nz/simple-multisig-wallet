import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePaymentTarget } from '../src/lib/bip21';
import { DEST_MAINNET } from './helpers';

describe('scanned payment targets', () => {
  it('accepts a bare address', () => {
    assert.deepEqual(parsePaymentTarget(DEST_MAINNET), { address: DEST_MAINNET });
    assert.deepEqual(parsePaymentTarget(`  ${DEST_MAINNET}\n`), { address: DEST_MAINNET });
  });

  it('lowercases uppercase bech32 from QR codes', () => {
    // QR encoders use uppercase for a smaller code; bech32 is case-insensitive.
    assert.equal(parsePaymentTarget(DEST_MAINNET.toUpperCase()).address, DEST_MAINNET);
    assert.equal(parsePaymentTarget(`bitcoin:${DEST_MAINNET.toUpperCase()}`).address, DEST_MAINNET);
  });

  it('parses a BIP21 URI with an amount in BTC', () => {
    const target = parsePaymentTarget(`bitcoin:${DEST_MAINNET}?amount=0.00125`);
    assert.equal(target.address, DEST_MAINNET);
    assert.equal(target.amountSats, 125_000);
  });

  it('handles amounts that float maths would round badly', () => {
    assert.equal(parsePaymentTarget(`bitcoin:${DEST_MAINNET}?amount=0.1`).amountSats, 10_000_000);
    assert.equal(parsePaymentTarget(`bitcoin:${DEST_MAINNET}?amount=0.00000001`).amountSats, 1);
    assert.equal(parsePaymentTarget(`bitcoin:${DEST_MAINNET}?amount=20.3`).amountSats, 2_030_000_000);
  });

  it('reads label and message, decoding escapes', () => {
    const target = parsePaymentTarget(
      `bitcoin:${DEST_MAINNET}?amount=0.001&label=Coffee%20Shop&message=Order%20%2317`
    );
    assert.equal(target.label, 'Coffee Shop');
    assert.equal(target.message, 'Order #17');
  });

  it('ignores unknown optional parameters but refuses required ones', () => {
    assert.ok(parsePaymentTarget(`bitcoin:${DEST_MAINNET}?somethingelse=1`).address);
    // BIP21: a req- parameter we do not understand must not be silently dropped.
    assert.throws(() => parsePaymentTarget(`bitcoin:${DEST_MAINNET}?req-fancy=1`), /does not support/i);
  });

  it('rejects junk', () => {
    assert.throws(() => parsePaymentTarget(''), /nothing scanned/i);
    assert.throws(() => parsePaymentTarget('bitcoin:?amount=1'), /no address/i);
    assert.throws(() => parsePaymentTarget('hello world'), /not a bitcoin address/i);
    assert.throws(() => parsePaymentTarget(`bitcoin:${DEST_MAINNET}?amount=abc`), /could not read the amount/i);
  });
});
