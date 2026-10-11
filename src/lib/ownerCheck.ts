import * as LocalAuthentication from 'expo-local-authentication';

/**
 * Asks the phone to confirm its owner before a secret is shown — biometrics,
 * or the device passcode when there are none or they fail. An unlocked phone
 * in the wrong hands should not be one tap from a recovery phrase.
 *
 * A phone with no passcode at all has nothing to confirm with, and is open
 * to whoever holds it anyway: the secret is shown as before. Anything that
 * goes wrong in the prompt counts as a no; the prompt itself has already
 * said why.
 */
export async function confirmOwner(reason: string): Promise<boolean> {
  try {
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    if (level === LocalAuthentication.SecurityLevel.NONE) return true;
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
    });
    return result.success;
  } catch {
    return false;
  }
}
