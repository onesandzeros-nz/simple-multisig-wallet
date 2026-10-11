import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { linkCosigners, renameCosigners } from '../src/lib/linkCosigners';
import { accountXpub, bip48Path, masterFingerprint } from '../src/lib/bitcoin';
import { MultisigWallet, NetworkName, SignerKey } from '../src/lib/types';
import { MNEMONICS, makeWallet } from './helpers';

function unlinked(wallet: MultisigWallet): MultisigWallet {
  return {
    ...wallet,
    cosigners: wallet.cosigners.map((c) => ({ ...c, keyId: undefined, name: 'Someone' })),
  };
}

function localKey(id: string, mnemonic: string, name = id): SignerKey {
  return { id, name, type: 'local', fingerprint: masterFingerprint(mnemonic), createdAt: 0 };
}

function importedKey(id: string, mnemonic: string, name = id): SignerKey {
  return {
    id,
    name,
    type: 'imported',
    fingerprint: masterFingerprint(mnemonic),
    xpub: accountXpub(mnemonic, 'mainnet'),
    path: bip48Path('mainnet'),
    network: 'mainnet',
    createdAt: 0,
  };
}

/**
 * The xpub proof store.tsx supplies in the app: each local key's account
 * xpub re-derived from its seed, per network.
 */
function resolverFor(pairs: [string, string][]): (keyId: string, network: NetworkName) => string | undefined {
  const map = new Map(
    pairs.map(([id, mn]) => [
      id,
      { mainnet: accountXpub(mn, 'mainnet'), testnet: accountXpub(mn, 'testnet') },
    ])
  );
  return (keyId, network) => map.get(keyId)?.[network];
}

describe('cosigner ↔ key linking', () => {
  it('links keys added after the wallet was imported', () => {
    const wallet = unlinked(makeWallet(2, MNEMONICS.slice(0, 3)));
    const keys = [localKey('local-0', MNEMONICS[0]), importedKey('imported-1', MNEMONICS[1])];

    const { wallets, changed } = linkCosigners([wallet], keys, resolverFor([['local-0', MNEMONICS[0]]]));

    assert.equal(changed, true);
    assert.equal(wallets[0].cosigners[0].keyId, 'local-0');
    assert.equal(wallets[0].cosigners[0].name, 'local-0');
    assert.equal(wallets[0].cosigners[1].keyId, 'imported-1');
    assert.equal(wallets[0].cosigners[2].keyId, undefined);
  });

  it('reports no change when everything is already linked', () => {
    const wallet = makeWallet(2, MNEMONICS.slice(0, 2));
    const keys = [localKey('key-0', MNEMONICS[0]), localKey('key-1', MNEMONICS[1])];

    const { wallets, changed } = linkCosigners([wallet], keys);

    assert.equal(changed, false);
    assert.equal(wallets[0], wallet);
  });

  it('clears references to deleted keys', () => {
    const wallet = makeWallet(2, MNEMONICS.slice(0, 2));

    const { wallets, changed } = linkCosigners([wallet], []);

    assert.equal(changed, true);
    assert.equal(wallets[0].cosigners[0].keyId, undefined);
    assert.equal(wallets[0].cosigners[1].keyId, undefined);
  });

  it('relinks a cosigner whose key was replaced by a re-import', () => {
    const wallet = makeWallet(2, MNEMONICS.slice(0, 2));

    const { wallets } = linkCosigners(
      [wallet],
      [localKey('fresh', MNEMONICS[1])],
      resolverFor([['fresh', MNEMONICS[1]]])
    );

    assert.equal(wallets[0].cosigners[0].keyId, undefined);
    assert.equal(wallets[0].cosigners[1].keyId, 'fresh');
  });

  it('does not link an imported key whose xpub differs, even with a matching fingerprint', () => {
    const wallet = unlinked(makeWallet(2, MNEMONICS.slice(0, 2), 'testnet'));
    const mainnetKey = importedKey('imported-0', MNEMONICS[0]);

    const { wallets } = linkCosigners([wallet], [mainnetKey]);

    assert.equal(wallets[0].cosigners[0].keyId, undefined);
  });

  it('does not link a local key by its fingerprint alone', () => {
    // The cosigner carries a real key's fingerprint but a different xpub —
    // without xpub proof from the seed, no link may be made.
    const wallet = unlinked(makeWallet(2, MNEMONICS.slice(0, 2), 'testnet'));

    const { wallets } = linkCosigners([wallet], [localKey('local-0', MNEMONICS[0])]);

    assert.equal(wallets[0].cosigners[0].keyId, undefined);
  });

  it('does not link when the derived xpub differs from the cosigner xpub', () => {
    const wallet = unlinked(makeWallet(2, MNEMONICS.slice(0, 2), 'testnet'));

    const { wallets } = linkCosigners(
      [wallet],
      [localKey('local-0', MNEMONICS[0])],
      resolverFor([['local-0', MNEMONICS[2]]]) // proves a different key
    );

    assert.equal(wallets[0].cosigners[0].keyId, undefined);
  });

  it('links a local key whose re-derived xpub matches, on any network', () => {
    const wallet = unlinked(makeWallet(2, MNEMONICS.slice(0, 2), 'testnet'));

    const { wallets } = linkCosigners(
      [wallet],
      [localKey('local-0', MNEMONICS[0])],
      resolverFor([['local-0', MNEMONICS[0]]])
    );

    assert.equal(wallets[0].cosigners[0].keyId, 'local-0');
  });
});

describe('renaming a key', () => {
  it('renames the cosigner in every wallet that uses the key', () => {
    const a = makeWallet(2, MNEMONICS.slice(0, 3));
    const b = { ...makeWallet(2, MNEMONICS.slice(1, 3)), id: 'other' };
    // makeWallet numbers keys by position, so b's first cosigner is 'key-0'.
    const { wallets, changed } = renameCosigners([a, b], 'key-0', 'Coldcard in the safe');

    assert.equal(changed, true);
    assert.equal(wallets[0].cosigners[0].name, 'Coldcard in the safe');
    assert.equal(wallets[1].cosigners[0].name, 'Coldcard in the safe');
  });

  it('leaves other cosigners and everything else about the wallet alone', () => {
    const wallet = makeWallet(2, MNEMONICS.slice(0, 3));

    const { wallets } = renameCosigners([wallet], 'key-1', 'Trezor');

    assert.deepEqual(wallets[0], {
      ...wallet,
      cosigners: [wallet.cosigners[0], { ...wallet.cosigners[1], name: 'Trezor' }, wallet.cosigners[2]],
    });
  });

  it('does not rename a cosigner that is not linked to the key', () => {
    const wallet = unlinked(makeWallet(2, MNEMONICS.slice(0, 2)));

    const { wallets, changed } = renameCosigners([wallet], 'key-0', 'Trezor');

    assert.equal(changed, false);
    assert.equal(wallets[0], wallet);
  });

  it('reports no change when the name is already in place', () => {
    const wallet = makeWallet(2, MNEMONICS.slice(0, 2));

    const { wallets, changed } = renameCosigners([wallet], 'key-0', 'Signer 1');

    assert.equal(changed, false);
    assert.equal(wallets[0], wallet);
  });
});
