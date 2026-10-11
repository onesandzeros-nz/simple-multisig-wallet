import { accountXpub, bip48Path } from './bitcoin';
import { Cosigner, MultisigWallet, NetworkName, SignerKey } from './types';

/**
 * Wallet network follows the imported keys; local keys adapt to either.
 * Imported keys on two different networks cannot share a wallet.
 */
export function resolveWalletNetwork(keys: SignerKey[], defaultNetwork: NetworkName): NetworkName {
  const importedNets = new Set(keys.filter((k) => k.type === 'imported').map((k) => k.network ?? 'mainnet'));
  if (importedNets.size > 1) {
    throw new Error('You mixed mainnet and testnet keys — a wallet needs all keys on one network.');
  }
  return importedNets.size === 1 ? [...importedNets][0] : defaultNetwork;
}

export interface BuildPrivateWalletInput {
  id: string;
  keys: SignerKey[];
  /** Required signatures. */
  m: number;
  /** Blank falls back to `${m} of ${n} wallet`. */
  name: string;
  /** Used when no imported key pins the network. */
  defaultNetwork: NetworkName;
  /** Injected so this runs outside the app (tests, smoke bundle). */
  loadMnemonic: (keyId: string) => Promise<string | null>;
  now?: number;
}

/**
 * Turn a set of keys on this phone into a private P2WSH multisig wallet.
 * Local keys derive their BIP48 account xpub for the resolved network;
 * imported keys contribute the xpub and path they arrived with.
 */
export async function buildPrivateWallet(input: BuildPrivateWalletInput): Promise<MultisigWallet> {
  const { id, keys, m, name, defaultNetwork, loadMnemonic } = input;
  const n = keys.length;
  if (n < 2) throw new Error('A shared wallet needs at least two keys.');
  if (m < 1 || m > n) throw new Error(`Threshold ${m} of ${n} is not possible.`);

  const network = resolveWalletNetwork(keys, defaultNetwork);

  const cosigners: Cosigner[] = [];
  for (const k of keys) {
    if (k.type === 'local') {
      const mnemonic = await loadMnemonic(k.id);
      if (!mnemonic) throw new Error(`The recovery phrase for "${k.name}" is missing from this phone.`);
      cosigners.push({
        name: k.name,
        fingerprint: k.fingerprint,
        path: bip48Path(network),
        xpub: accountXpub(mnemonic, network),
        keyId: k.id,
      });
    } else {
      cosigners.push({
        name: k.name,
        fingerprint: k.fingerprint,
        path: k.path!,
        xpub: k.xpub!,
        keyId: k.id,
      });
    }
  }

  // A local key and its own xpub pasted back in look like two keys to the
  // fingerprint checks upstream (a pasted xpub may carry no fingerprint);
  // the account xpub is the identity that matters.
  const seen = new Map<string, Cosigner>();
  for (const c of cosigners) {
    const dup = seen.get(c.xpub);
    if (dup) {
      throw new Error(`"${dup.name}" and "${c.name}" are the same key — each key can only go into the wallet once.`);
    }
    seen.set(c.xpub, c);
  }

  return {
    id,
    kind: 'private',
    name: name.trim() || `${m} of ${n} wallet`,
    m,
    n,
    network,
    scriptType: 'P2WSH',
    cosigners,
    createdAt: input.now ?? Date.now(),
  };
}
