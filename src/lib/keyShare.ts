import { accountXpub, bip48Path, keyExpression } from './bitcoin';
import { loadMnemonic } from './store';
import { NetworkName, SignerKey } from './types';

/**
 * Descriptor key expression for any key held on this phone — local keys
 * derive their account xpub on demand, imported keys already carry one.
 */
export async function keyExpressionForStoredKey(
  key: SignerKey,
  network: NetworkName = 'mainnet'
): Promise<string> {
  if (key.type === 'local') {
    const mnemonic = await loadMnemonic(key.id);
    if (!mnemonic) throw new Error(`The recovery phrase for "${key.name}" is missing from this phone.`);
    return keyExpression({
      fingerprint: key.fingerprint,
      path: bip48Path(network),
      xpub: accountXpub(mnemonic, network),
    });
  }
  if (!key.xpub) throw new Error(`"${key.name}" has no public key stored.`);
  return keyExpression({
    fingerprint: key.fingerprint,
    path: key.path ?? bip48Path(key.network ?? network),
    xpub: key.xpub,
  });
}
