import React from 'react';
import { AppState, View } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { DefaultTheme, NavigationContainer, Theme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { Ionicons } from '@expo/vector-icons';
import { StoreProvider, useStore } from './src/lib/store';
import { colors } from './src/theme';
import { RootStackParamList, TabParamList } from './src/navigation';
import HomeScreen from './src/screens/HomeScreen';
import KeysScreen from './src/screens/KeysScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import { VersionBadge } from './src/components/VersionBadge';
import { LogoHeaderTitle } from './src/components/Logo';
import { keysDueForCheck } from './src/lib/keyHealth';
import CreateKeyScreen from './src/screens/CreateKeyScreen';
import ImportKeyScreen from './src/screens/ImportKeyScreen';
import KeyDetailScreen from './src/screens/KeyDetailScreen';
import KeyTechnicalScreen from './src/screens/KeyTechnicalScreen';
import ScanQRScreen from './src/screens/ScanQRScreen';
import AddWalletScreen from './src/screens/AddWalletScreen';
import WalletHelpScreen from './src/screens/WalletHelpScreen';
import CreateWalletScreen from './src/screens/CreateWalletScreen';
import TutorialScreen from './src/screens/TutorialScreen';
import VerifyBackupScreen from './src/screens/VerifyBackupScreen';
import ImportWalletScreen from './src/screens/ImportWalletScreen';
import JoinGroupScreen from './src/screens/JoinGroupScreen';
import GroupScreen from './src/screens/GroupScreen';
import GroupChatScreen from './src/screens/GroupChatScreen';
import WalletScreen from './src/screens/WalletScreen';
import WalletMenuScreen from './src/screens/WalletMenuScreen';
import ReceiveScreen from './src/screens/ReceiveScreen';
import SendScreen from './src/screens/SendScreen';
import PsbtScreen from './src/screens/PsbtScreen';
import AdvancedScreen from './src/screens/AdvancedScreen';
import SecurityModeScreen from './src/screens/SecurityModeScreen';
import { DecoyApp } from './src/screens/decoy/DecoyApp';
import { RELOCK_AFTER_MS } from './src/lib/securityPin';
import { loadPinRecord } from './src/lib/securityMode';
import { clearDecoy } from './src/lib/decoy/decoyStore';

// Keep the splash up until saved state has loaded: with security mode on,
// not a frame of the wallet may show before the lock decision is made.
SplashScreen.preventAutoHideAsync().catch(() => {});

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

function headerOptions() {
  return {
    headerStyle: { backgroundColor: colors.bg },
    headerTintColor: colors.ink,
    headerTitleStyle: { fontWeight: '600' as const, fontSize: 17 },
    headerShadowVisible: false,
  };
}

function tabIcon(name: React.ComponentProps<typeof Ionicons>['name']) {
  return ({ color, size }: { color: string; size: number }) => (
    <Ionicons name={name} size={size} color={color} />
  );
}

function Tabs() {
  // Subscribe to the store so a theme change re-renders the navigator —
  // otherwise the memoized header and tab bar keep the old palette.
  const { keys } = useStore();
  // Whether a key's health check is due depends on the clock, so look again
  // whenever the app comes back to the foreground.
  const [, tick] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') tick();
    });
    return () => sub.remove();
  }, []);
  const keysDue = keysDueForCheck(keys, Date.now()).length;
  return (
    <Tab.Navigator
      screenOptions={{
        ...headerOptions(),
        // Align the header title and actions with the screen content (20px),
        // matching the card margins below. No left padding — the empty left
        // container would push the title further right on top of its margin.
        headerTitleContainerStyle: { marginHorizontal: 20 },
        headerRightContainerStyle: { paddingRight: 20 },
        headerTitle: ({ children }) => <LogoHeaderTitle>{children}</LogoHeaderTitle>,
        tabBarActiveTintColor: colors.ink,
        tabBarInactiveTintColor: colors.inkFaint,
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.line },
        tabBarLabelStyle: { fontWeight: '600', fontSize: 11 },
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tab.Screen
        name="WalletsTab"
        component={HomeScreen}
        options={{ title: 'Wallets', tabBarIcon: tabIcon('wallet-outline') }}
      />
      <Tab.Screen
        name="KeysTab"
        component={KeysScreen}
        options={{
          title: 'Keys',
          tabBarIcon: tabIcon('key-outline'),
          tabBarBadge: keysDue > 0 ? keysDue : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.warning, color: '#FFFFFF', fontSize: 11, fontWeight: '600' },
        }}
      />
      <Tab.Screen
        name="SettingsTab"
        component={SettingsScreen}
        options={{ title: 'Settings', tabBarIcon: tabIcon('settings-outline'), headerRight: () => <VersionBadge /> }}
      />
    </Tab.Navigator>
  );
}

