const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// The bitcoin libraries (via wif → bs58check@2 → create-hash) expect Node's
// core `stream` module, which React Native doesn't have.
config.resolver.extraNodeModules = {
  stream: require.resolve('stream-browserify'),
};

module.exports = config;
