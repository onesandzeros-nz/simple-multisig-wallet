import * as bitcoin from 'bitcoinjs-lib';
import { btcNetwork, walletDescriptor } from './bitcoin';
import type { GroupBackup } from './groupBackup';
import { cleanLabel, NAME_INPUT_CHARS } from './naming';
import { isFingerprint } from './slip132';
import { Cosigner, KeySource, MultisigWallet, NetworkName, PendingTx, SignerKey } from './types';
import { GAP_LIMIT, parsePsbt, summarisePsbt, unsignedTxId, WalletSync } from './wallet';

/**
 * BIP-139 wallet metadata export: one JSON object carrying what this phone
 * knows about a wallet beyond its descriptor — who holds which key and on
 * what, the coins and history it has seen, drafts in flight, and for a group
 * wallet the group invite — so another application can pick the wallet up
 * without the user re-entering any of it.
 *
 * Written against bip-0139.md and bip-0139/field-registry.md as merged on
 * 2026-10-24. Everything here is public: xpubs, fingerprints, names,
 * outpoints. No mnemonic, private key or group epoch key ever goes in, as the
 * BIP requires for an export that may be kept online.
 *
 * This is a third backup format next to the Coldcard-style text file and the
 * printed PDF, not a replacement: Sparrow, Nunchuk and Coldcard read the text
 * file and none of them read BIP-139 yet, so the text file stays as it is.
 */

/**
 * The format version this app writes. BIP-139 fixes the shape `BIP139-<n>`
 * and bumps `<n>` only for incompatible changes, but the merged text names
 * no starting value; its review read the published format as version 1.
 * Readers accept any `BIP139-<n>` (new mandatory fields are the only
 * incompatible change the BIP allows, and a reader only needs the ones it knows).
 */
export const BIP139_VERSION = 'BIP139-1';

/** This app's namespace inside a `proprietary` object. */
export const BIP139_PROPRIETARY_KEY = 'simplemultisig';

/** The most of a memo taken from a file that is kept. */
const MEMO_CHARS = 200;

/** Genesis block times, for the birth-height estimate the registry allows. */
const GENESIS_TIME: Record<NetworkName, number> = { mainnet: 1231006505, testnet: 1296688602 };

/** The registry's device object for each signer this app talks to directly. */
const DEVICES: Record<KeySource, { vendor: string; model?: string; transports: string[] }> = {
  ledger: { vendor: 'Ledger', transports: ['usb'] },
  trezor: { vendor: 'Trezor', transports: ['usb'] },
  bitbox02: { vendor: 'Shift Crypto', model: 'BitBox02', transports: ['usb'] },
  tapsigner: { vendor: 'Coinkite', model: 'TAPSIGNER', transports: ['nfc'] },
};

const ACCOUNT_STATUSES = ['active', 'superseded', 'archived'] as const;
export type Bip139AccountStatus = (typeof ACCOUNT_STATUSES)[number];

const seconds = (ms: number): number => Math.floor(ms / 1000);

/** Drops undefined members, so what is built equals what JSON carries. */
function compact<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as T;
}

/**
 * The BIP-139 name of a wallet's network. This app's testnet wallets are
 * scanned on testnet3 (the `/testnet` of Blockstream's and mempool.space's
 * Esplora), so that is what the export says.
 */
export function bip139Network(network: NetworkName): 'bitcoin' | 'testnet3' {
  return network === 'mainnet' ? 'bitcoin' : 'testnet3';
}

/**
 * This app's network for a BIP-139 network name. The three test networks
 * that share tpub keys and tb1 addresses import as testnet, with a warning
 * that their coins live on another chain than the one this app scans.
 */
export function networkFromBip139(name: string): { network: NetworkName; warning?: string } {
  switch (name) {
    case 'bitcoin':
      return { network: 'mainnet' };
    case 'testnet3':
      return { network: 'testnet' };
    case 'testnet4':
    case 'signet':
    case 'mutinynet':
      return {
        network: 'testnet',
        warning: `This export is for ${name}. The wallet imports as testnet, but this app looks for its coins on testnet3, so the balance may not show.`,
      };
    case 'regtest':
      throw new Error('This export is for regtest, which this app does not support.');
    default:
      throw new Error(`Unknown network "${name}" in this BIP-139 export.`);
  }
}

