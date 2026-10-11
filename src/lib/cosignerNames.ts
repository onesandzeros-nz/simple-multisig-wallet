import { Cosigner, MultisigWallet } from './types';

/**
 * The names that travel with a shared wallet (`WalletMessage.names`): who
 * holds each key, so the members' wallets say "Alice" and "Rob's phone"
 * rather than "Cosigner 1" and "Cosigner 2".
 *
 * On the wire the names sit in the descriptor's key order; here they are
 * keyed by xpub, since a wallet record on a phone may hold the same keys in
 * another order (one adopted from a private wallet, say).
 */

/** The name a parser gives a key nobody has named. */
const PLACEHOLDER = /^Cosigner \d+$/;

export function isPlaceholderName(name: string): boolean {
  return PLACEHOLDER.test(name.trim());
}

/**
 * What the coordinator shares: its own wallet's name for each key, in the
 * order the descriptor lists them.
 */
export function sharedNamesFor(
  wallet: Pick<MultisigWallet, 'cosigners'>,
  descriptorKeys: Pick<Cosigner, 'xpub' | 'name'>[]
): string[] {
  return descriptorKeys.map((k) => wallet.cosigners.find((c) => c.xpub === k.xpub)?.name ?? k.name);
}

/**
 * The shared names by xpub. Empty unless there is exactly one name per key
 * — anything else came from a different build, or is malformed, and the
 * keys keep their names.
 */
export function namesByXpub(descriptorKeys: Pick<Cosigner, 'xpub'>[], names: string[] | undefined): Map<string, string> {
  const byXpub = new Map<string, string>();
  if (!names || names.length !== descriptorKeys.length) return byXpub;
  descriptorKeys.forEach((k, i) => {
    const name = names[i].trim();
    if (name) byXpub.set(k.xpub, name);
  });
  return byXpub;
}

/**
 * Cosigners with the shared names applied. A key this phone holds (`keyId`
 * set) keeps the name it has here: its owner knows what to call it.
 */
export function applySharedNames<C extends Cosigner>(cosigners: C[], names: Map<string, string>): C[] {
  return cosigners.map((c) => {
    const name = names.get(c.xpub);
    return !c.keyId && name ? { ...c, name } : c;
  });
}

/**
 * A wallet already on this phone with shared names filled in where it still
 * shows a placeholder — for members who added the wallet before names were
 * shared. Nothing else changes: a name the person chose is theirs. Null when
 * there is nothing to fill in.
 */
export function backfillSharedNames(wallet: MultisigWallet, names: Map<string, string>): MultisigWallet | null {
  let changed = false;
  const cosigners = wallet.cosigners.map((c) => {
    const name = names.get(c.xpub);
    if (c.keyId || !name || !isPlaceholderName(c.name) || c.name === name) return c;
    changed = true;
    return { ...c, name };
  });
  return changed ? { ...wallet, cosigners } : null;
}
