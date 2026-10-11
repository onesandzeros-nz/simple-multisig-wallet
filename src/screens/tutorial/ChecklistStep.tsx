import React from 'react';
import { LayoutAnimation, Text, TextStyle, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Button, Card, Divider, IconName, Label, Mono, Row, SectionTitle } from '../../components/ui';
import { colors } from '../../theme';
import { showError } from '../../lib/errors';
import { useStore } from '../../lib/store';
import { exportWalletToCard } from '../../lib/exportActions';
import { nfcAvailable } from '../../lib/nfc';
import { deriveAddress } from '../../lib/bitcoin';
import { getCached, loadCached, refreshWallet } from '../../lib/walletCache';
import {
  applicableExtras,
  backupStatus,
  canFinish,
  completeSetup,
  describeBackupState,
  extraStatus,
  hasHardwareCosigner,
  ItemStatus,
  markDone,
  markSkipped,
  overrideNote,
  phraseChecklistItems,
  recordExport,
  setPhraseCheck,
  startSetup,
  testTxPlan,
  unmark,
} from '../../lib/tutorial';
import { SetupExtraId, WalletSetup } from '../../lib/types';
import { CheckRow, StepProps } from './common';
import { confirmSkipVerify, VerifyStatusNotice } from './VerifyStep';

const EXTRA_TITLES: Record<SetupExtraId, string> = {
  verify: 'Check the backup restores',
  phrases: 'Recovery phrases stored apart from the backup',
  address: 'Check a receive address on another device',
  hardware: 'Load the wallet onto your hardware signer',
  testtx: 'Send a small test transaction',
};

function statusIcon(status: ItemStatus): { name: IconName; color: string } {
  switch (status) {
    case 'done':
      return { name: 'checkmark-circle', color: colors.success };
    case 'skipped':
      return { name: 'remove-circle-outline', color: colors.inkFaint };
    case 'stale':
      return { name: 'alert-circle-outline', color: colors.warning };
    default:
      return { name: 'ellipse-outline', color: colors.inkFaint };
  }
}

/** "Alice", "Alice and Bob", "Alice, Bob and Carol". */
function listNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Step 6 · Checklist. The required rows are all ticked by the time the
 * guide gets here (bar a backup left for later); the recommended extras
 * each expand into an explanation and the actions that complete them.
 * Stays reachable from Manage → "Setup checklist" after Finish.
 */
