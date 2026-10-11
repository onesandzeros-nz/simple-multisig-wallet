import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySharedNames,
  backfillSharedNames,
  isPlaceholderName,
  namesByXpub,
  sharedNamesFor,
} from '../src/lib/cosignerNames';
import { Cosigner, MultisigWallet } from '../src/lib/types';

const key = (xpub: string, name: string, keyId?: string): Cosigner => ({
  name,
  fingerprint: 'deadbeef',
  path: "m/48'/0'/0'/2'",
  xpub,
  ...(keyId ? { keyId } : {}),
});

const walletOf = (cosigners: Cosigner[]): MultisigWallet => ({
  id: 'w',
  kind: 'group',
  name: 'Vault',
  m: 2,
  n: cosigners.length,
  network: 'mainnet',
  scriptType: 'P2WSH',
  cosigners,
  createdAt: 1,
});

describe('shared cosigner names', () => {
  // The descriptor the coordinator shares lists keys A, B, C in that order.
  const descriptorKeys = [key('xpubA', 'Cosigner 1'), key('xpubB', 'Cosigner 2'), key('xpubC', 'Cosigner 3')];

  it('the coordinator shares its own names, in the descriptor’s key order', () => {
    // Its wallet holds the same keys in another order.
    const wallet = walletOf([key('xpubC', 'Rob · Ledger', 'k1'), key('xpubA', 'Alice'), key('xpubB', 'Bob')]);
    assert.deepEqual(sharedNamesFor(wallet, descriptorKeys), ['Alice', 'Bob', 'Rob · Ledger']);
    assert.deepEqual(
      sharedNamesFor(walletOf([key('xpubA', 'Alice')]), descriptorKeys),
      ['Alice', 'Cosigner 2', 'Cosigner 3'],
      'a key the wallet does not name keeps the parser’s name'
    );
  });

  it('believes names only when there is exactly one per key', () => {
    assert.deepEqual([...namesByXpub(descriptorKeys, ['Alice', 'Bob', 'Carol'])], [
      ['xpubA', 'Alice'],
      ['xpubB', 'Bob'],
      ['xpubC', 'Carol'],
    ]);
    assert.equal(namesByXpub(descriptorKeys, ['Alice', 'Bob']).size, 0, 'a different build');
    assert.equal(namesByXpub(descriptorKeys, undefined).size, 0, 'an older build sent none');
    assert.deepEqual([...namesByXpub(descriptorKeys, ['Alice', '  ', 'Carol']).keys()], ['xpubA', 'xpubC'], 'a blank is no name');
  });

  it('names the keys a member receives, but never the one they hold', () => {
    const names = namesByXpub(descriptorKeys, ['Alice', 'Bob', 'Carol']);
    const mine = key('xpubB', "Rob's phone", 'k1');
    const named = applySharedNames([key('xpubA', 'Cosigner 1'), mine, key('xpubC', 'Cosigner 3')], names);
    assert.deepEqual(
      named.map((c) => c.name),
      ['Alice', "Rob's phone", 'Carol']
    );
    assert.equal(named[1], mine, 'untouched, not copied');
  });

  it('fills in placeholders on a wallet added before names were shared, and nothing else', () => {
    assert.ok(isPlaceholderName('Cosigner 12') && !isPlaceholderName('Alice') && !isPlaceholderName('Cosigner'));
    const names = namesByXpub(descriptorKeys, ['Alice', 'Bob', 'Carol']);
    const wallet = walletOf([
      key('xpubC', 'Cosigner 3'),
      key('xpubA', 'Alice from work'), // renamed by hand: theirs to keep
      key('xpubB', "Rob's phone", 'k1'),
    ]);
    const filled = backfillSharedNames(wallet, names);
    assert.ok(filled);
    assert.deepEqual(
      filled.cosigners.map((c) => c.name),
      ['Carol', 'Alice from work', "Rob's phone"]
    );
    assert.equal(backfillSharedNames(filled, names), null, 'nothing left to fill in');
    assert.equal(backfillSharedNames(wallet, new Map()), null, 'no names, no change');
  });
});
