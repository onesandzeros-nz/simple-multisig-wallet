import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BITBOX02_MEMORY_KEYS } from '../src/lib/hw/bitbox02';
import { hmacMemoryKey, ledgerMemoryKeys, multisigPolicy } from '../src/lib/hw/ledger';
import {
  createDeviceMemory,
  IndexStore,
  knownDeviceMemoryKeys,
  MEMORY_INDEX_KEY,
  SecureKeyStore,
  storageKey,
} from '../src/lib/hw/memoryStore';
import { makeWallet, MNEMONICS } from './helpers';

/**
 * Device memory with the list of what it holds (L4 in SECURITY-AUDIT.md): the
 * keystore cannot enumerate itself, so the wipe has to be told every name.
 */

type Keystore = SecureKeyStore & { map: Map<string, string>; options: unknown[] };

function fakeKeystore(initial: Record<string, string> = {}, refusing: string[] = []): Keystore {
  const map = new Map(Object.entries(initial));
  const options: unknown[] = [];
  return {
    map,
    options,
    async getItemAsync(k) {
      return map.get(k) ?? null;
    },
    async setItemAsync(k, v, o) {
      options.push(o);
      map.set(k, v);
    },
    async deleteItemAsync(k) {
      if (refusing.includes(k)) throw new Error(`the keystore refused to delete ${k}`);
      map.delete(k);
    },
  };
}

type AppStorage = IndexStore & { map: Map<string, string> };

function fakeAppStorage(initial: Record<string, string> = {}): AppStorage {
  const map = new Map(Object.entries(initial));
  return {
    map,
    async getItem(k) {
      return map.get(k) ?? null;
    },
    async setItem(k, v) {
      map.set(k, v);
    },
    async removeItem(k) {
      map.delete(k);
    },
  };
}

const listed = (app: AppStorage): string[] | null => JSON.parse(app.map.get(MEMORY_INDEX_KEY) ?? 'null');
const WRITE_OPTIONS = { keychainAccessible: 'when-unlocked' };

function memoryOver(secure: Keystore, index: AppStorage) {
  return createDeviceMemory({ secure, writeOptions: WRITE_OPTIONS, index });
}

