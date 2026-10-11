import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { Group, GroupEpoch, MultisigWallet, NetworkName, PendingTx, SetupDraft, SignerKey, StoredChat } from './types';
import { applyTheme } from '../theme';
import { BackendSettings, DEFAULT_BACKEND_SETTINGS, effectiveBackend, migrateBackendSettings } from './chain';
import { setBackend } from './chain';
import { invalidate as invalidateWalletCache } from './walletCache';
import { forgetSettled } from './settled';
import { linkCosigners, renameCosigners } from './linkCosigners';
import { accountXpub } from './bitcoin';
import { DEFAULT_RELAYS } from './nostr/protocol';
import { deleteAllOutboxes, deleteOutbox } from './nostr/outboxStore';
import { clearDeviceMemory } from './hw/memory';
import { parseEpochs, serialiseEpochs, withEpoch } from './nostr/epochs';

const KEYS_KEY = 'sms.keys.v1';
const WALLETS_KEY = 'sms.wallets.v1';
const PENDING_KEY = 'sms.pending.v1';
const SETTINGS_KEY = 'sms.settings.v1';
const GROUPS_KEY = 'sms.groups.v1';
const CHATS_KEY = 'sms.chats.v1';
/** The one in-progress guided setup that has no wallet yet. */
const SETUP_KEY = 'sms.setup.v1';

export interface AppSettings extends BackendSettings {
  darkMode: boolean;
  /** Local key whose seed derives this device's Nostr identity (NIP-06). */
  identityKeyId: string | null;
  /** Relays the user added themselves. See effectiveRelays(). */
  relays: string[];
  /** Include the built-in public relays alongside the user's own. */
  publicRelays: boolean;
  /** Network for keys and wallets created from now on. */
  testnet: boolean;
  /**
   * The app opens as a messaging app until the PIN is sent in a chat; the
   * PIN record itself is in the keystore (securityMode.ts).
   */
  securityMode: boolean;
  /**
   * What the people in shared wallets call this phone's owner, and what new
   * phone keys are named after (naming.ts). Asked for the first time a key
   * is made; empty until then.
   */
  userName: string;
  /**
   * What the last emergency wipe could not erase, by keystore name (or
   * `hw.*` / `outbox.*` for the stores that keep their own lists). Tried
   * again on every launch and from the Home screen, which says so until it
   * is empty. Settings outlive a wipe, so this does too.
   */
  wipeLeftovers: string[];
}

const DEFAULT_SETTINGS: AppSettings = {
  darkMode: false,
  ...DEFAULT_BACKEND_SETTINGS,
  identityKeyId: null,
  relays: [],
  publicRelays: true,
  testnet: false,
  securityMode: false,
  userName: '',
  wipeLeftovers: [],
};

/**
 * The relays group coordination actually uses: the built-in public set
 * (when enabled) plus whatever the user added in Settings.
 */
export function effectiveRelays(s: AppSettings): string[] {
  return s.publicRelays ? [...new Set([...DEFAULT_RELAYS, ...s.relays])] : s.relays;
}

/**
 * Groups saved by earlier builds predate the policy and contribution
 * fields — fill them in so screens can rely on their presence.
 */
function migrateGroup(g: any): Group {
  return {
    ...g,
    m: typeof g.m === 'number' ? g.m : 2,
    n: typeof g.n === 'number' ? g.n : Math.max(2, typeof g.m === 'number' ? g.m : 2),
    contributedKeyIds: Array.isArray(g.contributedKeyIds) ? g.contributedKeyIds : [],
    network: g.network === 'testnet' ? 'testnet' : 'mainnet',
    relays: Array.isArray(g.relays) ? g.relays : [],
  };
}

function applySettingsSideEffects(s: AppSettings): void {
  applyTheme(s.darkMode);
  setBackend(effectiveBackend(s));
}

export function newId(): string {
  return Crypto.randomUUID();
}

// --- Mnemonics live ONLY in SecureStore (iOS Keychain / Android Keystore) ---

const mnemonicKey = (keyId: string) => `mnemonic.${keyId}`;

