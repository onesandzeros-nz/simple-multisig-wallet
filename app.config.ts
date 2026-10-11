import { ConfigContext, ExpoConfig } from 'expo/config';
import pkg from './package.json';

/**
 * The android/ and ios/ folders are generated from this file (they are
 * gitignored — Continuous Native Generation), so nothing in them is edited by
 * hand. `npx expo prebuild --clean` throws them away and rebuilds them from
 * here; `npm run prebuild-version` does that after bumping the version below.
 *
 * The version comes from package.json so there is one number to bump. The
 * build number is rewritten by scripts/prebuild-version.js (a Unix timestamp,
 * so it only ever grows) and is used for both platforms.
 */
const build = { versionCode: 1791749908 };

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  // Shown in the launcher. Deliberately bland: with security mode on the
  // app passes as a messaging app, and the name must not give it away.
  name: 'SMS',
  slug: 'simple-multisig',
  version: pkg.version,
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'light',
  ios: {
    supportsTablet: false,
    bundleIdentifier: 'nz.onesandzeros.simplemultisig',
    buildNumber: String(build.versionCode),
    infoPlist: {
      NSCameraUsageDescription: 'Scan QR codes from hardware wallets to import keys.',
      // Self-hosted nodes are usually plain http on a LAN or VPN.
      NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
    },
  },
  android: {
    package: 'nz.onesandzeros.simplemultisig',
    versionCode: build.versionCode,
    adaptiveIcon: {
      backgroundColor: '#282828',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
    // Wallet metadata never leaves the phone via cloud backup; keys live in
    // the keystore and are excluded anyway.
    allowBackup: false,
    // The prebuild template declares these. Nothing here records audio or
    // draws over other apps, and a wallet asking for either would look wrong.
    blockedPermissions: ['android.permission.RECORD_AUDIO', 'android.permission.SYSTEM_ALERT_WINDOW'],
  },
  web: {
    favicon: './assets/favicon.png',
  },
  plugins: [
    // The mark on the brand dark background, matching the app icon. 120dp
    // keeps its corners inside the circular mask Android 12+ puts on the icon.
    ['expo-splash-screen', { image: './assets/splash-icon.png', imageWidth: 120, backgroundColor: '#282828' }],
    'expo-secure-store',
    // Confirming the owner before a recovery phrase or invite is shown.
    ['expo-local-authentication', { faceIDPermission: 'Confirm it is you before a recovery phrase or invite is shown.' }],
    ['expo-camera', { cameraPermission: 'Scan QR codes from hardware wallets to import keys.' }],
    [
      'react-native-nfc-manager',
      {
        nfcPermission: 'Tap a TAPSIGNER card to import its key.',
        // Coinkite's ISO7816 application id, so iOS lets us select the card.
        selectIdentifiers: ['F0436F696E6B697465434152447631'],
      },
    ],
    // Plain-http self-hosted servers (see the Settings screen warning).
    ['expo-build-properties', { android: { usesCleartextTraffic: true } }],
    // Gradle runs out of Metaspace on release builds with the template limits.
    './plugins/withGradleJvmArgs',
  ],
});
