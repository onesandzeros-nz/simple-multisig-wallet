import { NAME_INPUT_CHARS } from '../lib/naming';
import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { Screen, Card, Button, Input, Label, SectionTitle, Tag } from '../components/ui';
import { colors } from '../theme';
import { showError } from '../lib/errors';
import { useStore, newId, loadMnemonic } from '../lib/store';
import { buildPrivateWallet } from '../lib/buildWallet';
import { policyTradeoffs } from '../lib/tutorialPolicy';
import { keySelectionWarnings } from '../lib/tutorial';
import { NoticeCard } from './tutorial/common';
import { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'CreateWallet'>;

export default function CreateWalletScreen({ navigation }: Props) {
  const { keys, addWallet, settings } = useStore();
  const [name, setName] = React.useState('');
  const [selected, setSelected] = React.useState<string[]>([]);
  const [m, setM] = React.useState(2);
  const [saving, setSaving] = React.useState(false);

  const n = selected.length;
  const effectiveM = Math.min(m, Math.max(n, 1));
  const chosen = selected.flatMap((id) => {
    const k = keys.find((key) => key.id === id);
    return k ? [k] : [];
  });
  // The same checks the guided setup makes, so this path cannot quietly build
  // a wallet the guide would have warned about.
  const issues = keySelectionWarnings(chosen, effectiveM, n, settings.testnet);
  const tradeoffs = policyTradeoffs(effectiveM, n);

  const toggle = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const create = async () => {
    setSaving(true);
    try {
      const wallet = await buildPrivateWallet({
        id: newId(),
        keys: chosen,
        m: effectiveM,
        name,
        defaultNetwork: settings.testnet ? 'testnet' : 'mainnet',
        loadMnemonic,
        now: Date.now(),
      });
      await addWallet(wallet);
      navigation.replace('Wallet', { walletId: wallet.id });
    } catch (e: any) {
      showError('wallet:create', e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen>
      <Card>
        <Label>Wallet name</Label>
        <Input placeholder="e.g. Family savings" value={name} onChangeText={setName} maxLength={NAME_INPUT_CHARS} />
      </Card>

      <SectionTitle>Signers · {n} selected</SectionTitle>
      {keys.length === 0 && (
        <Card>
          <Text style={{ color: colors.inkSoft, marginBottom: 10, fontSize: 14 }}>
            You need keys first — one for each member of the group.
          </Text>
          <Button title="Add keys" variant="secondary" icon="key-outline" onPress={() => navigation.navigate('Tabs', { screen: 'KeysTab' })} />
        </Card>
      )}
      {keys.map((k) => {
        const on = selected.includes(k.id);
        return (
          <TouchableOpacity key={k.id} onPress={() => toggle(k.id)} activeOpacity={0.7}>
            <Card style={{ borderColor: on ? colors.ink : colors.line, borderWidth: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <Ionicons
                  name={on ? 'checkmark-circle' : 'ellipse-outline'}
                  size={24}
                  color={on ? colors.ink : colors.inkFaint}
                />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: '600', color: colors.ink }}>{k.name}</Text>
                  <View style={{ flexDirection: 'row', marginTop: 6 }}>
                    <Tag text={k.type === 'local' ? 'This phone' : 'Hardware wallet'} />
                    {k.network === 'testnet' && <Tag text="Testnet" tone="accent" />}
                  </View>
                </View>
              </View>
            </Card>
          </TouchableOpacity>
        );
      })}

      <SectionTitle>Required signatures</SectionTitle>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 28 }}>
          <TouchableOpacity onPress={() => setM(Math.max(1, effectiveM - 1))} hitSlop={8}>
            <Ionicons name="remove-circle-outline" size={34} color={colors.inkSoft} />
          </TouchableOpacity>
          <Text
            style={{
              fontSize: 32,
              fontWeight: '700',
              color: colors.ink,
              fontVariant: ['tabular-nums'],
              letterSpacing: -0.5,
            }}
          >
            {effectiveM} of {n || '—'}
          </Text>
          <TouchableOpacity onPress={() => setM(Math.min(Math.max(n, 1), effectiveM + 1))} hitSlop={8}>
            <Ionicons name="add-circle-outline" size={34} color={colors.inkSoft} />
          </TouchableOpacity>
        </View>
        <Text
          style={{
            color: n > 0 ? colors[tradeoffs.tone] : colors.inkSoft,
            textAlign: 'center',
            marginTop: 10,
            fontSize: 13,
            lineHeight: 19,
          }}
        >
          {n > 0 ? tradeoffs.lines.join(' ') : 'Select signers above first.'}
        </Text>
      </Card>

      {issues.blocking.map((b, i) => (
        <Text key={i} style={{ color: colors.danger, fontSize: 13, lineHeight: 19, marginBottom: 8, marginHorizontal: 4 }}>
          {b}
        </Text>
      ))}
      {issues.warnings.length > 0 && <NoticeCard tone="warning" lines={issues.warnings} />}

      <Button
        title="Create wallet"
        onPress={create}
        disabled={n < 2 || effectiveM < 1 || issues.blocking.length > 0 || !name.trim()}
        loading={saving}
      />
      {n >= 2 && !name.trim() && (
        <Text style={{ color: colors.inkSoft, textAlign: 'center', fontSize: 13 }}>
          Give the wallet a name first.
        </Text>
      )}
      {n === 1 && (
        <Text style={{ color: colors.inkSoft, textAlign: 'center', fontSize: 13 }}>
          A shared wallet needs at least two keys.
        </Text>
      )}
    </Screen>
  );
}
