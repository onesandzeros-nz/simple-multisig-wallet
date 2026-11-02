import { desktopBridge } from './bridge';
import type { KeystoreInfo } from './keystoreText';

export type { KeystoreInfo } from './keystoreText';
export { describeKeystore } from './keystoreText';

/** The desktop shell's keystore, or null in a plain browser. */
export async function desktopKeystoreInfo(): Promise<KeystoreInfo | null> {
  const bridge = desktopBridge();
  if (!bridge) return null;
  return bridge.secure.info().catch(() => ({ available: false, backend: 'unknown' }));
}
