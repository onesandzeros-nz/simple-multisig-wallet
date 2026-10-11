import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Input, Label } from '../components/ui';
import { CoinControlModal, outpointOf } from '../components/CoinControlModal';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { colors, radius, themeKey } from '../theme';
import { showError } from '../lib/errors';
import { useStore, newId } from '../lib/store';
import { formatSats, isValidAddress } from '../lib/bitcoin';
import { buildPsbt, BuildResult } from '../lib/wallet';
import { getCached, getSnapshot } from '../lib/walletCache';
import { fetchFees, RecommendedFees } from '../lib/chain';
import { parsePaymentTarget } from '../lib/bip21';
import { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Send'>;

/** One decision per screen, in the order a person makes them. */
type Step = 'recipient' | 'amount' | 'speed' | 'review';
const STEP_ORDER: Step[] = ['recipient', 'amount', 'speed', 'review'];
const STEP_TITLE: Record<Step, string> = {
  recipient: 'Send to',
  amount: 'Amount',
  speed: 'Speed',
  review: 'Review',
};

type Speed = 'fast' | 'medium' | 'slow' | 'custom';
const SPEEDS: { key: Speed; label: string; when: string }[] = [
  { key: 'fast', label: 'Fast', when: 'About 10 minutes' },
  { key: 'medium', label: 'Standard', when: 'About 30 minutes' },
  { key: 'slow', label: 'Slow', when: 'An hour or more' },
  { key: 'custom', label: 'Custom', when: 'Set your own fee rate' },
];

/** Below this, most nodes will not relay the transaction. */
const MIN_RELAY_RATE = 1;
const SATS_PER_BTC = 100_000_000;

/** Grouped digits, so a big number stays readable at a glance. */
function groupDigits(value: string): string {
  const [whole, fraction] = value.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

export default function SendScreen({ navigation, route }: Props) {
  const { wallets, savePendingTx } = useStore();
  const wallet = wallets.find((w) => w.id === route.params.walletId);
  const insets = useSafeAreaInsets();
  const styles = React.useMemo(makeStyles, [themeKey()]);

  const [step, setStep] = React.useState<Step>('recipient');
  const [address, setAddress] = React.useState('');
  const [scannedLabel, setScannedLabel] = React.useState<string | null>(null);
  const [entry, setEntry] = React.useState('');
  const [unit, setUnit] = React.useState<'sats' | 'btc'>('sats');
  const [sendMax, setSendMax] = React.useState(false);
  const [speed, setSpeed] = React.useState<Speed>('medium');
  const [customRate, setCustomRate] = React.useState('');
  const [fees, setFees] = React.useState<RecommendedFees | null>(null);
  const [preview, setPreview] = React.useState<BuildResult | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [building, setBuilding] = React.useState(false);
  /** Optional note shared with the group so everyone knows what it is for. */
  const [note, setNote] = React.useState('');
  /** Chosen outpoints, or null while the wallet picks coins itself. */
  const [coins, setCoins] = React.useState<string[] | null>(null);
  const [coinsOpen, setCoinsOpen] = React.useState(false);

  React.useEffect(() => {
    if (wallet) fetchFees(wallet.network).then(setFees).catch(() => {});
  }, [wallet?.id]);

  // A scanned QR may be a bare address or a full BIP21 payment link.
  React.useEffect(() => {
    const scanned = route.params?.scanned;
    if (!scanned) return;
    try {
      const target = parsePaymentTarget(scanned);
      setAddress(target.address);
      if (target.amountSats !== undefined && target.amountSats > 0) {
        setSendMax(false);
        setUnit('sats');
        setEntry(String(target.amountSats));
      }
      setScannedLabel(target.label ?? target.message ?? null);
    } catch (e: any) {
      showError('send:scan', e);
    }
  }, [route.params?.scanned]);

  // Stepping back within the flow, rather than straight out of it.
  const goBack = React.useCallback(() => {
    setStep((current) => {
      const i = STEP_ORDER.indexOf(current);
      if (i <= 0) {
        navigation.goBack();
        return current;
      }
      return STEP_ORDER[i - 1];
    });
  }, [navigation]);

  React.useLayoutEffect(() => {
    navigation.setOptions({
      title: STEP_TITLE[step],
      headerLeft: () => (
        <TouchableOpacity onPress={goBack} hitSlop={12}>
          <Ionicons name="chevron-back" size={24} color={colors.ink} />
        </TouchableOpacity>
      ),
    });
  }, [navigation, step, goBack]);

  if (!wallet) return null;

  const customValue = parseFloat(customRate);
  const customOk = Number.isFinite(customValue) && customValue > 0;
  const rateFor = (s: Speed): number => {
    if (s === 'custom') return customOk ? customValue : 0;
    return fees ? { fast: fees.fastestFee, medium: fees.halfHourFee, slow: fees.economyFee }[s] : 5;
  };
  const feeRate = rateFor(speed);
  const rateOk = feeRate > 0;

  const cachedSnapshot = getCached(wallet.id)?.snapshot;
  const allCoins = cachedSnapshot?.utxos ?? [];
  const chosenCoins = coins === null ? allCoins : allCoins.filter((u) => coins.includes(outpointOf(u)));
  // What this transaction can draw on: the chosen coins, or the whole balance.
  const available = cachedSnapshot
    ? coins === null
      ? cachedSnapshot.confirmedSats + cachedSnapshot.unconfirmedSats
      : chosenCoins.reduce((sum, u) => sum + u.value, 0)
    : null;
  // Spending a coin still in the mempool chains this transaction to its
  // parent: legal, but some nodes refuse it and it cannot confirm first.
  const onlyUnconfirmed =
    !!cachedSnapshot &&
    cachedSnapshot.utxos.length > 0 &&
    cachedSnapshot.utxos.every((u) => !u.confirmed);

  const addressOk = address.trim().length > 0 && isValidAddress(address, wallet.network);
  const addressWrong = address.trim().length > 0 && !addressOk;

  const amountSats =
    unit === 'sats'
      ? Math.round(parseFloat(entry || '0'))
      : Math.round(parseFloat(entry || '0') * SATS_PER_BTC);
  const amountOk = sendMax || amountSats > 0;

  // --- amount keypad ---------------------------------------------------------

  /** Sats a typed string would mean, for checking it against what we hold. */
  const satsOf = (text: string): number =>
    unit === 'sats'
      ? Math.round(parseFloat(text || '0'))
      : Math.round(parseFloat(text || '0') * SATS_PER_BTC);

  /** An amount in whichever unit is selected — so the top line follows the keypad. */
  const formatUnit = (sats: number): string =>
    unit === 'btc'
      ? `${(sats / SATS_PER_BTC).toFixed(8).replace(/0+$/, '').replace(/\.$/, '') || '0'} BTC`
      : `${groupDigits(String(sats))} sats`;

  const press = (key: string) => {
    setSendMax(false);
    setEntry((current) => {
      if (key === 'back') return current.slice(0, -1);
      if (key === '.') {
        if (unit === 'sats' || current.includes('.')) return current;
        return current === '' ? '0.' : `${current}.`;
      }
      // No leading zeros, and BTC stops at satoshi precision.
      if (current === '0') return key;
      const [, fraction] = current.split('.');
      if (unit === 'btc' && fraction !== undefined && fraction.length >= 8) return current;
      if (unit === 'sats' && current.length >= 12) return current;
      const next = current + key;
      // There is no point letting someone type past what the coins hold.
      if (available !== null && satsOf(next) > available) return current;
      return next;
    });
  };

  const swapUnit = () => {
    setUnit((current) => {
      if (sendMax) return current === 'sats' ? 'btc' : 'sats';
      const sats = amountSats;
      if (current === 'sats') {
        setEntry(sats === 0 ? '' : (sats / SATS_PER_BTC).toFixed(8).replace(/0+$/, '').replace(/\.$/, ''));
        return 'btc';
      }
      setEntry(sats === 0 ? '' : String(sats));
      return 'sats';
    });
  };

  const displayValue = sendMax
    ? 'Everything'
    : groupDigits(entry === '' ? '0' : entry);
  const secondary = sendMax
    ? available !== null
      ? `${formatSats(available)} minus the fee`
      : 'The whole balance, minus the fee'
    : unit === 'sats'
      ? `${(amountSats / SATS_PER_BTC).toFixed(8)} BTC`
      : `${groupDigits(String(amountSats))} sats`;

  // --- review ----------------------------------------------------------------

  const buildPreview = async () => {
    setPreview(null);
    setPreviewError(null);
    setStep('review');
    try {
      const { snapshot } = await getSnapshot(wallet);
      setPreview(
        buildPsbt(wallet, snapshot, address.trim(), sendMax ? 0 : amountSats, feeRate, sendMax, coins ?? undefined)
      );
    } catch (e: any) {
      console.error(`[send:preview] ${e.message ?? e}`);
      setPreviewError(e.message ?? String(e));
    }
  };

  const confirm = async () => {
    if (!preview) return;
    setBuilding(true);
    try {
      const id = newId();
      const sentValue = preview.psbt.txOutputs[0].value;
      await savePendingTx({
        id,
        walletId: wallet.id,
        base64: preview.psbt.toBase64(),
        // The user's note when they wrote one, else a plain summary. Either way
        // it travels with the transaction to the other group members.
        memo: note.trim() || `Send ${formatSats(sentValue)} to ${address.trim().slice(0, 12)}…`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      navigation.replace('Psbt', { walletId: wallet.id, pendingId: id });
    } catch (e: any) {
      showError('send:build', e);
    } finally {
      setBuilding(false);
    }
  };

  // --- steps -----------------------------------------------------------------

  /** Content scrolls; the primary action is pinned above the safe area. */
  const StepFrame = ({ children, action }: { children: React.ReactNode; action: React.ReactNode }) => (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <KeyboardAwareScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 20, paddingBottom: 24 }}
        bottomOffset={20}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </KeyboardAwareScrollView>
      <View style={[styles.footer, { paddingBottom: 16 + insets.bottom }]}>{action}</View>
    </View>
  );

  if (step === 'recipient') {
    return (
      <StepFrame
        action={
          <Button title="Continue" large onPress={() => setStep('amount')} disabled={!addressOk} />
        }
      >
        <Text style={styles.prompt}>Where is it going?</Text>
        <Input
          placeholder={wallet.network === 'mainnet' ? 'bc1q…' : 'tb1q…'}
          value={address}
          onChangeText={setAddress}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          style={{ minHeight: 88, fontSize: 16 }}
        />
        {addressWrong && (
          <Text style={styles.error}>This isn't a valid {wallet.network} address.</Text>
        )}
        {scannedLabel && <Text style={styles.hint}>Paying {scannedLabel}</Text>}
        <Button
          title="Scan a QR code"
          icon="qr-code-outline"
          variant="secondary"
          onPress={() => navigation.navigate('ScanQR', { returnTo: 'Send', walletId: wallet.id })}
        />
      </StepFrame>
    );
  }

  if (step === 'amount') {
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'];
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <View style={styles.amountArea}>
          {available !== null && (
            <TouchableOpacity
              onPress={() => {
                setSendMax((m) => !m);
                setEntry('');
              }}
              activeOpacity={0.7}
              style={[styles.availableTap, sendMax && { backgroundColor: colors.ink }]}
            >
              <Text style={[styles.available, sendMax && { color: colors.onPrimary }]}>
                {formatUnit(available)} available
                {coins !== null ? ` in ${chosenCoins.length} coin${chosenCoins.length === 1 ? '' : 's'}` : ''}
                {sendMax ? '  ·  max' : ''}
              </Text>
            </TouchableOpacity>
          )}
          <View style={styles.amountRow}>
            <Text style={styles.amount} numberOfLines={1} adjustsFontSizeToFit>
              {displayValue}
            </Text>
            {!sendMax && (
              <Text style={styles.amountUnit}>{unit === 'sats' ? 'sat' : 'BTC'}</Text>
            )}
          </View>

          <TouchableOpacity onPress={swapUnit} activeOpacity={0.7} style={styles.swap}>
            <Ionicons name="swap-vertical-outline" size={14} color={colors.inkSoft} />
            <Text style={styles.swapText}>{secondary}</Text>
          </TouchableOpacity>

          {allCoins.length > 1 && (
            <View style={styles.pills}>
              <TouchableOpacity
                onPress={() => setCoinsOpen(true)}
                activeOpacity={0.7}
                style={[styles.maxPill, coins !== null && { backgroundColor: colors.ink }]}
              >
                <Text style={[styles.maxText, coins !== null && { color: colors.onPrimary }]}>
                  {coins === null ? 'Select coins' : `${chosenCoins.length} coins`}
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        <CoinControlModal
          visible={coinsOpen}
          coins={allCoins}
          selected={coins}
          onCancel={() => setCoinsOpen(false)}
          onConfirm={(picked) => {
            setCoinsOpen(false);
            setCoins(picked);
            // A smaller pot can make what is already typed unspendable.
            const limit =
              picked === null
                ? null
                : allCoins
                    .filter((u) => picked.includes(outpointOf(u)))
                    .reduce((sum, u) => sum + u.value, 0);
            if (limit !== null && satsOf(entry) > limit) setEntry('');
          }}
        />

        <View style={[styles.keypad, { paddingBottom: 8 + insets.bottom }]}>
          <View style={styles.keyRows}>
            {keys.map((k) => {
              const disabled = k === '.' && unit === 'sats';
              return (
                <TouchableOpacity
                  key={k}
                  style={styles.key}
                  activeOpacity={disabled ? 1 : 0.5}
                  onPress={disabled ? undefined : () => press(k)}
                  accessibilityLabel={k === 'back' ? 'Delete' : k}
                >
                  {k === 'back' ? (
                    <Ionicons name="backspace-outline" size={24} color={colors.ink} />
                  ) : (
                    <Text style={[styles.keyText, disabled && { color: colors.line }]}>{k}</Text>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
          <Button title="Continue" large onPress={() => setStep('speed')} disabled={!amountOk} />
        </View>
      </View>
    );
  }

  if (step === 'speed') {
    return (
      <StepFrame
        action={<Button title="Continue" large onPress={buildPreview} disabled={!rateOk} />}
      >
        <Text style={styles.prompt}>How fast should it confirm?</Text>
        {SPEEDS.map(({ key, label, when }) => {
          const active = speed === key;
          const rate = rateFor(key);
          return (
            <TouchableOpacity
              key={key}
              onPress={() => setSpeed(key)}
              activeOpacity={0.7}
              style={[styles.option, active && { borderColor: colors.ink }]}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.optionLabel}>{label}</Text>
                <Text style={styles.optionWhen}>{when}</Text>
              </View>
              {key !== 'custom' && fees && <Text style={styles.optionRate}>{rate} sat/vB</Text>}
              <Ionicons
                name={active ? 'radio-button-on' : 'radio-button-off'}
                size={20}
                color={active ? colors.ink : colors.inkFaint}
              />
            </TouchableOpacity>
          );
        })}

        {speed === 'custom' && (
          <View style={{ marginTop: 4 }}>
            <Label>Fee rate (sat/vB)</Label>
            <Input
              placeholder="e.g. 1.5, or 0.1 for a very slow spend"
              value={customRate}
              onChangeText={setCustomRate}
              keyboardType="decimal-pad"
              autoCorrect={false}
            />
            {customRate.trim() !== '' && !customOk && (
              <Text style={styles.error}>Enter a fee rate greater than zero.</Text>
            )}
            {customOk && customValue < MIN_RELAY_RATE && (
              <Text style={styles.warn}>
                Below {MIN_RELAY_RATE} sat/vB most nodes will not relay this transaction. It may
                never confirm unless your own node accepts it or you bump it later.
              </Text>
            )}
          </View>
        )}

      </StepFrame>
    );
  }

  // step === 'review'
  const sending = preview ? preview.psbt.txOutputs[0].value : amountSats;
  return (
    <StepFrame
      action={
        preview ? (
          <>
            <Button title="Confirm" large onPress={confirm} loading={building} />
            <Text style={styles.footnote}>
              Nothing moves yet. Next you collect {wallet.m} signature{wallet.m > 1 ? 's' : ''}.
            </Text>
          </>
        ) : (
          <Button title="Confirm" large onPress={() => {}} disabled />
        )
      }
    >
      {!preview && !previewError && (
        <View style={{ paddingVertical: 48, alignItems: 'center' }}>
          <ActivityIndicator color={colors.ink} />
          <Text style={styles.hint}>Working out the fee…</Text>
        </View>
      )}

      {previewError && (
        <>
          <Text style={styles.error}>{previewError}</Text>
          <Button title="Change the amount" variant="secondary" onPress={() => setStep('amount')} />
        </>
      )}

      {preview && (
        <>
          <Text style={styles.reviewAmount}>{formatSats(sending)}</Text>
          <Text style={styles.reviewToLabel}>to</Text>
          <Text style={styles.reviewTo} selectable>
            {address.trim()}
          </Text>

          <View style={styles.summary}>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Amount</Text>
              <Text style={styles.summaryValue}>{formatSats(sending)}</Text>
            </View>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Network fee</Text>
              <Text style={styles.summaryValue}>{formatSats(preview.feeSats)}</Text>
            </View>
            {coins !== null && (
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>Coins</Text>
                <Text style={styles.summaryValue}>
                  {preview.usedUtxos.length} chosen
                </Text>
              </View>
            )}
            <View style={[styles.summaryRow, { borderBottomWidth: 0 }]}>
              <Text style={[styles.summaryLabel, { color: colors.ink, fontWeight: '600' }]}>
                Total
              </Text>
              <Text style={[styles.summaryValue, { fontWeight: '700' }]}>
                {formatSats(sending + preview.feeSats)}
              </Text>
            </View>
          </View>

          {(onlyUnconfirmed || preview.spendsUnconfirmed) && (
            <Text style={styles.warn}>
              This spends a coin that is still unconfirmed, so it cannot confirm before its parent
              does — and some nodes will not relay it.
            </Text>
          )}

          <Label>What's this for?</Label>
          <Input
            placeholder="e.g. Rent for August — shared with the group"
            value={note}
            onChangeText={setNote}
            multiline
            style={{ minHeight: 54 }}
          />
          <Text style={styles.hint}>
            Optional. This note is sent with the transaction so every group member knows what it is
            about.
          </Text>
        </>
      )}
    </StepFrame>
  );
}

function makeStyles() {
  return StyleSheet.create({
    prompt: {
      fontSize: 22,
      fontWeight: '600',
      color: colors.ink,
      letterSpacing: -0.3,
      marginBottom: 16,
    },
    hint: { color: colors.inkSoft, fontSize: 15, marginTop: 8, textAlign: 'center', lineHeight: 21 },
    error: { color: colors.danger, fontSize: 15, marginTop: 8 },
    warn: { color: colors.warning, fontSize: 15, lineHeight: 21, marginTop: 8, marginBottom: 4 },

    // Amount step — the one place this screen raises its voice.
    amountArea: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
    available: { color: colors.inkSoft, fontSize: 18 },
    availableTap: { marginBottom: 20, paddingVertical: 7, paddingHorizontal: 16, borderRadius: 999 },
    amountRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'center',
      maxWidth: '100%',
    },
    amount: {
      fontSize: 60,
      fontWeight: '700',
      color: colors.ink,
      letterSpacing: -1.5,
      fontVariant: ['tabular-nums'],
      flexShrink: 1,
    },
    amountUnit: { color: colors.inkSoft, fontSize: 20, fontWeight: '600', marginLeft: 6 },
    swap: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      marginTop: 18,
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 999,
      backgroundColor: colors.chipBg,
    },
    swapText: { color: colors.inkSoft, fontSize: 16, fontVariant: ['tabular-nums'] },
    pills: { flexDirection: 'row', gap: 8, marginTop: 14 },
    maxPill: {
      paddingVertical: 9,
      paddingHorizontal: 16,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.line,
    },
    maxText: { color: colors.ink, fontSize: 16, fontWeight: '600' },

    keypad: { paddingHorizontal: 20, paddingTop: 4 },
    keyRows: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 },
    key: { width: '33.33%', height: 68, alignItems: 'center', justifyContent: 'center' },
    keyText: {
      fontSize: 34,
      fontWeight: '500',
      color: colors.ink,
      fontVariant: ['tabular-nums'],
    },

    // Speed step
    option: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radius.card,
      padding: 16,
      marginBottom: 10,
    },
    optionLabel: { fontSize: 16, fontWeight: '600', color: colors.ink },
    optionWhen: { fontSize: 13, color: colors.inkSoft, marginTop: 1 },
    optionRate: { fontSize: 13, color: colors.inkSoft, fontVariant: ['tabular-nums'] },

    // Review step
    reviewAmount: {
      fontSize: 40,
      fontWeight: '700',
      color: colors.ink,
      letterSpacing: -0.8,
      textAlign: 'center',
      marginTop: 8,
      fontVariant: ['tabular-nums'],
    },
    reviewToLabel: {
      color: colors.inkSoft,
      fontSize: 15,
      textAlign: 'center',
      marginTop: 8,
    },
    reviewTo: {
      color: colors.ink,
      fontSize: 17,
      lineHeight: 24,
      textAlign: 'center',
      marginTop: 4,
      marginBottom: 24,
    },
    summary: {
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radius.card,
      paddingHorizontal: 16,
      marginBottom: 12,
    },
    summaryRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 15,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    summaryLabel: { fontSize: 16, color: colors.inkSoft },
    summaryValue: { fontSize: 16, color: colors.ink, fontVariant: ['tabular-nums'] },
    footnote: { color: colors.inkFaint, fontSize: 13, textAlign: 'center', marginTop: 8 },
    footer: {
      paddingHorizontal: 20,
      paddingTop: 12,
      borderTopWidth: 1,
      borderTopColor: colors.line,
      backgroundColor: colors.bg,
    },
  });
}