function AppInner() {
  const { settings, loaded, wipeAll, updateSettings } = useStore();
  // Starts locked; opens once saved settings say security mode is off, or
  // when the PIN is sent in a decoy chat. Turning security mode on from
  // Settings leaves the app unlocked until it next backgrounds or restarts.
  const [locked, setLocked] = React.useState(true);
  const hiddenAt = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (!loaded) return;
    if (!settings.securityMode) {
      setLocked(false);
      return;
    }
    // The flag without its PIN record (keystore cleared) would lock the app
    // for good, so treat that as security mode being off.
    loadPinRecord()
      .then(async (record) => {
        if (record) return;
        // The decoy inbox may hold what was typed while the record was
        // missing; it goes before the wallet shows.
        await clearDecoy().catch(() => {});
        await updateSettings({ securityMode: false });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, settings.securityMode]);

  React.useEffect(() => {
    if (loaded) SplashScreen.hideAsync().catch(() => {});
  }, [loaded]);

  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        hiddenAt.current = Date.now();
      } else if (state === 'active') {
        const away = hiddenAt.current ? Date.now() - hiddenAt.current : 0;
        hiddenAt.current = null;
        if (settings.securityMode && away > RELOCK_AFTER_MS) setLocked(true);
      }
    });
    return () => sub.remove();
  }, [settings.securityMode]);

  if (!loaded) return <View style={{ flex: 1, backgroundColor: '#282828' }} />;
  if (settings.securityMode && locked) {
    return <DecoyApp onUnlock={() => setLocked(false)} onWipe={wipeAll} />;
  }

  const navTheme: Theme = {
    ...DefaultTheme,
    dark: settings.darkMode,
    colors: {
      ...DefaultTheme.colors,
      background: colors.bg,
      card: colors.card,
      text: colors.ink,
      border: colors.line,
      primary: colors.accent,
    },
  };

  return (
    <NavigationContainer theme={navTheme}>
      <StatusBar style={settings.darkMode ? 'light' : 'dark'} />
      <Stack.Navigator
        screenOptions={{
          ...headerOptions(),
          headerBackButtonDisplayMode: 'minimal',
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
        <Stack.Screen name="CreateKey" component={CreateKeyScreen} options={{ title: 'New key' }} />
        <Stack.Screen name="ImportKey" component={ImportKeyScreen} options={{ title: 'Import key' }} />
        <Stack.Screen name="KeyDetail" component={KeyDetailScreen} options={{ title: 'Key details' }} />
        <Stack.Screen name="KeyTechnical" component={KeyTechnicalScreen} options={{ title: 'Technical details' }} />
        <Stack.Screen name="ScanQR" component={ScanQRScreen} options={{ title: 'Scan QR code' }} />
        <Stack.Screen name="AddWallet" component={AddWalletScreen} options={{ title: 'Add a wallet' }} />
        <Stack.Screen name="WalletHelp" component={WalletHelpScreen} options={{ title: 'Which wallet?' }} />
        <Stack.Screen name="CreateWallet" component={CreateWalletScreen} options={{ title: 'Create wallet' }} />
        <Stack.Screen name="Tutorial" component={TutorialScreen} options={{ title: 'Guided setup' }} />
        <Stack.Screen name="VerifyBackup" component={VerifyBackupScreen} options={{ title: 'Check backup' }} />
        <Stack.Screen name="ImportWallet" component={ImportWalletScreen} options={{ title: 'Import wallet' }} />
        <Stack.Screen name="JoinGroup" component={JoinGroupScreen} options={{ title: 'Group' }} />
        <Stack.Screen name="Group" component={GroupScreen} options={{ title: 'Group' }} />
        <Stack.Screen name="GroupChat" component={GroupChatScreen} options={{ title: 'Chat' }} />
        <Stack.Screen name="Wallet" component={WalletScreen} />
        <Stack.Screen name="WalletMenu" component={WalletMenuScreen} options={{ title: 'Manage' }} />
        <Stack.Screen name="Receive" component={ReceiveScreen} options={{ title: 'Receive' }} />
        <Stack.Screen name="Send" component={SendScreen} options={{ title: 'Send' }} />
        <Stack.Screen name="Psbt" component={PsbtScreen} options={{ title: 'Signatures' }} />
        <Stack.Screen name="Advanced" component={AdvancedScreen} options={{ title: 'Details' }} />
        <Stack.Screen name="SecurityMode" component={SecurityModeScreen} options={{ title: 'Security mode' }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <KeyboardProvider>
        <StoreProvider>
          <AppInner />
        </StoreProvider>
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}
