import { bridgeError, desktopBridge, requireBridgeInShell } from './bridge';

/**
 * What `@react-native-async-storage/async-storage` resolves to in the web
 * bundle (metro.config.js). Inside the desktop app it is a JSON file in the
 * app's data directory, written through the bridge; in a plain browser it is
 * localStorage, which is what the library itself would use there.
 */
type KeyValuePair = [string, string | null];

function fail(e: unknown): never {
  throw bridgeError(e);
}

let warned = false;
function browserStorage(): Storage {
  if (!warned) {
    warned = true;
    console.warn('[storage] no desktop shell: using the browser’s localStorage');
  }
  return globalThis.localStorage;
}

const AsyncStorage = {
  async getItem(key: string): Promise<string | null> {
    const bridge = requireBridgeInShell('storage');
    if (!bridge) return browserStorage().getItem(key);
    return bridge.storage.getItem(key).catch(fail);
  },
  async setItem(key: string, value: string): Promise<void> {
    const bridge = requireBridgeInShell('storage');
    if (!bridge) return void browserStorage().setItem(key, value);
    await bridge.storage.setItem(key, value).catch(fail);
  },
  async removeItem(key: string): Promise<void> {
    const bridge = requireBridgeInShell('storage');
    if (!bridge) return void browserStorage().removeItem(key);
    await bridge.storage.removeItem(key).catch(fail);
  },
  async multiRemove(keys: readonly string[]): Promise<void> {
    const bridge = requireBridgeInShell('storage');
    if (!bridge) {
      for (const key of keys) browserStorage().removeItem(key);
      return;
    }
    await bridge.storage.multiRemove([...keys]).catch(fail);
  },
  async getAllKeys(): Promise<readonly string[]> {
    const bridge = requireBridgeInShell('storage');
    if (!bridge) {
      const store = browserStorage();
      const keys: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (key !== null) keys.push(key);
      }
      return keys;
    }
    return bridge.storage.getAllKeys().catch(fail);
  },
  async multiGet(keys: readonly string[]): Promise<readonly KeyValuePair[]> {
    return Promise.all(keys.map(async (key): Promise<KeyValuePair> => [key, await AsyncStorage.getItem(key)]));
  },
  async multiSet(pairs: readonly [string, string][]): Promise<void> {
    for (const [key, value] of pairs) await AsyncStorage.setItem(key, value);
  },
  async clear(): Promise<void> {
    const bridge = requireBridgeInShell('storage');
    if (!bridge) return void browserStorage().clear();
    await bridge.storage.clear().catch(fail);
  },
};

export default AsyncStorage;
