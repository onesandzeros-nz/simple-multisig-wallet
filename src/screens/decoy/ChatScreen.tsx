import React from 'react';
import { FlatList, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { KeyboardAvoidingView, useKeyboardState } from 'react-native-keyboard-controller';
import { useHeaderHeight } from '@react-navigation/elements';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { DecoyStackParamList } from './DecoyApp';
import { useDecoy } from './DecoyContext';
import { Avatar } from './Avatar';
import { decoy } from './theme';
import {
  DecoyMessage,
  appendMessage,
  chatDay,
  isSameDay,
  markRead,
  replyFor,
  threadFor,
  timeOfDay,
} from '../../lib/decoy/conversations';
import { contactById } from '../../lib/decoy/data';
import { classifyMessage } from '../../lib/securityPin';

type Props = NativeStackScreenProps<DecoyStackParamList, 'Chat'>;

type Item = { kind: 'day'; key: string; label: string } | { kind: 'msg'; key: string; msg: DecoyMessage; tail: boolean };

/** Messages newest-first (the list is inverted) with a label where the day changes. */
function buildItems(messages: DecoyMessage[], now: number): Item[] {
  const items: Item[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (i === 0 || !isSameDay(messages[i - 1].at, m.at)) {
      items.push({ kind: 'day', key: `day-${m.at}`, label: chatDay(m.at, now) });
    }
    const next = messages[i + 1];
    // The last bubble in a run from one side gets the rounded tail.
    const tail = !next || next.from !== m.from || !isSameDay(next.at, m.at);
    items.push({ kind: 'msg', key: m.id, msg: m, tail });
  }
  return items.reverse();
}

export default function ChatScreen({ navigation, route }: Props) {
  const { contactId } = route.params;
  const contact = contactById(contactId);
  const { state, update, pinRecord, attempts, setAttempts, onUnlock, onWipe } = useDecoy();
  const insets = useSafeAreaInsets();
  // Same arrangement as the group chat: the avoiding view measures from its
  // own parent, so the header's height is exactly the offset to cancel.
  const headerHeight = useHeaderHeight();
  const keyboardVisible = useKeyboardState().isVisible;
  const [text, setText] = React.useState('');
  const timers = React.useRef<ReturnType<typeof setTimeout>[]>([]);

  React.useLayoutEffect(() => {
    if (!contact) return;
    navigation.setOptions({
      headerTitle: () => (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Avatar name={contact.name} color={contact.color} size={32} />
          <Text style={{ fontSize: 17, fontWeight: '600', color: decoy.ink }}>{contact.name}</Text>
        </View>
      ),
      headerRight: () => (
        <View style={{ flexDirection: 'row', gap: 20 }}>
          <Ionicons name="call-outline" size={22} color={decoy.inkSoft} />
          <Ionicons name="ellipsis-vertical" size={20} color={decoy.inkSoft} />
        </View>
      ),
    });
  }, [navigation, contact]);

  React.useEffect(() => {
    update((s) => markRead(s, contactId));
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, [contactId, update]);

  const send = async () => {
    const body = text.trim();
    if (!body || !contact) return;
    const outcome = classifyMessage(body, pinRecord, attempts);
    // Six digits with no PIN record to check them against: they may be the
    // PIN, and a chat message is written to disk, so the message stays in
    // the box as if it never sent.
    if (outcome.kind === 'withheld') return;
    setText('');
    if (outcome.kind === 'unlock') {
      // Never stored: the chat looks exactly as it did before.
      await setAttempts(0);
      onUnlock();
      return;
    }
    if (outcome.kind === 'wrong') {
      if (outcome.wipe) {
        await onWipe().catch(() => {});
        await setAttempts(0);
      } else {
        await setAttempts(outcome.attempts);
      }
    }
    // Either way the message goes into the chat like any other, and the
    // contact answers like they always do — nothing gives the guess away.
    update((s) => appendMessage(s, contactId, 'me', body, Date.now()));
    const delay = 1500 + Math.floor(Math.random() * 2500);
    const timer = setTimeout(() => {
      update((s) => {
        const reply = replyFor(s, contactId);
        return reply ? appendMessage(reply.state, contactId, 'them', reply.text, Date.now()) : s;
      });
    }, delay);
    timers.current.push(timer);
  };

  const now = Date.now();
  const items = state ? buildItems(threadFor(state, contactId).messages, now) : [];

  return (
    <KeyboardAvoidingView
      behavior="padding"
      keyboardVerticalOffset={headerHeight}
      style={{ flex: 1, backgroundColor: decoy.bg }}
    >
      <FlatList
        inverted
        data={items}
        keyExtractor={(i) => i.key}
        contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 10 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        renderItem={({ item }) => {
          if (item.kind === 'day') {
            return (
              <Text style={{ alignSelf: 'center', color: decoy.inkFaint, fontSize: 12, marginVertical: 12 }}>
                {item.label}
              </Text>
            );
          }
          const mine = item.msg.from === 'me';
          return (
            <View style={{ alignItems: mine ? 'flex-end' : 'flex-start', marginBottom: item.tail ? 10 : 3 }}>
              <View
                style={{
                  maxWidth: '78%',
                  backgroundColor: mine ? decoy.sent : decoy.received,
                  paddingHorizontal: 14,
                  paddingVertical: 9,
                  borderRadius: 18,
                  borderBottomRightRadius: mine && item.tail ? 4 : 18,
                  borderBottomLeftRadius: !mine && item.tail ? 4 : 18,
                }}
              >
                <Text style={{ color: mine ? decoy.onSent : decoy.onReceived, fontSize: 16, lineHeight: 21 }}>
                  {item.msg.text}
                </Text>
              </View>
              {item.tail && (
                <Text style={{ color: decoy.inkFaint, fontSize: 11, marginTop: 3, marginHorizontal: 6 }}>
                  {timeOfDay(item.msg.at)}
                </Text>
              )}
            </View>
          );
        }}
      />
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-end',
          paddingHorizontal: 12,
          paddingTop: 8,
          // With the keyboard up the lift already covers the gesture bar, so
          // the inset would only float the row above the keyboard.
          paddingBottom: keyboardVisible ? 8 : Math.max(insets.bottom, 8),
          gap: 8,
          borderTopWidth: 1,
          borderTopColor: decoy.line,
          backgroundColor: decoy.bg,
        }}
      >
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Text message"
          placeholderTextColor={decoy.inkFaint}
          multiline
          style={{
            flex: 1,
            minHeight: 42,
            maxHeight: 120,
            paddingHorizontal: 16,
            paddingVertical: 10,
            borderRadius: 21,
            backgroundColor: decoy.surface,
            color: decoy.ink,
            fontSize: 16,
          }}
        />
        <TouchableOpacity
          onPress={send}
          disabled={!text.trim()}
          style={{
            width: 42,
            height: 42,
            borderRadius: 21,
            backgroundColor: text.trim() ? decoy.primary : decoy.surface,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name="send" size={18} color={text.trim() ? '#FFFFFF' : decoy.inkFaint} />
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}
