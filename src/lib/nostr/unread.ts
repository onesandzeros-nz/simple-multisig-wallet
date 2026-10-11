import { Group, PendingTx, StoredChat } from '../types';

/**
 * What has arrived in a group since the person last looked.
 * Own messages never count, and neither does anything already seen.
 */
export interface UnreadCounts {
  chat: number;
  transactions: number;
  get total(): number;
}

export function unreadChat(group: Group | undefined, chats: StoredChat[]): number {
  if (!group) return 0;
  const since = group.lastReadChatAt ?? 0;
  return chats.filter((c) => c.groupId === group.id && !c.mine && c.at > since).length;
}

/**
 * Transactions that changed since the wallet was last opened — a new draft
 * from a member, or an existing one that gained a signature.
 */
export function unreadTransactions(group: Group | undefined, pending: PendingTx[]): number {
  if (!group?.walletId) return 0;
  const since = group.lastSeenTxAt ?? 0;
  return pending.filter((p) => p.walletId === group.walletId && p.updatedAt > since).length;
}

export function unreadFor(
  group: Group | undefined,
  chats: StoredChat[],
  pending: PendingTx[]
): { chat: number; transactions: number; total: number } {
  const chat = unreadChat(group, chats);
  const transactions = unreadTransactions(group, pending);
  return { chat, transactions, total: chat + transactions };
}
