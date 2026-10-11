import React from 'react';
import { Alert, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { Card, Button, SectionTitle, Tag, EmptyState, Row, Divider, UnreadDot, Input, Label } from '../components/ui';
import { unreadChat } from '../lib/nostr/unread';
import { colors } from '../theme';
import { showError } from '../lib/errors';
import { useStore } from '../lib/store';
import { exportBackup, exportWalletToCard } from '../lib/exportActions';
import { backupMissesGroup } from '../lib/groupBackup';
import { nfcAvailable } from '../lib/nfc';
import { describeBackupState, describeSetupRow, recordExport, startSetup } from '../lib/tutorial';
import { formatSats } from '../lib/bitcoin';
import { loadCached } from '../lib/walletCache';
import { WalletSnapshot } from '../lib/types';
import { NAME_INPUT_CHARS } from '../lib/naming';
import { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'WalletMenu'>;

/**
 * Everything about a wallet that is not the day-to-day balance / send /
 * receive / history: backups, the group chat, receiving a transaction to
 * sign, the signer list, coins, and the technical/destructive actions. Kept
 * off the main screen and reached through its top-right menu.
 */
export default function WalletMenuScreen({ navigation, route }: Props) {
  const { wallets, keys, groups, chats, pendingTxs, updateWallet, removeWallet } = useStore();
  const wallet = wallets.find((w) => w.id === route.params.walletId);
  const [snapshot, setSnapshot] = React.useState<WalletSnapshot | null>(null);
  const [showCoins, setShowCoins] = React.useState(false);
  const [exporting, setExporting] = React.useState<'file' | 'pdf' | 'nfc' | null>(null);
  const [hasNfc, setHasNfc] = React.useState(false);
  const [nameDraft, setNameDraft] = React.useState(wallet?.name ?? '');
  const [renaming, setRenaming] = React.useState(false);

  React.useEffect(() => {
    nfcAvailable().then(setHasNfc);
  }, []);

  const group = groups.find((g) => g.walletId === wallet?.id);

  React.useEffect(() => {
    navigation.setOptions({ title: wallet?.name ? `${wallet.name} · manage` : 'Manage' });
  }, [wallet?.name]);

  React.useEffect(() => {
    // Coins come from the cache the main screen keeps fresh — no rescan here.
    if (wallet) loadCached(wallet.id).then((cached) => cached && setSnapshot(cached.snapshot));
  }, [wallet?.id]);

  if (!wallet) return null;

  const newName = nameDraft.trim();
  const rename = async () => {
    setRenaming(true);
    try {
      await updateWallet(wallet.id, { name: newName });
      setNameDraft(newName);
    } catch (e: any) {
      showError('wallet:rename', e);
    } finally {
      setRenaming(false);
    }
  };

  const missesGroup = backupMissesGroup(wallet, group);

  const runExport = async (which: 'file' | 'pdf' | 'nfc') => {
    setExporting(which);
    try {
      // Only count it once the share sheet has been through successfully. A
      // file or PDF is a backup; an NFC send only loads the wallet onto the
      // signer, so it ticks the checklist's hardware step and nothing else.
      if (which === 'nfc') {
        await exportWalletToCard(wallet);
        await updateWallet(wallet.id, (w) => recordExport(w, 'nfc', Date.now()));
      } else {
        const withGroup = await exportBackup(which, wallet, groups, keys);
        await updateWallet(wallet.id, recordExport(wallet, which, Date.now(), withGroup));
      }
    } catch (e: any) {
      showError(`wallet:export-${which}`, e);
    } finally {
      setExporting(null);
    }
  };

  const confirmDelete = () =>
    Alert.alert(
      'Remove this wallet?',
      group
        ? 'This removes the wallet, its group chat and the group invite from this phone. The coins stay on the network, but you would need the invite again to rejoin. Your keys are kept.'
        : 'This only removes it from this phone — the coins stay on the network. You can re-create the wallet from the same keys any time.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            await removeWallet(wallet.id);
            navigation.popToTop();
          },
        },
      ]
    );

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: 20, paddingBottom: 56 }}
    >
      {(missesGroup || (!wallet.exportedAt && !(wallet.setup && !wallet.setup.completedAt))) && (
        <Card style={{ borderColor: colors.warning, borderWidth: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Ionicons name="alert-circle-outline" size={20} color={colors.warning} />
            <Text style={{ fontSize: 15, fontWeight: '600', color: colors.ink, flex: 1 }}>
              {missesGroup ? 'Save a new backup' : 'Back up this wallet'}
            </Text>
          </View>
          <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 8 }}>
            {missesGroup
              ? "Your backup doesn't include the group, so after losing this phone you couldn't rejoin it from the backup. A new one carries the group's invite as well — it still cannot spend your funds."
              : "Your keys alone cannot rebuild a multisig wallet — you also need every cosigner's public key. Save a backup now and keep it with your recovery phrase. It holds no private keys and cannot spend your funds."}
          </Text>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
            <View style={{ flex: 1 }}>
              <Button
                title="Save file"
                icon="document-text-outline"
                onPress={() => runExport('file')}
                loading={exporting === 'file'}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                title="Print PDF"
                icon="print-outline"
                variant="secondary"
                onPress={() => runExport('pdf')}
                loading={exporting === 'pdf'}
              />
            </View>
          </View>
        </Card>
      )}

      <SectionTitle>Name</SectionTitle>
      <Card>
        <Label>Wallet name</Label>
        <Input
          placeholder="e.g. Family savings"
          value={nameDraft}
          onChangeText={setNameDraft}
          maxLength={NAME_INPUT_CHARS}
          returnKeyType="done"
          onSubmitEditing={() => {
            if (newName && newName !== wallet.name) rename();
          }}
        />
        <Text style={{ color: colors.inkSoft, fontSize: 12, marginTop: 6, lineHeight: 17 }}>
          {group
            ? 'What this phone calls the wallet. Other members keep their own name for it.'
            : 'What this phone calls the wallet. Backups you save from now on carry the new name.'}
        </Text>
        <Button
          title="Save name"
          icon="checkmark-outline"
          variant="secondary"
          onPress={rename}
          loading={renaming}
          disabled={!newName || newName === wallet.name}
        />
      </Card>

      <SectionTitle>Group</SectionTitle>
      <Card>
        {group ? (
          <Row
            icon="chatbubbles-outline"
            title="Group chat"
            subtitle="Chat and coordinate with the other members"
            onPress={() => navigation.navigate('GroupChat', { groupId: group.id })}
            trailing={
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <UnreadDot count={unreadChat(group, chats)} showCount />
                <Ionicons name="chevron-forward" size={18} color={colors.inkFaint} />
              </View>
            }
          />
        ) : (
          // After restoring a group wallet from its backup (RECOVERY-DESIGN.md).
          <Row
            icon="people-outline"
            title="Join this wallet's group"
            subtitle="Restoring? Scan the group code from your backup"
            onPress={() => navigation.navigate('JoinGroup', { mode: 'restore', walletId: wallet.id })}
          />
        )}
      </Card>

      <SectionTitle>Setup</SectionTitle>
      <Card>
        <Row
          icon="list-outline"
          title="Setup checklist"
          subtitle={describeSetupRow(wallet, keys)}
          onPress={async () => {
            // A wallet made outside the guide adopts the checklist here; its
            // backup state is read from exportedAt, so nothing else is seeded.
            if (!wallet.setup) await updateWallet(wallet.id, { setup: startSetup(undefined, Date.now()) });
            navigation.navigate('Tutorial', { walletId: wallet.id });
          }}
        />
      </Card>

      <SectionTitle>
        Signers · {wallet.m} of {wallet.n} required
      </SectionTitle>
      <Card>
        {wallet.cosigners.map((c, i) => {
          // Prefer the live key record: names can change after the wallet was
          // built. Only proof earns "Yours" — the link made when the wallet
          // was built, or the exact xpub. A fingerprint alone is text anyone
          // can write into a wallet, and this screen exists to answer "is my
          // key really in it?".
          const held = keys.find((k) => k.id === c.keyId) ?? keys.find((k) => k.xpub === c.xpub);
          const onThisPhone = held?.type === 'local';
          // Where the key lives, in plain words. The fingerprint stays on the
          // Details screen for anyone matching it against a device.
          const where = held ? (onThisPhone ? 'On this phone' : 'Hardware wallet') : 'Held by someone else';
          return (
            <View key={c.xpub}>
              {i > 0 && <Divider />}
              <Row
                icon={
                  held
                    ? onThisPhone
                      ? 'phone-portrait-outline'
                      : 'hardware-chip-outline'
                    : 'person-outline'
                }
                title={held?.name ?? c.name}
                subtitle={where}
                trailing={held ? <Tag text="Yours" tone="success" /> : undefined}
              />
            </View>
          );
        })}
      </Card>

      <SectionTitle>Coins</SectionTitle>
      <Card>
        {snapshot?.utxos.length === 0 && (
          <EmptyState icon="server-outline" text="No coins yet. Use Receive to get an address." />
        )}
        {snapshot && snapshot.utxos.length > 0 && (
          <>
            <TouchableOpacity
              onPress={() => setShowCoins(!showCoins)}
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
            >
              <Text style={{ fontWeight: '600', color: colors.ink, fontSize: 15 }}>
                {snapshot.utxos.length} unspent output{snapshot.utxos.length === 1 ? '' : 's'}
              </Text>
              <Ionicons name={showCoins ? 'chevron-up' : 'chevron-down'} size={18} color={colors.inkFaint} />
            </TouchableOpacity>
            {showCoins &&
              snapshot.utxos.map((u) => (
                <View
                  key={`${u.txid}:${u.vout}`}
                  style={{ borderTopWidth: 1, borderTopColor: colors.line, paddingVertical: 10, marginTop: 10 }}
                >
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text style={{ fontWeight: '600', color: colors.ink, fontVariant: ['tabular-nums'] }}>
                      {formatSats(u.value)}
                    </Text>
                    <Tag text={u.confirmed ? 'Confirmed' : 'Pending'} tone={u.confirmed ? 'success' : 'warning'} />
                  </View>
                  <Text style={{ color: colors.inkFaint, fontSize: 12, marginTop: 4 }} numberOfLines={1}>
                    {u.txid}:{u.vout}
                  </Text>
                </View>
              ))}
          </>
        )}
      </Card>

      <SectionTitle>Advanced</SectionTitle>
      <Card>
        <Row
          icon="document-text-outline"
          title="Save backup file"
          subtitle={describeBackupState(wallet, missesGroup)}
          onPress={() => runExport('file')}
        />
        <Divider />
        <Row
          icon="print-outline"
          title="Print QR backup"
          subtitle="A PDF of QR codes this app can scan back in"
          onPress={() => runExport('pdf')}
        />
        <Divider />
        <Row
          icon="shield-checkmark-outline"
          title="Check a backup"
          subtitle="Scan or open a backup and check it matches this wallet"
          onPress={() => navigation.navigate('VerifyBackup', { walletId: wallet.id })}
        />
        {hasNfc && (
          <>
            <Divider />
            <Row
              icon="radio-outline"
              title={exporting === 'nfc' ? 'Hold against the Coldcard…' : 'Send wallet to Coldcard (NFC)'}
              subtitle="The card needs this before it can sign for the wallet"
              onPress={() => runExport('nfc')}
            />
          </>
        )}
        <Divider />
        <Row
          icon="code-slash-outline"
          title="Details & descriptors"
          subtitle="Derivation paths, cosigner xpubs, exports"
          onPress={() => navigation.navigate('Advanced', { walletId: wallet.id })}
        />
        <Divider />
        <Row icon="trash-outline" title="Remove wallet from this phone" onPress={confirmDelete} destructive />
      </Card>
    </ScrollView>
  );
}
