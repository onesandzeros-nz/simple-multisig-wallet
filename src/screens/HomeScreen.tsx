import React from 'react';
import { Alert, Text, TouchableOpacity, View } from 'react-native';
import { CompositeScreenProps } from '@react-navigation/native';
import { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { Screen, Card, Button, Tag, UnreadDot } from '../components/ui';
import { GroupSyncer } from '../components/GroupSyncer';
import { unreadFor } from '../lib/nostr/unread';
import { parsePsbt, summarisePsbt } from '../lib/wallet';
import { colors } from '../theme';
import { useStore } from '../lib/store';
import { draftProgress } from '../lib/tutorial';
import { RootStackParamList, TabParamList } from '../navigation';

type Props = CompositeScreenProps<
  BottomTabScreenProps<TabParamList, 'WalletsTab'>,
  NativeStackScreenProps<RootStackParamList>
>;

/** The whole idea in three lines, shown before the first wallet exists. */
const PRIMER: { icon: React.ComponentProps<typeof Ionicons>['name']; text: string }[] = [
  { icon: 'key-outline', text: 'Your money needs any 2 of 3 keys to move.' },
  { icon: 'shield-checkmark-outline', text: "Lose one key and you're fine." },
  { icon: 'lock-closed-outline', text: 'A thief with one key gets nothing.' },
];

export default function HomeScreen({ navigation }: Props) {
  const { wallets, pendingTxs, groups, chats, setupDraft, keys, settings, retryWipe } = useStore();

  React.useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <TouchableOpacity onPress={() => navigation.navigate('AddWallet')} hitSlop={10}>
          <Ionicons name="add" size={26} color={colors.ink} />
        </TouchableOpacity>
      ),
    });
  }, [navigation]);

  // Groups still being set up show their own card; once a group has built its
  // wallet it is represented by the wallet card instead.
  const settingUpGroups = groups.filter((g) => !g.walletId);
  // A guided setup that has not built its wallet yet shows as a card too.
  const draftProgressInfo = setupDraft ? draftProgress(setupDraft, keys) : null;

  // An emergency wipe that could not erase everything says so here, where
  // the phone's owner lands after unlocking — the decoy cannot.
  const leftovers = settings.wipeLeftovers.length;
  const finishWipe = () =>
    retryWipe()
      .then(() => Alert.alert('Erased', 'Everything the wipe left behind is gone now.'))
      .catch((e: any) => Alert.alert('Still could not erase everything', e?.message ?? String(e)));

  return (
    <Screen>
      {/* Live sessions so unread markers appear without opening each group. */}
      {groups.map((g) => (
        <GroupSyncer key={g.id} group={g} />
      ))}
      {leftovers > 0 && (
        <Card>
          <Text style={{ fontSize: 16, fontWeight: '700', color: colors.danger }}>
            The last emergency wipe did not finish
          </Text>
          <Text style={{ color: colors.inkSoft, fontSize: 14, lineHeight: 20, marginTop: 6 }}>
            {leftovers === 1 ? 'One entry' : `${leftovers} entries`} in the phone's keystore could not be erased, so
            a recovery phrase or group key may still be on this phone.
          </Text>
          <View style={{ marginTop: 12 }}>
            <Button title="Erase them now" icon="trash-outline" variant="danger" onPress={finishWipe} />
          </View>
        </Card>
      )}
      {setupDraft && draftProgressInfo && (
        <TouchableOpacity onPress={() => navigation.navigate('Tutorial')} activeOpacity={0.7}>
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ fontSize: 17, fontWeight: '600', color: colors.ink, flex: 1 }}>
                Guided wallet setup
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Tag text={`${setupDraft.policy.m} of ${setupDraft.policy.n}`} />
                <Ionicons name="chevron-forward" size={18} color={colors.inkFaint} />
              </View>
            </View>
            <Text style={{ color: colors.inkSoft, fontSize: 13, marginTop: 8 }} numberOfLines={1}>
              {draftProgressInfo.filled} of {draftProgressInfo.total} keys added
            </Text>
            <View style={{ flexDirection: 'row', marginTop: 8 }}>
              <Tag text="Setting up" tone="warning" />
            </View>
          </Card>
        </TouchableOpacity>
      )}
      {settingUpGroups.map((g) => (
        <TouchableOpacity
          key={g.id}
          onPress={() => navigation.navigate('Group', { groupId: g.id })}
          activeOpacity={0.7}
        >
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                <Text style={{ fontSize: 17, fontWeight: '600', color: colors.ink }}>{g.name}</Text>
                <UnreadDot count={unreadFor(g, chats, pendingTxs).total} />
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.inkFaint} />
            </View>
            <View style={{ flexDirection: 'row', marginTop: 8 }}>
              <Tag
                text={g.coordinator ? 'Coordinating' : 'Group member'}
                tone="accent"
                icon="radio-outline"
              />
              <Tag text="Setting up" tone="warning" />
            </View>
          </Card>
        </TouchableOpacity>
      ))}

      {wallets.length === 0 && settingUpGroups.length === 0 && !setupDraft && (
        <>
          <Card>
            <Text style={{ fontSize: 17, fontWeight: '600', color: colors.ink }}>How multisig works</Text>
            <View style={{ marginTop: 12, gap: 10 }}>
              {PRIMER.map((line) => (
                <View key={line.text} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <View
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 10,
                      backgroundColor: colors.chipBg,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Ionicons name={line.icon} size={18} color={colors.ink} />
                  </View>
                  <Text style={{ color: colors.ink, fontSize: 15, lineHeight: 21, flex: 1 }}>{line.text}</Text>
                </View>
              ))}
            </View>
            <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 14 }}>
              This app helps you make the keys, keep them in different places, and back it all up.
            </Text>
          </Card>

          <Card style={{ alignItems: 'center', paddingVertical: 28 }}>
            <View
              style={{
                width: 52,
                height: 52,
                borderRadius: 26,
                backgroundColor: colors.chipBg,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ionicons name="wallet-outline" size={26} color={colors.inkFaint} />
            </View>
            <Text style={{ fontSize: 18, fontWeight: '700', color: colors.ink, marginTop: 14 }}>
              Let's get started
            </Text>
            <Text
              style={{ color: colors.inkSoft, fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 6 }}
            >
              Set up your first wallet step by step, or pick an option yourself if you have done this before.
            </Text>
            <View style={{ alignSelf: 'stretch', marginTop: 18 }}>
              <Button
                title="Guide me through it"
                icon="school-outline"
                onPress={() => navigation.navigate('Tutorial')}
              />
              <Button
                title="Choose for myself"
                icon="list-outline"
                variant="secondary"
                onPress={() => navigation.navigate('AddWallet')}
              />
            </View>
          </Card>
        </>
      )}
      {wallets.map((w) => {
        const drafts = pendingTxs.filter((t) => t.walletId === w.id);
        const pending = drafts.length;
        // A fully signed draft is waiting to be sent, not for signatures.
        const readyCount = drafts.filter((d) => {
          try {
            return summarisePsbt(parsePsbt(d.base64, w.network), w).complete;
          } catch {
            return false;
          }
        }).length;
        const group = groups.find((g) => g.walletId === w.id);
        const unread = unreadFor(group, chats, pendingTxs);
        return (
          <TouchableOpacity
            key={w.id}
            onPress={() => navigation.navigate('Wallet', { walletId: w.id })}
            activeOpacity={0.7}
          >
            <Card>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                  <Text style={{ fontSize: 17, fontWeight: '600', color: colors.ink }}>{w.name}</Text>
                  <UnreadDot count={unread.total} />
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Tag text={`${w.m} of ${w.n}`} />
                  <Ionicons name="chevron-forward" size={18} color={colors.inkFaint} />
                </View>
              </View>
              <Text style={{ color: colors.inkSoft, fontSize: 13, marginTop: 8 }} numberOfLines={1}>
                {w.cosigners.map((c) => c.name).join(' · ')}
              </Text>
              <View style={{ flexDirection: 'row', marginTop: 8, flexWrap: 'wrap' }}>
                {w.kind === 'group' ? (
                  <Tag text="Nostr group" tone="accent" icon="radio-outline" />
                ) : (
                  <Tag text="Private" />
                )}
                {w.network === 'testnet' && <Tag text="Testnet" tone="accent" />}
                {readyCount > 0 && <Tag text={`${readyCount} ready to send`} tone="success" />}
                {pending - readyCount > 0 && (
                  <Tag text={`${pending - readyCount} awaiting signatures`} tone="warning" />
                )}
              </View>
            </Card>
          </TouchableOpacity>
        );
      })}
    </Screen>
  );
}
