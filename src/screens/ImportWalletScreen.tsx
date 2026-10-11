import React from 'react';
import { Alert, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { Screen, Card, Button, Input, Label, Tag, SectionTitle } from '../components/ui';
import { colors } from '../theme';
import { showError } from '../lib/errors';
import { useStore, newId, loadMnemonic } from '../lib/store';
import { accountXpub } from '../lib/bitcoin';
import { parseWalletImportText } from '../lib/walletImport';
import { groupFromBackupText, restoreMismatch } from '../lib/groupBackup';
import { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'ImportWallet'>;

export default function ImportWalletScreen({ navigation, route }: Props) {
  const { keys, wallets, addWallet } = useStore();
  const [text, setText] = React.useState('');
  const [name, setName] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  // The QR scanner hands its assembled result back via route params.
  React.useEffect(() => {
    if (route.params?.scanned) setText(route.params.scanned);
  }, [route.params?.scanned]);

  const pickFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['text/plain', 'application/json', 'application/octet-stream', '*/*'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const content = await FileSystem.readAsStringAsync(result.assets[0].uri);
      setText(content);
    } catch (e: any) {
      showError('wallet:import-file', e);
    }
  };

  // Live preview of whatever is pasted, scanned or loaded.
  const preview = React.useMemo(() => {
    if (!text.trim()) return null;
    try {
      const parsed = parseWalletImportText(text);
      // A group wallet's backup file carries its group (RECOVERY-DESIGN.md) —
      // only offered when it describes this very wallet's policy.
      const carried = groupFromBackupText(text);
      const group = carried && !restoreMismatch(carried.invite, parsed) ? carried : null;
      return { parsed, group, error: null as string | null };
    } catch (e: any) {
      return { parsed: null, group: null, error: e.message ?? String(e) };
    }
  }, [text]);

  const importWallet = async () => {
    setSaving(true);
    try {
      const parsed = parseWalletImportText(text);

      // Link cosigners to keys already on this phone (so signing works and
      // familiar names show up). Imported keys match by xpub directly;
      // local keys by deriving their account xpub for the parsed network.
      const xpubToKey = new Map<string, { id: string; name: string }>();
      for (const k of keys) {
        if (k.type === 'imported' && k.xpub) xpubToKey.set(k.xpub, { id: k.id, name: k.name });
        if (k.type === 'local') {
          const mnemonic = await loadMnemonic(k.id);
          if (mnemonic) xpubToKey.set(accountXpub(mnemonic, parsed.network), { id: k.id, name: k.name });
        }
      }
      const cosigners = parsed.cosigners.map((c) => {
        const known = xpubToKey.get(c.xpub);
        return known ? { ...c, keyId: known.id, name: known.name } : c;
      });

      const walletName = name.trim() || parsed.name || `${parsed.m} of ${parsed.n} wallet`;
      if (wallets.some((w) => w.cosigners.map((c) => c.xpub).join() === cosigners.map((c) => c.xpub).join() && w.m === parsed.m)) {
        throw new Error('A wallet with these exact keys and policy already exists on this phone.');
      }

      const wallet = {
        id: newId(),
        kind: 'private' as const,
        name: walletName,
        m: parsed.m,
        n: parsed.n,
        network: parsed.network,
        scriptType: 'P2WSH' as const,
        cosigners,
        createdAt: Date.now(),
      };
      await addWallet(wallet);
      const group = preview?.group;
      if (!group) {
        navigation.replace('Wallet', { walletId: wallet.id });
        return;
      }
      Alert.alert(
        'Rejoin the group?',
        `This backup also carries the wallet's group, "${group.invite.name}". Rejoin it now? You can also do it later from the wallet's Manage screen.`,
        [
          { text: 'Later', style: 'cancel', onPress: () => navigation.replace('Wallet', { walletId: wallet.id }) },
          {
            text: 'Rejoin',
            onPress: () =>
              navigation.replace('JoinGroup', {
                mode: 'restore',
                walletId: wallet.id,
                scanned: group.text,
                identityFingerprint: group.identityFingerprint,
              }),
          },
        ]
      );
    } catch (e: any) {
      showError('wallet:import', e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen>
      <Card>
        <Text style={{ fontSize: 17, fontWeight: '600', color: colors.ink }}>Import a wallet</Text>
        <Text style={{ color: colors.inkSoft, marginTop: 6, fontSize: 14, lineHeight: 20 }}>
          Import an output descriptor, a wallet config file, or a JSON export (Specter, Electrum)
          from this app, Sparrow, Coldcard, Specter or Nunchuk — by pasting, scanning QR codes, or
          opening a file. All of these contain only public keys.
        </Text>
      </Card>

      <Card>
        <Label>Descriptor, config file or JSON</Label>
        <Input
          placeholder={'wsh(sortedmulti(2,[…]xpub…,…))  or  "Policy: 2 of 3" config text'}
          value={text}
          onChangeText={setText}
          multiline
          style={{ minHeight: 120 }}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <View style={{ flex: 1 }}>
            <Button
              title="Scan QR"
              icon="qr-code-outline"
              variant="secondary"
              onPress={() => navigation.navigate('ScanQR', { returnTo: 'ImportWallet' })}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Button title="Open file" icon="document-outline" variant="secondary" onPress={pickFile} />
          </View>
        </View>
        <Label>Wallet name (optional)</Label>
        <Input placeholder="e.g. Family savings" value={name} onChangeText={setName} />
      </Card>

      {preview?.error && (
        <Card>
          <Text style={{ color: colors.danger, fontSize: 13, lineHeight: 19 }}>{preview.error}</Text>
        </Card>
      )}
      {preview?.parsed && (
        <>
          <SectionTitle>Preview</SectionTitle>
          <Card>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
              <Tag text={`${preview.parsed.m} of ${preview.parsed.n}`} />
              {preview.parsed.network === 'testnet' && <Tag text="Testnet" tone="accent" />}
              {preview.group && <Tag text={`Group · ${preview.group.invite.name}`} tone="success" />}
            </View>
            {preview.parsed.cosigners.map((c) => {
              const known = keys.find(
                (k) => k.xpub === c.xpub || (k.fingerprint === c.fingerprint && k.type === 'local')
              );
              return (
                <View
                  key={c.xpub}
                  style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6 }}
                >
                  <Text style={{ color: colors.ink, fontSize: 14 }}>{known?.name ?? c.name}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={{ color: colors.inkFaint, fontSize: 12 }}>{c.fingerprint}</Text>
                    {known && <Tag text="On this phone" tone="success" />}
                  </View>
                </View>
              );
            })}
          </Card>
        </>
      )}

      <Button title="Import wallet" onPress={importWallet} disabled={!preview?.parsed} loading={saving} />
    </Screen>
  );
}
