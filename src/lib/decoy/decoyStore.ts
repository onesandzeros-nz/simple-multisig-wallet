import AsyncStorage from '@react-native-async-storage/async-storage';
import { DecoyState, seedState } from './conversations';

/**
 * The decoy inbox persists in plain storage like any messaging app would —
 * there is nothing secret in it, and it must look lived-in across restarts.
 */
const DECOY_KEY = 'sms.inbox.v1';

export async function loadDecoy(now: number): Promise<DecoyState> {
  try {
    const raw = await AsyncStorage.getItem(DECOY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.version === 1 && Array.isArray(parsed.threads)) return parsed as DecoyState;
    }
  } catch {
    // Fall through to a fresh inbox.
  }
  const fresh = seedState(now);
  await saveDecoy(fresh);
  return fresh;
}

export async function saveDecoy(state: DecoyState): Promise<void> {
  await AsyncStorage.setItem(DECOY_KEY, JSON.stringify(state));
}

/** Seeds the inbox now so it is ready the first time the app locks. */
export async function ensureDecoy(now: number): Promise<void> {
  await loadDecoy(now);
}

export async function clearDecoy(): Promise<void> {
  await AsyncStorage.removeItem(DECOY_KEY);
}
