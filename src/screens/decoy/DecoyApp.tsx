import React from 'react';
import { DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { DecoyProvider } from './DecoyContext';
import ConversationsScreen from './ConversationsScreen';
import ChatScreen from './ChatScreen';
import ContactsScreen from './ContactsScreen';
import { decoy } from './theme';

/**
 * What the app is while security mode has it locked: a plain SMS inbox with
 * its own navigation tree. Sending the PIN in any chat calls `onUnlock`;
 * three wrong PINs call `onWipe`.
 */

export type DecoyStackParamList = {
  Conversations: undefined;
  Chat: { contactId: string };
  Contacts: undefined;
};

const Stack = createNativeStackNavigator<DecoyStackParamList>();

export function DecoyApp({ onUnlock, onWipe }: { onUnlock: () => void; onWipe: () => Promise<void> }) {
  return (
    <DecoyProvider onUnlock={onUnlock} onWipe={onWipe}>
      <NavigationContainer
        theme={{
          ...DefaultTheme,
          colors: { ...DefaultTheme.colors, background: decoy.bg, card: decoy.bg, text: decoy.ink, border: decoy.line, primary: decoy.primary },
        }}
      >
        <StatusBar style="dark" />
        <Stack.Navigator
          screenOptions={{
            headerStyle: { backgroundColor: decoy.bg },
            headerTintColor: decoy.ink,
            headerTitleStyle: { fontWeight: '600', fontSize: 20 },
            headerShadowVisible: false,
            headerBackButtonDisplayMode: 'minimal',
            contentStyle: { backgroundColor: decoy.bg },
          }}
        >
          <Stack.Screen
            name="Conversations"
            component={ConversationsScreen}
            options={{
              title: 'Messages',
              headerRight: () => <Ionicons name="search-outline" size={24} color={decoy.inkSoft} />,
            }}
          />
          <Stack.Screen name="Chat" component={ChatScreen} options={{ title: '' }} />
          <Stack.Screen name="Contacts" component={ContactsScreen} options={{ title: 'New conversation' }} />
        </Stack.Navigator>
      </NavigationContainer>
    </DecoyProvider>
  );
}
