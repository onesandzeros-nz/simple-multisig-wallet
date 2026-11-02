import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * The desktop keystore (desktop/lib/secure.js) against a stand-in for
 * Electron's safeStorage, which the real thing only offers inside Electron.
 */
const require = createRequire(import.meta.url);
const { SecureStore } = require('../desktop/lib/secure.js');

/** Behaves like safeStorage on Linux with a keyring: "v11" + the text, reversed. */
function fakeSafeStorage(opts: { tag?: string; available?: boolean; reEncrypt?: boolean; backend?: string } = {}) {
  const tag = opts.tag ?? 'v11';
  const log: string[] = [];
  return {
    log,
    async isAsyncEncryptionAvailable() {
      return opts.available ?? true;
    },
    getSelectedStorageBackend() {
      return opts.backend ?? 'gnome_libsecret';
    },
    async encryptStringAsync(text: string) {
      log.push(`enc:${text}`);
      return Buffer.concat([Buffer.from(tag), Buffer.from([...text].reverse().join(''), 'utf8')]);
    },
    async decryptStringAsync(buf: Buffer) {
      const head = buf.subarray(0, 3).toString();
      if (head !== tag) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      return { result: [...buf.subarray(3).toString('utf8')].reverse().join(''), shouldReEncrypt: opts.reEncrypt ?? false };
    },
  };
}

describe('desktop keystore', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-secure-'));
  const file = (name: string) => path.join(dir, name);

  it('round-trips, keeps only ciphertext on disk and answers null for missing keys', async () => {
    const crypto = fakeSafeStorage();
    const store = new SecureStore(file('a.json'), crypto);
    assert.equal(await store.get('mnemonic.k1'), null);
    await store.set('mnemonic.k1', 'abandon ability able');
    assert.equal(await store.get('mnemonic.k1'), 'abandon ability able');
    const onDisk = fs.readFileSync(file('a.json'), 'utf8');
    assert.ok(!onDisk.includes('abandon'), 'plaintext must not be on disk');
    assert.ok(/[A-Za-z0-9+/=]{10,}/.test(onDisk), 'base64 ciphertext expected');
    await store.remove('mnemonic.k1');
    await store.remove('never.there');
    assert.equal(await store.get('mnemonic.k1'), null);
  });

  it('re-encrypts when the OS asks for it', async () => {
    const crypto = fakeSafeStorage({ reEncrypt: true });
    const store = new SecureStore(file('b.json'), crypto);
    await store.set('k', 'v');
    crypto.log.length = 0;
    assert.equal(await store.get('k'), 'v');
    assert.deepEqual(crypto.log, ['enc:v'], 'the value was written again with a fresh key');
  });

  it('rejects, rather than returning null, when a ciphertext cannot be opened', async () => {
    const written = new SecureStore(file('c.json'), fakeSafeStorage({ tag: 'v11' }));
    await written.set('security.pin', '{"salt":"s","hash":"h"}');
    const other = new SecureStore(file('c.json'), fakeSafeStorage({ tag: 'v10', backend: 'basic_text' }));
    await assert.rejects(other.get('security.pin'), /could not be decrypted with the basic_text keystore/);
  });

  it('rejects when the system has no keystore at all', async () => {
    const store = new SecureStore(file('d.json'), fakeSafeStorage({ available: false }));
    await assert.rejects(store.set('k', 'v'), /keystore is not available/);
    assert.equal(await store.get('k'), null, 'nothing was stored');
  });

  it('reports the keystore, and recognises the fixed-key fallback by what it encrypts', { skip: process.platform !== 'linux' }, async () => {
    const keyring = new SecureStore(file('e.json'), fakeSafeStorage({ tag: 'v11', backend: 'gnome_libsecret' }));
    assert.deepEqual(await keyring.info(), { available: true, backend: 'gnome_libsecret' });
    // The backend says "keyring" but the ciphertext carries the fixed-key tag:
    // the keyring was locked or unreachable, so the data is only obfuscated.
    const fallen = new SecureStore(file('f.json'), fakeSafeStorage({ tag: 'v10', backend: 'gnome_libsecret' }));
    assert.deepEqual(await fallen.info(), { available: true, backend: 'basic_text' });
  });
});
