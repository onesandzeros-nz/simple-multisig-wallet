import React from 'react';
import { Share, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import QRCode from 'react-native-qrcode-svg';
import { Screen, Card, Button, Mono } from '../components/ui';
import { colors } from '../theme';
import { useStore } from '../lib/store';
import { deriveAddress } from '../lib/bitcoin';
import { getCached } from '../lib/walletCache';
import { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Receive'>;

export default function ReceiveScreen({ route }: Props) {
  const { wallets } = useStore();
  const wallet = wallets.find((w) => w.id === route.params.walletId);
  const [offset, setOffset] = React.useState(0);

  if (!wallet) return null;

  const baseIndex = getCached(wallet.id)?.snapshot.nextReceiveIndex ?? 0;
  const index = baseIndex + offset;
  const derived = deriveAddress(wallet, 0, index);

  return (
    <Screen>
      <Card style={{ alignItems: 'center', paddingVertical: 28 }}>
        <Text style={{ fontSize: 16, fontWeight: '600', color: colors.ink }}>Receiving address</Text>
        <Text style={{ color: colors.inkSoft, marginBottom: 18, marginTop: 2, fontSize: 13 }}>
          Address #{index}
        </Text>
        <View
          style={{
            backgroundColor: '#FFFFFF',
            padding: 14,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: colors.line,
          }}
        >
          <QRCode value={derived.address.toUpperCase()} size={210} />
        </View>
        <View style={{ alignSelf: 'stretch', marginTop: 18 }}>
          <Mono text={derived.address} />
          <Button
            title="Share address"
            icon="share-outline"
            onPress={() => Share.share({ message: derived.address })}
          />
          <Button
            title="Use a fresh address"
            icon="refresh-outline"
            variant="secondary"
            onPress={() => setOffset(offset + 1)}
          />
        </View>
      </Card>
    </Screen>
  );
}
