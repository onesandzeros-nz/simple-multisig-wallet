import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { CompositeScreenProps } from '@react-navigation/native';
import { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Screen, Card, Button, SectionTitle, EmptyState, Row, Divider, UnreadDot } from '../components/ui';
import { colors } from '../theme';
import { healthCheckDue } from '../lib/keyHealth';
import { useStore } from '../lib/store';
import { RootStackParamList, TabParamList } from '../navigation';

type Props = CompositeScreenProps<
  BottomTabScreenProps<TabParamList, 'KeysTab'>,
  NativeStackScreenProps<RootStackParamList>
>;

export default function KeysScreen({ navigation }: Props) {
  const { keys, wallets } = useStore();
  const now = Date.now();

  return (
    <Screen>
      {keys.length === 0 && (
        <Card>
          <EmptyState
            icon="key-outline"
            text="A key is what signs for your money. Make one on this phone, or bring in the public key from a hardware wallet or from someone else's phone."
          />
        </Card>
      )}
      {keys.length > 0 && (
        <Card>
          {keys.map((k, i) => {
            const usedBy = wallets.filter((w) => w.cosigners.some((c) => c.keyId === k.id)).length;
            const usage = usedBy === 0 ? 'Not in use' : `In use · ${usedBy} wallet${usedBy === 1 ? '' : 's'}`;
            const due = healthCheckDue(k, now);
            return (
              <View key={k.id}>
                {i > 0 && <Divider />}
                <Row
                  icon={k.type === 'local' ? 'phone-portrait-outline' : 'hardware-chip-outline'}
                  title={k.name}
                  subtitle={due ? `${usage} · Health check due` : usage}
                  onPress={() => navigation.navigate('KeyDetail', { keyId: k.id })}
                  trailing={
                    due ? (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <UnreadDot count={1} tone="warning" />
                        <Ionicons name="chevron-forward" size={18} color={colors.inkFaint} />
                      </View>
                    ) : undefined
                  }
                />
              </View>
            );
          })}
        </Card>
      )}

      <SectionTitle>Add a key</SectionTitle>
      <Button
        title="Create a key on this phone"
        icon="phone-portrait-outline"
        onPress={() => navigation.navigate('CreateKey')}
      />
      <Button
        title="Import a key"
        icon="download-outline"
        variant="secondary"
        onPress={() => navigation.navigate('ImportKey')}
      />
    </Screen>
  );
}