/**
 * The registry's estimate for a time without a chain source: blocks since
 * genesis at the ten-minute target. The chain has always run ahead of that
 * target, so this lands below the true height — too early costs an importer
 * scanning time, too late would silently lose transactions.
 */
export function estimateHeight(timeSec: number, network: NetworkName): number {
  return Math.max(0, Math.floor((timeSec - GENESIS_TIME[network]) / 600));
}

/**
 * `birth_block`: a height at or before everything the wallet has received.
 *
 * `createdAt` alone is not enough: a wallet imported from another app was
 * created there, possibly years before this record, and a height estimated
 * from the import date would come after coins it already had. So the
 * estimate is lowered to the earliest coin or transaction seen — and only
 * claimed at all when the sync says every used address's history is
 * complete. Esplora hands over one page of 25 confirmed transactions per
 * address, so a busy address can hide older activity; a cache from before
 * completeness was recorded says nothing until a rescan. Undefined when
 * nothing can be said.
 */
export function birthHeight(wallet: MultisigWallet, sync: WalletSync | null | undefined): number | undefined {
  if (!sync) return undefined;
  const complete = sync.snapshot.usedAddresses.every((a) => sync.addressHistoryComplete?.[a.address] === true);
  if (!complete) return undefined;
  let birth = wallet.createdAt > 0 ? estimateHeight(seconds(wallet.createdAt), wallet.network) : Infinity;
  for (const h of sync.history) {
    if (h.confirmed && h.blockTime) birth = Math.min(birth, estimateHeight(h.blockTime, wallet.network));
  }
  for (const u of sync.snapshot.utxos) {
    if (u.confirmed && u.blockHeight !== undefined) birth = Math.min(birth, u.blockHeight);
  }
  return Number.isFinite(birth) && birth > 0 ? birth : undefined;
}

function outputScriptHex(address: string, network: bitcoin.Network): string | undefined {
  try {
    return bitcoin.address.toOutputScript(address, network).toString('hex');
  } catch {
    return undefined;
  }
}

/** The registry's signer object for a key this phone holds, or undefined when nothing is known about its holder. */
function signerFor(key: SignerKey | undefined, fingerprint: string): Record<string, unknown> | undefined {
  if (!key) return undefined;
  if (key.type === 'local') return { fingerprints: [fingerprint], key_status: 'active', key_storage: 'hot' };
  // An xpub pasted or read from a file says nothing about what holds it.
  const device = key.source ? DEVICES[key.source] : undefined;
  if (!device) return undefined;
  return {
    fingerprints: [fingerprint],
    key_status: 'active',
    key_storage: 'cold',
    devices: [
      compact({
        ...device,
        last_health_check: key.lastHealthCheckAt ? seconds(key.lastHealthCheckAt) : undefined,
      }),
    ],
  };
}

/**
 * The change index a draft pays to, when the wallet re-derives that output
 * at the path the draft claims — `isChange` is only ever true then, so the
 * path can be read. A payment to one of the wallet's receive addresses is
 * verified the same way but is not change.
 */
function draftChangeIndex(psbt: bitcoin.Psbt, wallet: MultisigWallet): number {
  let highest = -1;
  summarisePsbt(psbt, wallet).outputs.forEach((o, i) => {
    if (!o.isChange) return;
    const parts = psbt.data.outputs[i]?.bip32Derivation?.[0]?.path.split('/') ?? [];
    const index = Number(parts[parts.length - 1]);
    const branch = Number(parts[parts.length - 2]);
    if (branch === 1 && Number.isInteger(index) && index >= 0) highest = Math.max(highest, index);
  });
  return highest;
}

export interface Bip139Source {
  wallet: MultisigWallet;
  /** Keys on this phone: aliases, ownership and the devices behind them. */
  keys: SignerKey[];
  /** The group section, when the wallet's backups carry one (groupBackup.ts). */
  group?: GroupBackup | null;
  /** Drafts and part-signed transactions kept on this phone. */
  pendingTxs?: PendingTx[];
  /** The cached chain state, when the wallet has been synced. Nothing is fetched here. */
  sync?: WalletSync | null;
  /** When the export is made, ms. */
  now: number;
  /** `exporter`: this app's name and version. */
  exporter: string;
}

