import { NavigatorScreenParams } from '@react-navigation/native';

export type TabParamList = {
  WalletsTab: undefined;
  KeysTab: undefined;
  SettingsTab: undefined;
};

export type RootStackParamList = {
  Tabs: NavigatorScreenParams<TabParamList> | undefined;
  CreateKey: undefined;
  /** verifyKeyId: re-read a key from its device and compare, instead of importing. */
  ImportKey: { scanned?: string; verifyKeyId?: string } | undefined;
  KeyDetail: { keyId: string };
  KeyTechnical: { keyId: string };
  ScanQR: {
    returnTo: 'ImportKey' | 'ImportWallet' | 'JoinGroup' | 'Send' | 'Psbt' | 'Wallet' | 'WalletMenu' | 'VerifyBackup';
    walletId?: string;
    pendingId?: string;
    /** For ImportKey in verify mode — popTo replaces params, so it rides along. */
    keyId?: string;
  };
  /**
   * restore: rejoin the group of an existing wallet (walletId) after a lost
   * phone — the invite usually comes from the wallet's backup, which also
   * names the identity key to use (RECOVERY-DESIGN.md).
   */
  JoinGroup:
    | { mode?: 'create' | 'join' | 'restore'; scanned?: string; walletId?: string; identityFingerprint?: string }
    | undefined;
  Group: { groupId: string };
  GroupChat: { groupId: string };
  AddWallet: undefined;
  WalletHelp: undefined;
  CreateWallet: undefined;
  /** Guided private-wallet setup; walletId once the wallet exists. */
  Tutorial: { walletId?: string } | undefined;
  VerifyBackup: { walletId: string; scanned?: string };
  ImportWallet: { scanned?: string } | undefined;
  Wallet: { walletId: string; scanned?: string };
  WalletMenu: { walletId: string; scanned?: string };
  Receive: { walletId: string };
  Send: { walletId: string; scanned?: string };
  Psbt: { walletId: string; pendingId: string; scanned?: string };
  Advanced: { walletId: string };
  SecurityMode: undefined;
};
