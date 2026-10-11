import React from 'react';
import { FlatList, Text, TouchableOpacity, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { DecoyStackParamList } from './DecoyApp';
import { Avatar } from './Avatar';
import { decoy } from './theme';
import { CONTACTS } from '../../lib/decoy/data';

type Props = NativeStackScreenProps<DecoyStackParamList, 'Contacts'>;

export default function ContactsScreen({ navigation }: Props) {
  const sorted = [...CONTACTS].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <View style={{ flex: 1, backgroundColor: decoy.bg }}>
      <FlatList
        data={sorted}
        keyExtractor={(c) => c.id}
        renderItem={({ item }) => (
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={() => navigation.replace('Chat', { contactId: item.id })}
            style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 14 }}
          >
            <Avatar name={item.name} color={item.color} size={40} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, color: decoy.ink }}>{item.name}</Text>
              <Text style={{ fontSize: 13, color: decoy.inkSoft }}>{item.detail}</Text>
            </View>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}
