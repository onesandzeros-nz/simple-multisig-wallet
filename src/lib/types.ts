import type { HardwareKind } from './hw/types';

export type NetworkName = 'mainnet' | 'testnet';

/**
 * A signing device this app talks to directly — a card it taps, or a hardware
 * wallet on a USB cable — rather than through files and QR codes.
 */
export type KeySource = 'tapsigner' | HardwareKind;

/**
 * A signer key known to this app. Either a key we generated locally
 * (mnemonic lives in SecureStore under `mnemonic:<id>`) or an account
 * xpub imported from a hardware wallet / another group member.
 */
export interface SignerKey {
  id: string;
  name: string;
  /** Name other group members see when this key is contributed. */
  displayName?: string;
  /** How the key arrived, when that changes how it can sign. */
  source?: KeySource;
  type: 'local' | 'imported';
  /** Master fingerprint, 8 hex chars, lowercase. */
  fingerprint: string;
  /**
   * For imported keys: the account xpub (normalised to xpub/tpub),
   * its derivation path and which network it belongs to.
   * Local keys derive their account xpub on demand for any network.
   */
  xpub?: string;
  path?: string;
  network?: NetworkName;
  createdAt: number;
  /**
   * Days between reminders to check the key still works — the written
   * phrase for a phone key, the device for a hardware key. Unset means the
   * default (a year); 0 turns reminders off.
   */
  healthCheckDays?: number;
  /** When the key last passed a health check. Unset: never — the clock runs from createdAt. */
  lastHealthCheckAt?: number;
}

/** One participant in a multisig wallet. Self-contained (embeds the xpub). */
export interface Cosigner {
  name: string;
  /** Master fingerprint, 8 hex chars. */
  fingerprint: string;
  /** Derivation path of the account xpub, e.g. m/48'/0'/0'/2'. */
  path: string;
  /** Account xpub, normalised to xpub (mainnet) / tpub (testnet). */
  xpub: string;
  /** id of the SignerKey in this app, if we hold it. */
  keyId?: string;
}

export interface MultisigWallet {
  id: string;
  name: string;
  /**
   * How the wallet is coordinated:
   *  - private: everything happens on this phone (QR, files, messaging apps)
   *  - group:   members coordinate over Nostr relays
   */
  kind: 'private' | 'group';
  /** Required signatures. */
  m: number;
  /** Total cosigners. */
  n: number;
  network: NetworkName;
  /** Always P2WSH (native segwit) in this app. */
  scriptType: 'P2WSH';
  cosigners: Cosigner[];
  createdAt: number;
  /** When a backup was last exported — unset means never backed up. */
  exportedAt?: number;
  /**
   * Whether that backup carried the wallet's group invite (RECOVERY-DESIGN.md).
   * A group wallet backed up before backups could carry it has `exportedAt`
   * but not this, and is asked for a fresh backup.
   */
  backupIncludesGroup?: boolean;
  /**
   * When a backup was last re-imported and found to match. Older than
   * exportedAt means the newer backup is unchecked.
   */
  backupVerifiedAt?: number;
  /** Guided-setup checklist. Unset means the wallet never used the guide. */
  setup?: WalletSetup;
}

// ---------------------------------------------------------------------------
// Guided setup
// ---------------------------------------------------------------------------

export type Owners = 'me' | 'pair' | 'group';

export interface PolicyAnswers {
  owners: Owners;
  /** People holding keys, including you: 1 for 'me', 2 for 'pair', 3..9 for 'group'. */
  people: number;
  /** Hardware signing devices across everyone; 3 means three or more. */
  hardwareDevices: 0 | 1 | 2 | 3;
  stakes: 'modest' | 'serious';
}

export type KeySlotKind = 'this-phone' | 'other-phone' | 'hardware';
export type KeySlotWhere = 'this-phone' | 'other-person' | 'home' | 'elsewhere';

export interface KeyPlanSlot {
  kind: KeySlotKind;
  where: KeySlotWhere;
  /** 2.. for other people's keys. */
  person?: number;
  /** The user does not own this signer yet. */
  toAcquire?: boolean;
  /** Filled in while gathering keys. */
  keyId?: string;
  /** Other people's keys: when instructions were last sent to that person. */
  instructionsSentAt?: number;
}

export interface SetupPolicy {
  m: number;
  n: number;
  recommendedM: number;
  recommendedN: number;
  slots: KeyPlanSlot[];
}

/** Progress of a guided setup before its wallet exists. At most one lives on the phone. */
export interface SetupDraft {
  version: 1;
  startedAt: number;
  updatedAt: number;
  answers: PolicyAnswers;
  /** Slots carry keyId as keys are gathered. */
  policy: SetupPolicy;
}

export type SetupExtraId = 'verify' | 'phrases' | 'address' | 'hardware' | 'testtx';

