import React from 'react';
import { Alert, LayoutAnimation, Linking, Share, Text, TouchableOpacity, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { Screen, Card, Button, SectionTitle, Tag, Input, Divider, Label, Mono, IconName } from '../components/ui';
import { AnimatedQrModal } from '../components/AnimatedQrModal';
import { TapsignerModal } from '../components/TapsignerModal';
import { UsbDeviceModal } from '../components/UsbDeviceModal';
import { colors } from '../theme';
import { showError } from '../lib/errors';
import { useStore, loadMnemonic } from '../lib/store';
import { formatSats } from '../lib/bitcoin';
import {
  attachSignatures,
  signingJobsFor,
  parsePsbt,
  summarisePsbt,
  signPsbtWithMnemonic,
  finalizeAndExtract,
  mergeSignatures,
  removeSignature,
  unsignedTxId,
  PsbtSummary,
} from '../lib/wallet';
import { broadcastTxVia, PUBLIC_FALLBACK_SERVER } from '../lib/esplora';
import { broadcastTx, backendLabel, explorerIsPublic, explorerName, fetchTxHex, txExplorerUrl } from '../lib/chain';
import { invalidate } from '../lib/walletCache';
import { markSettled } from '../lib/settled';
import { useGroup } from '../lib/nostr/useGroup';
import { psbtReceipts } from '../lib/nostr/receipts';
import { DEFAULT_MAX_ATTEMPTS } from '../lib/nostr/outbox';
import { cancelNfcSession, nfcAvailable, readPsbtFromTag, signWithTapsigner, writePsbtToTag } from '../lib/nfc';
import { isHardwareKind, kindName, signPsbtWithDevice } from '../lib/hw';
import { usbAvailable } from '../lib/hw/usb';
import { exportPsbtFile } from '../lib/exportActions';
import { exportBaseName } from '../lib/walletExport';
import { Cosigner, SignerKey } from '../lib/types';
import { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Psbt'>;

export default function PsbtScreen({ navigation, route }: Props) {
  const { wallets, keys, pendingTxs, savePendingTx, removePendingTx, groups } = useStore();
  const wallet = wallets.find((w) => w.id === route.params.walletId);
  const record = pendingTxs.find((t) => t.id === route.params.pendingId);
  const group = groups.find((g) => g.walletId === route.params.walletId);
  const {
    send: groupSend,
    connected: groupConnected,
    messages: groupMessages,
    requestDeletion,
    delivery,
  } = useGroup(group);
  /** The unsigned txid — what receipts and broadcast notices are keyed on. */
  const recordTxid = React.useMemo(() => {
    if (!wallet || !record) return null;
    try {
      return unsignedTxId(parsePsbt(record.base64, wallet.network));
    } catch {
      return null;
    }
  }, [record?.base64, wallet?.id]);
  /** Which members' wallets have reported holding this transaction. */
  const receipts = React.useMemo(
    () => psbtReceipts(groupMessages, group, recordTxid),
    [groupMessages, group?.roster, recordTxid]
  );
  /** Whether this phone has shared a transaction here at all — receipts mean nothing before that. */
  const sharedHere = groupMessages.some((m) => m.mine && m.message.type === 'psbt');
  /** Shares of ours no relay has confirmed storing. */
  const unsent = delivery.filter((i) => i.message?.type === 'psbt');
  const [sentToGroup, setSentToGroup] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [pasteOpen, setPasteOpen] = React.useState(false);
  const [pasteText, setPasteText] = React.useState('');
  const [broadcastedTxid, setBroadcastedTxid] = React.useState<string | null>(null);
  const [broadcastFailed, setBroadcastFailed] = React.useState(false);
  const [qrOpen, setQrOpen] = React.useState(false);
  const [copiedTxid, setCopiedTxid] = React.useState(false);
  const [cardSigner, setCardSigner] = React.useState<Cosigner | null>(null);
  const [hasNfc, setHasNfc] = React.useState(false);
  const [writingTag, setWritingTag] = React.useState(false);
  const [readingTag, setReadingTag] = React.useState(false);
  const [sentToCard, setSentToCard] = React.useState(false);
  const [outputsOpen, setOutputsOpen] = React.useState(false);
  /** The unsigned cosigner whose "get signature" steps are open, by fingerprint. */
  const [openSigner, setOpenSigner] = React.useState<string | null>(null);
  /** Every other way to move the transaction, folded away until asked for. */
  const [moreOpen, setMoreOpen] = React.useState(false);
  // Who a USB device is being asked to sign as: one cosigner, or 'any' to let
  // the device that gets plugged in say which of the wallet's keys it holds.
  const [usbSigner, setUsbSigner] = React.useState<Cosigner | 'any' | null>(null);
  const hasUsb = usbAvailable();
  // Set when the user calls off a card tap, so the resulting rejection is not
  // reported as a failure. A hook, so it must stay above the guards below.
  const cancelledCard = React.useRef(false);

  React.useEffect(() => {
    nfcAvailable().then(setHasNfc);
  }, []);

  // Signatures from other members land here live, so the count on screen
  // moves the moment someone else signs.
  React.useEffect(() => {
    if (!wallet || !record) return;
    for (const m of groupMessages) {
      if (m.message.type !== 'psbt' || m.mine) continue;
      try {
        const { base64, added } = mergeSignatures(record.base64, m.message.base64, wallet.network);
        if (added) savePendingTx({ ...record, base64, updatedAt: Date.now() });
      } catch {
        // A different transaction on the same channel — not ours to merge.
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupMessages.length, record?.base64, wallet?.id]);

  // If another member broadcasts this transaction, move straight to the sent
  // screen instead of sitting here still offering to broadcast it again.
  React.useEffect(() => {
    if (!wallet || !record || broadcastedTxid) return;
    let recordTxid: string;
    try {
      recordTxid = unsignedTxId(parsePsbt(record.base64, wallet.network));
    } catch {
      return;
    }
    const done = groupMessages.some(
      (m) => m.message.type === 'broadcast' && m.message.txid === recordTxid
    );
    if (done) finishBroadcast(recordTxid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupMessages.length, record?.base64, wallet?.id, broadcastedTxid]);

  const scanned = route.params.scanned;
  React.useEffect(() => {
    if (scanned && wallet && record) mergeText(scanned, 'psbt:merge-qr');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanned]);

  if (!wallet) return null;

  // Rendered from state alone: by this point the pending record is gone.
  if (broadcastedTxid) {
    const explorer = txExplorerUrl(wallet.network, broadcastedTxid);
    return (
      <Screen>
        <Card style={{ alignItems: 'center', paddingVertical: 32 }}>
          <Ionicons name="checkmark-circle" size={60} color={colors.success} />
          <Text style={{ fontSize: 22, fontWeight: '700', color: colors.ink, marginTop: 14 }}>
            Sent
          </Text>
          <Text style={{ color: colors.inkSoft, fontSize: 14, marginTop: 6, textAlign: 'center' }}>
            The network has your transaction. It will confirm in a block.
          </Text>

          <View style={{ alignSelf: 'stretch', marginTop: 20 }}>
            <Label>Transaction ID</Label>
            <Mono text={broadcastedTxid} small />

            <Button
              title={copiedTxid ? 'Copied' : 'Copy transaction ID'}
              icon={copiedTxid ? 'checkmark-outline' : 'copy-outline'}
              variant="secondary"
              onPress={async () => {
                await Clipboard.setStringAsync(broadcastedTxid);
                setCopiedTxid(true);
                setTimeout(() => setCopiedTxid(false), 1500);
              }}
            />
            <Button
              title={`See on ${explorerName()}`}
              icon="open-outline"
              variant="secondary"
              onPress={() =>
                Linking.openURL(explorer).catch((e) => showError('psbt:explorer', e))
              }
            />
            <Button
              title="Share link"
              icon="share-outline"
              variant="ghost"
              onPress={() => Share.share({ message: explorer })}
            />
            <Button title="Done" large onPress={() => navigation.popToTop()} />
          </View>
        </Card>
      </Screen>
    );
  }

  if (!record) return null;


  let summary: PsbtSummary | null = null;
  let parseError: string | null = null;
  try {
    summary = summarisePsbt(parsePsbt(record.base64, wallet.network), wallet);
  } catch (e: any) {
    parseError = e.message ?? String(e);
  }

  const localSigners = wallet.cosigners.filter((c) => {
    if (!c.keyId) return false;
    const k = keys.find((key) => key.id === c.keyId);
    return k?.type === 'local' && summary && !summary.signedBy.includes(c.fingerprint);
  });

  /** Sign with one key on this phone; omit to use every key it holds. */
  const sign = async (only?: Cosigner) => {
    setBusy(true);
    try {
      const psbt = parsePsbt(record.base64, wallet.network);
      let totalSigned = 0;
      for (const signer of only ? [only] : localSigners) {
        const mnemonic = await loadMnemonic(signer.keyId!);
        if (!mnemonic) continue;
        totalSigned += signPsbtWithMnemonic(psbt, mnemonic, wallet);
      }
      if (totalSigned === 0) {
        Alert.alert('Nothing to sign', 'The keys on this phone have already signed this transaction.');
      } else {
        const signed = psbt.toBase64();
        await savePendingTx({ ...record, base64: signed, updatedAt: Date.now() });
        // Send it straight back to the group — otherwise the signature sits on
        // this phone and the others never see it.
        if (group && groupSend) {
          groupSend({ type: 'psbt', base64: signed, memo: record.memo });
          setSentToGroup(true);
          setTimeout(() => setSentToGroup(false), 2500);
        }
      }
    } catch (e: any) {
      showError('psbt:sign', e, 'Signing failed');
    } finally {
      setBusy(false);
    }
  };

  const share = () => Share.share({ message: record.base64 });

  /** The transaction as a .psbt file, for another wallet or to keep. */
  const exportFile = async () => {
    let suffix = '';
    try {
      suffix = `-${unsignedTxId(parsePsbt(record.base64, wallet.network)).slice(0, 8)}`;
    } catch {
      // Unparseable here means unparseable everywhere; the file still goes out.
    }
    try {
      await exportPsbtFile(record.base64, `${exportBaseName(wallet)}${suffix}`);
    } catch (e: any) {
      showError('psbt:export-file', e);
    }
  };

  /**
   * The transaction wrapped in instructions, for a cosigner who is a person.
   * On their screen this phone's key is a cosigner they cannot sign for, so
   * its row offers "Send to <that name>", which is the way back.
   */
  const sendTo = (c: Cosigner) => {
    const mine = wallet.cosigners.find((x) => keys.find((k) => k.id === x.keyId)?.type === 'local');
    const wayBack = mine
      ? `Then, on the same screen, tap "Get signature" next to ${mine.name} and send it back to me.`
      : 'Then tap "Other ways to sign or share", "Share as text", and send me what it shares.';
    return Share.share({
      message:
        `Please sign a transaction from our "${wallet.name}" wallet in Simple Multisig.\n\n` +
        'Open the wallet, tap "Import transaction to sign", choose Paste and paste this whole message. ' +
        `Check the amounts and sign. ${wayBack}\n\n` +
        record.base64,
    });
  };

  /** Hand the transaction to a Coldcard over NFC. */
  const exportToTag = async () => {
    setWritingTag(true);
    try {
      await writePsbtToTag(record.base64);
      setSentToCard(true);
    } catch (e: any) {
      showError('psbt:nfc-export', e);
    } finally {
      setWritingTag(false);
    }
  };

  /** Read the signed copy back off the card and merge it in. */
  const readFromTag = async () => {
    setReadingTag(true);
    try {
      await mergeText(await readPsbtFromTag(wallet.network), 'psbt:nfc-import');
      setSentToCard(false);
    } catch (e: any) {
      showError('psbt:nfc-import', e);
    } finally {
      setReadingTag(false);
    }
  };

  /** Take a cosigner's signature back off the draft, once confirmed. */
  const confirmRemoveSignature = (cosigner: Cosigner) => {
    Alert.alert(
      `Remove ${cosigner.name}'s signature?`,
      'The transaction will need signing again by this key, or by another cosigner, before it can be broadcast.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              const base64 = removeSignature(record.base64, wallet.network, cosigner.fingerprint);
              await savePendingTx({ ...record, base64, updatedAt: Date.now() });
              // Group copies would otherwise merge the signature straight back.
              if (group && groupSend) groupSend({ type: 'psbt', base64, memo: record.memo });
            } catch (e: any) {
              showError('psbt:remove-signature', e, 'Could not remove that signature');
            }
          },
        },
      ]
    );
  };

  /** Called off mid-tap: end the NFC session too, not just the dialog. */
  const cancelCard = () => {
    cancelledCard.current = true;
    cancelNfcSession();
    setCardSigner(null);
  };

  /** Sign the inputs this card owns, in a single tap. */
  const signWithCard = async (cvc: string) => {
    if (!cardSigner) return;
    setBusy(true);
    try {
      cancelledCard.current = false;
      const jobs = signingJobsFor(record.base64, cardSigner.fingerprint, wallet.network);
      if (jobs.length === 0) {
        Alert.alert('Nothing to sign', 'This card has already signed every input it owns.');
        setCardSigner(null);
        return;
      }
      const signatures = await signWithTapsigner(
        cvc,
        // The expected key travels with each job, so a card holding a
        // different one is caught before its signature is attached.
        jobs.map((j) => ({ digest: j.digest, subpath: j.subpath, pubkey: j.pubkey })),
        cardSigner.path,
        cardSigner.fingerprint
      );
      // Verified against each digest before being attached.
      const base64 = attachSignatures(
        record.base64,
        wallet.network,
        jobs.map((job, i) => ({ job, signature: signatures[i].signature }))
      );
      await savePendingTx({ ...record, base64, updatedAt: Date.now() });
      if (group && groupSend) groupSend({ type: 'psbt', base64, memo: record.memo });
      setCardSigner(null);
    } catch (e: any) {
      // Cancelling rejects the pending tap; that is not a failure to report.
      if (!cancelledCard.current) showError('psbt:sign-card', e, 'Signing failed');
    } finally {
      setBusy(false);
    }
  };

  /** A hardware wallet signed: fold its signatures into whatever the draft is by now. */
  const acceptDeviceSignatures = async (signedBase64: string) => {
    setUsbSigner(null);
    try {
      // The device can take minutes, and other members' signatures may have
      // arrived meanwhile — merge rather than overwrite them.
      const { base64 } = mergeSignatures(record.base64, signedBase64, wallet.network);
      await savePendingTx({ ...record, base64, updatedAt: Date.now() });
      if (group && groupSend) {
        groupSend({ type: 'psbt', base64, memo: record.memo });
        setSentToGroup(true);
        setTimeout(() => setSentToGroup(false), 2500);
      }
    } catch (e: any) {
      showError('psbt:sign-usb', e, 'Signing failed');
    }
  };

  const sendToGroup = () => {
    try {
      if (!groupSend) throw new Error('Not connected to the group relays yet.');
      groupSend({ type: 'psbt', base64: record.base64, memo: record.memo });
      setSentToGroup(true);
      setTimeout(() => setSentToGroup(false), 2500);
    } catch (e: any) {
      showError('nostr:psbt-out', e);
    }
  };

  const mergeText = async (text: string, context: string) => {
    try {
      const { base64, added } = mergeSignatures(record.base64, text, wallet.network);
      if (!added) {
        Alert.alert('Nothing new', 'That copy has no signatures this one is missing.');
        return;
      }
      await savePendingTx({ ...record, base64, updatedAt: Date.now() });
    } catch (e: any) {
      showError(context, e);
    }
  };

  const mergePaste = async () => {
    await mergeText(pasteText, 'psbt:merge');
    setPasteText('');
    setPasteOpen(false);
  };

  const finishBroadcast = async (txid: string, announce = false) => {
    // Members keep re-sharing the PSBT; without this it comes straight back
    // as a fresh draft the moment we delete it.
    markSettled(wallet.id, txid);
    // The transaction is public now; the copies we published to relays
    // only add a lasting record of who signed what, so ask them to go.
    const mineHere = groupMessages.filter((m) => m.mine && m.message.type === 'psbt').map((m) => m.id);
    requestDeletion?.(mineHere);
    // Tell the group it is done, so everyone else leaves the signing screen for
    // the sent screen too instead of broadcasting the same transaction again.
    // The money has already moved by this point, so a relay problem must not
    // stop us recording that — announcing is a courtesy, not part of the spend.
    if (announce && groupSend) {
      try {
        groupSend({ type: 'broadcast', txid, memo: record.memo });
      } catch (e: any) {
        console.warn(`Could not tell the group the transaction was broadcast: ${e.message ?? e}`);
      }
    }
    setBroadcastedTxid(txid);
    invalidate(wallet.id);
    await removePendingTx(record.id);
  };

  const broadcastViaFallback = async () => {
    setBusy(true);
    try {
      const hex = finalizeAndExtract(parsePsbt(record.base64, wallet.network));
      await finishBroadcast(await broadcastTxVia(PUBLIC_FALLBACK_SERVER, wallet.network, hex), true);
    } catch (e: any) {
      showError('psbt:broadcast-fallback', e, 'Broadcast failed');
    } finally {
      setBusy(false);
    }
  };

  const broadcast = async () => {
    setBusy(true);
    try {
      const psbt = parsePsbt(record.base64, wallet.network);
      const hex = finalizeAndExtract(psbt);
      const txid = await broadcastTx(wallet.network, hex);
      await finishBroadcast(txid, true);
    } catch (e: any) {
      setBroadcastFailed(true);
      showError('psbt:broadcast', e, 'Broadcast failed');
    } finally {
      setBusy(false);
    }
  };

  if (parseError || !summary) {
    return (
      <Screen>
        <Card>
          <Text style={{ color: colors.danger, fontSize: 14 }}>
            {parseError ?? 'Could not read this transaction.'}
          </Text>
          <Button
            title="Discard"
            icon="trash-outline"
            variant="danger"
            onPress={async () => {
              await removePendingTx(record.id);
              navigation.goBack();
            }}
          />
        </Card>
      </Screen>
    );
  }

  // What is actually leaving the wallet, as opposed to change coming back.
  // "Change" here is verified against the wallet's own keys in summarisePsbt,
  // so a hostile draft cannot disguise a payment as change.
  const payments = summary.outputs.filter((o) => !o.isChange);
  const changeTotal = summary.changeTotal;

  // A draft from another cosigner / QR / file that spends coins this wallet
  // can't re-derive, or pays an outsized fee, is a red flag — surface it hard.
  const foreignInputs = !summary.allInputsOurs;
  const feeAbsurd =
    summary.fee > 0 && summary.feeRatio > 0.2 && summary.fee > 10_000;
  const feeAlarm = foreignInputs || feeAbsurd;

  const sigsSoFar = summary.signedBy.length;
  // A surplus signature makes the spend unfinalisable, so it is not "ready"
  // however many signatures are on it.
  const ready = summary.complete && !summary.overSigned;

  const scanSigned = () =>
    navigation.navigate('ScanQR', { returnTo: 'Psbt', walletId: wallet.id, pendingId: record.id });

  /** Out to a Coldcard over NFC, then the signed copy back: one pair of buttons following the round trip. */
  const nfcRoundTrip = () =>
    sentToCard ? (
      <>
        <Button
          title={readingTag ? 'Hold the phone against the Coldcard…' : 'Read signed copy from Coldcard'}
          icon="download-outline"
          compact
          onPress={readFromTag}
          loading={readingTag}
        />
        <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 2 }}>
          Sent. Approve it on the Coldcard, then tap the card again to bring the signed copy back.
        </Text>
        <Button title="Send it again" icon="repeat-outline" variant="ghost" compact onPress={exportToTag} loading={writingTag} />
      </>
    ) : (
      <Button
        title={writingTag ? 'Hold the phone against the Coldcard…' : 'Send to Coldcard (NFC)'}
        icon="radio-outline"
        variant="secondary"
        compact
        onPress={exportToTag}
        loading={writingTag}
      />
    );

  type SignerAction = { title: string; icon: IconName; variant?: 'primary' | 'secondary'; onPress: () => void; busy?: boolean };
  /** What gets this cosigner's signature onto the draft, and the one button that starts it. */
  type SignerStep = { hint: string; action?: SignerAction; kind?: 'person' | 'device' };

  const expandAction = (c: Cosigner): SignerAction => {
    const open = openSigner === c.fingerprint;
    return {
      title: open ? 'Close' : 'Get signature',
      icon: open ? 'chevron-up' : 'chevron-down',
      variant: 'secondary',
      onPress: () => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setOpenSigner(open ? null : c.fingerprint);
      },
    };
  };

  // The next step follows from where the key lives: on this phone, on a card
  // or device this phone can talk to, on a device it cannot, or with a person.
  const stepFor = (c: Cosigner, signed: boolean, held?: SignerKey): SignerStep => {
    if (signed) return { hint: 'Signed' };
    if (held?.type === 'local') {
      return { hint: 'On this phone', action: { title: 'Sign', icon: 'create-outline', onPress: () => sign(c), busy } };
    }
    const source = held?.source;
    if (source === 'tapsigner') {
      if (hasNfc) {
        return {
          hint: 'Hold the card against this phone to sign',
          action: { title: 'Tap card', icon: 'radio-outline', variant: 'secondary', onPress: () => setCardSigner(c) },
        };
      }
      return {
        hint: 'A TAPSIGNER card. This phone has no NFC, so sign on one that does and bring the copy back',
        kind: 'device',
        action: expandAction(c),
      };
    }
    if (isHardwareKind(source)) {
      if (hasUsb) {
        return {
          hint: `Plug the ${kindName(source)} into this phone`,
          action: { title: 'Plug in', icon: 'hardware-chip-outline', variant: 'secondary', onPress: () => setUsbSigner(c) },
        };
      }
      return {
        hint: `Show the ${kindName(source)} the QR code or give it the file, then bring the signed copy back`,
        kind: 'device',
        action: expandAction(c),
      };
    }
    if (held) {
      return {
        hint: 'A hardware wallet. Show it the QR code or give it the file, then bring the signed copy back',
        kind: 'device',
        action: expandAction(c),
      };
    }
    if (group) return { hint: `${c.name} signs on their own phone. It arrives here by itself.` };
    return { hint: `Send it to ${c.name}, then merge the signed copy they send back`, kind: 'person', action: expandAction(c) };
  };

  const stepLabel = {
    color: colors.inkFaint,
    fontSize: 12,
    fontWeight: '600' as const,
    letterSpacing: 0.3,
    marginTop: 8,
    marginBottom: 2,
  };

  return (
    <Screen>
      {record.memo && (
        <Card>
          <Text style={{ fontSize: 12, fontWeight: '600', color: colors.inkSoft, letterSpacing: 0.5 }}>
            WHAT THIS IS FOR
          </Text>
          <Text style={{ color: colors.ink, fontSize: 15, lineHeight: 21, marginTop: 4 }}>
            {record.memo}
          </Text>
        </Card>
      )}

      <Card>
        <Text style={{ fontSize: 13, fontWeight: '600', color: colors.inkSoft, textAlign: 'center' }}>
          SIGNATURES
        </Text>
        <Text
          style={{
            fontSize: 36,
            fontWeight: '700',
            color: ready ? colors.success : colors.ink,
            textAlign: 'center',
            marginVertical: 6,
            fontVariant: ['tabular-nums'],
          }}
        >
          {sigsSoFar} of {wallet.m}
        </Text>
        <Text
          style={{
            color: ready ? colors.success : colors.inkSoft,
            fontWeight: '600',
            textAlign: 'center',
            fontSize: 13,
            marginBottom: 4,
          }}
        >
          {ready
            ? 'Ready to broadcast'
            : summary.overSigned
              ? 'Too many signatures'
              : `Needs ${wallet.m - sigsSoFar} more signature${wallet.m - sigsSoFar === 1 ? '' : 's'}`}
        </Text>
        {sentToGroup && (
          <Text style={{ color: colors.accent, textAlign: 'center', fontSize: 12, marginBottom: 4 }}>
            Shared with the group
          </Text>
        )}
        {unsent.length > 0 && (
          <Text style={{ color: colors.warning, textAlign: 'center', fontSize: 12, lineHeight: 17, marginBottom: 4 }}>
            {unsent[0].rejected
              ? `A relay refused the shared copy: ${unsent[0].rejected}. `
              : 'No relay has confirmed the shared copy yet. '}
            {unsent[0].attempts < DEFAULT_MAX_ATTEMPTS
              ? 'Still trying.'
              : 'Given up for now — share with the group again to retry.'}
          </Text>
        )}
        {group && sharedHere && receipts.length > 0 && (
          <View style={{ marginBottom: 6 }}>
            {receipts.map((r) => (
              <Text
                key={r.author}
                style={{ color: r.received ? colors.success : colors.inkSoft, textAlign: 'center', fontSize: 12, lineHeight: 17 }}
              >
                {r.name} · {r.received ? 'has this transaction' : 'not received yet'}
              </Text>
            ))}
          </View>
        )}
        <Divider />
        {wallet.cosigners.map((c) => {
          const signed = summary!.signedBy.includes(c.fingerprint);
          const held = keys.find((k) => k.id === c.keyId);
          const step = stepFor(c, signed, held);
          const expanded = !signed && openSigner === c.fingerprint;
          return (
            <View key={c.fingerprint} style={{ paddingVertical: 7 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Ionicons
                  name={signed ? 'checkmark-circle' : 'ellipse-outline'}
                  size={20}
                  color={signed ? colors.success : colors.inkFaint}
                />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, color: colors.ink }}>{c.name}</Text>
                  <Text style={{ fontSize: 12, lineHeight: 17, color: signed ? colors.success : colors.inkSoft }}>
                    {step.hint}
                  </Text>
                </View>
                {signed ? (
                  <Button
                    title="Remove"
                    icon="close-circle-outline"
                    variant="ghost"
                    compact
                    onPress={() => confirmRemoveSignature(c)}
                  />
                ) : step.action ? (
                  <Button
                    title={step.action.title}
                    icon={step.action.icon}
                    variant={step.action.variant}
                    compact
                    onPress={step.action.onPress}
                    loading={step.action.busy}
                  />
                ) : null}
              </View>
              {expanded && (
                <View style={{ marginLeft: 30, marginTop: 6 }}>
                  <Text style={stepLabel}>{step.kind === 'person' ? `1 · Send it to ${c.name}` : '1 · Give it to the device'}</Text>
                  {step.kind === 'person' ? (
                    <Button title={`Send to ${c.name}`} icon="share-outline" variant="secondary" compact onPress={() => sendTo(c)} />
                  ) : (
                    <Button title="Export as a file" icon="document-outline" variant="secondary" compact onPress={exportFile} />
                  )}
                  <Button title="Show as QR code" icon="qr-code-outline" variant="secondary" compact onPress={() => setQrOpen(true)} />
                  {step.kind === 'device' && hasNfc && nfcRoundTrip()}
                  <Text style={stepLabel}>2 · Bring the signed copy back</Text>
                  <Button title="Scan a signed copy" icon="scan-outline" variant="secondary" compact onPress={scanSigned} />
                  <Button
                    title="Paste a signed copy"
                    icon="clipboard-outline"
                    variant="secondary"
                    compact
                    onPress={() => setPasteOpen(true)}
                  />
                </View>
              )}
            </View>
          );
        })}
        {summary.overSigned && (
          <Text style={{ color: colors.warning, fontSize: 13, lineHeight: 19, marginTop: 8 }}>
            This has more signatures than {wallet.m} of {wallet.n} needs. Bitcoin rejects a
            multisig spend carrying extra signatures — remove one to broadcast.
          </Text>
        )}
      </Card>

      {pasteOpen && (
        <Card>
          <Label>Signed copy</Label>
          <Input
            placeholder="Paste the signed transaction here"
            value={pasteText}
            onChangeText={setPasteText}
            multiline
            style={{ minHeight: 90 }}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
          />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Button
                title="Cancel"
                variant="ghost"
                onPress={() => {
                  setPasteOpen(false);
                  setPasteText('');
                }}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button title="Merge signatures" onPress={mergePaste} disabled={!pasteText.trim()} />
            </View>
          </View>
        </Card>
      )}

      <TapsignerModal
        visible={!!cardSigner}
        cardName={cardSigner?.name ?? ''}
        busy={busy}
        onSign={signWithCard}
        onCancel={cancelCard}
      />

      <UsbDeviceModal
        visible={!!usbSigner}
        title={usbSigner && usbSigner !== 'any' ? `Sign with ${usbSigner.name}` : 'Sign with a USB device'}
        intro="Plug in the Ledger, Trezor or BitBox02 that holds one of this wallet’s keys. It will show the transaction for you to check before it signs."
        run={async ({ device, status }) => {
          const signed = await signPsbtWithDevice({
            device,
            wallet,
            psbtBase64: record.base64,
            fetchTx: fetchTxHex,
            expectFingerprint: usbSigner && usbSigner !== 'any' ? usbSigner.fingerprint : undefined,
            status,
          });
          return signed.base64;
        }}
        onDone={acceptDeviceSignatures}
        onCancel={() => setUsbSigner(null)}
      />

      {feeAlarm && (
        <Card style={{ borderColor: colors.danger, borderWidth: 1 }}>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Ionicons name="warning-outline" size={22} color={colors.danger} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.danger, fontWeight: '700', fontSize: 14 }}>
                Check this transaction carefully
              </Text>
              {foreignInputs && (
                <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 4 }}>
                  It spends coins this wallet cannot account for, so the amounts below may be
                  wrong. Only sign if you built it or fully trust its source.
                </Text>
              )}
              {feeAbsurd && (
                <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 4 }}>
                  The network fee is {formatSats(summary.fee)} —{' '}
                  {Math.round(summary.feeRatio * 100)}% of what is being spent. That is unusually
                  high; a bad transaction can burn funds as fees.
                </Text>
              )}
            </View>
          </View>
        </Card>
      )}

      <SectionTitle>Sending</SectionTitle>
      <Card>
        <TouchableOpacity
          onPress={() => {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            setOutputsOpen(!outputsOpen);
          }}
          activeOpacity={0.6}
        >
          {/* The summary answers the only question that matters at a glance:
              how much is leaving, to whom, and what it costs. */}
          {payments.map((o, i) => (
            <View key={i} style={{ paddingBottom: 10 }}>
              <Text
                style={{ fontSize: 18, fontWeight: '700', color: colors.ink, fontVariant: ['tabular-nums'] }}
              >
                {formatSats(o.value)}
              </Text>
              <Text style={{ color: colors.inkSoft, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                to {o.address}
              </Text>
            </View>
          ))}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ color: colors.inkSoft, fontSize: 13 }}>Network fee</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text
                style={{ fontWeight: '600', color: feeAbsurd ? colors.danger : colors.ink, fontSize: 13, fontVariant: ['tabular-nums'] }}
              >
                {formatSats(summary.fee)}
              </Text>
              <Ionicons
                name={outputsOpen ? 'chevron-up' : 'chevron-down'}
                size={16}
                color={colors.inkFaint}
              />
            </View>
          </View>
        </TouchableOpacity>

        {outputsOpen && (
          <>
            <Divider />
            <Text style={{ color: colors.inkFaint, fontSize: 12, marginBottom: 4 }}>
              Every output, including change returning to this wallet
            </Text>
            {summary.outputs.map((o, i) => (
              <View
                key={i}
                style={{ borderTopWidth: i > 0 ? 1 : 0, borderTopColor: colors.line, paddingVertical: 10 }}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={{ fontWeight: '600', color: colors.ink, fontVariant: ['tabular-nums'] }}>
                    {formatSats(o.value)}
                  </Text>
                  {o.isChange && <Tag text="Change" tone="success" />}
                </View>
                <Text style={{ color: colors.inkSoft, fontSize: 12, marginTop: 3 }} selectable>
                  {o.address}
                </Text>
              </View>
            ))}
            <Divider />
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
              <Text style={{ color: colors.inkSoft, fontSize: 13 }}>
                Spending {summary.numInputs} coin{summary.numInputs === 1 ? '' : 's'}
              </Text>
              <Text style={{ color: colors.inkSoft, fontSize: 13, fontVariant: ['tabular-nums'] }}>
                {formatSats(summary.totalIn)}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
              <Text style={{ color: colors.inkSoft, fontSize: 13 }}>Returning as change</Text>
              <Text style={{ color: colors.inkSoft, fontSize: 13, fontVariant: ['tabular-nums'] }}>
                {formatSats(changeTotal)}
              </Text>
            </View>
          </>
        )}
      </Card>

      {ready && <Button title="Broadcast" icon="radio-outline" large onPress={broadcast} loading={busy} />}
      {broadcastFailed && !explorerIsPublic() && (
        <Card>
          <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19 }}>
            Your own server refused this transaction. You can send it through mempool.space
            instead — the transaction becomes public either way, but that hands a third party your
            IP address and the transaction a moment before the network sees it.
          </Text>
          <Button
            title="Broadcast via mempool.space"
            icon="cloud-upload-outline"
            variant="secondary"
            onPress={broadcastViaFallback}
            loading={busy}
          />
        </Card>
      )}

      <Button
        title={moreOpen ? 'Fewer options' : ready ? 'Other options' : 'Other ways to sign or share'}
        icon={moreOpen ? 'chevron-up' : 'chevron-down'}
        variant="ghost"
        onPress={() => {
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          setMoreOpen(!moreOpen);
        }}
      />
      {moreOpen && (
        <>
          <Button title="Export as a file" icon="document-outline" variant="secondary" onPress={exportFile} />
          <Button title="Share as text" icon="share-outline" variant="secondary" onPress={share} />
          {hasUsb && !ready && (
            <Button
              title="Sign with a USB device"
              icon="hardware-chip-outline"
              variant="secondary"
              onPress={() => setUsbSigner('any')}
            />
          )}
          {hasNfc && nfcRoundTrip()}
          <Button title="Show as QR code" icon="qr-code-outline" variant="secondary" onPress={() => setQrOpen(true)} />
          <Button title="Scan a signed copy" icon="scan-outline" variant="secondary" onPress={scanSigned} />
          <Button
            title="Paste a signed copy"
            icon="clipboard-outline"
            variant="secondary"
            onPress={() => setPasteOpen(true)}
          />
          {group && (
            <Button title="Share with the group again" icon="radio-outline" variant="secondary" onPress={sendToGroup} />
          )}
        </>
      )}
      <AnimatedQrModal
        visible={qrOpen}
        onClose={() => setQrOpen(false)}
        base64={record.base64}
        title={record.memo ?? 'Transaction'}
      />

      <Button
        title="Discard transaction"
        icon="trash-outline"
        variant="danger"
        onPress={() =>
          Alert.alert('Discard this transaction?', 'No funds move — this only deletes the draft.', [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Discard',
              style: 'destructive',
              onPress: async () => {
                await removePendingTx(record.id);
                navigation.goBack();
              },
            },
          ])
        }
      />
    </Screen>
  );
}