export async function saveMnemonic(keyId: string, mnemonic: string): Promise<void> {
  await SecureStore.setItemAsync(mnemonicKey(keyId), mnemonic, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function loadMnemonic(keyId: string): Promise<string | null> {
  return SecureStore.getItemAsync(mnemonicKey(keyId));
}

export async function deleteMnemonic(keyId: string): Promise<void> {
  await SecureStore.deleteItemAsync(mnemonicKey(keyId));
}

// --- Group epoch secrets also live in the keystore ---------------------------
// Whoever holds one can decrypt everything that group put on a relay for that
// epoch, so they get the same protection as a recovery phrase.
//
// Stored as a JSON array of epochs (REKEY-DESIGN.md). Builds from before
// rotation wrote a bare hex string; that is read back as epoch 0 and rewritten
// as JSON by the next save, so no migration pass is needed.

const groupKey = (groupId: string) => `group.${groupId}`;

async function writeGroupEpochs(groupId: string, epochs: GroupEpoch[]): Promise<void> {
  await SecureStore.setItemAsync(groupKey(groupId), serialiseEpochs(epochs), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function loadGroupEpochs(groupId: string): Promise<GroupEpoch[]> {
  return parseEpochs(await SecureStore.getItemAsync(groupKey(groupId)));
}

/** Stores the invite secret as epoch 0, discarding any rotation history. */
export async function saveGroupSecret(groupId: string, secret: string): Promise<void> {
  await writeGroupEpochs(groupId, [{ epoch: 0, secret }]);
}

/**
 * The invite secret — epoch 0. It is the group's permanent identity root and
 * what the invite QR shows, so it is what most callers want; use
 * `loadGroupEpochs` to read or write messages.
 */
export async function loadGroupSecret(groupId: string): Promise<string | null> {
  const epochs = await loadGroupEpochs(groupId);
  return epochs.find((e) => e.epoch === 0)?.secret ?? null;
}

/**
 * Records a rotated epoch. Idempotent: a group can have two live sessions (a
 * list syncing in the background while its screen is open) and both will adopt
 * the same epoch.
 */
export async function addGroupEpoch(groupId: string, epoch: GroupEpoch): Promise<GroupEpoch[]> {
  const epochs = await loadGroupEpochs(groupId);
  const next = withEpoch(epochs, epoch);
  if (next === epochs) return epochs;
  await writeGroupEpochs(groupId, next);
  return next;
}

export async function deleteGroupSecret(groupId: string): Promise<void> {
  await SecureStore.deleteItemAsync(groupKey(groupId));
}

// --- Finishing a wipe ----------------------------------------------------------
// A wipe deletes keystore entries first, then the lists that named them. A
// delete that fails is written down by name, so a later attempt knows what to
// delete without the lists. Device memory and the outboxes keep lists of
// their own, so one name stands for each.

const DEVICE_MEMORY_LEFTOVER = 'hw.*';
const OUTBOX_LEFTOVER = 'outbox.*';

/** Tries again to erase what an earlier wipe could not. Returns what still would not go. */
export async function eraseLeftovers(names: string[]): Promise<string[]> {
  const left: string[] = [];
  for (const name of names) {
    try {
      if (name === DEVICE_MEMORY_LEFTOVER) await clearDeviceMemory([]);
      else if (name === OUTBOX_LEFTOVER) await deleteAllOutboxes();
      else await SecureStore.deleteItemAsync(name);
    } catch {
      left.push(name);
    }
  }
  return left;
}

// --- App state ---

interface StoreShape {
  loaded: boolean;
  keys: SignerKey[];
  wallets: MultisigWallet[];
  pendingTxs: PendingTx[];
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  groups: Group[];
  chats: StoredChat[];
  /** Pass the invite secret on first save; it is stored in the keystore. */
  saveGroup: (group: Group, secret?: string) => Promise<void>;
  /**
   * Like updateWallet: a function patch is resolved against the group as it
   * is *now*. Background sessions write to group records (an adopted epoch, a
   * knock answered) while screens do too, so they must not start from a copy
   * taken when they rendered.
   */
  updateGroup: (id: string, patch: Partial<Group> | ((group: Group) => Partial<Group>)) => Promise<void>;
  removeGroup: (id: string) => Promise<void>;
  addChats: (messages: StoredChat[]) => Promise<void>;
  addKey: (key: SignerKey) => Promise<void>;
  updateKey: (id: string, patch: Partial<SignerKey>) => Promise<void>;
  removeKey: (id: string) => Promise<void>;
  addWallet: (wallet: MultisigWallet) => Promise<void>;
  /**
   * A function patch is resolved against the wallet as it is *now*, not as
   * it was when the caller rendered — use it for writes that may race with
   * other writers (an export finishing while a sync ticks the checklist).
   */
  updateWallet: (
    id: string,
    patch: Partial<MultisigWallet> | ((wallet: MultisigWallet) => Partial<MultisigWallet>)
  ) => Promise<void>;
  removeWallet: (id: string) => Promise<void>;
  savePendingTx: (tx: PendingTx) => Promise<void>;
  removePendingTx: (id: string) => Promise<void>;
  /** Guided setup in progress before its wallet exists; null when none. */
  setupDraft: SetupDraft | null;
  /** Pass null to discard the draft (after the wallet is created, or on start over). */
  saveSetupDraft: (draft: SetupDraft | null) => Promise<void>;
  /**
   * Erases every key, wallet, group, chat, draft, unsent group message and
   * hardware wallet pairing — recovery phrases, group secrets and device
   * memory in the keystore included. Settings survive, so security mode
   * stays on and the app keeps looking like a messaging app afterwards.
   * Whatever could not be erased is kept by name in `settings.wipeLeftovers`
   * and tried again on the next launch; this throws when there is any.
   */
  wipeAll: () => Promise<void>;
  /** Tries again to erase what the last wipe could not. Throws if anything still will not go. */
  retryWipe: () => Promise<void>;
}

const StoreContext = createContext<StoreShape | null>(null);

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const [keys, setKeys] = useState<SignerKey[]>([]);
  const [wallets, setWallets] = useState<MultisigWallet[]>([]);
  // The mutators below close over render-time state; a long-running handler
  // (share sheet, NFC wait) must not overwrite a write made meanwhile, so
  // they read the latest wallets from here instead of the closure.
  const walletsRef = useRef<MultisigWallet[]>([]);
  const [pendingTxs, setPendingTxs] = useState<PendingTx[]>([]);
  // Mirrors `pendingTxs` synchronously. Mutators read this, not the state, so
  // several saves in one render (a relay backlog of drafts) each see the
  // previous one instead of a stale snapshot — which is also what keeps the
  // per-wallet draft cap honest within a single batch.
  const pendingTxsRef = useRef<PendingTx[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [groups, setGroups] = useState<Group[]>([]);
  // Mirrors `groups` synchronously, for the same reason as walletsRef: group
  // records are written from live relay sessions as well as from screens.
  const groupsRef = useRef<Group[]>([]);
  const [chats, setChats] = useState<StoredChat[]>([]);
  const [setupDraft, setSetupDraft] = useState<SetupDraft | null>(null);
  // Account xpubs derived from each local key's seed, per network. Cosigner
  // linking uses these as proof of possession — never a bare fingerprint.
  const localXpubsRef = useRef<Map<string, Partial<Record<NetworkName, string>>>>(new Map());

  const rememberLocalXpubs = useCallback(async (key: SignerKey) => {
    if (key.type !== 'local') return;
    try {
      const mnemonic = await loadMnemonic(key.id);
      if (mnemonic) {
        localXpubsRef.current.set(key.id, {
          mainnet: accountXpub(mnemonic, 'mainnet'),
          testnet: accountXpub(mnemonic, 'testnet'),
        });
      }
    } catch {
      // Keystore unavailable — the key simply stays unlinked until next launch.
    }
  }, []);

  const localXpubFor = useCallback(
    (keyId: string, network: NetworkName) => localXpubsRef.current.get(keyId)?.[network],
    []
  );

  useEffect(() => {
    (async () => {
      try {
        const [k, w, p, s, g, c, d] = await Promise.all([
          AsyncStorage.getItem(KEYS_KEY),
          AsyncStorage.getItem(WALLETS_KEY),
          AsyncStorage.getItem(PENDING_KEY),
          AsyncStorage.getItem(SETTINGS_KEY),
          AsyncStorage.getItem(GROUPS_KEY),
          AsyncStorage.getItem(CHATS_KEY),
          AsyncStorage.getItem(SETUP_KEY),
        ]);
        if (d) {
          // It is only a draft — anything malformed is dropped rather than migrated.
          const raw = JSON.parse(d);
          if (raw && raw.answers && raw.policy && Array.isArray(raw.policy.slots)) {
            setSetupDraft({ ...raw, version: 1 });
          }
        }
        const loadedKeys: SignerKey[] = k ? JSON.parse(k) : [];
        setKeys(loadedKeys);
        // Re-derive each local key's account xpubs so cosigner linking has
        // proof of possession to match against.
        for (const key of loadedKeys) await rememberLocalXpubs(key);
        const rawGroups: any[] = g ? JSON.parse(g) : [];
        // Earlier builds kept the invite secret in plain storage. Move any we
        // find into the keystore and strip it from the record.
        let movedASecret = false;
        for (const raw of rawGroups) {
          if (typeof raw.secret === 'string' && raw.secret) {
            try {
              await saveGroupSecret(raw.id, raw.secret);
              delete raw.secret;
              movedASecret = true;
            } catch (e) {
              // Keep the group usable if the keystore write fails — but this
              // means the invite secret is still sitting in plaintext storage,
              // so make the failure visible rather than swallowing it.
              console.warn(`Could not move group ${raw.id} secret into the keystore; it remains in plaintext storage.`, e);
            }
          }
        }
        const loadedGroups: Group[] = rawGroups.map(migrateGroup);
        if (movedASecret) {
          await AsyncStorage.setItem(GROUPS_KEY, JSON.stringify(loadedGroups));
        }
        if (w) {
          // Wallets saved before the private/group split get their kind from
          // whether any group was coordinating them.
          const migrated: MultisigWallet[] = (JSON.parse(w) as any[]).map((wallet) => ({
            ...wallet,
            kind:
              wallet.kind ??
              (loadedGroups.some((grp) => grp.walletId === wallet.id) ? 'group' : 'private'),
          }));
          // Repair cosigner links for data saved before linking became
          // order-independent (keys added after the wallet were never linked).
          const linked = linkCosigners(migrated, loadedKeys, localXpubFor);
          walletsRef.current = linked.wallets;
          setWallets(linked.wallets);
          if (linked.changed) {
            await AsyncStorage.setItem(WALLETS_KEY, JSON.stringify(linked.wallets));
          }
        }
        if (p) {
          const loadedPending: PendingTx[] = JSON.parse(p);
          pendingTxsRef.current = loadedPending;
          setPendingTxs(loadedPending);
        }
        groupsRef.current = loadedGroups;
        setGroups(loadedGroups);
        if (c) setChats(JSON.parse(c));
        if (s) {
          const parsed = JSON.parse(s);
          // Settings saved before the public-relays toggle kept one mixed
          // list (defaults + custom). Split it: the user's own relays stay,
          // and the toggle is on unless they had removed every default.
          const rawRelays: string[] = Array.isArray(parsed.relays) ? parsed.relays : [];
          const migratingRelays = typeof parsed.publicRelays !== 'boolean';
          const loadedSettings: AppSettings = {
            ...DEFAULT_SETTINGS,
            ...parsed,
            relays: migratingRelays ? rawRelays.filter((r) => !DEFAULT_RELAYS.includes(r)) : rawRelays,
            publicRelays: migratingRelays
              ? rawRelays.length === 0 || rawRelays.some((r) => DEFAULT_RELAYS.includes(r))
              : parsed.publicRelays,
            // Earlier builds stored one server; now the public pick and
            // the user's own server are kept apart.
            ...migrateBackendSettings(parsed),
          };
          // Leave the old single-server fields behind.
          delete (loadedSettings as any).backend;
          delete (loadedSettings as any).esploraUrl;
          // Before there was one name for the person, each phone key could
          // carry its own group name. The first of those becomes the name.
          if (typeof loadedSettings.userName !== 'string' || !loadedSettings.userName.trim()) {
            const legacy = loadedKeys.find((k) => k.type === 'local' && k.displayName?.trim());
            loadedSettings.userName = legacy?.displayName?.trim() ?? '';
          }
          loadedSettings.wipeLeftovers = Array.isArray(parsed.wipeLeftovers)
            ? parsed.wipeLeftovers.filter((n: unknown): n is string => typeof n === 'string')
            : [];
          // A wipe that could not erase everything is finished here, before
          // anything is shown.
          if (loadedSettings.wipeLeftovers.length > 0) {
            loadedSettings.wipeLeftovers = await eraseLeftovers(loadedSettings.wipeLeftovers);
            await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(loadedSettings));
          }
          applySettingsSideEffects(loadedSettings);
          setSettings(loadedSettings);
        }
      } catch (e) {
        // Corrupted app storage must not wedge the app behind a blank screen —
        // start with empty state rather than crash on a malformed record.
        console.error('[store] could not load saved state; starting with defaults.', e);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const persistKeys = useCallback(async (next: SignerKey[]) => {
    setKeys(next);
    await AsyncStorage.setItem(KEYS_KEY, JSON.stringify(next));
  }, []);
  const persistWallets = useCallback(async (next: MultisigWallet[]) => {
    walletsRef.current = next;
    setWallets(next);
    await AsyncStorage.setItem(WALLETS_KEY, JSON.stringify(next));
  }, []);
  const persistPending = useCallback(async (next: PendingTx[]) => {
    pendingTxsRef.current = next;
    setPendingTxs(next);
    await AsyncStorage.setItem(PENDING_KEY, JSON.stringify(next));
  }, []);
  const persistGroups = useCallback(async (next: Group[]) => {
    groupsRef.current = next;
    setGroups(next);
    await AsyncStorage.setItem(GROUPS_KEY, JSON.stringify(next));
  }, []);
  const persistSetup = useCallback(async (next: SetupDraft | null) => {
    setSetupDraft(next);
    if (next) await AsyncStorage.setItem(SETUP_KEY, JSON.stringify(next));
    else await AsyncStorage.removeItem(SETUP_KEY);
  }, []);
  const persistChats = useCallback(async (next: StoredChat[]) => {
    setChats(next);
    await AsyncStorage.setItem(CHATS_KEY, JSON.stringify(next));
  }, []);

  const value: StoreShape = {
    loaded,
    keys,
    wallets,
    pendingTxs,
    settings,
    updateSettings: async (patch) => {
      const next = { ...settings, ...patch };
      applySettingsSideEffects(next);
      setSettings(next);
      await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    },
    addKey: async (key) => {
      await rememberLocalXpubs(key);
      const nextKeys = [...keys, key];
      await persistKeys(nextKeys);
      const linked = linkCosigners(walletsRef.current, nextKeys, localXpubFor);
      if (linked.changed) await persistWallets(linked.wallets);
    },
    updateKey: async (id, patch) => {
      await persistKeys(keys.map((k) => (k.id === id ? { ...k, ...patch } : k)));
      if (patch.name === undefined) return;
      const renamed = renameCosigners(walletsRef.current, id, patch.name);
      if (renamed.changed) await persistWallets(renamed.wallets);
    },
    removeKey: async (id) => {
      await deleteMnemonic(id);
      localXpubsRef.current.delete(id);
      const nextKeys = keys.filter((k) => k.id !== id);
      await persistKeys(nextKeys);
      const linked = linkCosigners(walletsRef.current, nextKeys, localXpubFor);
      if (linked.changed) await persistWallets(linked.wallets);
    },
    addWallet: (wallet) =>
      walletsRef.current.some((w) => w.id === wallet.id)
        ? Promise.resolve()
        : persistWallets([...walletsRef.current, linkCosigners([wallet], keys, localXpubFor).wallets[0]]),
    updateWallet: (id, patch) =>
      persistWallets(
        walletsRef.current.map((w) =>
          w.id === id ? { ...w, ...(typeof patch === 'function' ? patch(w) : patch) } : w
        )
      ),
    removeWallet: async (id) => {
      await persistWallets(walletsRef.current.filter((w) => w.id !== id));
      await persistPending(pendingTxsRef.current.filter((t) => t.walletId !== id));
      invalidateWalletCache(id);
      forgetSettled(id);
      // A group-coordinated wallet owns a group. Removing the wallet must take
      // the group with it — its record, its invite secret in the keystore, and
      // its chat history — so nothing dangles behind a deleted wallet. Keys are
      // shared across the app and are deliberately left untouched.
      const linkedGroups = groupsRef.current.filter((g) => g.walletId === id);
      if (linkedGroups.length > 0) {
        const goneIds = new Set(linkedGroups.map((g) => g.id));
        for (const g of linkedGroups) await deleteGroupSecret(g.id);
        await persistGroups(groupsRef.current.filter((g) => !goneIds.has(g.id)));
        await persistChats(chats.filter((c) => !goneIds.has(c.groupId)));
      }
    },
    savePendingTx: (tx) => {
      const rest = pendingTxsRef.current.filter((t) => t.id !== tx.id);
      return persistPending([...rest, tx]);
    },
    removePendingTx: (id) => persistPending(pendingTxsRef.current.filter((t) => t.id !== id)),
    setupDraft,
    saveSetupDraft: (draft) => persistSetup(draft ? { ...draft, updatedAt: Date.now() } : null),
    wipeAll: async () => {
      // Keystore entries first: they are the part that matters if anything
      // below fails, and each delete is independent of the others. One that
      // fails is written down by name — the lists that named it are about to
      // go — so the next launch can try again (`eraseLeftovers`).
      const leftovers = new Set(settings.wipeLeftovers);
      let firstFailure: unknown = null;
      const erase = async (name: string, run: () => Promise<void>) => {
        try {
          await run();
          leftovers.delete(name);
        } catch (e) {
          firstFailure = firstFailure ?? e;
          leftovers.add(name);
        }
      };
      for (const k of keys) await erase(mnemonicKey(k.id), () => deleteMnemonic(k.id));
      for (const g of groupsRef.current) await erase(groupKey(g.id), () => deleteGroupSecret(g.id));
      // Hardware wallet memory is in the keystore too: the key this phone
      // pairs with a BitBox02 under, and the Ledgers' approvals of these wallets.
      await erase(DEVICE_MEMORY_LEFTOVER, () => clearDeviceMemory(walletsRef.current));
      for (const w of walletsRef.current) {
        invalidateWalletCache(w.id);
        forgetSettled(w.id);
      }
      localXpubsRef.current.clear();
      // The outboxes hold plaintext — unsigned transactions, memos, chat —
      // waiting for a relay. Live ones are emptied first, or they would write
      // themselves back; then every `outbox.*` key on disk, orphans included.
      await erase(OUTBOX_LEFTOVER, () => deleteAllOutboxes());
      await AsyncStorage.multiRemove([KEYS_KEY, WALLETS_KEY, PENDING_KEY, GROUPS_KEY, CHATS_KEY, SETUP_KEY]);
      walletsRef.current = [];
      pendingTxsRef.current = [];
      groupsRef.current = [];
      setKeys([]);
      setWallets([]);
      setPendingTxs([]);
      setGroups([]);
      setChats([]);
      setSetupDraft(null);
      // The identity key is gone with the rest.
      const next = { ...settings, identityKeyId: null, wipeLeftovers: [...leftovers] };
      setSettings(next);
      await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      if (firstFailure) throw firstFailure;
    },
    retryWipe: async () => {
      const left = await eraseLeftovers(settings.wipeLeftovers);
      const next = { ...settings, wipeLeftovers: left };
      setSettings(next);
      await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      if (left.length > 0) {
        throw new Error(`${left.length} ${left.length === 1 ? 'entry' : 'entries'} in the keystore still could not be erased.`);
      }
    },
    groups,
    chats,
    saveGroup: async (group, secret) => {
      if (secret) await saveGroupSecret(group.id, secret);
      await persistGroups([...groupsRef.current.filter((g) => g.id !== group.id), group]);
    },
    updateGroup: async (id, patch) => {
      const current = groupsRef.current.find((g) => g.id === id);
      if (!current) return;
      const changes = typeof patch === 'function' ? patch(current) : patch;
      if (Object.keys(changes).length === 0) return;
      await persistGroups(groupsRef.current.map((g) => (g.id === id ? { ...g, ...changes } : g)));
    },
    removeGroup: async (id) => {
      await deleteGroupSecret(id);
      await deleteOutbox(id);
      await persistGroups(groupsRef.current.filter((g) => g.id !== id));
      await persistChats(chats.filter((c) => c.groupId !== id));
    },
    addChats: (messages) => {
      const known = new Set(chats.map((c) => c.id));
      const fresh = messages.filter((m) => !known.has(m.id));
      if (fresh.length === 0) return Promise.resolve();
      return persistChats([...chats, ...fresh].sort((a, b) => a.at - b.at).slice(-500));
    },
  };

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreShape {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used inside StoreProvider');
  return ctx;
}
