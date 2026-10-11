import React from 'react';
import { Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { Screen, Card, SectionTitle } from '../components/ui';
import { IconName } from '../components/ui';
import { colors, radius } from '../theme';
import { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'WalletHelp'>;

function Explainer({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: radius.control,
            backgroundColor: colors.chipBg,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name={icon} size={21} color={colors.ink} />
        </View>
        <Text style={{ fontSize: 16, fontWeight: '600', color: colors.ink, flex: 1 }}>{title}</Text>
      </View>
      <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 10 }}>{body}</Text>
    </Card>
  );
}

export default function WalletHelpScreen(_props: Props) {
  return (
    <Screen>
      <Card>
        <Text style={{ fontSize: 17, fontWeight: '600', color: colors.ink }}>
          Which one is right for you?
        </Text>
        <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 8 }}>
          Every wallet here is multisig — spending it needs several keys, held by you or shared with
          other people. The choice below is about who holds the keys and how you all coordinate.
        </Text>
      </Card>

      <SectionTitle>Private or group?</SectionTitle>
      <Explainer
        icon="lock-closed-outline"
        title="Private wallet"
        body="Everything stays on this phone. You gather the keys yourself, and transactions travel however you choose — QR codes, files, or your own messaging apps. Nothing touches a relay. Best when you hold all the keys yourself, or when other members handed you their public keys in advance."
      />
      <Explainer
        icon="radio-outline"
        title="Group wallet"
        body="Members coordinate over Nostr relays. Keys, the finished wallet, transactions and a group chat all move between phones automatically — encrypted, so relays only ever carry ciphertext. Best when the cosigners are in different places."
      />

      <SectionTitle>The five options</SectionTitle>
      <Explainer
        icon="school-outline"
        title="Set up a private wallet step by step"
        body="A guided version of the first option: it helps you decide how many keys and how many signatures, plans where each key should live, walks you through creating or importing them, requires a backup, and then has you scan or open that backup to prove it restores this wallet. It ends in the same private wallet."
      />
      <Explainer
        icon="construct-outline"
        title="Create a private wallet"
        body="Pick keys that are already on this phone — created here or imported from hardware wallets — and choose how many must sign. Use this when you hold every key yourself, or already have each cosigner's public key."
      />
      <Explainer
        icon="download-outline"
        title="Import an existing private wallet"
        body="Bring in a wallet that was set up elsewhere — Sparrow, Coldcard, Specter or Nunchuk — using its descriptor, config file or JSON export, by pasting, scanning QR codes, or opening a file. Only public keys are imported."
      />
      <Explainer
        icon="people-outline"
        title="Create a new group wallet"
        body="You set the policy, then send an invite link or QR. Each member adds their own key from their own phone, and the wallet is built and delivered to everyone automatically. Transactions and messages then flow between you without copy-paste."
      />
      <Explainer
        icon="enter-outline"
        title="Join a group wallet"
        body="Someone sent you an invite. Paste or scan it, choose which of your keys to contribute, and their wallet arrives here once it is built."
      />
    </Screen>
  );
}
