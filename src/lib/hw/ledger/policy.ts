import { sha256 } from '@noble/hashes/sha256';
import { Buffer } from 'buffer';
import { Cosigner, MultisigWallet } from '../../types';
import { encodeVarint, MerkleTree } from './merkle';

/**
 * Wallet policies (BIP-388): how a Ledger is told what wallet it is signing
 * for. A policy is a descriptor with its keys pulled out into a list —
 * `wsh(sortedmulti(2,@0/**,@1/**,@2/**))` plus three `[origin]xpub` strings —
 * and a name for the device to show.
 *
 * Reference: github.com/LedgerHQ/app-bitcoin-new doc/wallet.md
 */

const POLICY_VERSION_V2 = 2;
/** The app's MAX_WALLET_NAME_LENGTH. */
const MAX_NAME_LENGTH = 64;
/** The app's MAX_BIP388_XPUB_DERIVATION_STEPS. */
const MAX_ORIGIN_STEPS = 8;

export interface WalletPolicy {
  /** Shown on the device. Printable ASCII, 1 to 64 characters, no space at either end. */
  name: string;
  /** e.g. wsh(sortedmulti(2,@0/**,@1/**,@2/**)) */
  template: string;
  /** One per placeholder, in order: [fingerprint/path]xpub */
  keys: string[];
}

export function serialisePolicy(policy: WalletPolicy): Buffer {
  const name = Buffer.from(policy.name, 'ascii');
  if (name.length > MAX_NAME_LENGTH) throw new Error('The wallet name is too long for a Ledger.');
  const template = Buffer.from(policy.template, 'ascii');
  const keys = new MerkleTree(policy.keys.map((k) => Buffer.from(k, 'ascii')));
  return Buffer.concat([
    Buffer.from([POLICY_VERSION_V2, name.length]),
    name,
    encodeVarint(template.length),
    Buffer.from(sha256(template)),
    encodeVarint(policy.keys.length),
    keys.root,
  ]);
}

/** What the device knows the wallet by: the hash of its serialisation. */
export function policyId(policy: WalletPolicy): Buffer {
  return Buffer.from(sha256(serialisePolicy(policy)));
}

/**
 * A name the device will accept, made from the one the wallet has in the app.
 * Anything outside printable ASCII is dropped — the device would refuse the
 * whole registration over a single accented letter.
 */
export function policyName(wallet: Pick<MultisigWallet, 'name' | 'm' | 'n'>): string {
  const cleaned = wallet.name
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, MAX_NAME_LENGTH)
    .trim();
  return cleaned || `${wallet.m} of ${wallet.n} Multisig`;
}

/**
 * `[fingerprint/path]xpub`, written the one way the app reads it: lowercase
 * fingerprint, and ' for hardened steps — it does not understand h.
 */
export function policyKey(cosigner: Pick<Cosigner, 'fingerprint' | 'path' | 'xpub'>): string {
  const fingerprint = cosigner.fingerprint.toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(fingerprint)) {
    throw new Error(`"${cosigner.fingerprint}" is not a key fingerprint.`);
  }
  const steps = cosigner.path
    .trim()
    .replace(/^m\/?/i, '')
    .split('/')
    .filter(Boolean)
    .map((step) => {
      const match = /^(\d+)(['hH]?)$/.exec(step);
      if (!match || Number(match[1]) >= 0x80000000) {
        throw new Error(`Cannot read the key path "${cosigner.path}".`);
      }
      return `${Number(match[1])}${match[2] ? "'" : ''}`;
    });
  if (steps.length > MAX_ORIGIN_STEPS) {
    throw new Error(`The key path "${cosigner.path}" is longer than a Ledger accepts.`);
  }
  return `[${[fingerprint, ...steps].join('/')}]${cosigner.xpub}`;
}

/**
 * The policy for one of this app's wallets. Keys stay in the wallet's own
 * cosigner order: sortedmulti makes the order irrelevant to the addresses,
 * but not to the policy's id, so it must not drift between sessions.
 */
export function multisigPolicy(wallet: MultisigWallet): WalletPolicy {
  if (wallet.scriptType !== 'P2WSH') throw new Error('Only native segwit (P2WSH) wallets can be signed for.');
  const n = wallet.cosigners.length;
  if (n < 1 || wallet.m < 1 || wallet.m > n) throw new Error('This wallet’s policy is not valid.');
  const placeholders = wallet.cosigners.map((_, i) => `@${i}/**`);
  return {
    name: policyName(wallet),
    template: `wsh(sortedmulti(${wallet.m},${placeholders.join(',')}))`,
    keys: wallet.cosigners.map(policyKey),
  };
}

/**
 * The device-memory name a Ledger's approval of a policy is kept under. Per
 * device as well as per wallet: the approval is made with a key from the
 * device's seed, so two Ledgers in one wallet each have their own.
 */
export function hmacMemoryKey(fingerprint: string, policy: WalletPolicy): string {
  return `ledger.hmac.${fingerprint.toLowerCase()}.${policyId(policy).toString('hex')}`;
}

/**
 * Every name an approval of `wallet` could be kept under — one per cosigner,
 * since any of them may be the Ledger. Empty for a wallet no Ledger can sign
 * for. For the wipe, which has to find them all.
 */
export function ledgerMemoryKeys(wallet: MultisigWallet): string[] {
  let policy: WalletPolicy;
  try {
    policy = multisigPolicy(wallet);
  } catch {
    return [];
  }
  return wallet.cosigners.map((c) => hmacMemoryKey(c.fingerprint, policy));
}