/** The export as an object — `bip139ExportJson` is the file. */
export function buildBip139Export(src: Bip139Source): Record<string, unknown> {
  const { wallet, keys } = src;
  const sync = src.sync ?? null;
  const net = btcNetwork(wallet.network);

  const held = (c: Cosigner): SignerKey | undefined =>
    keys.find((k) => k.id === c.keyId) ?? keys.find((k) => !!k.xpub && k.xpub === c.xpub);

  // Keys: how this account uses each one. Signers: what holds it, once.
  const keyObjects: Record<string, unknown> = {};
  const labels: Record<string, string>[] = [];
  const signers: Record<string, unknown>[] = [];
  for (const c of wallet.cosigners) {
    const key = held(c);
    // The live key record first: names change after a wallet is built.
    const alias = key?.name ?? c.name;
    const fp = c.fingerprint.toLowerCase();
    labels.push({ type: 'xpub', ref: c.xpub, label: alias });
    if (keyObjects[fp]) continue; // two accounts of one master key: one key object, one signer
    keyObjects[fp] = compact({
      key: fp,
      alias,
      role: 'main',
      // Held here is ours. In a group the others are held by the people we
      // share the wallet with; a private wallet's unlinked keys could be anyone's.
      key_type: key ? 'internal' : wallet.kind === 'group' ? 'external' : undefined,
    });
    const signer = signerFor(key, fp);
    if (signer) signers.push(signer);
  }

  const coins = (sync?.snapshot.utxos ?? []).map((u) =>
    compact({
      outpoint: `${u.txid}:${u.vout}`,
      amount: u.value,
      script: outputScriptHex(u.address, net),
      block_height: u.confirmed ? u.blockHeight : undefined,
      is_change: u.branch === 1,
      derivation_index: u.index,
      spend_status: u.confirmed ? 'unspent' : 'unconfirmed',
    })
  );

  const transactions: Record<string, unknown> = {};
  for (const h of sync?.history ?? []) {
    transactions[h.txid] = compact({
      fee: Number.isFinite(h.feeSats) ? h.feeSats : undefined,
      block_time: h.confirmed && h.blockTime ? h.blockTime : undefined,
    });
  }
  const txids = Object.keys(transactions);

  // Keyed by the unsigned transaction's id, which signing does not change.
  const psbts: Record<string, string> = {};
  let draftChange = -1;
  for (const t of src.pendingTxs ?? []) {
    if (t.walletId !== wallet.id) continue;
    try {
      const psbt = parsePsbt(t.base64, wallet.network);
      const txid = unsignedTxId(psbt);
      psbts[txid] = psbt.toBase64();
      const memo = t.memo?.trim();
      if (memo) labels.push({ type: 'tx', ref: txid, label: memo });
      draftChange = Math.max(draftChange, draftChangeIndex(psbt, wallet));
    } catch {
      // A draft that no longer parses is not worth failing the backup for.
    }
  }
  const psbtIds = Object.keys(psbts);

  // The highest change index generated: the last one seen on chain, or the
  // one a draft in flight pays to — that address exists before it is used.
  const changeIndex = Math.max(sync ? sync.snapshot.nextChangeIndex - 1 : -1, draftChange);

  const account = compact({
    type: 'bip380',
    descriptor: walletDescriptor(wallet),
    name: wallet.name,
    status: 'active',
    gap_limit: GAP_LIMIT,
    // The receive address shown last is the highest handed out.
    receive_index: sync ? sync.snapshot.nextReceiveIndex : undefined,
    change_index: changeIndex >= 0 ? changeIndex : undefined,
    birth_block: birthHeight(wallet, sync),
    keys: keyObjects,
    labels: labels.length ? labels : undefined,
    transactions: txids.length ? txids : undefined,
    coins: coins.length ? coins : undefined,
    psbts: psbtIds.length ? psbtIds : undefined,
  });

  // The group invite, under the same rule as the text file: only what
  // groupBackupFor allows, never a rotated epoch key.
  const proprietary = src.group
    ? {
        [BIP139_PROPRIETARY_KEY]: {
          group: compact({ invite: src.group.invite, identity_fingerprint: src.group.identityFingerprint }),
        },
      }
    : undefined;

  return compact({
    version: BIP139_VERSION,
    network: bip139Network(wallet.network),
    name: wallet.name,
    date: seconds(src.now),
    exporter: src.exporter,
    accounts: [account],
    signers: signers.length ? signers : undefined,
    transactions: txids.length ? transactions : undefined,
    psbts: psbtIds.length ? psbts : undefined,
    proprietary,
  });
}

