import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrivateWallet, resolveWalletNetwork } from '../src/lib/buildWallet';
import { accountXpub, bip48Path, masterFingerprint } from '../src/lib/bitcoin';
import { NetworkName, SignerKey } from '../src/lib/types';
import { MNEMONICS, makeWallet } from './helpers';

function localKey(id: string, mnemonic: string, name = id): SignerKey {
  return { id, name, type: 'local', fingerprint: masterFingerprint(mnemonic), createdAt: 0 };
}

function importedKey(id: string, mnemonic: string, network: NetworkName = 'mainnet', name = id): SignerKey {
  return {
    id,
    name,
    type: 'imported',
    fingerprint: masterFingerprint(mnemonic),
    xpub: accountXpub(mnemonic, network),
    path: bip48Path(network),
    network,
    createdAt: 0,
  };
}

/** A SecureStore stand-in: key id → mnemonic. */
function loaderFor(entries: [string, string][]) {
  const store = new Map(entries);
  return async (keyId: string) => store.get(keyId) ?? null;
}

const THREE = MNEMONICS.slice(0, 3);
const localKeys = THREE.map((mn, i) => localKey(`key-${i}`, mn, `Signer ${i + 1}`));
const loader = loaderFor(THREE.map((mn, i) => [`key-${i}`, mn]));

describe('buildPrivateWallet', () => {
  it('builds a 2-of-3 from three local keys matching the reference wallet', async () => {
    const wallet = await buildPrivateWallet({
      id: 'w1',
      keys: localKeys,
      m: 2,
      name: '',
      defaultNetwork: 'mainnet',
      loadMnemonic: loader,
      now: 1234,
    });
    const reference = makeWallet(2, THREE);

    assert.equal(wallet.id, 'w1');
    assert.equal(wallet.createdAt, 1234);
    assert.equal(wallet.kind, 'private');
    assert.equal(wallet.scriptType, 'P2WSH');
    assert.equal(wallet.name, '2 of 3 wallet');
    assert.equal(wallet.m, 2);
    assert.equal(wallet.n, 3);
    assert.equal(wallet.network, 'mainnet');
    assert.deepEqual(
      wallet.cosigners.map((c) => c.xpub),
      reference.cosigners.map((c) => c.xpub)
    );
    assert.deepEqual(
      wallet.cosigners.map((c) => c.fingerprint),
      reference.cosigners.map((c) => c.fingerprint)
    );
    for (const [i, c] of wallet.cosigners.entries()) {
      assert.equal(c.path, bip48Path('mainnet'));
      assert.equal(c.keyId, `key-${i}`);
      assert.equal(c.name, `Signer ${i + 1}`);
    }
  });

  it('uses the trimmed name when one is given', async () => {
    const wallet = await buildPrivateWallet({
      id: 'w2',
      keys: localKeys,
      m: 2,
      name: '  Family savings  ',
      defaultNetwork: 'mainnet',
      loadMnemonic: loader,
    });
    assert.equal(wallet.name, 'Family savings');
    assert.ok(Math.abs(wallet.createdAt - Date.now()) < 5_000);
  });

  it('derives tpub cosigners on the testnet BIP48 path when the default is testnet', async () => {
    const wallet = await buildPrivateWallet({
      id: 'w3',
      keys: localKeys,
      m: 2,
      name: '',
      defaultNetwork: 'testnet',
      loadMnemonic: loader,
    });
    const reference = makeWallet(2, THREE, 'testnet');

    assert.equal(wallet.network, 'testnet');
    for (const c of wallet.cosigners) {
      assert.ok(c.xpub.startsWith('tpub'));
      assert.equal(c.path, "m/48'/1'/0'/2'");
    }
    assert.deepEqual(
      wallet.cosigners.map((c) => c.xpub),
      reference.cosigners.map((c) => c.xpub)
    );
  });

  it('follows an imported mainnet key even when the default is testnet', async () => {
    const hw = importedKey('hw', MNEMONICS[3], 'mainnet');
    const wallet = await buildPrivateWallet({
      id: 'w4',
      keys: [localKeys[0], localKeys[1], hw],
      m: 2,
      name: '',
      defaultNetwork: 'testnet',
      loadMnemonic: loader,
    });

    assert.equal(wallet.network, 'mainnet');
    for (const c of wallet.cosigners) assert.ok(c.xpub.startsWith('xpub'));
    const imported = wallet.cosigners[2];
    assert.equal(imported.xpub, hw.xpub);
    assert.equal(imported.path, hw.path);
    assert.equal(imported.keyId, 'hw');
  });

  it('follows an imported testnet key even when the default is mainnet', async () => {
    const hw = importedKey('hw', MNEMONICS[3], 'testnet');
    const wallet = await buildPrivateWallet({
      id: 'w5',
      keys: [localKeys[0], hw],
      m: 2,
      name: '',
      defaultNetwork: 'mainnet',
      loadMnemonic: loader,
    });
    assert.equal(wallet.network, 'testnet');
    assert.ok(wallet.cosigners[0].xpub.startsWith('tpub'));
    assert.equal(wallet.cosigners[0].path, bip48Path('testnet'));
  });

  it('refuses imported keys on two different networks', async () => {
    await assert.rejects(
      buildPrivateWallet({
        id: 'w6',
        keys: [importedKey('a', MNEMONICS[0], 'mainnet'), importedKey('b', MNEMONICS[1], 'testnet')],
        m: 2,
        name: '',
        defaultNetwork: 'mainnet',
        loadMnemonic: loader,
      }),
      { message: 'You mixed mainnet and testnet keys — a wallet needs all keys on one network.' }
    );
  });

  it('refuses a local key whose recovery phrase is not on this phone', async () => {
    await assert.rejects(
      buildPrivateWallet({
        id: 'w7',
        keys: [localKeys[0], localKey('gone', MNEMONICS[4], 'Lost key')],
        m: 2,
        name: '',
        defaultNetwork: 'mainnet',
        loadMnemonic: loader,
      }),
      { message: 'The recovery phrase for "Lost key" is missing from this phone.' }
    );
  });

  it('refuses a single key', async () => {
    await assert.rejects(
      buildPrivateWallet({
        id: 'w8',
        keys: [localKeys[0]],
        m: 1,
        name: '',
        defaultNetwork: 'mainnet',
        loadMnemonic: loader,
      }),
      { message: 'A shared wallet needs at least two keys.' }
    );
  });

  it('refuses a threshold above the number of keys or below one', async () => {
    await assert.rejects(
      buildPrivateWallet({
        id: 'w9',
        keys: localKeys,
        m: 4,
        name: '',
        defaultNetwork: 'mainnet',
        loadMnemonic: loader,
      }),
      { message: 'Threshold 4 of 3 is not possible.' }
    );
    await assert.rejects(
      buildPrivateWallet({
        id: 'w10',
        keys: localKeys,
        m: 0,
        name: '',
        defaultNetwork: 'mainnet',
        loadMnemonic: loader,
      }),
      { message: 'Threshold 0 of 3 is not possible.' }
    );
  });
});

