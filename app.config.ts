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
const build = { versionCode: 1791751667 };

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  // Shown in the launcher. Deliberately bland: with security mode on the
  // app passes as a messaging app, and the name must not give it away.
  name: 'SMS',
  slug: 'simple-multi-sig',
  // The Expo account the EAS project belongs to.
  owner: 'onesandzeros-nzs-team',
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
      // Export compliance declaration: the app's cryptography is claimed as
      // exempt (standard algorithms, software for money transactions), so
      // TestFlight and App Store builds need no separate answer.
      ITSAppUsesNonExemptEncryption: false,
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
  // The EAS project this app builds and submits under (`eas init`).
  extra: { eas: { projectId: 'a0de8574-cf70-464d-bf62-e7cd3f90f35f' } },
  plugins: [
    // Release builds are signed with the Play upload key. The keystore path is
    // relative to this project; the passwords come from `.env.local`, which
    // Expo CLI loads for every command and git ignores. Without them, release
    // builds keep the debug key and the plugin says so.
    [
      './plugins/withAndroidSigning.js',
      {
        storeFile: '../my-upload-key.keystore',
        keyAlias: 'onesandzeros-key',
        storePassword: process.env.ANDROID_KEYSTORE_PASSWORD,
        keyPassword: process.env.ANDROID_KEY_PASSWORD,
      },
    ],
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
