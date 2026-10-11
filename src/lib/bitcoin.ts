import * as bitcoin from 'bitcoinjs-lib';
import ecc from '@bitcoinerlab/secp256k1';
import { BIP32Factory, BIP32Interface } from 'bip32';
import * as bip39 from 'bip39';
import { Buffer } from 'buffer';
import { Cosigner, MultisigWallet, NetworkName } from './types';
import { withChecksum } from './descriptor';

bitcoin.initEccLib(ecc);
export const bip32 = BIP32Factory(ecc);

export function btcNetwork(name: NetworkName): bitcoin.Network {
  return name === 'mainnet' ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
}

/** BIP48 account path for P2WSH multisig — the app-wide default. */
export function bip48Path(network: NetworkName): string {
  return `m/48'/${network === 'mainnet' ? 0 : 1}'/0'/2'`;
}

// ---------------------------------------------------------------------------
// Local keys
// ---------------------------------------------------------------------------

export function generateMnemonic(): string {
  return bip39.generateMnemonic(128); // 12 words
}

/**
 * Deterministic mnemonic from user-supplied dice rolls, following the
 * Coldcard convention: SHA-256 over the ASCII digit string, first 16
 * bytes as entropy (128 bits → 12 words). 50 rolls carry ~129 bits of
 * entropy, so fewer than that is refused.
 */
export function mnemonicFromDiceRolls(rolls: string): string {
  if (!/^[1-6]+$/.test(rolls)) throw new Error('Dice rolls must be digits 1–6.');
  if (rolls.length < 50) throw new Error('At least 50 dice rolls are needed for a secure key.');
  const digest = bitcoin.crypto.sha256(Buffer.from(rolls, 'ascii'));
  return bip39.entropyToMnemonic(Buffer.from(digest.subarray(0, 16)));
}

export function validateMnemonic(mnemonic: string): boolean {
  return bip39.validateMnemonic(mnemonic.trim().toLowerCase().replace(/\s+/g, ' '));
}

export function rootFromMnemonic(mnemonic: string, network: NetworkName): BIP32Interface {
  const seed = bip39.mnemonicToSeedSync(mnemonic.trim().toLowerCase().replace(/\s+/g, ' '));
  return bip32.fromSeed(seed, btcNetwork(network));
}

export function masterFingerprint(mnemonic: string): string {
  return Buffer.from(rootFromMnemonic(mnemonic, 'mainnet').fingerprint).toString('hex');
}

/** Account xpub for this app's default multisig path (BIP48 / P2WSH). */
export function accountXpub(mnemonic: string, network: NetworkName): string {
  const root = rootFromMnemonic(mnemonic, network);
  return root.derivePath(bip48Path(network)).neutered().toBase58();
}

// ---------------------------------------------------------------------------
// Multisig derivation (BIP67 sorted keys, P2WSH)
// ---------------------------------------------------------------------------

export interface DerivedAddress {
  address: string;
  branch: number;
  index: number;
  witnessScript: Buffer;
  /** scriptPubKey */
  script: Buffer;
  /** pubkey + full path + fingerprint per cosigner, for PSBT bip32Derivation. */
  derivations: { pubkey: Buffer; masterFingerprint: Buffer; path: string }[];
}

export function deriveAddress(wallet: MultisigWallet, branch: number, index: number): DerivedAddress {
  const network = btcNetwork(wallet.network);
  const derivations = wallet.cosigners.map((c) => {
    const node = bip32.fromBase58(c.xpub, network).derive(branch).derive(index);
    return {
      pubkey: Buffer.from(node.publicKey),
      masterFingerprint: Buffer.from(c.fingerprint, 'hex'),
      path: `${c.path}/${branch}/${index}`,
    };
  });
  const p2ms = bitcoin.payments.p2ms({
    m: wallet.m,
    pubkeys: [...derivations.map((d) => d.pubkey)].sort((a, b) => a.compare(b)),
    network,
  });
  const p2wsh = bitcoin.payments.p2wsh({ redeem: p2ms, network });
  return {
    address: p2wsh.address!,
    branch,
    index,
    witnessScript: p2ms.output!,
    script: p2wsh.output!,
    derivations,
  };
}

