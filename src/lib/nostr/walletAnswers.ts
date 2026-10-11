import { Group } from '../types';
import { ReceivedMessage } from './session';

export type WalletAnswer = 'added' | 'declined' | 'waiting';

export interface MemberAnswer {
  /** The member's group pubkey. */
  author: string;
  name: string;
  answer: WalletAnswer;
}

/**
 * For the coordinator: each member the shared wallet went to, and whether
 * they have added it, declined it, or not answered yet. Null when no wallet
 * has been shared. Only answers to the current build count — a reply names
 * the descriptor it answers — and only members of the sealed roster are
 * listed, or everyone who joined on a group that never rotated.
 */
export function memberAnswers(
  messages: ReceivedMessage[],
  group: Pick<Group, 'coordinatorPubkey' | 'roster'> | undefined
): MemberAnswer[] | null {
  if (!group) return null;
  // Only the pinned coordinator may define the wallet; legacy groups without
  // a pinned pubkey accept any author, as the group screen does.
  const fromCoordinator = (author: string) => !group.coordinatorPubkey || author === group.coordinatorPubkey;
  const ordered = [...messages].sort((a, b) => a.at - b.at);

  let descriptor: string | null = null;
  for (const m of ordered) {
    if (m.message.type === 'wallet' && fromCoordinator(m.author)) descriptor = m.message.descriptor;
  }
  if (descriptor === null) return null;

  const inRoster = (author: string) => !group.roster || group.roster.includes(author);
  const names = new Map<string, string>();
  const replies = new Map<string, boolean>();
  for (const m of ordered) {
    if (m.mine || !inRoster(m.author)) continue;
    if (m.message.type === 'join') {
      names.set(m.author, m.message.name);
    } else if (m.message.type === 'wallet-reply' && m.message.descriptor === descriptor) {
      replies.set(m.author, m.message.accepted);
      if (!names.has(m.author)) names.set(m.author, m.message.name);
    }
  }
  return [...names].map(([author, name]) => {
    const accepted = replies.get(author);
    return { author, name, answer: accepted === undefined ? 'waiting' : accepted ? 'added' : 'declined' };
  });
}
