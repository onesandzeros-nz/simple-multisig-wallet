import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { MultisigWallet } from '../types';
import { createDeviceMemory, knownDeviceMemoryKeys } from './memoryStore';

/**
 * What the drivers remember between connections, held in the device keystore
 * alongside recovery phrases. Most of it is not secret — a Ledger's approval
 * of a wallet only saves pressing the buttons again — but the key this phone
 * pairs with a BitBox02 under is, so everything gets the same protection,
 * and the duress wipe reaches all of it (`clearDeviceMemory`).
 *
 * The rules are in `memoryStore.ts`; this binds them to the phone.
 */
const indexed = createDeviceMemory({
  secure: SecureStore,
  writeOptions: { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
  index: AsyncStorage,
});

export const deviceMemory = indexed.memory;

/**
 * Erases every entry device memory holds: whatever its list names, and the
 * names the drivers would have used for `wallets`, in case a build from
 * before the list wrote them.
 */
export function clearDeviceMemory(wallets: MultisigWallet[]): Promise<void> {
  return indexed.clear(knownDeviceMemoryKeys(wallets));
}
