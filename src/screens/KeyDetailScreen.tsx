import React from 'react';
import { Alert, Share, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { Screen, Card, Button, SectionTitle, Tag, Row, Divider, Input, Label } from '../components/ui';
import { QrModal } from '../components/QrModal';
import { colors } from '../theme';
import { useStore, loadMnemonic } from '../lib/store';
import { confirmOwner } from '../lib/ownerCheck';
import { accountXpub, bip48Path, keyExpression } from '../lib/bitcoin';
import { showError } from '../lib/errors';
import {
  HEALTH_CHECK_OPTIONS,
  describeHealthCheck,
  healthCheckDays,
  healthCheckDue,
  healthCheckHint,
  mnemonicMatches,
  recordHealthCheck,
  setHealthCheckDays,
} from '../lib/keyHealth';
import { memberName } from '../lib/naming';
import { NetworkName } from '../lib/types';
import { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'KeyDetail'>;

export default function KeyDetailScreen({ navigation, route }: Props) {
  const { keys, wallets, settings, removeKey, updateKey } = useStore();
  // The recovery phrase may be on this screen, shown or being typed in to
  // check: no screenshots or recordings, and nothing in the app switcher.
  usePreventScreenCapture();
  const k = keys.find((key) => key.id === route.params.keyId);
  // A phone key made in testnet mode carries the testnet path; its public
  // key has to be shared for the same network or the two will not match.
  const network: NetworkName = k?.network ?? (k?.path === bip48Path('testnet') ? 'testnet' : 'mainnet');
  const [xpub, setXpub] = React.useState<string | null>(k?.xpub ?? null);
  const [showWords, setShowWords] = React.useState<string | null>(null);
  const [qrOpen, setQrOpen] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const [phrase, setPhrase] = React.useState('');
  const [verifying, setVerifying] = React.useState(false);
  const [name, setName] = React.useState(k?.name ?? '');
  const [renaming, setRenaming] = React.useState(false);

  React.useEffect(() => {
    navigation.setOptions({ title: k?.name ?? 'Key' });
  }, [k?.name]);

  React.useEffect(() => {
    if (k?.type === 'local' && !xpub) {
      loadMnemonic(k.id).then((m) => {
        if (m) setXpub(accountXpub(m, network));
      });
    }
  }, [k?.id]);

  if (!k) return null;

  const usedByWallets = wallets.filter((w) => w.cosigners.some((c) => c.keyId === k.id));
  const path = k.path ?? bip48Path(network);
  const shownAs = memberName(settings.userName, k);
  const now = Date.now();
  const due = healthCheckDue(k, now);
  const intervalDays = healthCheckDays(k);

  // A phone key is checked against the written backup: the words typed in
  // must be this key's phrase. The phone's copy is only read to compare.
  const verifyPhrase = async () => {
    setVerifying(true);
    try {
      const stored = await loadMnemonic(k.id);
      if (!stored) throw new Error('The recovery phrase is missing from this phone.');
      if (!mnemonicMatches(phrase, stored)) {
        Alert.alert(
          'Does not match',
          'The words you typed are not this key’s recovery phrase. Check the order and spelling on your written backup — if it really differs, the backup is wrong and this key needs a new one.'
        );
        return;
      }
      await updateKey(k.id, recordHealthCheck(Date.now()));
      setPhrase('');
      setChecking(false);
      Alert.alert('Key checked', 'Your written backup matches. The next reminder starts from today.');
    } catch (e: any) {
      showError('key:health-check', e);
    } finally {
      setVerifying(false);
    }
  };

  const newName = name.trim();

  const rename = async () => {
    setRenaming(true);
    try {
      await updateKey(k.id, { name: newName });
      setName(newName);
    } catch (e: any) {
      showError('key:rename', e);
    } finally {
      setRenaming(false);
    }
  };

  const confirmDelete = () => {
    Alert.alert(
      'Delete this key?',
      usedByWallets.length > 0
        ? `This key is used by ${usedByWallets.length} wallet${usedByWallets.length === 1 ? '' : 's'}. Deleting it may leave you unable to sign. Are you sure?`
        : k.type === 'local'
          ? 'The recovery phrase will be erased from this phone. Without a written backup the key is gone for good.'
          : 'You can re-import it later from your hardware wallet.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await removeKey(k.id);
            navigation.goBack();
          },
        },
      ]
    );
  };

  return (
    <Screen>
      <Card>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 4 }}>
          <Tag text={k.type === 'local' ? 'This phone' : 'Hardware wallet'} />
          {k.network === 'testnet' && <Tag text="Testnet" tone="accent" />}
          {usedByWallets.length > 0 && <Tag text="In use" tone="success" />}
        </View>
        <Button
          title="Share public key"
          icon="share-outline"
          onPress={() =>
            Share.share({
              message: keyExpression({ fingerprint: k.fingerprint, path, xpub: xpub! }),
            })
          }
          disabled={!xpub}
        />
        <Button
          title="Show as QR code"
          icon="qr-code-outline"
          variant="secondary"
          onPress={() => setQrOpen(true)}
          disabled={!xpub}
        />
        {xpub && (
          <QrModal
            visible={qrOpen}
            onClose={() => setQrOpen(false)}
            data={keyExpression({ fingerprint: k.fingerprint, path, xpub })}
            title={k.name}
            caption="Another group member can scan this from their Import Key screen."
          />
        )}
        <Row
          icon="code-slash-outline"
          title="Technical details"
          subtitle="Fingerprint, derivation path, xpub"
          onPress={() => navigation.navigate('KeyTechnical', { keyId: k.id })}
        />
      </Card>

      <SectionTitle>Used by</SectionTitle>
      <Card>
        {usedByWallets.length === 0 && (
          <Text style={{ color: colors.inkSoft, fontSize: 14, paddingVertical: 4 }}>
            This key is not part of any wallet yet.
          </Text>
        )}
        {usedByWallets.map((w, i) => (
          <View key={w.id}>
            {i > 0 && <Divider />}
            <Row
              icon="wallet-outline"
              title={w.name}
              subtitle={`${w.m} of ${w.n}`}
              onPress={() => navigation.navigate('Wallet', { walletId: w.id })}
            />
          </View>
        ))}
      </Card>

      <SectionTitle>Health check</SectionTitle>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Ionicons
            name={due ? 'alert-circle-outline' : 'shield-checkmark-outline'}
            size={20}
            color={due ? colors.warning : intervalDays === 0 ? colors.inkFaint : colors.success}
          />
          <Text style={{ fontSize: 15, fontWeight: '600', color: colors.ink, flex: 1 }}>
            {due ? 'Check due' : intervalDays === 0 ? 'Reminders off' : 'No check due'}
          </Text>
        </View>
        <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 6 }}>
          {describeHealthCheck(k, now)}
        </Text>
        <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 6 }}>{healthCheckHint(k)}</Text>
        {k.type === 'local' ? (
          checking ? (
            <>
              <Label>Recovery phrase from your written backup</Label>
              <Input
                placeholder="word1 word2 … word12"
                value={phrase}
                onChangeText={setPhrase}
                autoCapitalize="none"
                autoCorrect={false}
                multiline
                style={{ minHeight: 90 }}
              />
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <Button
                    title="Cancel"
                    variant="ghost"
                    onPress={() => {
                      setChecking(false);
                      setPhrase('');
                    }}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Button
                    title="Verify"
                    icon="checkmark-outline"
                    onPress={verifyPhrase}
                    loading={verifying}
                    disabled={!phrase.trim()}
                  />
                </View>
              </View>
            </>
          ) : (
            <Button
              title="Check this key"
              icon="shield-checkmark-outline"
              variant={due ? 'primary' : 'secondary'}
              onPress={() => setChecking(true)}
            />
          )
        ) : (
          <Button
            title="Check this key"
            icon="shield-checkmark-outline"
            variant={due ? 'primary' : 'secondary'}
            onPress={() => navigation.navigate('ImportKey', { verifyKeyId: k.id })}
          />
        )}
        <Label>Remind me every</Label>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {HEALTH_CHECK_OPTIONS.map((o) => {
            const active = o.days === intervalDays;
            return (
              <TouchableOpacity
                key={o.days}
                onPress={() => updateKey(k.id, setHealthCheckDays(o.days))}
                activeOpacity={0.7}
                style={{
                  paddingVertical: 8,
                  paddingHorizontal: 14,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: active ? colors.ink : colors.line,
                  backgroundColor: active ? colors.ink : colors.card,
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: '600', color: active ? colors.onPrimary : colors.ink }}>
                  {o.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <Text style={{ color: colors.inkFaint, fontSize: 12, lineHeight: 17, marginTop: 8 }}>
          A due check shows a badge on this key and on the Keys tab until you pass it.
        </Text>
      </Card>

      {k.type === 'local' && (
        <>
          <SectionTitle>Shown to others</SectionTitle>
          <Card>
            <Row
              icon="person-outline"
              title={`Others see you as ${shownAs}`}
              subtitle="Your name in shared wallets and group chats. Change it in Settings."
              onPress={() => navigation.navigate('Tabs', { screen: 'SettingsTab' })}
            />
          </Card>
        </>
      )}

      <SectionTitle>Name</SectionTitle>
      <Card>
        <Label>Key name</Label>
        <Input
          placeholder={k.type === 'local' ? "e.g. Rob's phone" : "e.g. Alice's hardware wallet"}
          value={name}
          onChangeText={setName}
          onSubmitEditing={() => {
            if (newName && newName !== k.name) rename();
          }}
          returnKeyType="done"
        />
        <Text style={{ color: colors.inkSoft, fontSize: 12, marginTop: 6, lineHeight: 17 }}>
          What this phone calls the key, here and in the wallets that use it. The key itself
          does not change.
        </Text>
        <Button
          title="Save name"
          icon="checkmark-outline"
          variant="secondary"
          onPress={rename}
          loading={renaming}
          disabled={!newName || newName === k.name}
        />
      </Card>

      <SectionTitle>Options</SectionTitle>
      {k.type === 'local' && (
        <Card>
          {showWords ? (
            <View style={{ backgroundColor: colors.warningBg, borderRadius: 12, padding: 14, marginBottom: 8 }}>
              <Text style={{ fontWeight: '600', color: colors.warning, marginBottom: 6, fontSize: 13 }}>
                Recovery phrase — never share it with anyone
              </Text>
              <Text style={{ fontSize: 15, color: colors.ink, lineHeight: 24 }} selectable>
                {showWords}
              </Text>
            </View>
          ) : (
            <Text style={{ color: colors.inkSoft, fontSize: 13, marginBottom: 4 }}>
              The recovery phrase is stored in this phone's secure keystore.
            </Text>
          )}
          <Button
            title={showWords ? 'Hide recovery phrase' : 'Show recovery phrase'}
            icon={showWords ? 'eye-off-outline' : 'eye-outline'}
            variant="secondary"
            onPress={async () => {
              if (showWords) return setShowWords(null);
              if (!(await confirmOwner('Confirm it is you to show the recovery phrase'))) return;
              const m = await loadMnemonic(k.id);
              if (m) setShowWords(m);
            }}
          />
        </Card>
      )}
      <Button title="Delete key" icon="trash-outline" variant="danger" onPress={confirmDelete} />
    </Screen>
  );
}
