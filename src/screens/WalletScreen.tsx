import React from 'react';
import {
  LayoutAnimation,
  Linking,
  RefreshControl,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { Buffer } from 'buffer';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { Card, Button, SectionTitle, Tag, Row, Divider, UnreadDot } from '../components/ui';
import { ImportTxModal } from '../components/ImportTxModal';
import { unreadChat } from '../lib/nostr/unread';
import { extractPsbt } from '../lib/psbtFromBytes';
import { colors } from '../theme';
import { showError } from '../lib/errors';
import { useStore, newId } from '../lib/store';
import { exportBackup } from '../lib/exportActions';
import { backupMissesGroup } from '../lib/groupBackup';
import { formatSats } from '../lib/bitcoin';
import {
  assertDraftRoom,
  atDraftLimit,
  isDraftSettled,
  mergeSignatures,
  outpointKeys,
  parseIncomingPsbt,
  parsePsbt,
  summarisePsbt,
  unsignedTxId,
} from '../lib/wallet';
import { loadCached, refreshWallet } from '../lib/walletCache';
import { isSettled, markSettled } from '../lib/settled';
import { explorerName, txExplorerUrl } from '../lib/chain';
import { markDone, recordExport, setupSummary } from '../lib/tutorial';
import { WalletSnapshot, HistoryItem } from '../lib/types';
import { useGroup } from '../lib/nostr/useGroup';
import { memberAnswers } from '../lib/nostr/walletAnswers';
import { WalletAnswersCard } from '../components/WalletAnswersCard';
import { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Wallet'>;

export default function WalletScreen({ navigation, route }: Props) {
  const {
    wallets,
    keys,
    pendingTxs,
    savePendingTx,
    removePendingTx,
    updateWallet,
    groups,
    chats,
    updateGroup,
  } = useStore();
  const wallet = wallets.find((w) => w.id === route.params.walletId);
  const [snapshot, setSnapshot] = React.useState<WalletSnapshot | null>(null);
  const [history, setHistory] = React.useState<HistoryItem[]>([]);
  const [exporting, setExporting] = React.useState<'file' | 'pdf' | null>(null);
  const [importOpen, setImportOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [openTxid, setOpenTxid] = React.useState<string | null>(null);
  const [copiedTxid, setCopiedTxid] = React.useState<string | null>(null);

  const group = groups.find((g) => g.walletId === wallet?.id);
  const { messages: groupMessages, send: groupSend } = useGroup(group);
  // Receipts already sent this session, by the message they answer.
  const ackedRef = React.useRef(new Set<string>());
  // The coordinator sees who has added the wallet they built and who declined.
  const answers = React.useMemo(
    () => (group?.coordinator ? memberAnswers(groupMessages, group) : null),
    [groupMessages, group?.coordinator, group?.coordinatorPubkey, group?.roster]
  );
  const pending = pendingTxs.filter((t) => t.walletId === wallet?.id);

  // A menu in the header holds everything that is not day-to-day: backups,
  // group chat, receiving a transaction, signers, coins and advanced actions.
  // A dot flags a wallet that has never been backed up, or a group wallet
  // whose backup does not carry its group.
  React.useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () =>
        wallet ? (
          <TouchableOpacity
            onPress={() => navigation.navigate('WalletMenu', { walletId: wallet.id })}
            hitSlop={10}
          >
            <View>
              <Ionicons name="ellipsis-horizontal" size={24} color={colors.ink} />
              {(!wallet.exportedAt || backupMissesGroup(wallet, group)) && (
                <View
                  style={{
                    position: 'absolute',
                    top: -2,
                    right: -3,
                    width: 9,
                    height: 9,
                    borderRadius: 5,
                    backgroundColor: colors.warning,
                    borderWidth: 1,
                    borderColor: colors.bg,
                  }}
                />
              )}
            </View>
          </TouchableOpacity>
        ) : null,
    });
  }, [navigation, wallet?.id, wallet?.exportedAt, wallet?.backupIncludesGroup, group?.rekey, group?.coordinatorPubkey]);

  const refresh = React.useCallback(
    async (full = false) => {
      if (!wallet) return;
      setLoading(true);
      setError(null);
      try {
        const fresh = await refreshWallet(wallet, full);
        setSnapshot(fresh.snapshot);
        setHistory(fresh.history);
      } catch (e: any) {
        console.error(`[wallet:scan] ${e.message ?? e}\n${e.stack ?? ''}`);
        setError(e.message ?? String(e));
      } finally {
        setLoading(false);
      }
    },
    [wallet?.id]
  );

  // Renamed on the Manage screen while this one stays mounted underneath.
  React.useEffect(() => {
    navigation.setOptions({ title: wallet?.name ?? 'Wallet' });
  }, [wallet?.name]);

  React.useEffect(() => {
    navigation.setOptions({ title: wallet?.name ?? 'Wallet' });
    if (!wallet) return;
    let cancelled = false;
    // Show what we already know straight away, then bring it up to date.
    loadCached(wallet.id).then((cached) => {
      if (cancelled || !cached) return;
      setSnapshot(cached.snapshot);
      setHistory(cached.history);
    });
    refresh();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // Transactions shared by group members over Nostr land here automatically:
  // new ones become drafts, copies of existing ones merge their signatures.
  React.useEffect(() => {
    if (!wallet) return;
    // A relay can deliver many messages in one render, so this pass keeps its
    // own view of the wallet's drafts and updates it after every save or
    // removal. Reading `pendingTxs` inside the loop would use the snapshot
    // from before the pass: later messages would miss drafts saved by earlier
    // ones, merges would be lost, and the draft cap could be exceeded.
    let working = pendingTxs.filter((p) => p.walletId === wallet.id);
    const findDraft = (id: string) =>
      working.find((p) => {
        try {
          return unsignedTxId(parsePsbt(p.base64, wallet.network)) === id;
        } catch {
          return false;
        }
      });
    for (const m of groupMessages) {
      // A member broadcast it: settle the draft so it is not resurrected, and
      // drop it from this phone's pending list.
      if (m.message.type === 'broadcast') {
        const txid = m.message.txid;
        markSettled(wallet.id, txid);
        const stale = findDraft(txid);
        if (stale) {
          working = working.filter((p) => p.id !== stale.id);
          removePendingTx(stale.id);
        }
        continue;
      }
      if (m.message.type !== 'psbt' || m.mine) continue;
      try {
        const incoming = parseIncomingPsbt(m.message.base64, wallet.network);
        const unsignedId = unsignedTxId(incoming);
        // For segwit the txid does not change once signed, so a draft whose
        // id is already in our history has been sent — do not revive it.
        if (isSettled(wallet.id, unsignedId) || history.some((h) => h.txid === unsignedId)) continue;
        // Tell whoever shared it that it reached this wallet. Once per copy;
        // a copy seen before the session could send is answered next pass.
        if (groupSend && !ackedRef.current.has(m.id)) {
          try {
            groupSend({ type: 'psbt-ack', txid: unsignedId });
            ackedRef.current.add(m.id);
          } catch (e: any) {
            console.warn(`[nostr:psbt-ack] ${e?.message ?? e}`);
          }
        }
        const existing = findDraft(unsignedId);
        if (existing) {
          const { base64, added } = mergeSignatures(existing.base64, m.message.base64, wallet.network);
          if (added) {
            const merged = { ...existing, base64, updatedAt: Date.now() };
            working = working.map((p) => (p.id === merged.id ? merged : p));
            savePendingTx(merged);
          }
        } else {
          // Drafts arrive without any user confirmation, so their number is
          // capped — an invite holder must not be able to fill the list (and
          // the phone) with thousands of drafts.
          if (atDraftLimit(working.length)) continue;
          const draft = {
            id: newId(),
            walletId: wallet.id,
            base64: incoming.toBase64(),
            memo: m.message.memo ?? 'Received from the group',
            createdAt: m.at,
            updatedAt: Date.now(),
          };
          working = [...working, draft];
          savePendingTx(draft);
        }
      } catch (e: any) {
        console.error(`[nostr:psbt-in] ${e.message ?? e}`);
      }
    }
  }, [groupMessages.length, wallet?.id, history.length, !!groupSend]);

  // Being on this screen means the transactions listed here have been seen.
  React.useEffect(() => {
    if (group) updateGroup(group.id, { lastSeenTxAt: Date.now() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group?.id, pending.length]);

  // Clear drafts the chain has moved past: broadcast by anyone, confirmed,
  // or outbid by a transaction spending the same coins. Needs a real
  // snapshot — an empty one would look like everything was spent.
  React.useEffect(() => {
    if (!wallet || !snapshot) return;
    const unspent = outpointKeys(snapshot.utxos);
    const onChain = new Set(history.map((h) => h.txid));
    for (const p of pendingTxs) {
      if (p.walletId !== wallet.id) continue;
      try {
        if (isDraftSettled(p.base64, wallet.network, unspent, onChain)) removePendingTx(p.id);
      } catch {
        // Unreadable draft; leave it for the user to discard by hand.
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot?.scannedAt, history.length, pendingTxs.length, wallet?.id]);

  // A transaction scanned from the QR screen comes back as a route param.
  const scanned = route.params.scanned;
  React.useEffect(() => {
    if (scanned && wallet) importPsbtText(scanned, 'psbt:import-qr');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanned]);

  // The guided setup's "send a test transaction" step ticks itself the first
  // time the wallet has sent anything.
  React.useEffect(() => {
    if (!wallet?.setup || wallet.setup.done.testtx || wallet.setup.skipped.testtx) return;
    if (history.some((h) => h.netSats < 0)) {
      updateWallet(wallet.id, (w) => (w.setup ? { setup: markDone(w.setup, 'testtx', Date.now()) } : {})).catch((e) =>
        showError('tutorial:testtx', e)
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history.length, wallet?.id]);

  if (!wallet) return null;

  const importPsbtText = (text: string, context: string) => {
    try {
      const psbt = parseIncomingPsbt(text, wallet.network);
      // Merge into an existing draft with the same unsigned txid, else start one.
      const unsignedId = unsignedTxId(psbt);
      const existing = pending.find((p) => {
        try {
          return unsignedTxId(parsePsbt(p.base64, wallet.network)) === unsignedId;
        } catch {
          return false;
        }
      });
      if (existing) {
        const other = parsePsbt(existing.base64, wallet.network);
        other.combine(psbt);
        savePendingTx({ ...existing, base64: other.toBase64(), updatedAt: Date.now() });
        resetImport();
        navigation.navigate('Psbt', { walletId: wallet.id, pendingId: existing.id });
      } else {
        // The same cap as drafts from the relay: one rule for the list.
        assertDraftRoom(pending.length);
        const id = newId();
        savePendingTx({
          id,
          walletId: wallet.id,
          base64: psbt.toBase64(),
          memo: 'Imported from a group member',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        resetImport();
        navigation.navigate('Psbt', { walletId: wallet.id, pendingId: id });
      }
    } catch (e: any) {
      showError(context, e);
    }
  };

  const resetImport = () => setImportOpen(false);

  /** Opens a .psbt file (binary or text) as exported by Sparrow, Nunchuk, etc. */
  const pickPsbtFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/octet-stream', 'application/psbt', 'text/plain', '*/*'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled || !result.assets?.[0]) return;
      // Read as base64 so a binary .psbt survives; extractPsbt then accepts the
      // raw transaction, or base64/hex text, whichever the wallet wrote.
      const base64 = await FileSystem.readAsStringAsync(result.assets[0].uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      let psbt: string;
      try {
        psbt = extractPsbt([Buffer.from(base64, 'base64')], wallet.network);
      } catch {
        throw new Error(
          "That file doesn't contain a transaction this wallet can read. Export it as a transaction file (PSBT) from Sparrow, Nunchuk or another wallet."
        );
      }
      importPsbtText(psbt, 'psbt:import-file');
    } catch (e: any) {
      showError('psbt:import-file', e);
    }
  };

  const runExport = async (which: 'file' | 'pdf') => {
    setExporting(which);
    try {
      const withGroup = await exportBackup(which, wallet, groups, keys);
      await updateWallet(wallet.id, recordExport(wallet, which, Date.now(), withGroup));
    } catch (e: any) {
      showError(`wallet:export-${which}`, e);
    } finally {
      setExporting(null);
    }
  };

  const total = (snapshot?.confirmedSats ?? 0) + (snapshot?.unconfirmedSats ?? 0);

  /** How far along each draft is, so a finished one is not called "awaiting". */
  const pendingWithProgress = pending.map((p) => {
    try {
      const summary = summarisePsbt(parsePsbt(p.base64, wallet.network), wallet);
      return { tx: p, signed: summary.signedBy.length, ready: summary.complete };
    } catch {
      return { tx: p, signed: 0, ready: false };
    }
  });
  const allReady = pendingWithProgress.length > 0 && pendingWithProgress.every((p) => p.ready);
  const anyReady = pendingWithProgress.some((p) => p.ready);

  // A wallet mid-way through the guided setup gets its checklist card in
  // place of the plain backup nag; the guide's backup step covers the same.
  const setupActive = !!wallet.setup && !wallet.setup.completedAt;
  const summary = setupActive ? setupSummary(wallet, keys) : null;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: 20, paddingBottom: 56 }}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={() => refresh(true)} />}
    >
      <Card style={{ alignItems: 'center', paddingVertical: 28 }}>
        <View style={{ flexDirection: 'row' }}>
          <Tag text={`${wallet.m} of ${wallet.n}`} />
          <Tag
            text={wallet.kind === 'group' ? 'Group' : 'Private'}
            tone={wallet.kind === 'group' ? 'accent' : 'neutral'}
          />
          {wallet.network === 'testnet' && <Tag text="Testnet" tone="accent" />}
        </View>
        <Text
          style={{
            fontSize: 34,
            fontWeight: '700',
            color: colors.ink,
            marginTop: 12,
            letterSpacing: -0.5,
            fontVariant: ['tabular-nums'],
          }}
        >
          {snapshot ? formatSats(total) : loading ? '…' : '—'}
        </Text>
        {snapshot && snapshot.unconfirmedSats !== 0 && (
          <Text style={{ color: colors.inkSoft, marginTop: 4, fontSize: 13 }}>
            {formatSats(snapshot.unconfirmedSats)} awaiting confirmation
          </Text>
        )}
        {error && (
          <Text style={{ color: colors.danger, marginTop: 10, textAlign: 'center', fontSize: 13 }}>
            {error}
          </Text>
        )}
      </Card>

      {setupActive && summary && (
        <Card style={{ borderColor: colors.accent, borderWidth: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Ionicons name="list-outline" size={20} color={colors.accent} />
            <Text style={{ fontSize: 15, fontWeight: '600', color: colors.ink, flex: 1 }}>
              Setup checklist
            </Text>
          </View>
          <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 8 }}>
            {summary.backupDone
              ? `${summary.recommendedDone} of ${summary.recommendedTotal} recommended steps done`
              : wallet.exportedAt
                ? 'Confirm where your backup is kept to finish setting it up'
                : 'Back up the wallet to finish setting it up'}
          </Text>
          <Button
            title="Continue setup"
            icon="arrow-forward-outline"
            onPress={() => navigation.navigate('Tutorial', { walletId: wallet.id })}
          />
        </Card>
      )}

      {!wallet.exportedAt && !setupActive && (
        <Card style={{ borderColor: colors.warning, borderWidth: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Ionicons name="alert-circle-outline" size={20} color={colors.warning} />
            <Text style={{ fontSize: 15, fontWeight: '600', color: colors.ink, flex: 1 }}>
              Back up this wallet
            </Text>
          </View>
          <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 8 }}>
            Your keys alone cannot rebuild a multisig wallet — you also need every cosigner's public
            key. Save a backup now and keep it with your recovery phrase. It holds no secrets and
            cannot spend your funds.
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

      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Button
            title="Receive"
            icon="arrow-down-outline"
            variant="secondary"
            onPress={() => navigation.navigate('Receive', { walletId: wallet.id })}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Button
            title="Send"
            icon="arrow-up-outline"
            onPress={() => navigation.navigate('Send', { walletId: wallet.id })}
            disabled={!snapshot || snapshot.utxos.length === 0}
          />
        </View>
      </View>

      {pending.length > 0 && (
        <>
          <SectionTitle>
            {allReady ? 'Ready to send' : anyReady ? 'Transactions' : 'Awaiting signatures'}
          </SectionTitle>
          <Card>
            {pendingWithProgress.map(({ tx: p, signed, ready }, i) => (
              <View key={p.id}>
                {i > 0 && <Divider />}
                <Row
                  icon={ready ? 'checkmark-circle-outline' : 'create-outline'}
                  title={p.memo ?? 'Transaction'}
                  subtitle={
                    ready
                      ? `${signed} of ${wallet.m} signatures · ready to broadcast`
                      : `${signed} of ${wallet.m} signatures · needs ${wallet.m - signed} more`
                  }
                  onPress={() => navigation.navigate('Psbt', { walletId: wallet.id, pendingId: p.id })}
                  trailing={
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      {ready && <Tag text="Ready" tone="success" />}
                      <Ionicons name="chevron-forward" size={18} color={colors.inkFaint} />
                    </View>
                  }
                />
              </View>
            ))}
          </Card>
        </>
      )}

      <SectionTitle>Sign a transaction</SectionTitle>
      <Card>
        <Row
          icon="create-outline"
          title="Import transaction to sign"
          subtitle="Scan, paste, or open a transaction file"
          onPress={() => setImportOpen(true)}
        />
      </Card>

      {answers && <WalletAnswersCard walletName={wallet.name} answers={answers} />}

      {group && (
        <>
          <SectionTitle>Group</SectionTitle>
          <Card>
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
          </Card>
        </>
      )}

      {history.length > 0 && (
        <>
          <SectionTitle>History</SectionTitle>
          <Card>
            {history.slice(0, 15).map((h, i) => {
              const expanded = openTxid === h.txid;
              return (
                <View
                  key={h.txid}
                  style={{ borderTopWidth: i > 0 ? 1 : 0, borderTopColor: colors.line }}
                >
                  <TouchableOpacity
                    activeOpacity={0.6}
                    onPress={() => {
                      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                      setOpenTxid(expanded ? null : h.txid);
                    }}
                    style={{ paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 12 }}
                  >
                    <Ionicons
                      name={h.netSats >= 0 ? 'arrow-down-outline' : 'arrow-up-outline'}
                      size={18}
                      color={h.netSats >= 0 ? colors.success : colors.ink}
                    />
                    <View style={{ flex: 1 }}>
                      <Text
                        style={{
                          fontWeight: '600',
                          color: h.netSats >= 0 ? colors.success : colors.ink,
                          fontVariant: ['tabular-nums'],
                        }}
                      >
                        {h.netSats >= 0 ? '+' : '−'}
                        {formatSats(Math.abs(h.netSats))}
                      </Text>
                      <Text style={{ color: colors.inkFaint, fontSize: 12 }} numberOfLines={1}>
                        {h.txid}
                      </Text>
                    </View>
                    <Text style={{ color: colors.inkSoft, fontSize: 12 }}>
                      {h.confirmed
                        ? h.blockTime
                          ? new Date(h.blockTime * 1000).toLocaleDateString()
                          : 'Confirmed'
                        : 'Pending'}
                    </Text>
                    <Ionicons
                      name={expanded ? 'chevron-up' : 'chevron-down'}
                      size={16}
                      color={colors.inkFaint}
                    />
                  </TouchableOpacity>

                  {expanded && (
                    <View style={{ flexDirection: 'row', gap: 10, paddingBottom: 10 }}>
                      <View style={{ flex: 1 }}>
                        <Button
                          title={copiedTxid === h.txid ? 'Copied' : 'Copy txid'}
                          icon={copiedTxid === h.txid ? 'checkmark-outline' : 'copy-outline'}
                          variant="secondary"
                          compact
                          onPress={async () => {
                            await Clipboard.setStringAsync(h.txid);
                            setCopiedTxid(h.txid);
                            setTimeout(() => setCopiedTxid(null), 1500);
                          }}
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Button
                          // Opens whichever explorer the wallet is pointed at,
                          // so a self-hosted instance stays self-hosted.
                          title={`Open in ${explorerName()}`}
                          icon="open-outline"
                          variant="secondary"
                          compact
                          onPress={() =>
                            Linking.openURL(txExplorerUrl(wallet.network, h.txid)).catch((e) =>
                              showError('history:open', e)
                            )
                          }
                        />
                      </View>
                    </View>
                  )}
                </View>
              );
            })}
          </Card>
        </>
      )}

      <ImportTxModal
        visible={importOpen}
        onClose={() => setImportOpen(false)}
        onScan={() => {
          setImportOpen(false);
          navigation.navigate('ScanQR', { returnTo: 'Wallet', walletId: wallet.id });
        }}
        onPickFile={pickPsbtFile}
        onPaste={(text) => importPsbtText(text, 'psbt:import')}
      />
    </ScrollView>
  );
}
