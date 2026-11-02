/**
 * What the Settings screen says about where the keys live, from the
 * desktop shell's answer. Kept apart from keystoreInfo.ts because that
 * module has a web variant, and a `.web.ts` file importing its own name
 * would resolve to itself.
 */
export interface KeystoreInfo {
  available: boolean;
  backend: string;
}

/** A sentence for the Settings screen about where the keys live. */
export function describeKeystore(info: KeystoreInfo): { text: string; warning: boolean } {
  switch (info.backend) {
    case 'keychain':
      return { text: 'Keys are encrypted by the macOS Keychain and never leave this computer.', warning: false };
    case 'dpapi':
      return { text: 'Keys are encrypted by Windows (DPAPI), tied to your login, and never leave this computer.', warning: false };
    case 'gnome_libsecret':
      return { text: 'Keys are encrypted with a secret held by GNOME Keyring and never leave this computer.', warning: false };
    case 'kwallet':
    case 'kwallet5':
    case 'kwallet6':
      return { text: 'Keys are encrypted with a secret held by KWallet and never leave this computer.', warning: false };
    case 'basic_text':
      return {
        text:
          'This desktop has no secret service (GNOME Keyring or KWallet), so the keys on disk are only obfuscated, not encrypted. Install one, or keep this computer’s disk encrypted and its login private.',
        warning: true,
      };
    default:
      return info.available
        ? { text: 'Keys are encrypted by this computer’s keystore and never leave it.', warning: false }
        : { text: 'This computer has no keystore available: keys cannot be stored safely here.', warning: true };
  }
}
