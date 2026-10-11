import React from 'react';
import { addGroupEpoch, effectiveRelays, loadGroupEpochs, loadMnemonic, useStore } from '../store';
import { StoredChat } from '../types';
import { Group } from '../types';
import { GroupSession, ReceivedMessage } from './session';
import { OutboxItem } from './outbox';
import { outboxFor } from './outboxStore';
import { nostrSecretForGroup } from './identity';
import { coordinatorKnock, knocksToReseal, missingEpoch, RESEAL_GRACE_MS, silentOnEpoch } from './recovery';
import { memberName } from '../naming';

/**
 * Knocks already being answered, across every live session. A group can have
 * several at once (the list behind a screen, the screen, its chat), and each
 * sees the same knock; the group record remembers answered ones across
 * restarts, but not before its write lands.
 */
const answering = new Set<string>();

export interface GroupState {
  session: GroupSession | null;
  messages: ReceivedMessage[];
  /**
   * The epoch this session publishes on. Tracked as state because a member
   * can have two live sessions (this one and a list syncing behind it), and
   * the group record may move to a new epoch before this session has adopted
   * it — anything that must wait for rotation has to wait for this one.
   */
  epoch: number;
  connected: number;
  relays: number;
  error: string | null;
  /** Messages this phone published that no relay has confirmed yet. */
  delivery: OutboxItem[];
}

/**
 * Opens a live session for a group and collects everything it receives.
 * The Nostr identity is derived from the designated phone key's seed.
 */
