import React from 'react';
import { Alert, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Screen, Card, Button, Input, Label, SectionTitle, Tag, Row, Divider, Stepper } from '../components/ui';
import { colors } from '../theme';
import { showError } from '../lib/errors';
import { useStore, newId, effectiveRelays, loadMnemonic, loadGroupSecret } from '../lib/store';
import { parseInvite } from '../lib/nostr/protocol';
import { probeRelays } from '../lib/nostr/probe';
import { generateSecretKey, getPublicKey } from '../lib/nostr/crypto';
import { isCoordinatorSeed, nostrSecretForGroup } from '../lib/nostr/identity';
import { restoreMismatch } from '../lib/groupBackup';
import { memberName } from '../lib/naming';
import { policyTradeoffs } from '../lib/tutorialPolicy';
import { keySelectionWarnings } from '../lib/tutorial';
import { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'JoinGroup'>;

/**
 * Creates a new group (coordinator), joins one from an invite, or — restore —
 * rejoins the group of a wallet brought back from its backup after a lost
 * phone (RECOVERY-DESIGN.md).
 */
export default function JoinGroupScreen({ navigation, route }: Props) {
  const { keys, wallets, groups, settings, saveGroup, updateSettings, updateWallet } = useStore();
  const mode = route.params?.mode ?? 'join';
  const restoreWallet = mode === 'restore' ? wallets.find((w) => w.id === route.params?.walletId) : undefined;
  /** The identity key the wallet's backup names, when it came from one. */
  const backupIdentity = route.params?.identityFingerprint;
  const [inviteText, setInviteText] = React.useState('');
  const [groupName, setGroupName] = React.useState('');
  const [total, setTotal] = React.useState(3);
  const [quorum, setQuorum] = React.useState(2);
  const [selectedKeys, setSelectedKeys] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    navigation.setOptions({
      title: mode === 'create' ? 'New group wallet' : mode === 'restore' ? 'Rejoin the group' : 'Join a group',
    });
  }, [mode]);

  React.useEffect(() => {
    if (route.params?.scanned) setInviteText(route.params.scanned);
  }, [route.params?.scanned]);

  const localKeys = keys.filter((k) => k.type === 'local');
  const usableKeys = keys.filter((k) => k.type === 'local' || !!k.xpub);

  // Which phone key acts as this device's Nostr identity for this group. Chosen
  // here, per group; defaults to the last-used identity, else the first key.
  const [identityKeyId, setIdentityKeyId] = React.useState<string | null>(settings.identityKeyId ?? null);
  React.useEffect(() => {
    setIdentityKeyId((cur) =>
      cur && localKeys.some((k) => k.id === cur) ? cur : (localKeys[0]?.id ?? null)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys.length]);
  // A restore starts on the key the backup names: the group knows this
  // device by the identity derived from it, and any other key is a stranger.
  React.useEffect(() => {
    const named = backupIdentity && localKeys.find((k) => k.fingerprint === backupIdentity);
    if (named) setIdentityKeyId(named.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backupIdentity, keys.length]);
  const identity = keys.find((k) => k.id === identityKeyId);
  const backupIdentityMissing = !!backupIdentity && !localKeys.some((k) => k.fingerprint === backupIdentity);

  // Remember the pick as the default for next time.
  const pickIdentity = (id: string) => {
    setIdentityKeyId(id);
    updateSettings({ identityKeyId: id });
  };

  // Preview the policy carried in a pasted invite.
  const invitePreview = React.useMemo(() => {
    if (mode === 'create' || !inviteText.trim()) return null;
    try {
      return { invite: parseInvite(inviteText), error: null as string | null };
    } catch (e: any) {
      return { invite: null, error: e.message ?? String(e) };
    }
  }, [inviteText, mode]);

  const mismatch =
    restoreWallet && invitePreview?.invite ? restoreMismatch(invitePreview.invite, restoreWallet) : null;

  const effectiveQuorum = Math.min(quorum, total);
  const maxMine = mode === 'create' ? total : (invitePreview?.invite?.n ?? 1);
  const me = memberName(settings.userName, identity);
  const tradeoffs = policyTradeoffs(effectiveQuorum, total);
  // The same checks the guided setup makes on the keys this phone puts in:
  // the network they must be on, and whether this one phone could spend alone.
  const chosenKeys = selectedKeys.flatMap((id) => {
    const k = usableKeys.find((key) => key.id === id);
    return k ? [k] : [];
  });
  const policyM = mode === 'create' ? effectiveQuorum : (invitePreview?.invite?.m ?? 1);
  const policyN = mode === 'create' ? total : (invitePreview?.invite?.n ?? 1);
  const expectTestnet = mode === 'create' ? settings.testnet : invitePreview?.invite?.network === 'testnet';
  const keyIssues = keySelectionWarnings(chosenKeys, policyM, policyN, expectTestnet);

  const toggleKey = (id: string) => {
    if (selectedKeys.includes(id)) {
      setSelectedKeys((cur) => cur.filter((x) => x !== id));
      return;
    }
    if (selectedKeys.length >= maxMine) return; // never contribute more than the wallet holds
    // Two records of the same underlying key (same master fingerprint) would
    // put a duplicate cosigner in the wallet — reject it with a message.
    const key = usableKeys.find((k) => k.id === id);
    const dup = key && usableKeys.find((k) => selectedKeys.includes(k.id) && k.fingerprint === key.fingerprint);
    if (dup) {
      Alert.alert(
        'Key already added',
        `"${dup.name}" is the same key — each key can only go into the wallet once.`
      );
      return;
    }
    setSelectedKeys((cur) => [...cur, id]);
  };

  // Contributing none of your own keys is allowed (a pure coordinator), but
  // it means this phone can never sign for the wallet — make sure that is a
  // deliberate choice before building the group.
  const attemptStart = () => {
    if (mode === 'create' && selectedKeys.length === 0) {
      Alert.alert(
        'No keys of your own',
        "You have not added any of your own keys — this means you can't sign any group transactions.",
        [
          { text: 'Go back', style: 'cancel' },
          { text: 'Create anyway', style: 'destructive', onPress: start },
        ]
      );
      return;
    }
    start();
  };

  const start = async () => {
    setBusy(true);
    try {
      if (!identity) throw new Error('Choose which phone key to use as your group identity first.');
      const myRelays = effectiveRelays(settings);
      if (mode === 'create' && myRelays.length === 0) {
        throw new Error(
          'No relays to coordinate over. Add your own relay in Settings, or turn public relays back on.'
        );
      }
      // Try the relays before the group depends on them: one that refuses
      // this kind of event, or caps it below a transaction's size, would
      // silently lose the group's messages later.
      if (mode === 'create') {
        const results = await probeRelays(myRelays);
        const failed = results.filter((r) => !r.ok);
        if (failed.length > 0) {
          const allFailed = failed.length === results.length;
          const proceed = await new Promise<boolean>((resolve) =>
            Alert.alert(
              allFailed ? 'No relay passed the check' : `${failed.length} of ${results.length} relays failed the check`,
              `${failed.map((r) => `${r.url.replace(/^wss?:\/\//, '')} — ${r.reason}`).join('\n')}\n\nA relay that fails here can lose the group's messages. ${
                allFailed
                  ? 'Add a working relay in Settings before creating the group.'
                  : 'The others will carry the group, but every relay working is safer.'
              }`,
              allFailed
                ? [{ text: 'OK', onPress: () => resolve(false) }]
                : [
                    { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
                    { text: 'Create anyway', onPress: () => resolve(true) },
                  ]
            )
          );
          if (!proceed) return;
        }
      }
      const base = { id: newId(), identityKeyId: identity.id, contributedKeyIds: selectedKeys, createdAt: Date.now() };
      if (mode === 'restore') {
        if (!restoreWallet) throw new Error('That wallet is no longer on this phone.');
        if (groups.some((g) => g.walletId === restoreWallet.id)) {
          throw new Error('This wallet already has a group on this phone.');
        }
      }
      // The secret is kept out of the group record and stored in the keystore.
      let group;
      let secret: string;
      if (mode === 'create') {
        secret = generateSecretKey();
        // Pin our own coordinator identity into the group and the invite, so
        // members only ever trust wallets/selections that come from us.
        const mnemonic = await loadMnemonic(identity.id);
        if (!mnemonic) throw new Error('Could not load the identity key to coordinate this group.');
        const coordinatorPubkey = getPublicKey(nostrSecretForGroup(mnemonic, secret));
        group = {
          ...base,
          name: groupName.trim() || 'Shared wallet',
          relays: myRelays,
          coordinator: true,
          coordinatorPubkey,
          m: effectiveQuorum,
          n: total,
          network: settings.testnet ? ('testnet' as const) : ('mainnet' as const),
          // Groups we create always rotate off the invite key once the roster
          // closes — see REKEY-DESIGN.md.
          rekey: true,
          currentEpoch: 0,
        };
      } else {
        const invite = parseInvite(inviteText);
        secret = invite.secret;
        if (restoreWallet) {
          const problem = restoreMismatch(invite, restoreWallet);
          if (problem) throw new Error(problem);
        }
        // Joining twice would run two records of one group side by side.
        for (const g of groups) {
          if ((await loadGroupSecret(g.id)) === invite.secret) {
            throw new Error(`This phone is already in that group, as "${g.name}".`);
          }
        }
        const mnemonic = await loadMnemonic(identity.id);
        if (!mnemonic) throw new Error('Could not load the identity key for this group.');
        // A coordinator back from a lost phone: only its seed derives the
        // pubkey the invite pins, so recognising it makes no new trust decision.
        const coordinator = isCoordinatorSeed(mnemonic, invite.secret, invite.coordinatorPubkey);
        group = {
          ...base,
          name: groupName.trim() || invite.name,
          // Keep the invite's relays (the coordinator is there) and add
          // ours, so both sides have at least one in common.
          relays: [...new Set([...invite.relays, ...myRelays])],
          coordinator,
          coordinatorPubkey: invite.coordinatorPubkey,
          m: invite.m,
          n: invite.n,
          network: invite.network,
          // Only if the coordinator's build offered it; an older invite keeps
          // the old behaviour rather than waiting forever to be secured.
          rekey: invite.rekey === true,
          currentEpoch: 0,
          // Restoring: the wallet is already here, so nothing waits for the
          // group's `wallet` message — which the relays may since have
          // dropped. This phone contributes whichever of its keys are in it.
          ...(restoreWallet
            ? {
                walletId: restoreWallet.id,
                contributedKeyIds: restoreWallet.cosigners
                  .map((c) => c.keyId)
                  .filter((id): id is string => !!id && keys.some((k) => k.id === id)),
              }
            : {}),
        };
      }
      await saveGroup(group, secret);
      if (restoreWallet) await updateWallet(restoreWallet.id, { kind: 'group' });
      navigation.replace('Group', { groupId: group.id });
    } catch (e: any) {
      showError('nostr:join', e);
    } finally {
      setBusy(false);
    }
  };

  if (localKeys.length === 0) {
    return (
      <Screen>
        <Card>
          <Text style={{ fontSize: 16, fontWeight: '600', color: colors.ink }}>
            {mode === 'restore' ? 'Restore your phone key first' : 'Create a phone key first'}
          </Text>
          <Text style={{ color: colors.inkSoft, marginTop: 6, fontSize: 14, lineHeight: 20 }}>
            {mode === 'restore'
              ? "The group recognises you by an identity derived from the phone key you used in it. Restore that key from its recovery phrase (Create a key → Restore from a recovery phrase), then come back — a new key would make you a stranger to the group."
              : "Coordinating over Nostr needs an identity so the group can recognise you. It's derived from one of your phone keys — the seed never leaves this device. Create a phone key, then come back to set up the group."}
          </Text>
          <Button
            title={mode === 'restore' ? 'Restore a phone key' : 'Create a phone key'}
            onPress={() => navigation.navigate('CreateKey')}
          />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen>
      <Card>
        <Text style={{ color: colors.inkSoft, fontSize: 14, lineHeight: 20 }}>
          {mode === 'create'
            ? 'Set the wallet policy, choose which of your own keys go in, then invite the others to fill the remaining places.'
            : mode === 'restore'
              ? "Rejoin the group this wallet belongs to: scan the group code from the wallet's backup, and choose the phone key you used in the group."
              : 'Paste or scan the invite, then choose which of your keys to contribute.'}
        </Text>
      </Card>

      <SectionTitle>You</SectionTitle>
      <Card>
        <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19 }}>
          The other members will see you as <Text style={{ fontWeight: '600', color: colors.ink }}>{me}</Text>.
          {mode === 'restore' ? '' : ' You can change your name in Settings.'}
        </Text>
        <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 8 }}>
          {localKeys.length > 1 || mode === 'restore'
            ? 'The group tells this phone apart from the others by one of its keys. Pick which:'
            : 'The group tells this phone apart from the others by this key:'}
        </Text>
        {localKeys.map((k, i) => (
          <View key={k.id}>
            {i > 0 && <Divider />}
            <Row
              icon={identityKeyId === k.id ? 'checkmark-circle' : 'ellipse-outline'}
              title={k.name}
              subtitle={
                mode === 'restore'
                  ? `${k.fingerprint}${k.fingerprint === backupIdentity ? ' · named in your backup' : ''}`
                  : 'Key on this phone'
              }
              onPress={localKeys.length > 1 || mode === 'restore' ? () => pickIdentity(k.id) : undefined}
            />
          </View>
        ))}
      </Card>

      {mode === 'restore' && backupIdentityMissing && (
        <Card>
          <Text style={{ color: colors.warning, fontSize: 13, lineHeight: 19 }}>
            Your backup says your identity in this group is the phone key {backupIdentity}, which is
            not on this phone. Restore its recovery phrase first. With another key the group sees a
            stranger, and the coordinator has to let you in.
          </Text>
        </Card>
      )}

      {mode === 'restore' && restoreWallet && (
        <Card>
          <Row
            icon="wallet-outline"
            title={restoreWallet.name}
            subtitle={`${restoreWallet.m} of ${restoreWallet.n}${restoreWallet.network === 'testnet' ? ' · testnet' : ''} · the wallet this group is for`}
          />
        </Card>
      )}

      {mode !== 'create' && (
        <Card>
          <Label>{mode === 'restore' ? 'Group code' : 'Invite link'}</Label>
          <Input
            placeholder="multisig:join?…"
            value={inviteText}
            onChangeText={setInviteText}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            style={{ minHeight: 70 }}
          />
          <Button
            title="Scan invite QR"
            icon="qr-code-outline"
            variant="secondary"
            onPress={() =>
              navigation.navigate('ScanQR', { returnTo: 'JoinGroup', walletId: restoreWallet?.id })
            }
          />
          {invitePreview?.error && (
            <Text style={{ color: colors.danger, fontSize: 13, marginTop: 6 }}>{invitePreview.error}</Text>
          )}
          {mismatch && <Text style={{ color: colors.danger, fontSize: 13, marginTop: 6 }}>{mismatch}</Text>}
          {invitePreview?.invite && (
            <View style={{ flexDirection: 'row', marginTop: 10, flexWrap: 'wrap' }}>
              <Tag text={invitePreview.invite.name} />
              <Tag text={`${invitePreview.invite.m} of ${invitePreview.invite.n}`} tone="success" />
            </View>
          )}
          {invitePreview?.invite && invitePreview.invite.relays.some((r) => /^ws:\/\//i.test(r)) && (
            <Text style={{ color: colors.warning, fontSize: 13, lineHeight: 19, marginTop: 8 }}>
              This invite includes an unencrypted ws:// relay. Message contents stay end-to-end
              encrypted, but the network between you and the relay can see that you are talking to
              it — only join over a network you trust.
            </Text>
          )}
          {invitePreview?.invite && !invitePreview.invite.coordinatorPubkey && (
            <Text style={{ color: colors.warning, fontSize: 13, lineHeight: 19, marginTop: 8 }}>
              This invite is from an older version and does not pin the coordinator — anyone holding
              it could push a wallet or key selection. Prefer a fresh invite from the coordinator's
              current app.
            </Text>
          )}
        </Card>
      )}

      {mode === 'create' && (
        <>
          <SectionTitle>Policy</SectionTitle>
          <Card>
            <View style={{ flexDirection: 'row' }}>
              <Stepper
                label="Keys in total"
                value={total}
                min={2}
                max={9}
                onChange={(v) => {
                  setTotal(v);
                  if (quorum > v) setQuorum(v);
                  setSelectedKeys((cur) => cur.slice(0, v));
                }}
              />
              <Stepper
                label="Needed to sign"
                value={effectiveQuorum}
                min={1}
                max={total}
                onChange={setQuorum}
              />
            </View>
            <Text
              style={{ color: colors[tradeoffs.tone], textAlign: 'center', marginTop: 12, fontSize: 13, lineHeight: 19 }}
            >
              {tradeoffs.lines.join(' ')}
            </Text>
            <Text style={{ color: colors.inkFaint, textAlign: 'center', marginTop: 6, fontSize: 12, lineHeight: 17 }}>
              2 of 3 is the usual choice for a couple or a small household. 3 of 5 suits four or more
              people, or serious savings.
            </Text>
          </Card>
        </>
      )}

      {/* Restoring: the wallet already says which keys are in it, and the
          group's name comes from the code. */}
      {mode !== 'restore' && (
        <>
          <SectionTitle>
            My keys in this wallet · {selectedKeys.length}
            {mode === 'create' ? ` of ${total}` : ''}
          </SectionTitle>
          <Card>
            <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginBottom: 4 }}>
              Pick any of your keys to contribute — none, one, or several. The rest of the places are
              filled by the other members.
            </Text>
            {usableKeys.length === 0 && (
              <Text style={{ color: colors.warning, fontSize: 13, marginTop: 8 }}>
                No usable keys yet — add one in the Keys tab.
              </Text>
            )}
            {mode === 'create' && usableKeys.length > 0 && selectedKeys.length === 0 && (
              <Text style={{ color: colors.warning, fontSize: 13, lineHeight: 19, marginTop: 8 }}>
                You have not added any of your own keys — this means you can't sign any group
                transactions.
              </Text>
            )}
            {usableKeys.map((k, i) => {
              const on = selectedKeys.includes(k.id);
              const full = !on && selectedKeys.length >= maxMine;
              return (
                <View key={k.id}>
                  {i > 0 && <Divider />}
                  <Row
                    icon={on ? 'checkmark-circle' : 'ellipse-outline'}
                    title={k.name}
                    subtitle={`${k.type === 'local' ? 'On this phone' : 'Hardware wallet'}${full ? ' · no places left' : ''}`}
                    onPress={() => toggleKey(k.id)}
                  />
                </View>
              );
            })}
            {keyIssues.blocking.map((b, i) => (
              <Text key={`block-${i}`} style={{ color: colors.danger, fontSize: 13, lineHeight: 19, marginTop: 8 }}>
                {b}
              </Text>
            ))}
            {keyIssues.warnings.map((w, i) => (
              <Text key={`warn-${i}`} style={{ color: colors.warning, fontSize: 13, lineHeight: 19, marginTop: 8 }}>
                {w}
              </Text>
            ))}
          </Card>

          <Card>
            <Label>Group name</Label>
            <Input
              placeholder={mode === 'create' ? 'e.g. Family savings' : 'Optional — from the invite'}
              value={groupName}
              onChangeText={setGroupName}
            />
          </Card>
        </>
      )}

      <Button
        title={mode === 'create' ? 'Create group' : mode === 'restore' ? 'Rejoin group' : 'Join group'}
        onPress={attemptStart}
        loading={busy}
        disabled={
          keyIssues.blocking.length > 0 ||
          (mode === 'join' && !invitePreview?.invite) ||
          (mode === 'restore' && (!restoreWallet || !invitePreview?.invite || !!mismatch))
        }
      />
    </Screen>
  );
}
