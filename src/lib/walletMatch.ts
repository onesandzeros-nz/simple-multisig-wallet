import { Cosigner, MultisigWallet } from './types';

/**
 * Two wallet records describe the same on-chain wallet when they share the
 * network, the policy and the exact set of cosigner xpubs — the descriptor,
 * in other words. Names, key links and record ids are per-phone and don't
 * count; sortedmulti makes cosigner order irrelevant too.
 */
export function sameWalletPolicy(
  a: Pick<MultisigWallet, 'm' | 'n' | 'network' | 'cosigners'>,
  b: Pick<MultisigWallet, 'm' | 'n' | 'network' | 'cosigners'>
): boolean {
  if (a.m !== b.m || a.n !== b.n || a.network !== b.network) return false;
  if (a.cosigners.length !== b.cosigners.length) return false;
  const xpubs = (w: { cosigners: Cosigner[] }) => w.cosigners.map((c) => c.xpub).sort();
  const ax = xpubs(a);
  const bx = xpubs(b);
  return ax.every((x, i) => x === bx[i]);
}

export function findSameWallet(
  wallets: MultisigWallet[],
  candidate: Pick<MultisigWallet, 'm' | 'n' | 'network' | 'cosigners'>
): MultisigWallet | undefined {
  return wallets.find((w) => sameWalletPolicy(w, candidate));
}

/**
 * A group has just produced a wallet this phone already holds — typically a
 * copy restored from a backup before rejoining the group. Rather than add a
 * second record watching the same coins, turn the existing one into the group
 * wallet. The user's own name for it is kept; key links come from the group
 * build where it proved a key is held, and stay as they were otherwise.
 */
export function adoptAsGroupWallet(
  existing: MultisigWallet,
  built: Pick<MultisigWallet, 'cosigners'>
): Partial<MultisigWallet> {
  const cosigners = existing.cosigners.map((c) => {
    const fresh = built.cosigners.find((b) => b.xpub === c.xpub);
    return fresh?.keyId ? { ...c, keyId: fresh.keyId, name: fresh.name } : c;
  });
  return { kind: 'group', cosigners };
}
