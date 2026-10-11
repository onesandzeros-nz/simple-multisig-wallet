import AsyncStorage from '@react-native-async-storage/async-storage';
import { MultisigWallet } from './types';
import { syncWallet, WalletSync } from './wallet';
import { chainApi } from './chain';

/**
 * Persistent per-wallet cache of balance, coins and history.
 *
 * Opening a wallet shows the cached figures immediately and then refreshes
 * incrementally: only addresses whose transaction count changed (or that
 * still have unconfirmed activity) are re-fetched.
 */
const KEY_PREFIX = 'sms.cache.v2.';
const memory = new Map<string, WalletSync>();

function key(walletId: string): string {
  return `${KEY_PREFIX}${walletId}`;
}

export function getCached(walletId: string): WalletSync | undefined {
  return memory.get(walletId);
}

/** Reads from memory, falling back to disk. Never hits the network. */
export async function loadCached(walletId: string): Promise<WalletSync | undefined> {
  const hit = memory.get(walletId);
  if (hit) return hit;
  try {
    const raw = await AsyncStorage.getItem(key(walletId));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as WalletSync;
    memory.set(walletId, parsed);
    return parsed;
  } catch {
    return undefined;
  }
}

async function persist(walletId: string, sync: WalletSync): Promise<void> {
  memory.set(walletId, sync);
  try {
    await AsyncStorage.setItem(key(walletId), JSON.stringify(sync));
  } catch {
    // A cache write failing is not worth surfacing — the data is re-derivable.
  }
}

/**
 * Refreshes a wallet against the chain and caches the result.
 * `full: true` ignores the cached per-address state and rescans everything.
 */
export async function refreshWallet(wallet: MultisigWallet, full = false): Promise<WalletSync> {
  const previous = full ? undefined : await loadCached(wallet.id);
  const fresh = await syncWallet(wallet, previous, chainApi);
  await persist(wallet.id, fresh);
  return fresh;
}

/** Cached value if it is younger than maxAge, otherwise a refresh. */
export async function getSnapshot(wallet: MultisigWallet, maxAgeMs = 120_000): Promise<WalletSync> {
  const cached = await loadCached(wallet.id);
  if (cached && Date.now() - cached.snapshot.scannedAt < maxAgeMs) return cached;
  return refreshWallet(wallet);
}

export function invalidate(walletId: string): void {
  memory.delete(walletId);
  AsyncStorage.removeItem(key(walletId)).catch(() => {});
}
