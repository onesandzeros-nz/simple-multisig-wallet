import React from 'react';
import { Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { Screen, Card, Button, Input, Label, Mono, Tag, EmptyState, IconName } from '../components/ui';
import { colors, radius } from '../theme';
import { showError } from '../lib/errors';
import { loadGroupSecret, useStore } from '../lib/store';
import { exportBackup } from '../lib/exportActions';
import { deriveAddress } from '../lib/bitcoin';
import { BackupVerdict, describeVerdict, GroupOnPhone, verifyBackupText } from '../lib/backupVerify';
import { recordExport } from '../lib/tutorial';
import { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'VerifyBackup'>;

/**
 * Does a backup describe this wallet? Scan the "Scan to restore" QR, open
 * the .txt, or paste it; the text is compared with the wallet on this phone
 * and the verdict shown. Nothing is imported — the only write is
 * backupVerifiedAt on the existing record, and only on a match.
 */
export default function VerifyBackupScreen({ navigation, route }: Props) {
  const { wallets, groups, keys, updateWallet } = useStore();
  // A pasted backup can carry the group invite: no screenshots here.
  usePreventScreenCapture();
  const wallet = wallets.find((w) => w.id === route.params.walletId);
  const group = groups.find((g) => g.walletId === wallet?.id);
  // The wallet's group, to check a backup's group invite against. A group
  // from before rotation is never put in a backup, so it is not expected.
  const [groupOnPhone, setGroupOnPhone] = React.useState<GroupOnPhone | null>(null);
  React.useEffect(() => {
    if (!group) return setGroupOnPhone(null);
    loadGroupSecret(group.id).then((secret) =>
      setGroupOnPhone(secret ? { secret, expected: group.rekey === true && !!group.coordinatorPubkey } : null)
    );
  }, [group?.id]);
  const [text, setText] = React.useState('');
  const [pasting, setPasting] = React.useState(false);
  const [verdict, setVerdict] = React.useState<BackupVerdict | null>(null);
  const [exporting, setExporting] = React.useState<'file' | 'pdf' | null>(null);
  // What already stamped backupVerifiedAt — the text plus the export it was
  // checked against — so re-checking writes nothing, but a different backup,
  // or the same one after a newer export, stamps again.
  const stampedRef = React.useRef<string | null>(null);

  const runCheck = async (candidate: string) => {
    if (!wallet) return;
    setText(candidate);
    const v = verifyBackupText(candidate, wallet, wallets, groupOnPhone);
    setVerdict(v);
    const stampKey = `${candidate}|${wallet.exportedAt ?? 0}`;
    if (v.status === 'match' && stampedRef.current !== stampKey) {
      try {
        await updateWallet(wallet.id, { backupVerifiedAt: Date.now() });
        stampedRef.current = stampKey;
      } catch (e: any) {
        showError('backup:verify', e);
      }
    }
  };

  // The QR scanner hands its assembled result back via route params.
  const scanned = route.params.scanned;
  React.useEffect(() => {
    if (!scanned) return;
    runCheck(scanned);
    // Consume it, so scanning the same code again after "Try another" is seen.
    navigation.setParams({ scanned: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanned]);

  const pickFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['text/plain', 'application/json', 'application/octet-stream', '*/*'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const content = await FileSystem.readAsStringAsync(result.assets[0].uri);
      await runCheck(content);
    } catch (e: any) {
      showError('backup:verify-file', e);
    }
  };

  const runExport = async (which: 'file' | 'pdf') => {
    if (!wallet) return;
    setExporting(which);
    try {
      const withGroup = await exportBackup(which, wallet, groups, keys);
      // Only count it once the share sheet has been through successfully.
      await updateWallet(wallet.id, recordExport(wallet, which, Date.now(), withGroup));
    } catch (e: any) {
      showError(`wallet:export-${which}`, e);
    } finally {
      setExporting(null);
    }
  };

  if (!wallet) {
    return (
      <Screen>
        <Card>
          <EmptyState icon="wallet-outline" text="This wallet is no longer on this phone." />
        </Card>
      </Screen>
    );
  }

  const copy = verdict ? describeVerdict(verdict, wallet) : null;
  const verdictIcon: IconName =
    copy?.tone === 'success' ? 'checkmark-circle' : copy?.tone === 'danger' ? 'close-circle' : 'alert-circle-outline';

  return (
    <Screen>
      <Card>
        <Text style={{ fontSize: 17, fontWeight: '600', color: colors.ink }}>Check a backup</Text>
        <Text style={{ color: colors.inkSoft, marginTop: 6, fontSize: 14, lineHeight: 20 }}>
          Scan the large "Scan to restore" QR on the printed backup (not the smaller key QRs), open the
          saved backup .txt, or paste its text. The app only checks that it describes this wallet —
          nothing is imported and no second copy of the wallet is created.
        </Text>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
          <View style={{ flex: 1 }}>
            <Button
              title="Scan QR"
              icon="qr-code-outline"
              variant="secondary"
              onPress={() => navigation.navigate('ScanQR', { returnTo: 'VerifyBackup', walletId: wallet.id })}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Button title="Open file" icon="document-outline" variant="secondary" onPress={pickFile} />
          </View>
        </View>
        <Button title="Paste" icon="clipboard-outline" variant="ghost" onPress={() => setPasting(!pasting)} />
        {pasting && (
          <>
            <Input
              placeholder={'wsh(sortedmulti(2,…))  or  "Policy: 2 of 3" config text'}
              value={text}
              onChangeText={setText}
              multiline
              style={{ minHeight: 120 }}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Button title="Check" onPress={() => runCheck(text)} disabled={!text.trim()} />
          </>
        )}
      </Card>

      {verdict && copy && (
        <>
          <Card style={{ borderColor: colors[copy.tone], borderWidth: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Ionicons name={verdictIcon} size={20} color={colors[copy.tone]} />
              <Text style={{ fontSize: 15, fontWeight: '600', color: colors.ink, flex: 1 }}>{copy.title}</Text>
            </View>
            {copy.lines.map((line, i) => (
              <Text key={i} style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: i === 0 ? 8 : 6 }}>
                {line}
              </Text>
            ))}

            {verdict.status === 'match' && (
              <>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 10 }}>
                  {wallet.cosigners.map((c) => (
                    <Tag key={c.xpub} text={c.fingerprint} tone="success" />
                  ))}
                </View>
                <Label>Receive #0</Label>
                <Mono text={deriveAddress(wallet, 0, 0).address} small />
                <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 4 }}>
                  The first address printed on the PDF should be this one.
                </Text>
                {verdict.originWarnings.length > 0 && (
                  <View
                    style={{
                      borderColor: colors.warning,
                      borderWidth: 1,
                      borderRadius: radius.control,
                      padding: 12,
                      marginTop: 12,
                    }}
                  >
                    {verdict.originWarnings.map((w, i) => (
                      <Text
                        key={i}
                        style={{ color: colors.warning, fontSize: 13, lineHeight: 19, marginTop: i === 0 ? 0 : 6 }}
                      >
                        {w}
                      </Text>
                    ))}
                  </View>
                )}
                <Button title="Done" onPress={() => navigation.goBack()} />
              </>
            )}
          </Card>

          {verdict.status !== 'match' && (
            <>
              {(verdict.status === 'mismatch' || verdict.status === 'unreadable') && (
                <>
              <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginLeft: 4, marginBottom: 4 }}>
                Make a fresh backup from this wallet, then check it again.
              </Text>
              <View style={{ flexDirection: 'row', gap: 10 }}>
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
                </>
              )}
              <Button
                title="Try another"
                variant="ghost"
                onPress={() => {
                  setText('');
                  setVerdict(null);
                }}
              />
            </>
          )}
        </>
      )}
    </Screen>
  );
}
