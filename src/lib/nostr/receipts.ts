import { Group } from '../types';
import { ReceivedMessage } from './session';

export interface Receipt {
  /** The member's group pubkey. */
  author: string;
  name: string;
  /** Whether their wallet has reported holding the transaction. */
  received: boolean;
}

/**
 * For whoever shared a transaction: which members' wallets have reported
 * receiving it. Only roster members count (everyone who joined, on a group
 * that never rotated), and a receipt is matched on the unsigned txid, so it
 * holds across re-shares with more signatures.
 */
export function psbtReceipts(
  messages: ReceivedMessage[],
  group: Pick<Group, 'roster'> | undefined,
  txid: string | null
): Receipt[] {
  if (!group || !txid) return [];
  const inRoster = (author: string) => !group.roster || group.roster.includes(author);
  const names = new Map<string, string>();
  const received = new Set<string>();
  for (const m of [...messages].sort((a, b) => a.at - b.at)) {
    if (m.mine || !inRoster(m.author)) continue;
    if (m.message.type === 'join') names.set(m.author, m.message.name);
    else if (m.message.type === 'psbt-ack' && m.message.txid === txid) received.add(m.author);
  }
  return [...names].map(([author, name]) => ({ author, name, received: received.has(author) }));
}
