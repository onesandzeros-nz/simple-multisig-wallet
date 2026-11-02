const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// The bitcoin libraries (via wif → bs58check@2 → create-hash) expect Node's
// core `stream` module, which React Native doesn't have.
config.resolver.extraNodeModules = {
  stream: require.resolve('stream-browserify'),
};

// The QR decoder the camera uses on the web is WebAssembly, bundled as an
// asset so the desktop app needs no CDN (see src/platform/setup.web.ts).
config.resolver.assetExts = [...config.resolver.assetExts, 'wasm'];

/**
 * The web bundle — which is what the desktop app runs — swaps the phone-only
 * modules for implementations backed by the Electron shell (src/platform),
 * and drops the two libraries that are only ever `require()`d inside a
 * try/catch. Native builds are untouched: the resolver defers to the default
 * for every other platform and module.
 */
const WEB_REPLACEMENTS = {
  'expo-secure-store': path.resolve(__dirname, 'src/platform/secureStore.web.ts'),
  '@react-native-async-storage/async-storage': path.resolve(__dirname, 'src/platform/asyncStorage.web.ts'),
  'expo-screen-capture': path.resolve(__dirname, 'src/platform/screenCapture.web.ts'),
  'expo-document-picker': path.resolve(__dirname, 'src/platform/documentPicker.web.ts'),
};
const WEB_EMPTY = new Set(['react-native-tcp-socket', 'react-native-nfc-manager']);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web') {
    if (WEB_REPLACEMENTS[moduleName]) return { type: 'sourceFile', filePath: WEB_REPLACEMENTS[moduleName] };
    if (WEB_EMPTY.has(moduleName)) return { type: 'empty' };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
