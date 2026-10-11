import { MultisigWallet, NetworkName, SignerKey } from './types';

/**
 * Point each wallet cosigner at the key on this phone that backs it, so
 * signing and "used by" listings work no matter which order keys and
 * wallets were added in. A cosigner is only linked when this phone can
 * PROVE it holds the key: an imported key by its exact account xpub, a
 * local key by the account xpub re-derived from its seed (supplied via
 * `localXpubFor`). A fingerprint on its own never links — in an imported
 * wallet it is attacker-chosen text, and matching on it would let a
 * substituted xpub borrow a real key's identity. Dangling references to
 * deleted keys are cleared.
 */
export function linkCosigners(
  wallets: MultisigWallet[],
  keys: SignerKey[],
  localXpubFor?: (keyId: string, network: NetworkName) => string | undefined
): { wallets: MultisigWallet[]; changed: boolean } {
  const keyIds = new Set(keys.map((k) => k.id));
  let changed = false;
  const next = wallets.map((w) => {
    let walletChanged = false;
    const cosigners = w.cosigners.map((c) => {
      if (c.keyId && keyIds.has(c.keyId)) return c;
      const match = keys.find((k) => {
        if (k.xpub) return k.xpub === c.xpub;
        if (k.type === 'local' && localXpubFor) return localXpubFor(k.id, w.network) === c.xpub;
        return false;
      });
      if (match) {
        walletChanged = true;
        return { ...c, keyId: match.id, name: match.name };
      }
      if (c.keyId) {
        walletChanged = true;
        return { ...c, keyId: undefined };
      }
      return c;
    });
    if (!walletChanged) return w;
    changed = true;
    return { ...w, cosigners };
  });
  return { wallets: next, changed };
}

/**
 * Carry a key's new name into the wallets that use it. A cosigner keeps its
 * own copy of the name, so without this a renamed key would still sign under
 * the old one. Only cosigners linked to the key are touched.
 */
export function renameCosigners(
  wallets: MultisigWallet[],
  keyId: string,
  name: string
): { wallets: MultisigWallet[]; changed: boolean } {
  let changed = false;
  const next = wallets.map((w) => {
    if (!w.cosigners.some((c) => c.keyId === keyId && c.name !== name)) return w;
    changed = true;
    return { ...w, cosigners: w.cosigners.map((c) => (c.keyId === keyId ? { ...c, name } : c)) };
  });
  return { wallets: next, changed };
}
