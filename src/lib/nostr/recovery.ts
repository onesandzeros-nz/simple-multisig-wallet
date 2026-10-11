import { Group } from '../types';
import { isEpoch, MAX_EPOCH } from './protocol';
import { ReceivedMessage } from './session';

/**
 * What a live group session should do for someone who has lost the group key
 * (RECOVERY-DESIGN.md). Kept pure, on the messages a session has received, so
 * the rules can be tested without a relay; `useGroup` acts on them.
 *
 * Someone who has lost the key can only speak on the lobby — the epoch-0
 * channel the invite opens — and all they can say there is `join`. A lobby
 * join newer than the current epoch is therefore a knock: a member or
 * coordinator back from a lost phone.
 */

type RecoveryGroup = Pick<
  Group,
  | 'coordinator'
  | 'coordinatorPubkey'
  | 'rekey'
  | 'currentEpoch'
  | 'currentEpochAt'
  | 'roster'
  | 'resealed'
  | 'resealedAt'
  | 'answeredCoordinatorAt'
>;

/** The epoch a lobby join says its sender holds, when it says one believably. */
export function reportedEpoch(m: ReceivedMessage): number | null {
  if (m.message.type !== 'join') return null;
  return isEpoch(m.message.epoch) ? m.message.epoch : null;
}

/**
 * How far above the epoch this phone last knew a report is believed. A group
 * rotates a handful of times in its life; a thousand is never reached
 * honestly, and anything past it is someone trying to spend the group's
 * numbering (`MAX_EPOCH`) so that recovery stops working.
 */
export const MAX_EPOCH_JUMP = 1_000;

/**
 * How long after an epoch begins before a silent roster member is sealed the
 * key again — and the least time between two envelopes to the same member.
 */
export const RESEAL_GRACE_MS = 2 * 60 * 1000;
/** How long after a rotation notice a member waits for its envelope before knocking. */
export const ENVELOPE_GRACE_MS = 60 * 1000;

function lobbyJoins(messages: ReceivedMessage[]): ReceivedMessage[] {
  return messages.filter((m) => !m.mine && m.epoch === 0 && m.message.type === 'join');
}

/**
 * Coordinator: roster members knocking since the current epoch began — a
 * reinstalled phone whose sealed envelope the relays no longer hold. The
 * newest knock per member, leaving out any already answered.
 *
 * Only roster pubkeys. Anyone holding the invite can knock; a stranger is a
 * latecomer, and letting one in is the coordinator's decision, not this.
 *
 * And at most one answer per member per `graceMs`, by this phone's clock
 * (`now`). A knock's time is the knocker's to choose, so each re-dated knock
 * would otherwise be a fresh one, and each answer is an envelope published
 * under the coordinator's identity and retried until a relay keeps it.
 */
export function knocksToReseal(
  messages: ReceivedMessage[],
  group: RecoveryGroup,
  epoch: number,
  now: number,
  graceMs = RESEAL_GRACE_MS
): { author: string; at: number }[] {
  if (!group.coordinator || group.rekey !== true || epoch === 0) return [];
  // Unknown start: nothing counts, or every pre-rotation join would look
  // like a knock. useGroup backfills it when a session starts.
  const since = group.currentEpochAt ?? Infinity;
  const roster = new Set(group.roster ?? []);
  const newest = new Map<string, number>();
  for (const m of lobbyJoins(messages)) {
    if (!roster.has(m.author) || m.at <= since) continue;
    // A member answering a lost coordinator already holds the key.
    const reported = reportedEpoch(m);
    if (reported !== null && reported >= epoch) continue;
    if (m.at <= (group.resealed?.[m.author] ?? 0)) continue;
    const lastAnswered = group.resealedAt?.[m.author];
    if (lastAnswered !== undefined && now - lastAnswered < graceMs) continue;
    newest.set(m.author, Math.max(newest.get(m.author) ?? 0, m.at));
  }
  return [...newest].map(([author, at]) => ({ author, at }));
}

/**
 * Member: the time of a knock from the pinned coordinator since this member's
 * epoch began — the coordinator has lost the key, and needs telling which
 * epoch the group is on. Null when there is nothing to answer.
 *
 * A coordinator that holds the key announces on it, never on the lobby, so
 * its original pre-rotation join is the only lobby join it should have — and
 * that is older than the epoch.
 */
