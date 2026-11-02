import { bridgeError, desktopBridge, requireBridgeInShell } from './bridge';

/**
 * What `expo-secure-store` resolves to in the web bundle (metro.config.js).
 * Inside the desktop app, values go through the bridge to Electron's
 * safeStorage — encrypted with the macOS Keychain, Windows DPAPI or the
 * Linux desktop's secret service — and the ciphertexts live in the app's
 * data directory. The keychain accessibility constants are accepted and
 * ignored: a desktop has no lock state to key them to.
 *
 * A plain browser (`expo start --web`) has no keystore at all; there the
 * values are held in sessionStorage — in the clear, gone when the tab
 * closes — with a warning. That mode is for working on the interface,
 * never for keys that hold money.
 */
export type KeychainAccessibilityConstant = number;
export const AFTER_FIRST_UNLOCK: KeychainAccessibilityConstant = 0;
export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: KeychainAccessibilityConstant = 1;
export const ALWAYS: KeychainAccessibilityConstant = 2;
export const WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: KeychainAccessibilityConstant = 3;
export const ALWAYS_THIS_DEVICE_ONLY: KeychainAccessibilityConstant = 4;
export const WHEN_UNLOCKED: KeychainAccessibilityConstant = 5;
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY: KeychainAccessibilityConstant = 6;

export interface SecureStoreOptions {
  keychainService?: string;
  keychainAccessible?: KeychainAccessibilityConstant;
  requireAuthentication?: boolean;
  authenticationPrompt?: string;
  accessGroup?: string;
}

const BROWSER_PREFIX = 'insecure-store:';

function fail(e: unknown): never {
  throw bridgeError(e);
}

/** expo-secure-store's own rule for keys. */
function checkKey(key: string): string {
  if (typeof key !== 'string' || !/^[\w.-]+$/.test(key)) {
    throw new Error('Invalid key provided to SecureStore. Keys must not be empty and contain only alphanumeric characters, ".", "-", and "_".');
  }
  return key;
}

let warned = false;
function browserStorage(): Storage {
  if (!warned) {
    warned = true;
    console.warn('[secure-store] no desktop shell: secrets are kept UNENCRYPTED in sessionStorage until the tab closes. Development only.');
  }
  return globalThis.sessionStorage;
}

export async function isAvailableAsync(): Promise<boolean> {
  const bridge = requireBridgeInShell('the keystore');
  if (!bridge) return typeof globalThis.sessionStorage !== 'undefined';
  return bridge.secure.info().then((i) => i.available, () => false);
}

export function canUseBiometricAuthentication(): boolean {
  return false;
}

export async function getItemAsync(key: string, _options: SecureStoreOptions = {}): Promise<string | null> {
  checkKey(key);
  const bridge = requireBridgeInShell('the keystore');
  if (!bridge) return browserStorage().getItem(BROWSER_PREFIX + key);
  return bridge.secure.getItem(key).catch(fail);
}

export async function setItemAsync(key: string, value: string, _options: SecureStoreOptions = {}): Promise<void> {
  checkKey(key);
  if (typeof value !== 'string') throw new Error('Invalid value provided to SecureStore. Values must be strings.');
  const bridge = requireBridgeInShell('the keystore');
  if (!bridge) return void browserStorage().setItem(BROWSER_PREFIX + key, value);
  await bridge.secure.setItem(key, value).catch(fail);
}

export async function deleteItemAsync(key: string, _options: SecureStoreOptions = {}): Promise<void> {
  checkKey(key);
  const bridge = requireBridgeInShell('the keystore');
  if (!bridge) return void browserStorage().removeItem(BROWSER_PREFIX + key);
  await bridge.secure.deleteItem(key).catch(fail);
}
