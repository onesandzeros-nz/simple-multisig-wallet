import React from 'react';
import { Share, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Screen, Card, Button, SectionTitle, Label, Mono, Tag } from '../components/ui';
import { colors } from '../theme';
import { useStore } from '../lib/store';
import { showError } from '../lib/errors';
import { exportWalletToCard } from '../lib/exportActions';
import { nfcAvailable } from '../lib/nfc';
import { recordExport } from '../lib/tutorial';
import { walletDescriptor, walletConfigFile, deriveAddress } from '../lib/bitcoin';
import { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Advanced'>;

export default function AdvancedScreen({ route }: Props) {
  const { wallets, keys, updateWallet } = useStore();
  const [hasNfc, setHasNfc] = React.useState(false);
  const [sending, setSending] = React.useState(false);

  React.useEffect(() => {
    nfcAvailable().then(setHasNfc);
  }, []);
  const wallet = wallets.find((w) => w.id === route.params.walletId);
  if (!wallet) return null;

  const descriptor = walletDescriptor(wallet);
  const receiveDescriptor = walletDescriptor(wallet, 0);
  const changeDescriptor = walletDescriptor(wallet, 1);
  const configFile = walletConfigFile(wallet);

  return (
    <Screen>
      <Card>
        <Text style={{ fontSize: 17, fontWeight: '600', color: colors.ink }}>How this wallet works</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 10 }}>
          <Tag text={`Policy ${wallet.m} of ${wallet.n}`} />
          <Tag
            text={wallet.kind === 'group' ? 'Group coordinated (Nostr)' : 'Private (no relays)'}
            tone={wallet.kind === 'group' ? 'accent' : 'neutral'}
          />
          <Tag text="P2WSH · native segwit" />
          <Tag text="BIP67 sorted keys" />
          <Tag text={wallet.network} />
        </View>
        <Text style={{ color: colors.inkSoft, marginTop: 12, fontSize: 13, lineHeight: 19 }}>
          Addresses are derived from each cosigner's account xpub at{' '}
          <Text style={{ fontWeight: '600', color: colors.ink }}>account/branch/index</Text>, where
          branch 0 is receiving and branch 1 is change. Public keys are sorted (BIP67) before the
          multisig script is built, so any standards-compliant wallet derives identical addresses.
        </Text>
      </Card>

      <SectionTitle>Output descriptor</SectionTitle>
      <Card>
        <Label>Combined (BIP389 multipath)</Label>
        <Mono text={descriptor} small />
        <Label>Receive</Label>
        <Mono text={receiveDescriptor} small />
        <Label>Change</Label>
        <Mono text={changeDescriptor} small />
        <Button
          title="Export descriptor"
          icon="share-outline"
          variant="secondary"
          onPress={() => Share.share({ message: descriptor })}
        />
      </Card>

      <SectionTitle>Cosigners</SectionTitle>
      {wallet.cosigners.map((c) => {
        const held = keys.find((k) => k.id === c.keyId);
        return (
          <Card key={c.fingerprint}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ fontSize: 15, fontWeight: '600', color: colors.ink }}>{c.name}</Text>
              <Tag text={held?.type === 'local' ? 'This phone' : 'External'} />
            </View>
            <Label>Master fingerprint</Label>
            <Mono text={c.fingerprint} />
            <Label>Derivation path</Label>
            <Mono text={c.path} />
            <Label>Account xpub</Label>
            <Mono text={c.xpub} small />
          </Card>
        );
      })}

      <SectionTitle>Interoperability</SectionTitle>
      <Card>
        <Text style={{ color: colors.inkSoft, marginBottom: 10, fontSize: 13, lineHeight: 19 }}>
          This configuration file imports directly into Sparrow, Coldcard, Specter and Nunchuk.
          Every group member should keep a copy — it contains only public keys, no secrets.
        </Text>
        <Mono text={configFile} small />
        <Button
          title="Export wallet config"
          icon="share-outline"
          variant="secondary"
          onPress={() => Share.share({ message: configFile })}
        />
        {hasNfc && (
          <Button
            title={sending ? 'Hold against the Coldcard…' : 'Send to Coldcard (NFC)'}
            icon="radio-outline"
            variant="secondary"
            loading={sending}
            onPress={async () => {
              setSending(true);
              try {
                await exportWalletToCard(wallet);
                // Loading the wallet onto the signer ticks the checklist's
                // hardware step; it is not a backup, so exportedAt stays.
                await updateWallet(wallet.id, (w) => recordExport(w, 'nfc', Date.now()));
              } catch (e: any) {
                showError('wallet:export-nfc', e);
              } finally {
                setSending(false);
              }
            }}
          />
        )}
      </Card>

      <SectionTitle>First addresses</SectionTitle>
      <Card>
        <Text style={{ color: colors.inkSoft, marginBottom: 6, fontSize: 13, lineHeight: 19 }}>
          Compare these against another wallet application to verify the setup matches.
        </Text>
        {[0, 1, 2].map((i) => (
          <View key={i}>
            <Label>Receive #{i}</Label>
            <Mono text={deriveAddress(wallet, 0, i).address} small />
          </View>
        ))}
      </Card>
    </Screen>
  );
}
