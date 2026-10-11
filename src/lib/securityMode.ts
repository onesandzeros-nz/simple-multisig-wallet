import * as SecureStore from 'expo-secure-store';
import { PinRecord, makePinRecord } from './securityPin';

/**
 * Where security mode keeps its PIN record and the wrong-attempt streak:
 * the keystore, beside the recovery phrases. The `securityMode` flag itself
 * is an ordinary setting; without a record here it is treated as off.
 */

const PIN_KEY = 'security.pin';
const ATTEMPTS_KEY = 'security.attempts';

export async function loadPinRecord(): Promise<PinRecord | null> {
  const raw = await SecureStore.getItemAsync(PIN_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.salt === 'string' && typeof parsed?.hash === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export async function savePin(pin: string): Promise<void> {
  await SecureStore.setItemAsync(PIN_KEY, JSON.stringify(makePinRecord(pin)), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  await resetAttempts();
}

export async function clearPin(): Promise<void> {
  await SecureStore.deleteItemAsync(PIN_KEY);
  await resetAttempts();
}

export async function loadAttempts(): Promise<number> {
  const raw = await SecureStore.getItemAsync(ATTEMPTS_KEY);
  const n = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function saveAttempts(n: number): Promise<void> {
  if (n <= 0) await SecureStore.deleteItemAsync(ATTEMPTS_KEY);
  else {
    await SecureStore.setItemAsync(ATTEMPTS_KEY, String(n), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }
}

export async function resetAttempts(): Promise<void> {
  await saveAttempts(0);
}
