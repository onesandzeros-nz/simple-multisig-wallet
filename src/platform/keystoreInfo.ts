import type { KeystoreInfo } from './keystoreText';

export type { KeystoreInfo } from './keystoreText';
export { describeKeystore } from './keystoreText';

/**
 * Which keystore holds the recovery phrases. On a phone it is the Keychain
 * or Keystore and there is nothing to ask; keystoreInfo.web.ts, which the
 * web bundle gets instead, asks the desktop shell.
 */
export async function desktopKeystoreInfo(): Promise<KeystoreInfo | null> {
  return null;
}