describe('device memory: the list of names', () => {
  it('writes under a name the keystore accepts, with the options it was given, and lists the name', async () => {
    const secure = fakeKeystore();
    const app = fakeAppStorage({ 'sms.keys.v1': '[]' });
    const { memory } = memoryOver(secure, app);

    assert.equal(storageKey('a b/c'), 'hw.a_b_c');
    await memory.set('bitbox02.noise.key', 'aa');
    await memory.set('ledger.hmac.ab/cd.x y', 'bb');
    assert.deepEqual([...secure.map.keys()].sort(), ['hw.bitbox02.noise.key', 'hw.ledger.hmac.ab_cd.x_y']);
    assert.deepEqual(secure.options, [WRITE_OPTIONS, WRITE_OPTIONS], 'the keychain class goes with every write');
    assert.deepEqual(listed(app), ['hw.bitbox02.noise.key', 'hw.ledger.hmac.ab_cd.x_y']);
    assert.equal(await memory.get('bitbox02.noise.key'), 'aa');
    assert.equal(await memory.get('ledger.hmac.ab/cd.x y'), 'bb');
    assert.equal(await memory.get('never'), null);
    assert.equal(app.map.get('sms.keys.v1'), '[]', 'the rest of app storage is left alone');

    await memory.set('bitbox02.noise.key', 'cc');
    assert.deepEqual(listed(app), ['hw.bitbox02.noise.key', 'hw.ledger.hmac.ab_cd.x_y'], 'a name is listed once');
  });

  it('lists the name before writing: nothing goes in the keystore that a wipe cannot find', async () => {
    const secure = fakeKeystore();
    const app = fakeAppStorage();
    app.setItem = async () => {
      throw new Error('app storage is full');
    };
    const { memory } = memoryOver(secure, app);
    await assert.rejects(memory.set('bitbox02.noise.key', 'aa'), /full/);
    assert.equal(secure.map.size, 0, 'the entry was not written');
  });

  it('erases everything it listed, and the list, and nothing else', async () => {
    const secure = fakeKeystore({ 'mnemonic.k1': 'phrase', 'group.g1': '[]' });
    const app = fakeAppStorage({ 'sms.keys.v1': '[]' });
    const { memory, clear } = memoryOver(secure, app);
    await memory.set('bitbox02.noise.key', 'aa');
    await memory.set('bitbox02.noise.devices', '["dd"]');
    await memory.set('ledger.hmac.deadbeef.00', 'bb');

    await clear();
    assert.deepEqual([...secure.map.keys()].sort(), ['group.g1', 'mnemonic.k1'], 'other keystore entries are not its to erase');
    assert.equal(app.map.has(MEMORY_INDEX_KEY), false, 'an empty list is no list');
    assert.equal(app.map.get('sms.keys.v1'), '[]');
    assert.equal(await memory.get('bitbox02.noise.key'), null);

    await clear(); // nothing left: still fine
    assert.equal(app.map.has(MEMORY_INDEX_KEY), false);
  });

  it('finds what a build from before the list wrote: once it is read, or by the names the drivers use', async () => {
    const secure = fakeKeystore({
      'hw.bitbox02.noise.key': 'aa',
      'hw.ledger.hmac.deadbeef.00': 'bb',
      'hw.forgotten': 'cc',
    });
    const app = fakeAppStorage();
    const { memory, clear } = memoryOver(secure, app);

    assert.equal(await memory.get('bitbox02.noise.key'), 'aa');
    assert.deepEqual(listed(app), ['hw.bitbox02.noise.key'], 'read once, listed from then on');
    assert.equal(await memory.get('ledger.hmac.feedface.00'), null);
    assert.deepEqual(listed(app), ['hw.bitbox02.noise.key'], 'a miss lists nothing');

    await clear(['ledger.hmac.deadbeef.00']);
    assert.deepEqual([...secure.map.keys()], ['hw.forgotten'], 'what nobody can name is out of reach — hence the list');
    assert.equal(app.map.has(MEMORY_INDEX_KEY), false);
  });

  it('erases the drivers’ names even when the list cannot be read', async () => {
    const secure = fakeKeystore({ 'hw.bitbox02.noise.key': 'aa' });
    const app = fakeAppStorage({ [MEMORY_INDEX_KEY]: 'not json' });
    await memoryOver(secure, app).clear(['bitbox02.noise.key']);
    assert.equal(secure.map.size, 0);

    const broken = fakeAppStorage();
    broken.getItem = async () => {
      throw new Error('app storage is unreadable');
    };
    const secure2 = fakeKeystore({ 'hw.bitbox02.noise.key': 'aa' });
    await assert.rejects(memoryOver(secure2, broken).clear(['bitbox02.noise.key']), /unreadable/);
    assert.equal(secure2.map.size, 0, 'the known names went anyway, and the failure was reported');
  });

  it('keeps a name it could not erase on the list, reports the failure, and gets it next time', async () => {
    const stuck = 'hw.ledger.hmac.aa.bb';
    const secure = fakeKeystore({}, [stuck]);
    const app = fakeAppStorage();
    const first = memoryOver(secure, app);
    await first.memory.set('bitbox02.noise.key', 'aa');
    await first.memory.set('ledger.hmac.aa.bb', 'bb');
    await first.memory.set('ledger.hmac.cc.dd', 'cc');

    await assert.rejects(first.clear(), /refused to delete hw\.ledger\.hmac\.aa\.bb/);
    assert.deepEqual([...secure.map.keys()], [stuck], 'everything else went');
    assert.deepEqual(listed(app), [stuck], 'so the next wipe knows to try again');

    // The keystore relents; a fresh instance (a relaunch) reads the list back.
    const relenting = fakeKeystore(Object.fromEntries(secure.map));
    await memoryOver(relenting, app).clear();
    assert.equal(relenting.map.size, 0);
    assert.equal(app.map.has(MEMORY_INDEX_KEY), false);
  });

  it('writes the list in order when writes overlap', async () => {
    const secure = fakeKeystore();
    const app = fakeAppStorage();
    const { memory } = memoryOver(secure, app);
    await Promise.all([memory.set('a', '1'), memory.set('b', '2'), memory.set('c', '3')]);
    assert.deepEqual(listed(app), ['hw.a', 'hw.b', 'hw.c']);
    assert.deepEqual([...secure.map.keys()].sort(), ['hw.a', 'hw.b', 'hw.c']);
  });
});

describe('device memory: the names the drivers use', () => {
  const wallet = makeWallet(2, MNEMONICS.slice(0, 3));

  it('are the fixed BitBox02 names and one Ledger approval per cosigner per wallet', () => {
    assert.deepEqual(BITBOX02_MEMORY_KEYS, ['bitbox02.noise.key', 'bitbox02.noise.devices']);
    const policy = multisigPolicy(wallet);
    const approvals = wallet.cosigners.map((c) => hmacMemoryKey(c.fingerprint, policy));
    assert.equal(new Set(approvals).size, 3, 'one per device that could be the Ledger');
    for (const a of approvals) assert.match(a, /^ledger\.hmac\.[0-9a-f]{8}\.[0-9a-f]{64}$/);
    assert.deepEqual(ledgerMemoryKeys(wallet), approvals);
    assert.deepEqual(knownDeviceMemoryKeys([wallet]), [...BITBOX02_MEMORY_KEYS, ...approvals]);
    assert.deepEqual(knownDeviceMemoryKeys([]), BITBOX02_MEMORY_KEYS);
  });

  it('spell the fingerprint the way the driver does', () => {
    const policy = multisigPolicy(wallet);
    assert.equal(hmacMemoryKey('DEADBEEF', policy), hmacMemoryKey('deadbeef', policy));
  });

  it('name nothing for a wallet no Ledger could have approved', () => {
    const legacy = { ...wallet, scriptType: 'P2SH-P2WSH' as any };
    assert.deepEqual(ledgerMemoryKeys(legacy), []);
    assert.deepEqual(knownDeviceMemoryKeys([legacy]), BITBOX02_MEMORY_KEYS);
  });
});
