import { MAX_NAME_CHARS } from '../lib/nostr/protocol';
import React from 'react';
import { Alert, Share, Text, TouchableOpacity, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { Screen, Card, Button, SectionTitle, Tag, Mono, Row, Divider, UnreadDot, Stepper } from '../components/ui';
import { ConfigureKeysModal, KeyCandidate } from '../components/ConfigureKeysModal';
import { WalletAnswersCard } from '../components/WalletAnswersCard';
import { unreadChat } from '../lib/nostr/unread';
import { QrModal } from '../components/QrModal';
import { confirmOwner } from '../lib/ownerCheck';
import { colors } from '../theme';
import { showError } from '../lib/errors';
import { useStore, newId, loadMnemonic, loadGroupSecret, addGroupEpoch } from '../lib/store';
import { adoptAsGroupWallet, findSameWallet } from '../lib/walletMatch';
import { accountXpub, keyCheckCode, walletDescriptor } from '../lib/bitcoin';
import { keyExpressionForStoredKey } from '../lib/keyShare';
import { parseWalletDescriptor } from '../lib/walletImport';
import { applySharedNames, backfillSharedNames, namesByXpub, sharedNamesFor } from '../lib/cosignerNames';
import { parseKeyExpression } from '../lib/slip132';
import { encodeInvite } from '../lib/nostr/protocol';
import { shortNpub } from '../lib/nostr/identity';
import { memberName } from '../lib/naming';
import { policyTradeoffs } from '../lib/tutorialPolicy';
import { useGroup } from '../lib/nostr/useGroup';
import { memberAnswers } from '../lib/nostr/walletAnswers';
import { epochFloor, heardFromMembers, reportedEpoch } from '../lib/nostr/recovery';
import { Cosigner, MultisigWallet, SignerKey } from '../lib/types';
import { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Group'>;

interface ContributedKey {
  /** Nostr event id — used for selection and NIP-09 cleanup. */
  eventId: string;
  xpub: string;
  fingerprint: string;
  path: string;
  memberName: string;
  author: string;
  mine: boolean;
  at: number;
}

export default function GroupScreen({ navigation, route }: Props) {
  const { groups, wallets, keys, chats, settings, addWallet, updateWallet, updateGroup, removeGroup } = useStore();
  const group = groups.find((g) => g.id === route.params.groupId);
  const { session, messages, epoch: sessionEpoch, connected, relays, error, send } = useGroup(group);
  const [qrOpen, setQrOpen] = React.useState(false);
  const [secret, setSecret] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (group) loadGroupSecret(group.id).then(setSecret);
  }, [group?.id]);
  const [busy, setBusy] = React.useState(false);
  const [approved, setApproved] = React.useState<string[]>([]);
  const [configureOpen, setConfigureOpen] = React.useState(false);
  // Non-null while the coordinator is editing the policy (a draft to Save).
  const [draftPolicy, setDraftPolicy] = React.useState<{ n: number; m: number } | null>(null);
  const publishedRef = React.useRef(false);
  const lastSelectionRef = React.useRef<string>('');
  // So the one-time default selection only happens once, letting manual
  // ticking override it afterwards.
  const autoSelectedRef = React.useRef(false);
  // A ref as well as `busy` for accepting a wallet: a second tap can land
  // before the re-render that disables the button, and two runs would each
  // add a wallet. Declared up here with the other hooks: leaving the group
  // empties `group`, the early return below fires, and a hook after it would
  // make React see fewer hooks than the render before.
  const acceptingRef = React.useRef(false);

  React.useEffect(() => {
    navigation.setOptions({ title: group?.name ?? 'Group' });
  }, [group?.name]);

  const wallet = wallets.find((w) => w.id === group?.walletId);

  /**
   * Every key anyone has contributed, deduped by xpub and kept in arrival
   * order — one member may legitimately contribute several keys.
   */
  const contributed: ContributedKey[] = React.useMemo(() => {
    const byXpub = new Map<string, ContributedKey>();
    for (const m of messages) {
      if (m.message.type !== 'key') continue;
      try {
        const parsed = parseKeyExpression(m.message.keyExpression);
        if (!parsed.fingerprint || !parsed.path) continue;
        if (byXpub.has(parsed.xpub)) continue;
        byXpub.set(parsed.xpub, {
          eventId: m.id,
          xpub: parsed.xpub,
          fingerprint: parsed.fingerprint,
          path: parsed.path,
          memberName: m.message.name,
          author: m.author,
          mine: m.mine,
          at: m.at,
        });
      } catch {
        // ignore malformed key messages from the channel
      }
    }
    return [...byXpub.values()].sort((a, b) => a.at - b.at);
  }, [messages]);

  // Only the pinned coordinator may define the wallet or the selection. Without
  // a pinned pubkey (legacy groups) fall back to accepting any author, which is
  // the old, unsafe behaviour — new groups always carry one from the invite.
  const fromCoordinator = React.useCallback(
    (author: string) => !group?.coordinatorPubkey || author === group.coordinatorPubkey,
    [group?.coordinatorPubkey]
  );

  const walletMessage = React.useMemo(
    () =>
      [...messages]
        .reverse()
        .find((m) => m.message.type === 'wallet' && fromCoordinator(m.author)),
    [messages, fromCoordinator]
  );

  /**
   * The coordinator's wallet, parsed for display *before* anyone accepts it:
   * members review the cosigner set (check codes, and whether each key was
   * ever shared in this group), not just the raw descriptor text.
   */
  const receivedWallet = React.useMemo(() => {
    if (!walletMessage || walletMessage.message.type !== 'wallet') return null;
    try {
      return parseWalletDescriptor(walletMessage.message.descriptor);
    } catch {
      return null;
    }
  }, [walletMessage]);

  /** Coordinator: who has added the shared wallet, who declined, who is yet to answer. */
  const answers = React.useMemo(
    () => memberAnswers(messages, group),
    [messages, group?.coordinatorPubkey, group?.roster]
  );

  /** Who holds each key, as the coordinator shared it with the wallet, by xpub. */
  const sharedNames = React.useMemo(
    () =>
      walletMessage?.message.type === 'wallet' && receivedWallet
        ? namesByXpub(receivedWallet.cosigners, walletMessage.message.names)
        : new Map<string, string>(),
    [walletMessage, receivedWallet]
  );

  // Names shared after this phone added the wallet fill in any key still
  // called "Cosigner N". A name the person chose themselves stays.
  React.useEffect(() => {
    if (!wallet || sharedNames.size === 0) return;
    const filled = backfillSharedNames(wallet, sharedNames);
    if (filled) {
      updateWallet(wallet.id, { cosigners: filled.cosigners }).catch((e) =>
        console.error(`[nostr:names] ${e?.message ?? e}`)
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet?.id, sharedNames]);

  // A coordinator whose wallet went out before names travelled with it shares
  // it again with them, once per visit. The descriptor is the same, so nobody
  // is asked anything twice; members' wallets just learn the names.
  const resharedRef = React.useRef(false);
  React.useEffect(() => {
    if (resharedRef.current || !group?.coordinator || !wallet || !send || !receivedWallet) return;
    if (!walletMessage || walletMessage.message.type !== 'wallet' || walletMessage.message.names) return;
    resharedRef.current = true;
    try {
      send({
        type: 'wallet',
        name: walletMessage.message.name,
        descriptor: walletMessage.message.descriptor,
        names: sharedNamesFor(wallet, receivedWallet.cosigners),
      });
    } catch (e: any) {
      console.error(`[nostr:names] ${e?.message ?? e}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group?.coordinator, wallet?.id, send, walletMessage, receivedWallet]);

  // Retrofit: a coordinator's own per-group pubkey is exactly its session
  // pubkey, so pin it on groups created before the field existed.
  React.useEffect(() => {
    if (!group?.coordinator || !session) return;
    if (group.coordinatorPubkey === session.pubkey) return;
    updateGroup(group.id, { coordinatorPubkey: session.pubkey });
  }, [group?.id, group?.coordinator, group?.coordinatorPubkey, session?.pubkey]);

  // The coordinator ticks which keys go in. We keep the selection clean of
  // withdrawn keys, and — once, as a starting point — pre-tick the
  // coordinator's own contributed keys. Everyone else's key must be ticked by
  // hand (after verifying its check code), and manual choices are never undone.
  React.useEffect(() => {
    if (!group?.coordinator) return;
    setApproved((cur) => {
      let next = cur.filter((x) => contributed.some((c) => c.xpub === x));
      if (!autoSelectedRef.current) {
        const mine = contributed.filter((c) => c.mine).map((c) => c.xpub);
        if (mine.length > 0) {
          next = [...new Set([...next, ...mine])].slice(0, group.n);
          autoSelectedRef.current = true;
        }
      }
      return next.length === cur.length && next.every((x, i) => x === cur[i]) ? cur : next;
    });
  }, [contributed, group?.n, group?.coordinator]);

  /**
   * Who has announced themselves, newest announcement per member. The
   * coordinator seals the rotated key to exactly this list.
   */
  const joined = React.useMemo(() => {
    const byAuthor = new Map<
      string,
      { author: string; name: string; rekey: boolean; mine: boolean; epoch: number; answered: boolean }
    >();
    for (const m of messages) {
      if (m.message.type !== 'join') continue;
      byAuthor.set(m.author, {
        author: m.author,
        name: m.message.name,
        rekey: m.message.rekey === true,
        mine: m.mine,
        epoch: m.epoch,
        // Told a coordinator that lost the key which epoch it holds — an
        // existing member, as far as anyone holding the invite can claim.
        answered: (byAuthor.get(m.author)?.answered ?? false) || reportedEpoch(m) !== null,
      });
    }
    return [...byAuthor.values()];
  }, [messages]);

  // Announce ourselves once per session, so the coordinator can build a roster
  // to seal the rotated key to. Cheap and idempotent — the roster dedupes by
  // author, and a repeat after a reinstall is exactly what re-admits us.
  const announcedRef = React.useRef(false);
  React.useEffect(() => {
    if (!group || !send || announcedRef.current) return;
    announcedRef.current = true;
    const identity = keys.find((k) => k.id === group.identityKeyId);
    send({ type: 'join', name: memberName(settings.userName, identity), rekey: true });
  }, [!!send, group?.id]);

  const toggleApproved = (xpub: string) =>
    setApproved((cur) => {
      if (cur.includes(xpub)) return cur.filter((x) => x !== xpub);
      if (!group || cur.length >= group.n) return cur;
      return [...cur, xpub];
    });

  /**
   * What the coordinator has picked. On the coordinator's own phone that is
   * local state; everyone else learns it from the published selection, which
   * is how a member sees their key go in without waiting for the wallet.
   */
  const publishedSelection = React.useMemo(() => {
    const latest = [...messages]
      .reverse()
      .find((m) => m.message.type === 'selection' && fromCoordinator(m.author));
    return latest && latest.message.type === 'selection' ? latest.message.xpubs : null;
  }, [messages, fromCoordinator]);

  const chosenXpubs = group?.coordinator ? approved : (publishedSelection ?? []);
  // The chosen keys, resolved to their contributed entries (for names / codes)
  // in selection order.
  const chosenKeys = chosenXpubs
    .map((x) => contributed.find((c) => c.xpub === x))
    .filter((c): c is ContributedKey => !!c);

  // Coordinator: publish the pick whenever it changes.
  React.useEffect(() => {
    if (!group?.coordinator || !send || wallet) return;
    const encoded = approved.join(',');
    if (encoded === lastSelectionRef.current) return;
    lastSelectionRef.current = encoded;
    if (approved.length === 0) return;
    send({ type: 'selection', xpubs: approved });
  }, [approved, !!send, wallet?.id]);

  // From `chosenXpubs`, not `approved`: `approved` is the coordinator's local
  // state and stays empty on a member's phone.
  const slotsLeft = (group?.n ?? 0) - chosenXpubs.length;
  const full = slotsLeft <= 0;
  /**
   * Keys members have shared that the coordinator has not ticked yet. They
   * only appear inside Configure keys, so without a pointer on this screen a
   * member's key looks as though it never arrived.
   */
  const awaiting =
    group?.coordinator && !full ? contributed.filter((c) => !c.mine && !approved.includes(c.xpub)) : [];

  // Publish the keys this device promised, once, as soon as a relay is up —
  // but never before the group has rotated off the invite key, or the xpubs
  // would sit on the relays readable by whoever gets the link next.
  //
  // The keys chosen when creating or joining are promised while the group is
  // still on the invite key, so this has to fire again when the rotation
  // lands. It waits on this session's own epoch, not the group record: a list
  // syncing behind this screen can save the new epoch first, and `send` would
  // refuse until this session has adopted it too. A member hears about that
  // through `sessionEpoch`; the coordinator rotates this session itself and
  // then saves `currentEpoch`.
  React.useEffect(() => {
    if (!group || !send || !session || wallet || publishedRef.current) return;
    if (group.rekey === true && session.epoch === 0) return;
    if ((group.contributedKeyIds?.length ?? 0) === 0) return;
    publishedRef.current = true;
    (async () => {
      try {
        const mine = keys.filter((k) => (group.contributedKeyIds ?? []).includes(k.id));
        // The group sees the member, not the key: names come from the phone
        // key acting as this device's identity. Imported keys have no group
        // name of their own, so several contributions are told apart by
        // appending the key's own name.
        const identity = keys.find((k) => k.id === group.identityKeyId);
        const me = memberName(settings.userName, identity);
        for (const k of mine) {
          send({
            type: 'key',
            name: (mine.length > 1 ? `${me} · ${k.name}` : me).slice(0, MAX_NAME_CHARS),
            keyExpression: await keyExpressionForStoredKey(k, group.network),
          });
        }
      } catch (e: any) {
        publishedRef.current = false;
        showError('nostr:share-key', e);
      }
    })();
  }, [!!send, group?.id, wallet?.id, sessionEpoch, group?.currentEpoch]);

  if (!group) return null;

  const epoch = group.currentEpoch ?? 0;
  /** This group rotates off the invite key; legacy groups do not. */
  const rotates = group.rekey === true;
  /** Safe to put keys, selections and transactions on the wire. */
  const secured = !rotates || epoch > 0;
  /** Members who joined from a build that cannot follow a rotation. */
  const stragglers = joined.filter((j) => !j.mine && !j.rekey);
  const others = joined.filter((j) => !j.mine);
  /**
   * People who turned up after the roster closed. They were never sealed the
   * current key, so the coordinator has to let them in deliberately — that
   * decision is the membership check rotation rests on.
   */
  const latecomers = secured && group.coordinator
    ? others.filter((j) => !(group.roster ?? []).includes(j.author))
    : [];
  /** How this phone is named to the group. */
  const myName = () => memberName(settings.userName, keys.find((k) => k.id === group.identityKeyId));

  const invite = secret
    ? encodeInvite({
        secret,
        relays: group.relays,
        name: group.name,
        coordinatorPubkey: group.coordinatorPubkey,
        m: group.m,
        n: group.n,
        network: group.network,
        rekey: rotates,
      })
    : null;

  /**
   * Closes the roster and moves the group onto a key the invite cannot read.
   * Everything substantive waits for this, so the invite only ever protects
   * the handshake — see REKEY-DESIGN.md.
   *
   * Also how a coordinator restored without its copy of the key re-secures
   * the group (RECOVERY-DESIGN.md): it rotates above the highest epoch the
   * members have reported, or they would ignore the new one.
   */
  const secureGroup = async () => {
    setBusy(true);
    try {
      if (!session) throw new Error('Not connected to any relay yet.');
      const roster = [...new Set([session.pubkey, ...joined.map((j) => j.author)])];
      const adopted = session.rotate(roster, epochFloor(messages, group, roster));
      await addGroupEpoch(group.id, { epoch: adopted.epoch, secret: adopted.secret });
      await updateGroup(group.id, {
        currentEpoch: adopted.epoch,
        currentEpochAt: adopted.at,
        roster: adopted.members,
      });
    } catch (e: any) {
      showError('nostr:secure-group', e);
    } finally {
      setBusy(false);
    }
  };

  /** Hands the current key to someone who arrived after the roster closed. */
  const admit = async (author: string, name: string) => {
    Alert.alert(
      `Let ${name} in?`,
      'They will be able to read this group from now on. Only do this if you know who they are — anyone holding the invite link can ask.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Let in',
          onPress: async () => {
            try {
              if (!session) throw new Error('Not connected to any relay yet.');
              const roster = [...new Set([...(group.roster ?? []), author])];
              session.reseal(author, roster);
              await updateGroup(group.id, (g) => ({ roster: [...new Set([...(g.roster ?? []), author])] }));
            } catch (e: any) {
              showError('nostr:admit-member', e);
            }
          },
        },
      ]
    );
  };

  /**
   * Records the group's wallet on this phone. If the same wallet is already
   * here — restored from a backup, say — it becomes the group wallet rather
   * than being duplicated. Returns the id to show.
   */
  const adoptWallet = async (built: MultisigWallet): Promise<string> => {
    const existing = findSameWallet(wallets, built);
    if (existing) {
      await updateWallet(existing.id, adoptAsGroupWallet(existing, built));
      await updateGroup(group.id, { walletId: existing.id });
      return existing.id;
    }
    await addWallet(built);
    await updateGroup(group.id, { walletId: built.id });
    return built.id;
  };

  const buildWallet = async () => {
    setBusy(true);
    try {
      if (!send) throw new Error('Not connected to any relay yet.');
      const chosen = approved
        .map((x) => contributed.find((c) => c.xpub === x))
        .filter((c): c is ContributedKey => !!c);
      if (chosen.length !== group.n) {
        throw new Error(`The wallet needs exactly ${group.n} keys — ${chosen.length} chosen so far.`);
      }
      // Link a cosigner to a key on this phone only with proof we hold it:
      // an exact stored xpub, or a local seed that re-derives the same xpub.
      // A claimed fingerprint alone never links — it is attacker-chosen text.
      const cosigners: Cosigner[] = await Promise.all(
        chosen.map(async (c) => {
          const byXpub = keys.find((k) => k.xpub && k.xpub === c.xpub);
          if (byXpub) {
            return { name: c.memberName, fingerprint: c.fingerprint, path: c.path, xpub: c.xpub, keyId: byXpub.id };
          }
          const localCandidate = keys.find((k) => k.type === 'local' && k.fingerprint === c.fingerprint);
          if (localCandidate) {
            const mnemonic = await loadMnemonic(localCandidate.id);
            if (mnemonic && accountXpub(mnemonic, group.network) === c.xpub) {
              return {
                name: c.memberName,
                fingerprint: c.fingerprint,
                path: c.path,
                xpub: c.xpub,
                keyId: localCandidate.id,
              };
            }
          }
          return { name: c.memberName, fingerprint: c.fingerprint, path: c.path, xpub: c.xpub };
        })
      );
      const built = {
        id: newId(),
        kind: 'group' as const,
        name: group.name,
        m: group.m,
        n: group.n,
        network: group.network,
        scriptType: 'P2WSH' as const,
        cosigners,
        createdAt: Date.now(),
      };
      const walletId = await adoptWallet(built);
      send({
        type: 'wallet',
        name: built.name,
        descriptor: walletDescriptor(built),
        names: sharedNamesFor(built, built.cosigners),
      });
      navigation.replace('Wallet', { walletId });
    } catch (e: any) {
      showError('nostr:build-wallet', e);
    } finally {
      setBusy(false);
    }
  };

  const acceptWallet = async () => {
    if (acceptingRef.current) return;
    acceptingRef.current = true;
    setBusy(true);
    try {
      if (!walletMessage || walletMessage.message.type !== 'wallet') return;
      const parsed = parseWalletDescriptor(walletMessage.message.descriptor);
      if (parsed.network !== group.network) {
        throw new Error(
          `That wallet is on ${parsed.network}, but this group agreed ${group.network}.`
        );
      }
      if (parsed.m !== group.m || parsed.n !== group.n) {
        throw new Error(
          `The wallet the coordinator built is ${parsed.m} of ${parsed.n}, but this group agreed ${group.m} of ${group.n}. Check with them before adding it.`
        );
      }
      // Link each cosigner to a key on this phone only when we can *prove* we
      // hold it: a local seed that re-derives the exact xpub, or an imported
      // key whose xpub matches exactly. Matching on fingerprint alone would
      // let a substituted xpub borrow a real key's identity.
      const cosigners = await Promise.all(
        parsed.cosigners.map(async (c) => {
          const local = keys.find((k) => k.fingerprint === c.fingerprint);
          if (local?.type === 'local') {
            const mnemonic = await loadMnemonic(local.id);
            if (mnemonic && accountXpub(mnemonic, parsed.network) === c.xpub) {
              return { ...c, keyId: local.id, name: local.name };
            }
          }
          if (local?.type === 'imported' && local.xpub === c.xpub) {
            return { ...c, keyId: local.id, name: local.name };
          }
          return c;
        })
      );
      // The coordinator's names for the other keys — who holds each — while
      // a key this phone holds keeps the name it has here.
      const named = applySharedNames(cosigners, namesByXpub(parsed.cosigners, walletMessage.message.names));
      // Never adopt a wallet that does not actually include a key we hold —
      // otherwise a bad coordinator can hand you a balance you can never sign
      // for, or funds you route in become unspendable.
      if (!named.some((c) => c.keyId)) {
        throw new Error(
          'This wallet does not include any key held on this phone. Check with the coordinator before adding it — do not deposit to it.'
        );
      }
      const built = {
        id: newId(),
        kind: 'group' as const,
        name: walletMessage.message.name || group.name,
        m: parsed.m,
        n: parsed.n,
        network: parsed.network,
        scriptType: 'P2WSH' as const,
        cosigners: named,
        createdAt: Date.now(),
      };
      const walletId = await adoptWallet(built);
      // Tell the coordinator. Best-effort: the wallet is on this phone either
      // way, and a reply that fails to send is not worth blocking on.
      if (send) {
        try {
          send({ type: 'wallet-reply', name: myName(), accepted: true, descriptor: walletMessage.message.descriptor });
        } catch (e: any) {
          console.error(`[nostr:wallet-reply] ${e?.message ?? e}`);
        }
      }
      navigation.replace('Wallet', { walletId });
    } catch (e: any) {
      showError('nostr:accept-wallet', e);
    } finally {
      acceptingRef.current = false;
      setBusy(false);
    }
  };

  /**
   * Turns the shared wallet down. The coordinator hears about it; this phone
   * stops asking until a different wallet is built, or the member looks again.
   */
  const declineWallet = () => {
    if (!walletMessage || walletMessage.message.type !== 'wallet') return;
    const descriptor = walletMessage.message.descriptor;
    Alert.alert(
      'Decline this wallet?',
      'The coordinator is told you did not add it. Nothing is deleted, and the wallet shows again if they build a different one.',
      [
        { text: 'Keep looking', style: 'cancel' },
        {
          text: 'Decline',
          style: 'destructive',
          onPress: async () => {
            if (!send) {
              showError('nostr:wallet-reply', new Error('Not connected to the group relays yet — try again in a moment.'));
              return;
            }
            try {
              send({ type: 'wallet-reply', name: myName(), accepted: false, descriptor });
              await updateGroup(group.id, { declinedDescriptor: descriptor });
            } catch (e: any) {
              showError('nostr:wallet-reply', e);
            }
          },
        },
      ]
    );
  };

  // Keys on this phone that can be contributed, and which ones this device has
  // put into the group so far. `contributedKeyIds` is the local source of
  // truth — the relay copy in `contributed` catches up.
  const usableKeys = keys.filter((k) => k.type === 'local' || !!k.xpub);
  const contributedIds = group.contributedKeyIds ?? [];

  /** Publishes a key to the group. Returns its account xpub, or null on failure. */
  const contributeKey = async (k: SignerKey): Promise<string | null> => {
    if (!send) {
      showError('nostr:add-key', new Error('Not connected to the group relays yet — try again in a moment.'));
      return null;
    }
    if (!secured) {
      Alert.alert(
        'Not secured yet',
        'The coordinator has to close the roster first. Until then the group is still using the key from the invite link, and a shared key would be readable by anyone who ever gets hold of it.'
      );
      return null;
    }
    try {
      const expression = await keyExpressionForStoredKey(k, group.network);
      const { xpub } = parseKeyExpression(expression);
      // A key can only go into the wallet once. Reject a duplicate — whether
      // this phone already added it or another member contributed the same key.
      if (contributed.some((c) => c.xpub === xpub)) {
        Alert.alert(
          'Key already in the group',
          'That key has already been added to this group. Each key can only go into the wallet once.'
        );
        return null;
      }
      const identity = keys.find((x) => x.id === group.identityKeyId);
      const me = memberName(settings.userName, identity);
      // Tell several of your own keys apart by their name once there is more
      // than one; a single contribution just shows the member name. The key
      // may already be on the list — promised at join time, before the group
      // was secured — so it is not counted against itself or added twice.
      const otherIds = contributedIds.filter((id) => id !== k.id);
      send({
        type: 'key',
        name: otherIds.length >= 1 ? `${me} · ${k.name}` : me,
        keyExpression: expression,
      });
      await updateGroup(group.id, (g) => ({
        contributedKeyIds: [...(g.contributedKeyIds ?? []).filter((id) => id !== k.id), k.id],
      }));
      return xpub;
    } catch (e: any) {
      showError('nostr:add-key', e);
      return null;
    }
  };

  // Every key for the Configure screen: those contributed to the group, plus
  // this phone's keys not yet contributed, as one tickable list.
  const keyCandidates: KeyCandidate[] = [
    ...contributed.map((c) => ({
      key: c.xpub,
      name: c.memberName,
      fingerprint: c.fingerprint,
      xpub: c.xpub,
      author: c.author,
      mine: c.mine,
      contributed: true,
      inWallet: chosenXpubs.includes(c.xpub),
    })),
    ...usableKeys
      .filter((k) => !contributed.some((c) => c.mine && c.fingerprint === k.fingerprint))
      .map((k) => ({
        key: k.id,
        name: k.name,
        fingerprint: k.fingerprint,
        xpub: null,
        author: null,
        mine: true,
        contributed: false,
        local: k,
        inWallet: false,
      })),
  ];

  // Ticking/unticking a key in the wallet — the coordinator's call alone. One
  // of their own keys is published to the group first if it has not been yet.
  const toggleKeyInWallet = async (cand: KeyCandidate) => {
    if (!group.coordinator) return;
    if (cand.inWallet && cand.xpub) {
      toggleApproved(cand.xpub);
      return;
    }
    if (!cand.contributed && cand.local) {
      const xpub = await contributeKey(cand.local);
      if (xpub) toggleApproved(xpub);
    } else if (cand.xpub) {
      toggleApproved(cand.xpub);
    }
  };

  // The coordinator can still adjust the policy until the wallet is built. New
  // invites carry the new numbers; anyone who already joined keeps the policy
  // they agreed to, so re-share the invite if you change it after inviting.
  const changePolicy = (nextN: number, nextM: number) => {
    const n = Math.max(2, Math.min(9, nextN));
    const m = Math.max(1, Math.min(n, nextM));
    if (n === group.n && m === group.m) return;
    setApproved((cur) => cur.slice(0, n));
    updateGroup(group.id, { n, m });
  };

  const savePolicy = () => {
    if (draftPolicy) changePolicy(draftPolicy.n, draftPolicy.m);
    setDraftPolicy(null);
  };

  const leave = () =>
    Alert.alert('Leave this group?', 'The group chat and invite are removed from this phone. Any wallet you already built stays.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: async () => {
          await removeGroup(group.id);
          navigation.popToTop();
        },
      },
    ]);

  /** The wallet the coordinator shared, if any — a member's to add or decline. */
  const sharedWallet = walletMessage?.message.type === 'wallet' ? walletMessage.message : null;
  const declined = !!sharedWallet && group.declinedDescriptor === sharedWallet.descriptor;

  // A member with a wallet to answer sees nothing else: the only decision on
  // the table is whether this is the wallet everyone agreed on.
  if (!wallet && !group.coordinator && sharedWallet && !declined) {
    const unshared = receivedWallet?.cosigners.some((c) => !contributed.some((k) => k.xpub === c.xpub)) ?? false;
    return (
      <Screen>
        <SectionTitle>Wallet received</SectionTitle>
        <Card>
          <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19 }}>
            The coordinator built “{sharedWallet.name}”
            {receivedWallet ? `, a ${receivedWallet.m} of ${receivedWallet.n} wallet with these keys` : ''}. Add it
            if this is the wallet you all agreed on. If it is not, decline and the coordinator is told.
          </Text>
          {receivedWallet ? (
            receivedWallet.cosigners.map((c, i) => {
              // Tie each key to whoever shared it here. "Mine" only when this
              // phone published that exact xpub or holds it as an import — a
              // fingerprint alone is attacker-chosen text.
              const shared = contributed.find((k) => k.xpub === c.xpub);
              const held = keys.find((k) => k.fingerprint === c.fingerprint);
              const mine = shared?.mine === true || (!!held && held.xpub === c.xpub);
              return (
                <View key={c.xpub}>
                  {i > 0 && <Divider />}
                  <Row
                    icon={mine ? 'phone-portrait-outline' : 'key-outline'}
                    title={mine ? held?.name ?? shared?.memberName ?? c.name : shared?.memberName ?? c.name}
                    subtitle={mine ? 'This phone' : shared ? shortNpub(shared.author) : c.fingerprint}
                    trailing={
                      mine ? (
                        <Tag text="Mine" tone="accent" />
                      ) : shared ? undefined : (
                        <Tag text="Not shared here" tone="warning" />
                      )
                    }
                  />
                </View>
              );
            })
          ) : (
            <Mono text={sharedWallet.descriptor} small />
          )}
          {unshared && (
            <Text style={{ color: colors.warning, fontSize: 13, lineHeight: 19, marginTop: 8 }}>
              This wallet contains a key that was never shared in this group. Ask the coordinator
              where it came from before adding the wallet.
            </Text>
          )}
          {error && <Text style={{ color: colors.danger, fontSize: 13, marginTop: 8 }}>{error}</Text>}
          <Button title="Agree and add this wallet" icon="checkmark-outline" onPress={acceptWallet} loading={busy} />
          <Button title="Decline" variant="ghost" onPress={declineWallet} disabled={busy} />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', flex: 1 }}>
            <Tag text={group.coordinator ? 'Coordinator' : 'Member'} />
            <Tag
              text={connected > 0 ? `${connected}/${relays} relays` : 'Connecting…'}
              tone={connected > 0 ? 'neutral' : 'warning'}
            />
            {rotates && <Tag text={secured ? 'Secured' : 'Not secured'} tone={secured ? 'accent' : 'warning'} />}
          </View>
          {group.coordinator && !wallet && (
            <TouchableOpacity
              onPress={() => setDraftPolicy((d) => (d ? null : { n: group.n, m: group.m }))}
              hitSlop={10}
              style={{ padding: 2 }}
            >
              <Ionicons name="ellipsis-horizontal" size={22} color={colors.ink} />
            </TouchableOpacity>
          )}
        </View>

        <View style={{ alignItems: 'center', marginTop: 14 }}>
          <Text
            style={{
              fontSize: 34,
              fontWeight: '700',
              color: colors.ink,
              fontVariant: ['tabular-nums'],
              letterSpacing: -0.5,
            }}
          >
            {group.m} of {group.n}
          </Text>
          <Text style={{ color: colors.inkSoft, fontSize: 13, marginTop: 2 }}>keys needed to sign</Text>
        </View>

        {group.coordinator && !wallet && draftPolicy && (
          <View style={{ marginTop: 10 }}>
            <View style={{ flexDirection: 'row' }}>
              <Stepper
                label="Keys in total"
                value={draftPolicy.n}
                min={2}
                max={9}
                onChange={(v) => setDraftPolicy((d) => (d ? { n: v, m: Math.min(d.m, v) } : d))}
              />
              <Stepper
                label="Needed to sign"
                value={draftPolicy.m}
                min={1}
                max={draftPolicy.n}
                onChange={(v) => setDraftPolicy((d) => (d ? { ...d, m: v } : d))}
              />
            </View>
            <Text
              style={{
                color: colors[policyTradeoffs(draftPolicy.m, draftPolicy.n).tone],
                textAlign: 'center',
                marginTop: 10,
                fontSize: 13,
                lineHeight: 19,
              }}
            >
              {policyTradeoffs(draftPolicy.m, draftPolicy.n).lines.join(' ')}
            </Text>
            <Text style={{ color: colors.inkSoft, textAlign: 'center', marginTop: 6, fontSize: 13, lineHeight: 19 }}>
              Re-share the invite if you change this after inviting anyone.
            </Text>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 6 }}>
              <View style={{ flex: 1 }}>
                <Button title="Cancel" variant="ghost" onPress={() => setDraftPolicy(null)} />
              </View>
              <View style={{ flex: 1 }}>
                <Button title="Save" icon="checkmark-outline" onPress={savePolicy} />
              </View>
            </View>
          </View>
        )}

        {error && <Text style={{ color: colors.danger, fontSize: 13, marginTop: 8 }}>{error}</Text>}
        {wallet && (
          <Row
            icon="wallet-outline"
            title={wallet.name}
            subtitle={`${wallet.m} of ${wallet.n} · wallet ready`}
            onPress={() => navigation.navigate('Wallet', { walletId: wallet.id })}
          />
        )}
      </Card>

      {/* Kept after the wallet is built: a member who lost their phone and has
          no backup carrying it can get the code from anyone still here. */}
      <SectionTitle>{wallet ? 'Group invite' : 'Invite members'}</SectionTitle>
      <Card>
        {invite ? (
          <>
            <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginBottom: 4 }}>
              {wallet
                ? 'For a member rejoining after losing their phone — with their recovery phrase they are recognised and let back in. Anyone else who uses it has to be let in by the coordinator.'
                : 'Share this code to invite group members.'}
            </Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Button
                  title="Share link"
                  icon="share-outline"
                  variant="secondary"
                  onPress={async () => {
                    if (await confirmOwner('Confirm it is you to share the invite')) Share.share({ message: invite });
                  }}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  title="Show QR"
                  icon="qr-code-outline"
                  variant="secondary"
                  onPress={async () => {
                    if (await confirmOwner('Confirm it is you to show the invite')) setQrOpen(true);
                  }}
                />
              </View>
            </View>
            <QrModal
              visible={qrOpen}
              onClose={() => setQrOpen(false)}
              data={invite}
              sensitive
              title={group.name}
              caption={
                wallet
                  ? `${group.m} of ${group.n} — restore the wallet first, then scan this from its Manage → Join this wallet's group.`
                  : `${group.m} of ${group.n} — the other members scan this from Wallets → Join a group.`
              }
            />
          </>
        ) : (
          <Text style={{ color: colors.inkFaint, fontSize: 13, marginTop: 8 }}>
            Reading the invite from this phone's keystore…
          </Text>
        )}
      </Card>

      {!wallet && rotates && !secured && (
        <>
          <SectionTitle>Secure the group</SectionTitle>
          <Card>
            {group.coordinator ? (
              <>
                <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19 }}>
                  The invite link is the key to this channel, and whatever you sent it through keeps
                  a copy. Closing the roster moves everyone onto a fresh key the link cannot read, so
                  a leak later exposes nothing but this handshake. Keys and transactions wait for it.
                </Text>
                <View style={{ marginTop: 10 }}>
                  {others.length === 0 ? (
                    <Text style={{ color: colors.inkFaint, fontSize: 13, paddingVertical: 4 }}>
                      Waiting for the first member to appear…
                    </Text>
                  ) : (
                    joined.map((j, i) => (
                      <View key={j.author}>
                        {i > 0 && <Divider />}
                        <Row
                          icon="person-outline"
                          title={j.name}
                          subtitle={j.mine ? 'this phone' : shortNpub(j.author)}
                          trailing={j.rekey ? undefined : <Tag text="Old version" tone="warning" />}
                        />
                      </View>
                    ))
                  )}
                </View>
                {stragglers.length > 0 && (
                  <Text style={{ color: colors.danger, fontSize: 13, lineHeight: 19, marginTop: 8 }}>
                    {stragglers.length === 1
                      ? `${stragglers[0].name} is`
                      : `${stragglers.length} members are`}{' '}
                    on a build from before this step and will stop seeing the group until they
                    update. Their key is sealed and waits on the relays, so updating the app is
                    enough to catch up.
                  </Text>
                )}
                <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 8 }}>
                  Anyone who joins after this has to be let back in by you, so wait until everyone
                  has arrived.
                </Text>
                <Button
                  title={`Close the roster · ${joined.length} member${joined.length === 1 ? '' : 's'}`}
                  icon="lock-closed-outline"
                  onPress={secureGroup}
                  loading={busy}
                  disabled={others.length === 0}
                />
              </>
            ) : (
              <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19 }}>
                Waiting for the coordinator to close the roster. Until then this group is still using
                the key from the invite link, so keys and transactions are held back — anything sent
                now would be readable by whoever gets hold of that link later.
              </Text>
            )}
          </Card>
        </>
      )}

      {/* Rejoined from a backup (RECOVERY-DESIGN.md) and not holding the
          group's current key yet. */}
      {wallet && rotates && !secured && group.coordinator && (
        <>
          <SectionTitle>Re-secure the group</SectionTitle>
          <Card>
            <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19 }}>
              This phone doesn't hold the group's current key yet. If the relays still keep this
              phone's copy it arrives by itself in a few seconds, and this goes away. If not, the
              other members' apps answer as they come online — then re-secure the group to move
              everyone onto a new key.
            </Text>
            <View style={{ marginTop: 10 }}>
              {others.length === 0 ? (
                <Text style={{ color: colors.inkFaint, fontSize: 13, paddingVertical: 4 }}>
                  Waiting for members to answer…
                </Text>
              ) : (
                joined.map((j, i) => (
                  <View key={j.author}>
                    {i > 0 && <Divider />}
                    <Row
                      icon="person-outline"
                      title={j.name}
                      subtitle={j.mine ? 'this phone' : shortNpub(j.author)}
                      trailing={
                        j.answered ? (
                          <Tag text="Answered" tone="success" />
                        ) : j.rekey ? undefined : (
                          <Tag text="Old version" tone="warning" />
                        )
                      }
                    />
                  </View>
                ))
              )}
            </View>
            <Text style={{ color: colors.warning, fontSize: 13, lineHeight: 19, marginTop: 8 }}>
              This phone lost the list of who was in the group, and anyone holding the invite or a
              backup can appear here. Check with each person before re-securing — everyone listed
              will be able to read the group.
            </Text>
            <Button
              title={`Re-secure · ${joined.length} member${joined.length === 1 ? '' : 's'}`}
              icon="lock-closed-outline"
              onPress={secureGroup}
              loading={busy}
              // Until a member has said which epoch they hold, a new one might
              // not be above it — and they would ignore it. Only the people
              // about to be sealed in count: anyone with the invite can answer.
              disabled={!heardFromMembers(messages, others.map((j) => j.author))}
            />
          </Card>
        </>
      )}

      {wallet && rotates && !secured && !group.coordinator && (
        <>
          <SectionTitle>Rejoining the group</SectionTitle>
          <Card>
            <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19 }}>
              Waiting for this phone's copy of the group key. It comes back from the relays by
              itself, or when the coordinator next opens the app — nothing needs doing here. The
              wallet works in the meantime; only the group chat and sharing transactions wait.
            </Text>
          </Card>
        </>
      )}

      {!wallet && secured && (
        <>
          <SectionTitle>
            Chosen keys · {chosenXpubs.length} of {group.n}
          </SectionTitle>
          <Card>
            {chosenKeys.length === 0 && (
              <Text style={{ color: colors.inkSoft, fontSize: 14, paddingVertical: 4 }}>
                {group.coordinator
                  ? 'No keys chosen yet. Open Configure keys to add your own and accept the keys members share.'
                  : "The coordinator hasn't chosen the keys yet. The keys you picked when joining are shared with them automatically."}
              </Text>
            )}
            {chosenKeys.map((c, i) => (
              <View key={c.xpub}>
                {i > 0 && <Divider />}
                <Row
                  icon="key-outline"
                  title={c.memberName}
                  subtitle={`check ${keyCheckCode(c.xpub)} · ${c.mine ? 'from this phone' : shortNpub(c.author)}`}
                  trailing={c.mine ? <Tag text="Mine" tone="accent" /> : undefined}
                />
              </View>
            ))}
            {Array.from({ length: Math.max(0, slotsLeft) }).map((_, i) => (
              <View key={`empty-${i}`}>
                {(chosenKeys.length > 0 || i > 0) && <Divider />}
                <Row icon="ellipse-outline" title="Empty place" subtitle="Not chosen yet" />
              </View>
            ))}
            {awaiting.length > 0 && (
              <Text style={{ color: colors.accent, fontSize: 13, lineHeight: 19, marginTop: 8 }}>
                {awaiting.length === 1 ? '1 shared key is' : `${awaiting.length} shared keys are`} waiting
                for you — open Configure keys, check {awaiting.length === 1 ? 'it' : 'each one'} with
                its owner, and tick it in.
              </Text>
            )}
            {!group.coordinator && contributedIds.length === 0 && (
              <Text style={{ color: colors.warning, fontSize: 13, lineHeight: 19, marginTop: 8 }}>
                You joined without any of your own keys, so this phone won't be able to sign for
                the wallet.
              </Text>
            )}
            {group.coordinator && (
              <Button
                title="Configure keys"
                icon="options-outline"
                variant="secondary"
                onPress={() => setConfigureOpen(true)}
              />
            )}
          </Card>
        </>
      )}

      {!wallet && group.coordinator && secured && (
        <>
          <SectionTitle>Build the wallet</SectionTitle>
          <Card>
            <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19 }}>
              {full
                ? `All ${group.n} keys are chosen. Read the "check" code on each key aloud to its owner and confirm it matches on their phone before you build — anyone holding the invite could have published a key, and only this code proves the key is really theirs.`
                : `Choose ${slotsLeft} more key${slotsLeft === 1 ? '' : 's'} before the ${group.m}-of-${group.n} wallet can be built. Open Configure keys to accept the keys members have shared.`}
            </Text>
            <Button title="Build and share wallet" onPress={buildWallet} loading={busy} disabled={!full} />
          </Card>
        </>
      )}

      {!wallet && !group.coordinator && sharedWallet && declined && (
        <>
          <SectionTitle>Wallet declined</SectionTitle>
          <Card>
            <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19 }}>
              You declined “{sharedWallet.name}” and the coordinator has been told. If they build a
              different wallet it shows up here. Talk it over in the chat.
            </Text>
            <Row
              icon="refresh-outline"
              title="Look at it again"
              subtitle="Go back to adding or declining the wallet"
              onPress={() => updateGroup(group.id, { declinedDescriptor: undefined })}
            />
          </Card>
        </>
      )}

      {wallet && group.coordinator && answers && group.answersDismissedFor !== (sharedWallet?.descriptor ?? '') && (
        <WalletAnswersCard
          walletName={wallet.name}
          answers={answers}
          onDismiss={() => {
            updateGroup(group.id, { answersDismissedFor: sharedWallet?.descriptor ?? '' }).catch(() => {});
          }}
        />
      )}

      {latecomers.length > 0 && (
        <>
          <SectionTitle>Waiting to be let in</SectionTitle>
          <Card>
            <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19 }}>
              {latecomers.length === 1 ? 'Someone has' : `${latecomers.length} people have`} turned
              up since the roster closed, so they cannot read the group yet. Anyone holding the
              invite link can ask — check with them before letting them in.
            </Text>
            {latecomers.map((j, i) => (
              <View key={j.author}>
                {i > 0 && <Divider />}
                <Row
                  icon="person-add-outline"
                  title={j.name}
                  subtitle={shortNpub(j.author)}
                  onPress={() => admit(j.author, j.name)}
                />
              </View>
            ))}
          </Card>
        </>
      )}

      <SectionTitle>Group</SectionTitle>
      <Card>
        <Row
          icon="chatbubbles-outline"
          title="Open chat"
          subtitle="Message the other members"
          onPress={() => navigation.navigate('GroupChat', { groupId: group.id })}
          trailing={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <UnreadDot count={unreadChat(group, chats)} showCount />
              <Ionicons name="chevron-forward" size={18} color={colors.inkFaint} />
            </View>
          }
        />
        <Divider />
        <Row icon="exit-outline" title="Leave group" onPress={leave} destructive />
      </Card>

      {group.coordinator && (
        <ConfigureKeysModal
          visible={configureOpen}
          onClose={() => setConfigureOpen(false)}
          group={group}
          candidates={keyCandidates}
          chosenCount={chosenXpubs.length}
          onToggle={toggleKeyInWallet}
        />
      )}
    </Screen>
  );
}
