import { MAX_CHAT_CHARS } from '../lib/nostr/protocol';
import React from 'react';
import { FlatList, Text, TouchableOpacity, View } from 'react-native';
import { KeyboardAvoidingView, useKeyboardState } from 'react-native-keyboard-controller';
import { useHeaderHeight } from '@react-navigation/elements';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { Input, Tag } from '../components/ui';
import { colors, radius } from '../theme';
import { useStore } from '../lib/store';
import { useGroup } from '../lib/nostr/useGroup';
import { shortNpub } from '../lib/nostr/identity';
import { memberName } from '../lib/naming';
import { StoredChat } from '../lib/types';
import { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'GroupChat'>;

export default function GroupChatScreen({ navigation, route }: Props) {
  const { groups, chats, keys, settings, updateGroup } = useStore();
  const group = groups.find((g) => g.id === route.params.groupId);
  const { messages, connected, relays, send } = useGroup(group);
  const [text, setText] = React.useState('');

  // The avoiding view measures from its own parent, so the offset it needs to
  // cancel is exactly the header's height — measured, never hardcoded.
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState().isVisible;

  const listRef = React.useRef<FlatList<StoredChat>>(null);
  const hasRendered = React.useRef(false);
  const scrollToEnd = React.useCallback((animated: boolean) => {
    listRef.current?.scrollToEnd({ animated });
  }, []);

  React.useEffect(() => {
    navigation.setOptions({ title: group ? `${group.name} · chat` : 'Chat' });
  }, [group?.name]);

  // Opening the chat marks everything in it as read.
  React.useEffect(() => {
    if (group) updateGroup(group.id, { lastReadChatAt: Date.now() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group?.id, messages.length]);

  const history = React.useMemo(
    () => chats.filter((c) => c.groupId === route.params.groupId).sort((a, b) => a.at - b.at),
    [chats, route.params.groupId]
  );

  // The name the person gave the app; older records may carry one on the key.
  const identity = keys.find((k) => k.id === group?.identityKeyId);
  const myName = memberName(settings.userName, identity, 'Me');

  const submit = () => {
    const body = text.trim();
    if (!body || !send) return;
    send({ type: 'chat', name: myName, text: body });
    setText('');
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg }}
      behavior="padding"
      keyboardVerticalOffset={headerHeight}
    >
      <View style={{ paddingHorizontal: 20, paddingTop: 10 }}>
        <Tag
          text={connected > 0 ? `Connected · ${connected}/${relays} relays` : 'Connecting…'}
          tone={connected > 0 ? 'success' : 'warning'}
        />
      </View>
      <FlatList
        data={history}
        keyExtractor={(item) => item.id}
        ref={listRef}
        contentContainerStyle={{ padding: 20, gap: 10, flexGrow: 1 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        // The list shrinks when the keyboard opens: re-pin to the newest
        // message. Unanimated here so it does not fight the lift animation.
        onLayout={() => scrollToEnd(false)}
        onContentSizeChange={() => {
          scrollToEnd(hasRendered.current);
          hasRendered.current = true;
        }}
        renderItem={({ item }) => (
          <View style={{ alignItems: item.mine ? 'flex-end' : 'flex-start' }}>
            {!item.mine && (
              <Text style={{ color: colors.inkFaint, fontSize: 11, marginBottom: 2 }}>
                {item.name || shortNpub(item.author)}
              </Text>
            )}
            <View
              style={{
                backgroundColor: item.mine ? colors.primary : colors.card,
                borderWidth: item.mine ? 0 : 1,
                borderColor: colors.line,
                borderRadius: radius.card,
                paddingHorizontal: 14,
                paddingVertical: 10,
                maxWidth: '85%',
              }}
            >
              <Text style={{ color: item.mine ? colors.onPrimary : colors.ink, fontSize: 15 }}>
                {item.text}
              </Text>
            </View>
            <Text style={{ color: colors.inkFaint, fontSize: 10, marginTop: 2 }}>
              {new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </Text>
          </View>
        )}
        ListEmptyComponent={
          <Text style={{ color: colors.inkSoft, textAlign: 'center', marginTop: 40, fontSize: 14 }}>
            No messages yet. Say hello to your group.
          </Text>
        }
      />
      <View
        style={{
          flexDirection: 'row',
          gap: 10,
          paddingHorizontal: 16,
          paddingTop: 16,
          // While the keyboard is open the lift already spans the gesture bar,
          // so adding the inset again would float the row above the keyboard.
          paddingBottom: 16 + (keyboardVisible ? 0 : insets.bottom),
          borderTopWidth: 1,
          borderTopColor: colors.line,
          backgroundColor: colors.card,
          alignItems: 'flex-end',
        }}
      >
        <View style={{ flex: 1 }}>
          <Input
            placeholder="Message"
            value={text}
            onChangeText={setText}
            maxLength={MAX_CHAT_CHARS}
            multiline
            style={{ maxHeight: 100 }}
            onSubmitEditing={submit}
          />
        </View>
        <TouchableOpacity
          onPress={submit}
          disabled={!text.trim() || !send}
          style={{
            width: 46,
            height: 46,
            borderRadius: 23,
            backgroundColor: text.trim() && send ? colors.primary : colors.chipBg,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons
            name="arrow-up"
            size={20}
            color={text.trim() && send ? colors.onPrimary : colors.inkFaint}
          />
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}
