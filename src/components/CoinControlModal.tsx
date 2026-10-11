import React from 'react';
import { Modal, Pressable, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Button } from './ui';
import { colors, radius } from '../theme';
import { formatSats } from '../lib/bitcoin';
import { Utxo } from '../lib/types';

export const outpointOf = (u: Utxo): string => `${u.txid}:${u.vout}`;

/**
 * Picks which coins a transaction spends. Every chosen coin becomes an input,
 * so the total shown here is exactly what the transaction has to work with.
 *
 * The selection is held locally and only handed back on "Use these coins", so
 * backing out leaves the previous choice untouched.
 */
export function CoinControlModal({
  visible,
  coins,
  selected,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  coins: Utxo[];
  /** Outpoints currently chosen, or null for "everything". */
  selected: string[] | null;
  onCancel: () => void;
  onConfirm: (outpoints: string[] | null) => void;
}) {
  const all = React.useMemo(() => coins.map(outpointOf), [coins]);
  const [draft, setDraft] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    if (visible) setDraft(new Set(selected ?? all));
  }, [visible]);

  const toggle = (key: string) =>
    setDraft((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const total = coins.reduce((sum, u) => (draft.has(outpointOf(u)) ? sum + u.value : sum), 0);
  const everything = draft.size === coins.length;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel} statusBarTranslucent>
      <Pressable
        style={{
          flex: 1,
          backgroundColor: '#000000AA',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 20,
        }}
        onPress={onCancel}
      >
        <Pressable
          style={{
            backgroundColor: colors.card,
            borderRadius: radius.card,
            maxWidth: 420,
            width: '100%',
            maxHeight: '85%',
            overflow: 'hidden',
          }}
          onPress={() => {}}
        >
          <View style={{ padding: 20, paddingBottom: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ fontSize: 17, fontWeight: '600', color: colors.ink, flex: 1 }}>
                Choose coins
              </Text>
              <TouchableOpacity
                onPress={() => setDraft(everything ? new Set() : new Set(all))}
                hitSlop={10}
              >
                <Text style={{ color: colors.accent, fontSize: 14, fontWeight: '600' }}>
                  {everything ? 'Clear' : 'Select all'}
                </Text>
              </TouchableOpacity>
            </View>
            <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 6 }}>
              Only the coins you pick are spent. Anything left over comes back as change.
            </Text>
          </View>

          <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: 20 }}>
            {coins.map((u) => {
              const key = outpointOf(u);
              const on = draft.has(key);
              return (
                <TouchableOpacity
                  key={key}
                  onPress={() => toggle(key)}
                  activeOpacity={0.7}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    paddingVertical: 12,
                    borderTopWidth: 1,
                    borderTopColor: colors.line,
                  }}
                >
                  <Ionicons
                    name={on ? 'checkbox' : 'square-outline'}
                    size={22}
                    color={on ? colors.accent : colors.inkFaint}
                  />
                  <View style={{ flex: 1 }}>
                    <Text
                      style={{
                        fontSize: 15,
                        fontWeight: '600',
                        color: colors.ink,
                        fontVariant: ['tabular-nums'],
                      }}
                    >
                      {formatSats(u.value)}
                    </Text>
                    <Text style={{ fontSize: 12, color: colors.inkFaint, marginTop: 1 }}>
                      {u.address.slice(0, 10)}…{u.address.slice(-6)}
                      {u.confirmed ? '' : ' · unconfirmed'}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <View style={{ padding: 20, paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.line }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 }}>
              <Text style={{ color: colors.inkSoft, fontSize: 14 }}>
                {draft.size} of {coins.length} selected
              </Text>
              <Text
                style={{
                  color: colors.ink,
                  fontSize: 14,
                  fontWeight: '700',
                  fontVariant: ['tabular-nums'],
                }}
              >
                {formatSats(total)}
              </Text>
            </View>
            <Button
              title="Use these coins"
              // Handing back null for a full selection keeps the normal
              // automatic behaviour rather than pinning every coin.
              onPress={() => onConfirm(everything ? null : [...draft])}
              disabled={draft.size === 0}
            />
            <Button title="Cancel" variant="ghost" onPress={onCancel} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
