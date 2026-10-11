import React from 'react';
import { FlatList, Text, TouchableOpacity, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { DecoyStackParamList } from './DecoyApp';
import { useDecoy } from './DecoyContext';
import { Avatar } from './Avatar';
import { decoy } from './theme';
import { inbox, inboxTime, lastMessage } from '../../lib/decoy/conversations';
import { contactById } from '../../lib/decoy/data';

type Props = NativeStackScreenProps<DecoyStackParamList, 'Conversations'>;

export default function ConversationsScreen({ navigation }: Props) {
  const { state } = useDecoy();
  const now = Date.now();
  const threads = state ? inbox(state) : [];

  return (
    <View style={{ flex: 1, backgroundColor: decoy.bg }}>
      <FlatList
        data={threads}
        keyExtractor={(t) => t.contactId}
        contentContainerStyle={{ paddingBottom: 96 }}
        renderItem={({ item }) => {
          const contact = contactById(item.contactId);
          const last = lastMessage(item);
          if (!contact || !last) return null;
          const preview = last.from === 'me' ? `You: ${last.text}` : last.text;
          return (
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={() => navigation.navigate('Chat', { contactId: contact.id })}
              style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 14 }}
            >
              <Avatar name={contact.name} color={contact.color} />
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
                  <Text
                    numberOfLines={1}
                    style={{ flex: 1, fontSize: 16, color: decoy.ink, fontWeight: item.unread ? '700' : '500' }}
                  >
                    {contact.name}
                  </Text>
                  <Text style={{ fontSize: 12, color: item.unread ? decoy.unread : decoy.inkFaint, marginLeft: 8 }}>
                    {inboxTime(last.at, now)}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
                  <Text
                    numberOfLines={1}
                    style={{
                      flex: 1,
                      fontSize: 14,
                      color: item.unread ? decoy.ink : decoy.inkSoft,
                      fontWeight: item.unread ? '600' : '400',
                    }}
                  >
                    {preview}
                  </Text>
                  {item.unread && (
                    <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: decoy.unread, marginLeft: 8 }} />
                  )}
                </View>
              </View>
            </TouchableOpacity>
          );
        }}
      />
      <TouchableOpacity
        activeOpacity={0.8}
        onPress={() => navigation.navigate('Contacts')}
        style={{
          position: 'absolute',
          right: 16,
          bottom: 24,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          backgroundColor: decoy.primary,
          paddingHorizontal: 18,
          paddingVertical: 14,
          borderRadius: 16,
          shadowColor: '#000',
          shadowOpacity: 0.2,
          shadowRadius: 6,
          shadowOffset: { width: 0, height: 2 },
          elevation: 4,
        }}
      >
        <Ionicons name="chatbubble-ellipses-outline" size={20} color="#FFFFFF" />
        <Text style={{ color: '#FFFFFF', fontWeight: '600', fontSize: 15 }}>Start chat</Text>
      </TouchableOpacity>
    </View>
  );
}