export default function ChecklistStep({ wallet, go, navigation }: StepProps) {
  const { keys, updateWallet } = useStore();
  const [open, setOpen] = React.useState<SetupExtraId | null>(null);
  const [hasNfc, setHasNfc] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [finishing, setFinishing] = React.useState(false);
  const [hasCoins, setHasCoins] = React.useState(false);
  const walletId = wallet?.id;

  React.useEffect(() => {
    nfcAvailable().then(setHasNfc);
  }, []);

  // Show what the cache knows at once, then bring it up to date: the guide's
  // own path reaches this step without ever opening the wallet screen, so
  // nothing else would notice coins that arrived meanwhile.
  React.useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    setHasCoins(!!getCached(wallet.id)?.snapshot.utxos.length);
    loadCached(wallet.id).then((cached) => {
      if (!cancelled && cached) setHasCoins(cached.snapshot.utxos.length > 0);
    });
    refreshWallet(wallet)
      .then((fresh) => {
        if (!cancelled) setHasCoins(fresh.snapshot.utxos.length > 0);
      })
      .catch(() => {
        // Offline: the cached answer stands.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletId]);

  if (!wallet) return null;
  // The guide attaches a checklist before this step is reachable; a wallet
  // that somehow has none adopts one on its first write here.
  const setup: WalletSetup = wallet.setup ?? startSetup(undefined, wallet.createdAt);
  const { m, n } = wallet;
  const phraseItems = phraseChecklistItems(wallet, keys);
  const extras = applicableExtras({
    hasHardwareKeys: hasHardwareCosigner(wallet, keys),
    hasLinkedKeys: phraseItems.length > 0,
  });
  const backupDone = backupStatus(wallet) === 'done';
  const note = overrideNote(setup);
  const body: TextStyle = { color: colors.inkSoft, fontSize: 13, lineHeight: 19 };

  // Exactly one wallet write per tap; a transition that changed nothing
  // (same reference) writes nothing.
  const save = (next: WalletSetup, context: string) => {
    if (next === setup && wallet.setup) return;
    updateWallet(wallet.id, { setup: next }).catch((e) => showError(context, e));
  };
  const done = (id: SetupExtraId) => save(markDone(setup, id, Date.now()), 'tutorial:checklist');
  // A verify skip is dated: one made against an older backup is cleared first
  // so the new skip counts for the current backup.
  const skip = (id: SetupExtraId) =>
    save(markSkipped(id === 'verify' ? unmark(setup, id) : setup, id, Date.now()), 'tutorial:checklist');
  const undoSkip = (id: SetupExtraId) => save(unmark(setup, id), 'tutorial:checklist');

  const toggle = (id: SetupExtraId) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setOpen(open === id ? null : id);
  };

  const sendToCard = async () => {
    setSending(true);
    try {
      await exportWalletToCard(wallet);
      await updateWallet(wallet.id, (w) => recordExport(w.setup ? w : { ...w, setup }, 'nfc', Date.now()));
    } catch (e: any) {
      showError('wallet:export-nfc', e);
    } finally {
      setSending(false);
    }
  };

  const finish = async () => {
    setFinishing(true);
    try {
      await updateWallet(wallet.id, { setup: completeSetup({ ...wallet, setup }, Date.now()) });
      navigation.popToTop();
      navigation.navigate('Wallet', { walletId: wallet.id });
    } catch (e: any) {
      showError('tutorial:finish', e);
    } finally {
      setFinishing(false);
    }
  };

  const tick = (on: boolean) =>
    on ? (
      <Ionicons name="checkmark-circle" color={colors.success} size={20} />
    ) : (
      <Ionicons name="ellipse-outline" color={colors.inkFaint} size={20} />
    );

  /** "Skip" while still to do; "Undo skip" once skipped; nothing when done or stale. */
  const skipButton = (id: SetupExtraId, status: ItemStatus, onSkip: () => void = () => skip(id)) => {
    if (status === 'todo' || status === 'stale') return <Button title="Skip" variant="ghost" compact onPress={onSkip} />;
    if (status === 'skipped') return <Button title="Undo skip" variant="ghost" compact onPress={() => undoSkip(id)} />;
    return null;
  };

  const renderBody = (id: SetupExtraId, status: ItemStatus) => {
    switch (id) {
      case 'verify':
        return (
          <View style={{ paddingBottom: 10 }}>
            <VerifyStatusNotice status={status} wallet={wallet} />
            <Button
              title="Check my backup"
              icon="shield-checkmark-outline"
              compact
              onPress={() => navigation.navigate('VerifyBackup', { walletId: wallet.id })}
            />
            {skipButton('verify', status, () => confirmSkipVerify(() => skip('verify')))}
          </View>
        );

      case 'phrases':
        return (
          <View style={{ paddingBottom: 10 }}>
            <Text style={body}>
              {`Keep the wallet backup and every recovery phrase in different places — a fire or a burglary should never take two of them at once. Anyone who gathers ${m} of the phrases can spend, and the backup tells them exactly which keys to look for; never photograph the words. A common split: one phrase at home, one with a relative or in a bank box, and the wallet backup with each of them. Losing any ${n - m + 1} keys loses the money for good.`}
            </Text>
            {phraseItems.map((item) => {
              const checked = !!setup.phraseChecks[item.keyId];
              return (
                <View key={item.keyId}>
                  <CheckRow
                    checked={checked}
                    label={item.label}
                    onPress={() => save(setPhraseCheck(setup, item.keyId, !checked, Date.now()), 'tutorial:phrases')}
                  />
                  {item.kind === 'local' && (
                    <Button
                      title="Show recovery phrase"
                      variant="ghost"
                      compact
                      onPress={() => navigation.navigate('KeyDetail', { keyId: item.keyId })}
                    />
                  )}
                </View>
              );
            })}
            {skipButton('phrases', status)}
          </View>
        );

      case 'address':
        return (
          <View style={{ paddingBottom: 10 }}>
            <Label>Receive #0</Label>
            <Mono text={deriveAddress(wallet, 0, 0).address} small />
            <Text style={[body, { marginTop: 6 }]}>
              Compare this with the first address printed on the PDF backup and with what your hardware
              wallet or Sparrow shows for the same wallet. Manage → Details lists the first three.
            </Text>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
              <View style={{ flex: 1 }}>
                <Button
                  title="Open Receive"
                  variant="secondary"
                  compact
                  onPress={() => navigation.navigate('Receive', { walletId: wallet.id })}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  title="Open Details"
                  variant="ghost"
                  compact
                  onPress={() => navigation.navigate('Advanced', { walletId: wallet.id })}
                />
              </View>
            </View>
            {status !== 'done' && <Button title="It matched" compact onPress={() => done('address')} />}
            {skipButton('address', status)}
          </View>
        );

      case 'hardware':
        return (
          <View style={{ paddingBottom: 10 }}>
            <Text style={body}>
              The device needs the wallet configuration before it will recognise addresses or sign for
              the wallet.
              {hasNfc
                ? ''
                : ' Copy the backup .txt to the device by SD card (Coldcard: Settings → Multisig Wallets → Import from SD).'}
            </Text>
            {hasNfc && (
              <Button
                title={sending ? 'Hold against the Coldcard…' : 'Send to Coldcard (NFC)'}
                icon="radio-outline"
                compact
                loading={sending}
                onPress={sendToCard}
              />
            )}
            {status !== 'done' && (
              <Button
                title="Mark as done"
                variant={hasNfc ? 'secondary' : 'primary'}
                compact
                onPress={() => done('hardware')}
              />
            )}
            {skipButton('hardware', status)}
          </View>
        );

      case 'testtx': {
        const plan = testTxPlan(m, n);
        return (
          <View style={{ paddingBottom: 10 }}>
            <Text style={body}>
              {`Receive a small amount, then send some of it back to this wallet's own address. Every key should sign a real transaction once — a device set up wrong, or a phrase written down wrong, shows up here instead of in an emergency. P2WSH takes exactly ${m} signatures per transaction, so proving every key takes ${plan.length} send${plan.length === 1 ? '' : 's'}:`}
            </Text>
            {plan.map((round, r) => (
              <Text key={r} style={[body, { marginTop: 4, marginLeft: 8 }]}>
                {`Send ${r + 1}: sign with ${listNames(round.map((i) => wallet.cosigners[i]?.name ?? `key ${i + 1}`))}`}
              </Text>
            ))}
            <View style={{ marginTop: 6 }}>
              <Button
                title="Start a test send"
                icon="arrow-up-outline"
                compact
                disabled={!hasCoins}
                onPress={() => navigation.navigate('Send', { walletId: wallet.id })}
              />
              {!hasCoins && (
                <Text style={{ color: colors.inkFaint, fontSize: 12, textAlign: 'center', marginBottom: 4 }}>
                  Receive some coins first
                </Text>
              )}
            </View>
            <Button
              title="Open Receive"
              icon="arrow-down-outline"
              variant="ghost"
              compact
              onPress={() => navigation.navigate('Receive', { walletId: wallet.id })}
            />
            {status !== 'done' && (
              <Button title="Mark as done" variant="secondary" compact onPress={() => done('testtx')} />
            )}
            {skipButton('testtx', status)}
          </View>
        );
      }
    }
  };

  return (
    <>
      <SectionTitle>Required</SectionTitle>
      <Card>
        <Row icon="shield-outline" title="Policy chosen" subtitle={`${m} of ${n}`} trailing={tick(true)} />
        {note && (
          <Text style={{ color: colors.warning, fontSize: 13, lineHeight: 19, marginLeft: 48, marginBottom: 8 }}>
            {note}
          </Text>
        )}
        <Divider />
        <Row icon="key-outline" title="Keys gathered" subtitle={`${n} keys`} trailing={tick(true)} />
        <Divider />
        <Row icon="wallet-outline" title="Wallet created" subtitle={wallet.name} trailing={tick(true)} />
        <Divider />
        <Row
          icon="document-text-outline"
          title="Backed up"
          subtitle={wallet.exportedAt ? describeBackupState(wallet) : 'Not backed up yet'}
          trailing={tick(backupDone)}
          onPress={backupDone ? undefined : () => go('backup')}
        />
      </Card>

      <SectionTitle>Recommended</SectionTitle>
      <Card>
        {extras.map((id, i) => {
          const status = extraStatus(wallet, id, keys);
          const expanded = open === id;
          const icon = statusIcon(status);
          return (
            <View key={id} style={{ borderTopWidth: i > 0 ? 1 : 0, borderTopColor: colors.line }}>
              <TouchableOpacity
                activeOpacity={0.6}
                onPress={() => toggle(id)}
                style={{ paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12 }}
              >
                <Ionicons name={icon.name} size={20} color={icon.color} />
                <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: colors.ink }}>
                  {EXTRA_TITLES[id]}
                </Text>
                <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={colors.inkFaint} />
              </TouchableOpacity>
              {expanded && renderBody(id, status)}
            </View>
          );
        })}
      </Card>

      <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: 8, marginBottom: 4 }}>
        You can come back to any unfinished item from the wallet's Manage screen.
      </Text>
      <Button title="Finish" large disabled={!canFinish(wallet)} loading={finishing} onPress={finish} />
    </>
  );
}