// ---------------------------------------------------------------------------
// Descriptors & interop exports (for power users)
// ---------------------------------------------------------------------------

/**
 * Descriptor key expression in the format Sparrow displays and shares:
 * [fingerprint/path]xpub with h hardened markers.
 */
export function keyExpression(key: { fingerprint: string; path: string; xpub: string }): string {
  const origin = key.path.replace(/^m/, key.fingerprint.toLowerCase()).replace(/'/g, 'h');
  return `[${origin}]${key.xpub}`;
}

/**
 * A short code that commits to an account xpub, for out-of-band verification
 * when contributing keys to a group. Unlike the BIP32 master fingerprint —
 * which is attacker-chosen text that does not derive from the key — this is a
 * hash of the xpub itself, so two people comparing it detect a swapped key.
 */
export function keyCheckCode(xpub: string): string {
  const digest = bitcoin.crypto.sha256(Buffer.from(xpub, 'utf8'));
  return Buffer.from(digest.subarray(0, 4)).toString('hex');
}

function cosignerDescriptorPart(c: Cosigner, multipath: string): string {
  return `${keyExpression(c)}/${multipath}`;
}

/** wsh(sortedmulti(...)) descriptor with Core-style checksum. */
export function walletDescriptor(wallet: MultisigWallet, branch?: 0 | 1): string {
  const multipath = branch === undefined ? '<0;1>/*' : `${branch}/*`;
  const parts = wallet.cosigners.map((c) => cosignerDescriptorPart(c, multipath));
  return withChecksum(`wsh(sortedmulti(${wallet.m},${parts.join(',')}))`);
}

/** Coldcard/Sparrow/Specter compatible wallet config text file. */
export function walletConfigFile(wallet: MultisigWallet): string {
  const lines = [
    `# Simple Multisig wallet config`,
    `Name: ${wallet.name.replace(/[^ -~]/g, '').slice(0, 20)}`,
    `Policy: ${wallet.m} of ${wallet.n}`,
    `Format: P2WSH`,
    '',
  ];
  for (const c of wallet.cosigners) {
    lines.push(`Derivation: ${c.path}`);
    lines.push(`${c.fingerprint.toUpperCase()}: ${c.xpub}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Fee / size estimation
// ---------------------------------------------------------------------------

/** Virtual size of one P2WSH m-of-n input, in vbytes (worst case). */
export function multisigInputVbytes(m: number, n: number): number {
  const witnessScript = 3 + 34 * n; // OP_m ... OP_n OP_CHECKMULTISIG
  const witness =
    1 + // item count
    1 + // empty item for CHECKMULTISIG bug
    m * (1 + 72) + // signatures
    (witnessScript <= 75 ? 1 : 3) + witnessScript;
  return Math.ceil(41 + witness / 4);
}

export function outputVbytes(address: string, network: NetworkName): number {
  const script = bitcoin.address.toOutputScript(address, btcNetwork(network));
  return 8 + 1 + script.length;
}

export function estimateVsize(wallet: MultisigWallet, numInputs: number, outputAddresses: string[]): number {
  const overhead = 11; // version + locktime + varints + segwit marker/flag
  const inputs = numInputs * multisigInputVbytes(wallet.m, wallet.n);
  const outputs = outputAddresses.reduce((sum, a) => sum + outputVbytes(a, wallet.network), 0);
  return overhead + inputs + outputs;
}

export function isValidAddress(address: string, network: NetworkName): boolean {
  try {
    bitcoin.address.toOutputScript(address.trim(), btcNetwork(network));
    return true;
  } catch {
    return false;
  }
}

export const DUST_SATS = 546;

export function formatSats(sats: number): string {
  const btc = sats / 1e8;
  if (sats >= 1_000_000) return `${btc.toLocaleString(undefined, { maximumFractionDigits: 8 })} BTC`;
  return `${sats.toLocaleString()} sats`;
}