/** The export file: UTF-8 JSON, indented so a person can read their backup. */
export function bip139ExportJson(src: Bip139Source): string {
  return JSON.stringify(buildBip139Export(src), null, 2);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** A PSBT the export carries for an account, with its BIP-329 `tx` label as the memo. */
export interface Bip139Draft {
  txid: string;
  base64: string;
  memo?: string;
}

export interface Bip139Account {
  type: string;
  /** The account's descriptor, or each of the set for `multi_bip380`. */
  descriptors: string[];
  name?: string;
  /** One of the registered statuses; anything else is not imported. */
  status?: Bip139AccountStatus;
  /** Lowercase fingerprint → alias, from the account's keys. */
  aliases: Record<string, string>;
  /** xpub → BIP-329 label. */
  xpubLabels: Record<string, string>;
  /** txid → BIP-329 label. */
  txLabels: Record<string, string>;
  /** The account's `psbts` references into the wallet's map, when it has the field. */
  psbtRefs?: string[];
  /** The drafts for this account, resolved from the wallet's `psbts` map. */
  drafts: Bip139Draft[];
}

export interface Bip139Read {
  network: NetworkName;
  /** What the file calls the network, for messages. */
  networkName: string;
  name?: string;
  accounts: Bip139Account[];
  warnings: string[];
}

/**
 * Whether JSON is a BIP-139 export: its version says so, or it has the
 * accounts array and network the BIP makes mandatory under some other
 * version — a draft-era file, read with a warning.
 */
export function isBip139Object(obj: unknown): obj is Record<string, unknown> {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return false;
  const o = obj as Record<string, unknown>;
  if (isBip139Version(o.version)) return true;
  return Array.isArray(o.accounts) && typeof o.network === 'string';
}

function isBip139Version(value: unknown): boolean {
  return typeof value === 'string' && /^BIP139-\d+$/.test(value);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** A string from the file, cleaned; undefined when there is nothing left. */
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return cleanLabel(value, max) || undefined;
}

/** Maps keyed by what a file says — never by Object.prototype's names. */
function emptyMap(): Record<string, string> {
  return Object.create(null);
}

/**
 * One account. `strict` is the BIP's own rule — every mandatory field — for
 * a file that names a BIP-139 version; a draft-era file, which predates the
 * `type` field, gets the benefit of the doubt for a plain descriptor.
 */
function readAccount(raw: unknown, index: number, strict: boolean): Bip139Account {
  const where = `Account ${index + 1}`;
  if (!isRecord(raw)) throw new Error(`${where} of this BIP-139 export is not an object.`);
  let type: string;
  if (typeof raw.type === 'string') type = raw.type;
  else if (!strict && typeof raw.descriptor === 'string') type = 'bip380';
  else throw new Error(`${where} has no "type".`);
  let descriptors: string[];
  if (typeof raw.descriptor === 'string') descriptors = [raw.descriptor];
  else if (Array.isArray(raw.descriptor) && raw.descriptor.every((d) => typeof d === 'string')) {
    descriptors = raw.descriptor as string[];
  } else throw new Error(`${where} has no "descriptor".`);

  const aliases = emptyMap();
  if (raw.keys !== undefined) {
    if (!isRecord(raw.keys)) throw new Error(`${where}: "keys" is not an object.`);
    for (const [fp, k] of Object.entries(raw.keys)) {
      if (!isRecord(k) || typeof k.key !== 'string') throw new Error(`${where}: key ${fp} has no "key" field.`);
      const alias = text(k.alias, NAME_INPUT_CHARS);
      if (alias) aliases[k.key.toLowerCase()] = alias;
    }
  }
  const xpubLabels = emptyMap();
  const txLabels = emptyMap();
  if (Array.isArray(raw.labels)) {
    for (const l of raw.labels) {
      if (!isRecord(l) || typeof l.ref !== 'string') continue;
      if (l.type === 'xpub') {
        const label = text(l.label, NAME_INPUT_CHARS);
        if (label) xpubLabels[l.ref] = label;
      }
      if (l.type === 'tx') {
        const label = text(l.label, MEMO_CHARS);
        if (label) txLabels[l.ref.toLowerCase()] = label;
      }
    }
  }
  if (Array.isArray(raw.coins)) {
    for (const c of raw.coins) {
      if (!isRecord(c) || typeof c.outpoint !== 'string') throw new Error(`${where}: a coin has no "outpoint".`);
    }
  }
  let psbtRefs: string[] | undefined;
  if (raw.psbts !== undefined) {
    if (!Array.isArray(raw.psbts) || !raw.psbts.every((p) => typeof p === 'string')) {
      throw new Error(`${where}: "psbts" is not an array of transaction ids.`);
    }
    psbtRefs = (raw.psbts as string[]).map((p) => p.toLowerCase());
  }
  const status = ACCOUNT_STATUSES.find((s) => s === raw.status);
  return {
    type,
    descriptors,
    name: text(raw.name, NAME_INPUT_CHARS),
    status,
    aliases,
    xpubLabels,
    txLabels,
    psbtRefs,
    drafts: [],
  };
}

/**
 * The wallet-level `psbts` map: unsigned txid → PSBT. Values that are not
 * strings are left behind rather than failing the import.
 */
function readPsbtMap(raw: unknown): Record<string, string> {
  const out = emptyMap();
  if (raw === undefined) return out;
  if (!isRecord(raw)) throw new Error('This BIP-139 export\'s "psbts" is not an object.');
  for (const [txid, psbt] of Object.entries(raw)) {
    if (typeof psbt === 'string' && psbt.trim()) out[txid.toLowerCase()] = psbt.trim();
  }
  return out;
}

/**
 * Validates a BIP-139 export the way the BIP asks of importers — every
 * object carries its mandatory fields, at least one account — and returns
 * what this app can use. Unknown fields and enum values are ignored; names
 * and labels are cleaned and capped. Descriptors are returned as written;
 * walletImport.ts parses them.
 */
export function readBip139(obj: Record<string, unknown>): Bip139Read {
  const warnings: string[] = [];
  const strict = isBip139Version(obj.version);
  if (!strict) {
    warnings.push(
      `The file's version is ${JSON.stringify(obj.version)} rather than "BIP139-<n>"; it was read as a BIP-139 export anyway.`
    );
  }
  if (typeof obj.network !== 'string') throw new Error('This BIP-139 export has no "network".');
  const { network, warning } = networkFromBip139(obj.network);
  if (warning) warnings.push(warning);
  if (!Array.isArray(obj.accounts) || obj.accounts.length === 0) {
    throw new Error('This BIP-139 export has no accounts.');
  }
  const accounts = obj.accounts.map((a, i) => readAccount(a, i, strict));
  // Each account's drafts: the ones it references, or — when nothing says
  // which account a draft belongs to and there is only one — all of them.
  const psbts = readPsbtMap(obj.psbts);
  for (const account of accounts) {
    const ids = account.psbtRefs ?? (accounts.length === 1 ? Object.keys(psbts) : []);
    account.drafts = ids
      .filter((id) => psbts[id] !== undefined)
      .map((id) => ({ txid: id, base64: psbts[id], ...(account.txLabels[id] ? { memo: account.txLabels[id] } : {}) }));
  }
  if (obj.signers !== undefined) {
    if (!Array.isArray(obj.signers)) throw new Error('This BIP-139 export\'s "signers" is not an array.');
    for (const s of obj.signers) {
      if (!isRecord(s) || !Array.isArray(s.fingerprints) || s.fingerprints.length === 0) {
        throw new Error('A signer in this BIP-139 export has no fingerprints.');
      }
    }
  }
  return {
    network,
    networkName: obj.network,
    name: text(obj.name, NAME_INPUT_CHARS),
    accounts,
    warnings,
  };
}

/** The group invite this app wrote into an export's proprietary section, if any. */
export function bip139Group(obj: unknown): { invite: string; identityFingerprint?: string } | null {
  if (!isBip139Object(obj) || !isRecord(obj.proprietary)) return null;
  const ours = obj.proprietary[BIP139_PROPRIETARY_KEY];
  if (!isRecord(ours) || !isRecord(ours.group) || typeof ours.group.invite !== 'string') return null;
  const fp = ours.group.identity_fingerprint;
  return { invite: ours.group.invite, identityFingerprint: isFingerprint(fp) ? fp.toLowerCase() : undefined };
}