export function useGroup(
  group: Group | undefined
): GroupState & {
  send: GroupSession['send'] | null;
  requestDeletion: GroupSession['requestDeletion'] | null;
  /** Starts the outbox over on everything still waiting. */
  retryDelivery: () => void;
} {
  const [session, setSession] = React.useState<GroupSession | null>(null);
  const [delivery, setDelivery] = React.useState<OutboxItem[]>([]);
  // Ticks so the time-based rotation checks below run again while nothing
  // else changes — a member waiting on an envelope, or a silent roster.
  const [clock, setClock] = React.useState(0);
  React.useEffect(() => {
    const t = setInterval(() => setClock((c) => c + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const [messages, setMessages] = React.useState<ReceivedMessage[]>([]);
  const [epoch, setEpoch] = React.useState(0);
  const [status, setStatus] = React.useState({ connected: 0, relays: 0 });
  const [error, setError] = React.useState<string | null>(null);
  const { settings, keys, addChats, updateGroup } = useStore();

  // The latest record, for handlers that outlive the render that set them up.
  const groupRef = React.useRef(group);
  groupRef.current = group;

  // A group remembers the relays from its invite, but relays added in
  // Settings should help straight away — so connect to both sets.
  const relayList = React.useMemo(() => {
    const configured = effectiveRelays(settings);
    return [...new Set([...(group?.relays ?? []), ...configured])];
  }, [group?.relays, settings.relays, settings.publicRelays]);
  const relayKey = relayList.join(',');

  // What the group's outbox still holds, for the screens that show delivery.
  React.useEffect(() => {
    if (!group) {
      setDelivery([]);
      return;
    }
    const entry = outboxFor(group.id);
    setDelivery(entry.outbox.pending);
    entry.listeners.add(setDelivery);
    return () => {
      entry.listeners.delete(setDelivery);
    };
  }, [group?.id]);

  React.useEffect(() => {
    if (!group) return;
    let live: GroupSession | null = null;
    let cancelled = false;

    (async () => {
      try {
        const [mnemonic, epochs] = await Promise.all([
          loadMnemonic(group.identityKeyId),
          loadGroupEpochs(group.id),
        ]);
        if (cancelled) return;
        // A group whose identity key (its seed) or invite secret is no longer
        // on this phone — usually because the key was deleted — cannot run.
        // That is an expected, recoverable state, not a crash: surface it to
        // the UI without logging it like an error.
        if (!mnemonic) {
          setError("This group's identity key is no longer on this phone. Re-add that key, or leave the group.");
          return;
        }
        const root = epochs.find((e) => e.epoch === 0)?.secret;
        if (!root) {
          setError("This group's invite secret is missing from this phone. You'll need the invite again to rejoin.");
          return;
        }
        live = new GroupSession({
          epochs,
          relays: relayList,
          // A distinct identity per group, always from the epoch-0 secret —
          // see identity.ts.
          identitySecret: nostrSecretForGroup(mnemonic, root),
          coordinatorPubkey: group.coordinatorPubkey,
          rotation: group.rekey === true,
          outbox: outboxFor(group.id).outbox,
        });
        live.start({
          onMessage: (m) =>
            setMessages((cur) => (cur.some((x) => x.id === m.id) ? cur : [...cur, m].sort((a, b) => a.at - b.at))),
          onStatus: (connected, relays) => setStatus({ connected, relays }),
          onRekey: async (adopted) => {
            setEpoch(adopted.epoch);
            try {
              await addGroupEpoch(group.id, { epoch: adopted.epoch, secret: adopted.secret });
              // Another live session may have recorded it already.
              await updateGroup(group.id, (g) =>
                adopted.epoch > (g.currentEpoch ?? 0)
                  ? { currentEpoch: adopted.epoch, currentEpochAt: adopted.at, roster: adopted.members }
                  : {}
              );
            } catch (e: any) {
              // The session already reads the new epoch, so the group keeps
              // working now — but the secret is not on disk, and a restart
              // would lose it. Say so rather than failing silently.
              console.error(`[nostr:rekey] ${e.message ?? e}`);
              setError('Received a new group key but could not save it to this phone. Reopen the group before restarting the app.');
            }
          },
        });
        // A group that rotated before epochs were timestamped: count from now.
        // A knock from before this is missed, but the phone knocking asks
        // again the next time its group screen opens.
        if (live.epoch > 0 && !groupRef.current?.currentEpochAt) {
          await updateGroup(group.id, (g) => (g.currentEpochAt ? {} : { currentEpochAt: Date.now() }));
        }
        setEpoch(live.epoch);
        setSession(live);
      } catch (e: any) {
        console.error(`[nostr:start] ${e.message ?? e}\n${e.stack ?? ''}`);
        setError(e.message ?? String(e));
      }
    })();

    return () => {
      cancelled = true;
      live?.stop();
      setSession(null);
      setEpoch(0);
    };
  }, [group?.id, relayKey]);

  // Someone who has lost the group key knocks on the lobby
  // (RECOVERY-DESIGN.md). The coordinator seals the current key back to a
  // roster member; a member tells a coordinator that lost it which epoch the
  // group is on, so it can re-secure above it. Wherever a session is live —
  // the Home screen keeps one per group — not only on the group screen.
  // A member is answered at most once per grace, so a knock inside it is
  // answered when the grace ends: this counter re-runs the effect then.
  const [graceOver, setGraceOver] = React.useState(0);
  React.useEffect(() => {
    const latest = groupRef.current;
    if (!session || !latest || latest.rekey !== true || session.epoch === 0) return;
    const now = Date.now();

    for (const knock of knocksToReseal(messages, latest, session.epoch, now)) {
      const tag = `${latest.id}:reseal:${knock.author}:${knock.at}`;
      if (answering.has(tag)) continue;
      answering.add(tag);
      session.reseal(knock.author, latest.roster ?? []);
      updateGroup(latest.id, (g) => ({
        resealed:
          (g.resealed?.[knock.author] ?? 0) >= knock.at ? g.resealed : { ...g.resealed, [knock.author]: knock.at },
        resealedAt: { ...g.resealedAt, [knock.author]: now },
      })).catch((e) => console.error(`[nostr:reseal] ${e?.message ?? e}`));
    }
    const waits = Object.values(latest.resealedAt ?? {})
      .map((at) => at + RESEAL_GRACE_MS - now)
      .filter((wait) => wait > 0);
    const timer = waits.length > 0 ? setTimeout(() => setGraceOver((n) => n + 1), Math.min(...waits)) : null;

    const knockAt = coordinatorKnock(messages, latest, session.epoch);
    const tag = `${latest.id}:answer:${knockAt}`;
    if (knockAt !== null && !answering.has(tag)) {
      answering.add(tag);
      const identity = keys.find((k) => k.id === latest.identityKeyId);
      session.announce({
        type: 'join',
        name: memberName(settings.userName, identity),
        rekey: true,
        epoch: session.epoch,
      });
      updateGroup(latest.id, (g) =>
        (g.answeredCoordinatorAt ?? 0) >= knockAt ? {} : { answeredCoordinatorAt: knockAt }
      ).catch((e) => console.error(`[nostr:answer] ${e?.message ?? e}`));
    }
    // The record is read through groupRef; what changes the answer is new
    // messages, a new epoch, a record that now carries the epoch's start, or
    // a grace ending.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [messages, session, epoch, group?.currentEpochAt, group?.roster, graceOver]);

  // Rotation retry. A sealed envelope is published once; if the relays lost
  // it, the member it was for is stranded on the old key without ever
  // knocking. So the coordinator seals the key again to anyone still silent
  // on the new epoch, and a member who saw the notice but no envelope knocks
  // on the lobby. Both at most once per launch per case.
  React.useEffect(() => {
    const latest = groupRef.current;
    if (!session || !latest || latest.rekey !== true) return;
    const now = Date.now();

    for (const author of silentOnEpoch(messages, latest, session.epoch, now)) {
      const tag = `${latest.id}:reseal-silent:${author}:${session.epoch}`;
      if (answering.has(tag)) continue;
      answering.add(tag);
      session.reseal(author, latest.roster ?? []);
    }

    const missing = missingEpoch(messages, latest, session.epoch, now);
    const tag = `${latest.id}:chase:${missing}`;
    if (missing !== null && !answering.has(tag)) {
      answering.add(tag);
      const identity = keys.find((k) => k.id === latest.identityKeyId);
      session.announce({
        type: 'join',
        name: memberName(settings.userName, identity),
        rekey: true,
        epoch: session.epoch,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, session, epoch, clock, group?.currentEpochAt, group?.roster]);

  // Record chat wherever a session is live, so the unread count is right
  // even if the chat screen was never opened.
  React.useEffect(() => {
    if (!group) return;
    const incoming: StoredChat[] = messages
      .filter((m) => m.message.type === 'chat')
      .map((m) => ({
        id: m.id,
        groupId: group.id,
        author: m.author,
        name: m.message.type === 'chat' ? m.message.name : '',
        text: m.message.type === 'chat' ? m.message.text : '',
        mine: m.mine,
        at: m.at,
      }));
    if (incoming.length) addChats(incoming);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, group?.id]);

  return {
    session,
    messages,
    epoch,
    connected: status.connected,
    relays: status.relays,
    error,
    delivery,
    send: session ? session.send.bind(session) : null,
    requestDeletion: session ? session.requestDeletion.bind(session) : null,
    retryDelivery: () => {
      if (group) outboxFor(group.id).outbox.kick();
    },
  };
}
