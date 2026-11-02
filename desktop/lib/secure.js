'use strict';

const { JsonFileStore } = require('./storage');

/**
 * The desktop's keystore: what expo-secure-store is on a phone. Values are
 * encrypted by Electron's safeStorage — the macOS Keychain, Windows DPAPI,
 * or on Linux the desktop's secret service (GNOME Keyring, KWallet) — and the
 * ciphertexts are kept in userData/secure.json. The key never touches that
 * file. A Linux desktop without a secret service falls back to a fixed key
 * ("basic_text"); `info()` reports which, so the app can say so.
 *
 * The crypto object is Electron's safeStorage; tests pass a stand-in.
 */
function electronSafeStorage() {
  return require('electron').safeStorage;
}

class SecureStore {
  constructor(file, crypto = electronSafeStorage()) {
    this.store = new JsonFileStore(file);
    this.crypto = crypto;
  }

  static prepare(crypto = electronSafeStorage()) {
    // Without this a Linux box with no password manager has no encryption at
    // all and every call would fail; with it, the data is at least not plain.
    if (process.platform === 'linux' && typeof crypto.setUsePlainTextEncryption === 'function') {
      crypto.setUsePlainTextEncryption(true);
    }
  }

  async info() {
    const available = await this.crypto.isAsyncEncryptionAvailable();
    let backend;
    if (process.platform === 'darwin') backend = 'keychain';
    else if (process.platform === 'win32') backend = 'dpapi';
    else {
      backend = this.crypto.getSelectedStorageBackend();
      // The backend name says what was chosen, not what is in use: a locked
      // or unreachable keyring makes Chromium fall back to its fixed key.
      // What it encrypts says so itself — "v11" for a keyring key, "v10"
      // for the fixed one.
      if (available) {
        try {
          const probe = await this.crypto.encryptStringAsync('probe');
          if (probe.subarray(0, 3).toString('latin1') === 'v10') backend = 'basic_text';
        } catch {
          // keep the selected backend's name
        }
      }
    }
    return { available, backend };
  }

  async requireEncryption() {
    if (!(await this.crypto.isAsyncEncryptionAvailable())) {
      throw new Error('The system keystore is not available, so secrets cannot be stored.');
    }
  }

  async get(key) {
    const stored = this.store.get(key);
    if (stored === null) return null;
    await this.requireEncryption();
    let decrypted;
    try {
      decrypted = await this.crypto.decryptStringAsync(Buffer.from(stored, 'base64'));
    } catch (e) {
      // Typically a Linux desktop whose keyring changed (or was reset) since
      // the entry was written: the ciphertext is intact but its key is gone.
      const { backend } = await this.info();
      throw new Error(
        `The keystore entry could not be decrypted with the ${backend} keystore in use now. ` +
          `It was encrypted by a different keyring or login, which is needed to read it. (${(e && e.message) || e})`
      );
    }
    const { result, shouldReEncrypt } = decrypted;
    if (shouldReEncrypt) {
      // The OS rotated its key; the stored ciphertext still opens but a
      // fresh one is preferred. Not fatal if the rewrite fails.
      try {
        await this.set(key, result);
      } catch {
        // keep the old ciphertext
      }
    }
    return result;
  }

  async set(key, value) {
    await this.requireEncryption();
    const encrypted = await this.crypto.encryptStringAsync(value);
    await this.store.set(key, encrypted.toString('base64'));
  }

  async remove(key) {
    await this.store.remove(key);
  }

  whenIdle() {
    return this.store.whenIdle();
  }
}

module.exports = { SecureStore };
