import { useGroup } from '../lib/nostr/useGroup';
import { Group } from '../lib/types';

/**
 * Keeps a group's relay session alive while a list is on screen, so unread
 * markers appear without having to open the group first. Renders nothing.
 */
export function GroupSyncer({ group }: { group: Group }) {
  useGroup(group);
  return null;
}
