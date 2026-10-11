const path = require('path');
const { withAppBuildGradle } = require('expo/config-plugins');

/**
 * Signs Android release builds with the upload key for Google Play.
 *
 * The android/ folder is generated, so the signing config cannot live in it;
 * this appends it to android/app/build.gradle at prebuild. Props come from
 * app.config.ts: the keystore path (relative to the project root, or
 * absolute), the key alias, and the two passwords, which app.config.ts reads
 * from the environment — put them in `.env.local`, which Expo CLI loads for
 * every command and git ignores.
 *
 * Without the passwords nothing is changed and the template's debug signing
 * stays, with a warning. That is also what an EAS cloud build sees: it has
 * no `.env.local`, and brings its own signing instead.
 */
module.exports = function withAndroidSigning(config, props = {}) {
  const { storeFile, keyAlias, storePassword, keyPassword } = props;
  if (!storeFile || !keyAlias) return config;
  if (!storePassword || !keyPassword) {
    console.warn(
      '[android-signing] ANDROID_KEYSTORE_PASSWORD or ANDROID_KEY_PASSWORD is not set: release builds keep the debug signing key.'
    );
    return config;
  }
  return withAppBuildGradle(config, (config) => {
    if (config.modResults.contents.includes(MARKER)) return config;
    const keystore = path.resolve(config.modRequest.projectRoot, storeFile);
    config.modResults.contents += `
${MARKER}
// The upload key for Google Play (plugins/withAndroidSigning.js). A second
// android {} block configures the same extension; the template's debug
// signing is left for debug builds.
android {
    signingConfigs {
        release {
            storeFile file(${groovy(keystore)})
            storePassword ${groovy(storePassword)}
            keyAlias ${groovy(keyAlias)}
            keyPassword ${groovy(keyPassword)}
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
        }
    }
}
`;
    return config;
  });
};

const MARKER = '// @simple-multisig/android-signing';

/** A Groovy single-quoted string: no interpolation, so a `$` in a password is just a `$`. */
function groovy(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