/** Guided-setup checklist kept on the wallet. */
export interface WalletSetup {
  version: 1;
  startedAt: number;
  /** Copied from the draft; absent when an existing wallet adopted the checklist later. */
  policy?: SetupPolicy;
  /** The user confirmed the exported backup is stored away from this phone. */
  backupConfirmedAt?: number;
  done: Partial<Record<SetupExtraId, number>>;
  skipped: Partial<Record<SetupExtraId, number>>;
  /** keyId → when its recovery phrase / seed backup was confirmed stored apart. */
  phraseChecks: Record<string, number>;
  /** Finish pressed; the wallet screen stops offering to continue. */
  completedAt?: number;
}

export interface Utxo {
  txid: string;
  vout: number;
  value: number;
  address: string;
  /** Derivation branch/index below the account, e.g. [0, 3]. */
  branch: number;
  index: number;
  confirmed: boolean;
  blockHeight?: number;
}

export interface AddressInfo {
  address: string;
  branch: number;
  index: number;
  txCount: number;
}

export interface WalletSnapshot {
  confirmedSats: number;
  unconfirmedSats: number;
  utxos: Utxo[];
  usedAddresses: AddressInfo[];
  /** Next unused receive address index. */
  nextReceiveIndex: number;
  nextChangeIndex: number;
  scannedAt: number;
}

export interface PendingTx {
  id: string;
  walletId: string;
  base64: string;
  memo?: string;
  createdAt: number;
  updatedAt: number;
}

/** One group key and the epoch it opens. Epoch 0 is the invite secret. */
export interface GroupEpoch {
  epoch: number;
  secret: string;
}

/**
 * A Nostr coordination group. The epoch secrets are NOT stored here — each is
 * the capability to read a stretch of the channel, so they live in the device
 * keystore alongside recovery phrases (see loadGroupEpochs in store.tsx).
 */
export interface Group {
  id: string;
  name: string;
  relays: string[];
  /** Local key id whose seed derives this device's Nostr identity. */
  identityKeyId: string;
  /**
   * The coordinator's per-group Nostr pubkey (x-only hex), carried in the
   * invite. Only `wallet` and `selection` messages from this author are
   * trusted — without it any invite holder could push a malicious wallet.
   * Optional for groups created before this field existed.
   */
  coordinatorPubkey?: string;
  /** Agreed policy: m of n. Set by the coordinator, carried in the invite. */
  m: number;
  n: number;
  /**
   * True when this group rotates its key once the roster closes
   * (REKEY-DESIGN.md), carried in the invite as `k=1`. Groups created before
   * rotation existed leave it unset and stay on epoch 0 for good.
   */
  rekey?: boolean;
  /** Highest epoch this device holds. Absent or 0 means the invite secret. */
  currentEpoch?: number;
  /**
   * When the current epoch began: the rotation time on the coordinator, the
   * sealed envelope's time on a member. A lobby `join` newer than this comes
   * from someone who has lost the key since (RECOVERY-DESIGN.md).
   */
  currentEpochAt?: number;
  /**
   * The pubkeys the current epoch was sealed to. The coordinator keeps it so a
   * member who reinstalls — and so derives the same pubkey again — can be
   * sealed back in without a fresh trust decision.
   */
  roster?: string[];
  /**
   * Coordinator: for each roster pubkey, the newest knock already answered
   * with a reseal — so a knock still on the relays is not answered again on
   * every launch.
   */
  resealed?: Record<string, number>;
  /**
   * Coordinator: for each roster pubkey, when by this phone's clock it was
   * last sealed the key. A knock's own time is the knocker's to choose; this
   * is what bounds how often one member can have envelopes published.
   */
  resealedAt?: Record<string, number>;
  /** Member: the newest knock from a coordinator that lost the key, already answered. */
  answeredCoordinatorAt?: number;
  /** Which network the group's wallet is on. */
  network: NetworkName;
  /** Keys on this phone that this device contributes to the wallet. */
  contributedKeyIds: string[];
  /** True if this device created the group. */
  coordinator: boolean;
  /** Set once the wallet has been built/received. */
  walletId?: string;
  /**
   * Member: the descriptor of a shared wallet this phone declined, so the
   * screen stops asking about it until the coordinator builds another.
   */
  declinedDescriptor?: string;
  /**
   * Coordinator: the descriptor whose members' answers card was dismissed.
   * The card matters while the wallet is new; a fresh build brings it back.
   */
  answersDismissedFor?: string;
  createdAt: number;
  /** When the chat was last opened — anything newer counts as unread. */
  lastReadChatAt?: number;
  /** When this wallet's transactions were last looked at. */
  lastSeenTxAt?: number;
}

/** A chat message kept locally so the wallet screen has history offline. */
export interface StoredChat {
  id: string;
  groupId: string;
  author: string;
  name: string;
  text: string;
  mine: boolean;
  at: number;
}

export interface HistoryItem {
  txid: string;
  /** Net effect on the wallet in sats (positive = received). */
  netSats: number;
  feeSats: number;
  confirmed: boolean;
  blockTime?: number;
}