export function coordinatorKnock(messages: ReceivedMessage[], group: RecoveryGroup, epoch: number): number | null {
  if (group.coordinator || group.rekey !== true || !group.coordinatorPubkey || epoch === 0) return null;
  const since = Math.max(group.currentEpochAt ?? Infinity, group.answeredCoordinatorAt ?? 0);
  let newest: number | null = null;
  for (const m of lobbyJoins(messages)) {
    if (m.author !== group.coordinatorPubkey || m.at <= since) continue;
    newest = Math.max(newest ?? 0, m.at);
  }
  return newest;
}

/**
 * Restored coordinator without the key: the highest epoch the group is known
 * to have reached, to rotate above — from the answers of the members about
 * to be sealed in, and from this coordinator's own rekey notices on the lobby.
 *
 * Only `roster` is believed. Anyone holding the invite can answer on the
 * lobby, and the epoch in a join is just a number: a stranger claiming
 * 999,999 would push the group's numbering to the ceiling and stop recovery
 * working for good. The roster is the people the coordinator has decided to
 * hand the key to, so trusting their count costs nothing more. Nothing is
 * believed further than `MAX_EPOCH_JUMP` above the epoch this phone last
 * knew, either — a bound no real group reaches.
 */
export function epochFloor(messages: ReceivedMessage[], group: RecoveryGroup, roster: string[]): number {
  const known = group.currentEpoch ?? 0;
  const trusted = new Set(roster);
  const believable = (e: number) => e < MAX_EPOCH && e <= known + MAX_EPOCH_JUMP;
  let floor = known;
  for (const m of messages) {
    if (m.epoch !== 0) continue;
    const reported = trusted.has(m.author) ? reportedEpoch(m) : null;
    if (reported !== null && believable(reported)) floor = Math.max(floor, reported);
    if (m.message.type === 'rekey-notice' && m.author === group.coordinatorPubkey && believable(m.message.epoch)) {
      floor = Math.max(floor, m.message.epoch);
    }
  }
  return floor;
}

/**
 * Whether someone on `roster` has told a lost coordinator which epoch the
 * group is on. Gated like `epochFloor`: an answer from anyone else would
 * enable re-securing without a floor to re-secure above.
 */
export function heardFromMembers(messages: ReceivedMessage[], roster: string[]): boolean {
  const trusted = new Set(roster);
  return lobbyJoins(messages).some((m) => trusted.has(m.author) && reportedEpoch(m) !== null);
}

/**
 * Coordinator: roster members not heard on the current epoch since it began,
 * once the grace has passed — their sealed envelope may never have reached a
 * relay. Safe to answer unasked: a reseal goes only to a pinned roster
 * pubkey, and a member already on the epoch ignores a second copy.
 */
export function silentOnEpoch(
  messages: ReceivedMessage[],
  group: RecoveryGroup,
  epoch: number,
  now: number,
  graceMs = RESEAL_GRACE_MS
): string[] {
  if (!group.coordinator || group.rekey !== true || epoch === 0) return [];
  const began = group.currentEpochAt;
  if (!began || now - began < graceMs) return [];
  const heard = new Set(messages.filter((m) => !m.mine && m.epoch >= epoch).map((m) => m.author));
  return (group.roster ?? []).filter((a) => a !== group.coordinatorPubkey && !heard.has(a));
}

/**
 * Member: an epoch the coordinator announced that this phone never got the
 * key for — the notice arrived, the envelope did not, and enough time has
 * passed that it is not merely in flight. Null when there is nothing to
 * chase. The answer is a knock on the lobby, which the coordinator's
 * `knocksToReseal` turns into a fresh envelope.
 */
export function missingEpoch(
  messages: ReceivedMessage[],
  group: RecoveryGroup,
  epoch: number,
  now: number,
  graceMs = ENVELOPE_GRACE_MS
): number | null {
  if (group.coordinator || group.rekey !== true || !group.coordinatorPubkey) return null;
  let newest: number | null = null;
  for (const m of messages) {
    if (m.message.type !== 'rekey-notice' || m.author !== group.coordinatorPubkey) continue;
    if (m.message.epoch <= epoch || m.message.epoch >= MAX_EPOCH) continue;
    if (now - m.at < graceMs) continue;
    newest = Math.max(newest ?? 0, m.message.epoch);
  }
  return newest;
}