describe('resolveWalletNetwork', () => {
  it('falls back to the default when there are no imported keys', () => {
    assert.equal(resolveWalletNetwork([], 'testnet'), 'testnet');
    assert.equal(resolveWalletNetwork(localKeys, 'mainnet'), 'mainnet');
    assert.equal(resolveWalletNetwork(localKeys, 'testnet'), 'testnet');
  });

  it('follows the imported keys', () => {
    assert.equal(resolveWalletNetwork([localKeys[0], importedKey('hw', MNEMONICS[3], 'mainnet')], 'testnet'), 'mainnet');
    assert.equal(resolveWalletNetwork([localKeys[0], importedKey('hw', MNEMONICS[3], 'testnet')], 'mainnet'), 'testnet');
  });

  it('throws on mixed imported networks', () => {
    assert.throws(
      () =>
        resolveWalletNetwork(
          [importedKey('a', MNEMONICS[0], 'mainnet'), importedKey('b', MNEMONICS[1], 'testnet')],
          'mainnet'
        ),
      { message: 'You mixed mainnet and testnet keys — a wallet needs all keys on one network.' }
    );
  });
});

describe('buildPrivateWallet — duplicate keys', () => {
  it('refuses the same key twice even when the pasted copy carries a different fingerprint', async () => {
    const pasted: SignerKey = { ...importedKey('back', THREE[0], 'mainnet', 'Pasted'), fingerprint: 'deadbeef' };
    await assert.rejects(
      buildPrivateWallet({ id: 'w', keys: [localKeys[0], pasted, localKeys[1]], m: 2, name: '', defaultNetwork: 'mainnet', loadMnemonic: loader }),
      { message: '"Signer 1" and "Pasted" are the same key — each key can only go into the wallet once.' }
    );
  });
});
