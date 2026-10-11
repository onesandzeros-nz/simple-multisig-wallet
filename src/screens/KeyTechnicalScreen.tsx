import React from 'react';
import { Text } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Screen, Card, Label, Mono } from '../components/ui';
import { colors } from '../theme';
import { useStore, loadMnemonic } from '../lib/store';
import { accountXpub, bip48Path } from '../lib/bitcoin';
import { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'KeyTechnical'>;

export default function KeyTechnicalScreen({ navigation, route }: Props) {
  const { keys } = useStore();
  const k = keys.find((key) => key.id === route.params.keyId);
  const [xpub, setXpub] = React.useState<string | null>(k?.xpub ?? null);

  React.useEffect(() => {
    navigation.setOptions({ title: k ? `${k.name} · details` : 'Technical details' });
    if (k?.type === 'local' && !xpub) {
      loadMnemonic(k.id).then((m) => {
        if (m) setXpub(accountXpub(m, 'mainnet'));
      });
    }
  }, [k?.id]);

  if (!k) return null;

  const path = k.path ?? bip48Path('mainnet');

  return (
    <Screen>
      <Card>
        <Label>Type</Label>
        <Text style={{ color: colors.ink, fontSize: 14 }}>
          {k.type === 'local' ? 'Created on this phone (BIP39, 12 words)' : 'Imported public key'}
          {k.network === 'testnet' ? ' · testnet' : ''}
        </Text>
        <Label>Master fingerprint</Label>
        <Mono text={k.fingerprint} />
        <Label>Derivation path</Label>
        <Mono text={path} />
        <Label>Account xpub</Label>
        {xpub ? <Mono text={xpub} small /> : <Text style={{ color: colors.inkFaint }}>Loading…</Text>}
      </Card>
      <Card>
        <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19 }}>
          The account xpub is derived at the path above and is what other wallet software needs to
          include this key in a multisig. It contains no secrets — it cannot spend funds on its own.
        </Text>
      </Card>
    </Screen>
  );
}
