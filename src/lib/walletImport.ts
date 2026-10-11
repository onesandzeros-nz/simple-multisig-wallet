import { Buffer } from 'buffer';
import { bip32, bip48Path, btcNetwork } from './bitcoin';
import { descriptorChecksum } from './descriptor';
import { parseKeyExpression } from './slip132';
import { Cosigner, NetworkName } from './types';

export interface ParsedWallet {
  name?: string;
  m: number;
  n: number;
  network: NetworkName;
  cosigners: Cosigner[];
}

function toCosigner(expr: string, index: number, name?: string): { cosigner: Cosigner; network: NetworkName } {
  const parsed = parseKeyExpression(expr);
  let fingerprint = parsed.fingerprint;
  if (!fingerprint) {
    const node = bip32.fromBase58(parsed.xpub, btcNetwork(parsed.network));
    fingerprint = Buffer.from(node.fingerprint).toString('hex');
  }
  return {
    cosigner: {
      name: name ?? `Cosigner ${index + 1}`,
      fingerprint,
      path: parsed.path ?? bip48Path(parsed.network),
      xpub: parsed.xpub,
    },
    network: parsed.network,
  };
}

function assembleWallet(
  m: number,
  entries: { cosigner: Cosigner; network: NetworkName }[],
  name?: string
): ParsedWallet {
  if (entries.length < 2) throw new Error('A multisig wallet needs at least 2 cosigners.');
  if (m < 1 || m > entries.length) {
    throw new Error(`Threshold ${m} of ${entries.length} is not possible.`);
  }
  const networks = new Set(entries.map((e) => e.network));
  if (networks.size > 1) throw new Error('Cosigner keys mix mainnet and testnet.');
  const xpubs = entries.map((e) => e.cosigner.xpub);
  if (new Set(xpubs).size !== xpubs.length) throw new Error('The same key appears more than once.');
  return {
    name,
    m,
    n: entries.length,
    network: [...networks][0],
    cosigners: entries.map((e) => e.cosigner),
  };
}

/**
 * Parses a wsh(sortedmulti(...)) output descriptor — the format this app
 * (and Sparrow, Bitcoin Core, Specter…) exports. Verifies the checksum if
 * one is present. Multipath (<0;1>/*) and single-branch variants both work.
 */
export function parseWalletDescriptor(input: string): ParsedWallet {
  let desc = input.trim().replace(/\s+/g, '');
  const hashIdx = desc.lastIndexOf('#');
  if (hashIdx !== -1) {
    const body = desc.slice(0, hashIdx);
    const checksum = desc.slice(hashIdx + 1);
    if (descriptorChecksum(body) !== checksum) {
      throw new Error('The descriptor checksum does not match — the text may be corrupted.');
    }
    desc = body;
  }
  const match = desc.match(/^wsh\(sortedmulti\((\d+),(.+)\)\)$/);
  if (!match) {
    throw new Error('Only wsh(sortedmulti(...)) descriptors are supported (native segwit multisig).');
  }
  const m = parseInt(match[1], 10);
  // Key expressions contain no commas, so top-level split is safe.
  const entries = match[2].split(',').map((part, i) => toCosigner(part, i));
  return assembleWallet(m, entries);
}

/**
 * Parses JSON wallet exports:
 *  - Specter / Sparrow "Specter" format: { "label": "...", "descriptor": "wsh(...)#..." }
 *  - Electrum multisig wallets: { "wallet_type": "2of3", "x1/": { xpub, derivation, root_fingerprint }, ... }
 */
export function parseWalletJson(input: string): ParsedWallet {
  let obj: any;
  try {
    obj = JSON.parse(input);
  } catch {
    throw new Error('This is not valid JSON.');
  }
  if (typeof obj !== 'object' || obj === null) throw new Error('This is not a wallet file.');

  if (typeof obj.descriptor === 'string') {
    const parsed = parseWalletDescriptor(obj.descriptor);
    return { ...parsed, name: typeof obj.label === 'string' ? obj.label : parsed.name };
  }

  const walletType = typeof obj.wallet_type === 'string' && obj.wallet_type.match(/^(\d+)of(\d+)$/);
  if (walletType) {
    const m = parseInt(walletType[1], 10);
    const n = parseInt(walletType[2], 10);
    const entries: { cosigner: Cosigner; network: NetworkName }[] = [];
    for (let i = 1; i <= n; i++) {
      const x = obj[`x${i}/`] ?? obj[`x${i}`];
      if (!x || typeof x.xpub !== 'string') {
        throw new Error(`The wallet file is missing cosigner x${i}.`);
      }
      const fp = typeof x.root_fingerprint === 'string' ? x.root_fingerprint.toLowerCase() : undefined;
      const path = typeof x.derivation === 'string' ? x.derivation.replace(/h/g, "'") : undefined;
      const origin = fp && path ? `[${fp}${path.replace(/^m/, '')}]` : '';
      entries.push(toCosigner(`${origin}${x.xpub}`, i - 1));
    }
    return assembleWallet(m, entries);
  }

  throw new Error('Unrecognised wallet JSON — expected a descriptor or an Electrum multisig file.');
}

/**
 * Single entry point for anything pasted, scanned or read from a file:
 * output descriptor, Coldcard/Sparrow config text, or JSON wallet export.
 */
export function parseWalletImportText(input: string): ParsedWallet {
  const text = input.trim();
  if (!text) throw new Error('Nothing to import.');
  if (text.startsWith('{')) return parseWalletJson(text);
  if (/^wsh\(/i.test(text)) return parseWalletDescriptor(text);
  if (/^policy\s*:/im.test(text)) return parseWalletConfigFile(text);
  try {
    return parseWalletConfigFile(text);
  } catch {
    return parseWalletDescriptor(text);
  }
}

/**
 * Parses the Coldcard/Sparrow/Specter wallet config text format:
 *   Name: …
 *   Policy: 2 of 3
 *   Format: P2WSH
 *   Derivation: m/48'/0'/0'/2'
 *   DEADBEEF: xpub…
 */
export function parseWalletConfigFile(input: string): ParsedWallet {
  let name: string | undefined;
  let m: number | undefined;
  let format = 'P2WSH';
  let currentPath: string | undefined;
  const entries: { cosigner: Cosigner; network: NetworkName }[] = [];

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const kv = line.match(/^([^:]+):\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    const value = kv[2].trim();

    if (/^name$/i.test(key)) name = value;
    else if (/^policy$/i.test(key)) {
      const pol = value.match(/^(\d+)\s*of\s*(\d+)$/i);
      if (!pol) throw new Error(`Could not read the policy "${value}" — expected e.g. "2 of 3".`);
      m = parseInt(pol[1], 10);
    } else if (/^format$/i.test(key)) format = value.toUpperCase();
    else if (/^derivation$/i.test(key)) currentPath = value.replace(/h/g, "'");
    else if (/^[0-9a-fA-F]{8}$/.test(key)) {
      const expr = currentPath
        ? `[${key.toLowerCase()}${currentPath.replace(/^m/, '')}]${value}`
        : value;
      const entry = toCosigner(expr, entries.length);
      entries.push(entry);
    }
  }

  if (format !== 'P2WSH') {
    throw new Error(`This wallet is ${format} — only P2WSH (native segwit) is supported.`);
  }
  if (m === undefined) throw new Error('The config file has no "Policy" line.');
  return assembleWallet(m, entries, name);
}
