import * as bitcoin from 'bitcoinjs-lib';
import * as bs58check from 'bs58check';
import { Buffer } from 'buffer';
import { accountXpub, bip48Path, deriveAddress, masterFingerprint } from '../src/lib/bitcoin';
import { MultisigWallet, NetworkName, Utxo, WalletSnapshot } from '../src/lib/types';

/** Deterministic BIP39 test-vector mnemonics (all valid). */
export const MNEMONICS = [
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  'legal winner thank year wave sausage worth useful legal winner thank yellow',
  'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
  'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
  'ozone drill grab fiber curtain grace pudding thank cruise elder eight picnic',
];

export function makeWallet(
  m: number,
  mnemonics: string[],
  network: NetworkName = 'mainnet',
  name = 'Test wallet'
): MultisigWallet {
  return {
    id: `test-${m}-of-${mnemonics.length}-${network}`,
    kind: 'private',
    name,
    m,
    n: mnemonics.length,
    network,
    scriptType: 'P2WSH',
    cosigners: mnemonics.map((mn, i) => ({
      name: `Signer ${i + 1}`,
      fingerprint: masterFingerprint(mn),
      path: bip48Path(network),
      xpub: accountXpub(mn, network),
      keyId: `key-${i}`,
    })),
    createdAt: 0,
  };
}

/** Fake chain snapshot funding the wallet's first receive addresses. */
export function makeSnapshot(wallet: MultisigWallet, values: number[]): WalletSnapshot {
  const utxos: Utxo[] = values.map((value, i) => ({
    txid: (i + 10).toString(16).padStart(2, '0').repeat(32),
    vout: i,
    value,
    address: deriveAddress(wallet, 0, i).address,
    branch: 0,
    index: i,
    confirmed: true,
  }));
  return {
    confirmedSats: values.reduce((s, v) => s + v, 0),
    unconfirmedSats: 0,
    utxos,
    usedAddresses: [],
    nextReceiveIndex: values.length,
    nextChangeIndex: 0,
    scannedAt: 0,
  };
}

/** Re-encode an extended key with different SLIP-132 version bytes. */
export function withVersionBytes(extKey: string, versionHex: string): string {
  const data = Buffer.from(bs58check.decode(extKey));
  return bs58check.encode(Buffer.concat([Buffer.from(versionHex, 'hex'), Buffer.from(data.subarray(4))]));
}

/** BIP173 test-vector address, handy as a mainnet recipient. */
export const DEST_MAINNET = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

/**
 * A snapshot whose coins come from real transactions, so each input's txid is
 * the hash of something — what a hardware wallet insists on. Returns the raw
 * transactions by txid alongside, standing in for a chain server.
 */
export function makeFundedSnapshot(
  wallet: MultisigWallet,
  values: number[],
  branch: 0 | 1 = 0
): { snapshot: WalletSnapshot; transactions: Map<string, string> } {
  const transactions = new Map<string, string>();
  const utxos: Utxo[] = values.map((value, i) => {
    const derived = deriveAddress(wallet, branch, i);
    const funding = new bitcoin.Transaction();
    funding.version = 2;
    // Spends nothing real; only its hash and its outputs matter here.
    funding.addInput(Buffer.alloc(32, i + 1), 0, 0xfffffffd, Buffer.alloc(0));
    // A decoy first, so the coin is not always output 0.
    funding.addOutput(bitcoin.address.toOutputScript(DEST_MAINNET, bitcoin.networks.bitcoin), 1000 + i);
    funding.addOutput(derived.script, value);
    const txid = funding.getId();
    transactions.set(txid, funding.toHex());
    return { txid, vout: 1, value, address: derived.address, branch, index: i, confirmed: true };
  });
  return {
    snapshot: {
      confirmedSats: values.reduce((s, v) => s + v, 0),
      unconfirmedSats: 0,
      utxos,
      usedAddresses: [],
      nextReceiveIndex: values.length,
      nextChangeIndex: 0,
      scannedAt: 0,
    },
    transactions,
  };
}
