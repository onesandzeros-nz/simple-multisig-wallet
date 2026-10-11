import AsyncStorage from '@react-native-async-storage/async-storage';
import { MultisigWallet } from '../types';
import { BITBOX02_MEMORY_KEYS } from './bitbox02';
import { ledgerMemoryKeys } from './ledger';
import { DeviceMemory } from './types';

/**
 * Device memory that keeps a list of what it holds, so a wipe can erase it.
 *
 * The keystore cannot list its own entries, and the duress wipe promises to
 * erase every secret on the phone — the key this phone pairs with a BitBox02
 * under included. So the name of every entry written goes on a list in app
 * storage before the entry itself. Names only, never values: a Ledger
 * approval's name says which wallet and which device, and the wallet list
 * beside it says that already.
 *
 * `memory.ts` binds this to the real keystore; the tests bind it to maps.
 */

const PREFIX = 'hw.';

/** The keystore accepts letters, digits, '.', '-' and '_' in a name. */
export function storageKey(key: string): string {
  return `${PREFIX}${key.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

/** Where in app storage the list of names lives. */
export const MEMORY_INDEX_KEY = 'sms.hwMemory.v1';

/** The slice of the keystore device memory uses. */
export interface SecureKeyStore {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: any): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

/** The slice of app storage the list uses — injectable so the tests run without a device. */
export type IndexStore = Pick<typeof AsyncStorage, 'getItem' | 'setItem' | 'removeItem'>;

export interface IndexedDeviceMemory {
  memory: DeviceMemory;
  /**
   * Erases every entry on the list, and any of `alsoKeys` — names a driver
   * may have written before the list existed. Every delete is tried; a name
   * that could not be deleted stays on the list for the next wipe, and the
   * first failure is thrown once the rest are done.
   */
  clear(alsoKeys?: string[]): Promise<void>;
}

/** The list of names: read once, written in the order the writes were asked for. */
class NameIndex {
  private names: Promise<Set<string>> | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(private store: IndexStore) {}

  all(): Promise<Set<string>> {
    if (!this.names) {
      this.names = this.store.getItem(MEMORY_INDEX_KEY).then(
        (raw) => {
          const names = new Set<string>();
          try {
            const parsed = raw ? JSON.parse(raw) : [];
            if (Array.isArray(parsed)) for (const n of parsed) if (typeof n === 'string') names.add(n);
          } catch {
            // A list that cannot be read lists nothing; the drivers' own names are swept regardless.
          }
          return names;
        },
        (e) => {
          this.names = null; // read it again next time
          throw e;
        }
      );
    }
    return this.names;
  }

  async add(name: string): Promise<void> {
    const names = await this.all();
    if (names.has(name)) return;
    names.add(name);
    await this.save(names);
  }

  async replace(next: Set<string>): Promise<void> {
    const names = await this.all();
    names.clear();
    for (const n of next) names.add(n);
    await this.save(names);
  }

  /** Each write sees the list as it is when its turn comes, never an older copy. */
  private save(names: Set<string>): Promise<void> {
    const write = this.writes.then(() =>
      names.size === 0
        ? this.store.removeItem(MEMORY_INDEX_KEY)
        : this.store.setItem(MEMORY_INDEX_KEY, JSON.stringify([...names].sort()))
    );
    this.writes = write.catch(() => {});
    return write;
  }
}

export function createDeviceMemory(opts: {
  secure: SecureKeyStore;
  /** Handed to the keystore with every write — which keychain class, on iOS. */
  writeOptions?: unknown;
  index?: IndexStore;
}): IndexedDeviceMemory {
  const { secure, writeOptions } = opts;
  const index = new NameIndex(opts.index ?? AsyncStorage);
  return {
    memory: {
      async get(key) {
        const name = storageKey(key);
        const value = await secure.getItemAsync(name);
        // Written by a build from before the list: on it from now on.
        if (value !== null) await index.add(name).catch(() => {});
        return value;
      },
      async set(key, value) {
        const name = storageKey(key);
        // The list first: nothing goes in the keystore that a wipe cannot find.
        await index.add(name);
        await secure.setItemAsync(name, value, writeOptions);
      },
    },
    async clear(alsoKeys = []) {
      const failures: unknown[] = [];
      let listed = new Set<string>();
      try {
        listed = await index.all();
      } catch (e) {
        failures.push(e);
      }
      const names = new Set([...listed, ...alsoKeys.map(storageKey)]);
      const left = new Set<string>();
      for (const name of names) {
        try {
          await secure.deleteItemAsync(name);
        } catch (e) {
          failures.push(e);
          left.add(name);
        }
      }
      await index.replace(left).catch((e) => failures.push(e));
      if (failures.length > 0) throw failures[0];
    },
  };
}

/**
 * Names the drivers would have used for `wallets`, listed or not — a build
 * from before the list may have written them, and a wipe that misses the
 * BitBox02 pairing key has not kept its promise. The BitBox02 names are
 * fixed; a Ledger approval is named after the wallet and the Ledger, and any
 * cosigner may be the Ledger.
 */
export function knownDeviceMemoryKeys(wallets: MultisigWallet[]): string[] {
  return [...BITBOX02_MEMORY_KEYS, ...wallets.flatMap(ledgerMemoryKeys)];
}
