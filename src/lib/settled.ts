/**
 * Transactions that are done with — broadcast from this phone, or already
 * seen on chain. Group members keep re-sharing a PSBT after it has been
 * sent, so without this the wallet would keep resurrecting it as a draft.
 *
 * Only needed for the window between broadcasting and the next chain
 * refresh; after that the wallet's own history is the source of truth, so
 * this deliberately does not persist.
 */
const settled = new Set<string>();

const key = (walletId: string, txid: string) => `${walletId}:${txid}`;

export function markSettled(walletId: string, txid: string): void {
  settled.add(key(walletId, txid));
}

export function isSettled(walletId: string, txid: string): boolean {
  return settled.has(key(walletId, txid));
}

export function forgetSettled(walletId: string): void {
  for (const entry of [...settled]) {
    if (entry.startsWith(`${walletId}:`)) settled.delete(entry);
  }
}
