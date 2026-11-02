'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * A string map persisted as one JSON file — the desktop's stand-in for
 * AsyncStorage (and, holding ciphertexts, for the keystore). Every change is
 * written whole, to a temporary file that is fsynced and renamed over the
 * old one, so a crash mid-write leaves the previous file intact rather than
 * a truncated one. Writes are serialised; a burst of changes coalesces into
 * as few writes as the disk allows, and a caller's promise resolves once
 * its change is on disk.
 */
class JsonFileStore {
  constructor(file) {
    this.file = file;
    this.data = new Map();
    this.dirty = false;
    this.flushing = null;
    this.load();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // Not silently emptied: that would look like a wiped wallet. The caller
      // shows the error and the file stays where it is for recovery.
      throw new Error(`${this.file} is not valid JSON (${e.message}). Move it aside to start afresh.`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${this.file} does not hold an object.`);
    }
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') this.data.set(k, v);
    }
  }

  get(key) {
    return this.data.has(key) ? this.data.get(key) : null;
  }

  set(key, value) {
    this.data.set(key, value);
    return this.persist();
  }

  remove(key) {
    this.data.delete(key);
    return this.persist();
  }

  removeMany(keys) {
    for (const k of keys) this.data.delete(k);
    return this.persist();
  }

  keys() {
    return [...this.data.keys()];
  }

  clear() {
    this.data.clear();
    return this.persist();
  }

  /** Resolves once nothing is waiting to be written. */
  whenIdle() {
    return this.flushing ? this.flushing.catch(() => {}) : Promise.resolve();
  }

  persist() {
    this.dirty = true;
    if (!this.flushing) {
      this.flushing = (async () => {
        try {
          while (this.dirty) {
            this.dirty = false;
            await this.writeNow();
          }
        } finally {
          this.flushing = null;
        }
      })();
    }
    return this.flushing;
  }

  async writeNow() {
    const json = JSON.stringify(Object.fromEntries(this.data), null, 1);
    const dir = path.dirname(this.file);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const handle = await fs.promises.open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(json, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(tmp, this.file);
  }
}

module.exports = { JsonFileStore };
