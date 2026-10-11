import * as bs58check from 'bs58check';
import { Buffer } from 'buffer';
import { NetworkName } from './types';

/**
 * SLIP-132 extended public key version bytes. Hardware wallets export
 * multisig account keys with these prefixes; internally we normalise
 * everything to plain xpub (mainnet) / tpub (testnet).
 */
const VERSIONS: Record<string, { network: NetworkName }> = {
  '0488b21e': { network: 'mainnet' }, // xpub
  '049d7cb2': { network: 'mainnet' }, // ypub
  '04b24746': { network: 'mainnet' }, // zpub
  '0295b43f': { network: 'mainnet' }, // Ypub (multisig p2sh-p2wsh)
  '02aa7ed3': { network: 'mainnet' }, // Zpub (multisig p2wsh)
  '043587cf': { network: 'testnet' }, // tpub
  '044a5262': { network: 'testnet' }, // upub
  '045f1cf6': { network: 'testnet' }, // vpub
  '024289ef': { network: 'testnet' }, // Upub (multisig p2sh-p2wsh)
  '02575483': { network: 'testnet' }, // Vpub (multisig p2wsh)
};

const XPUB_VERSION = '0488b21e';
const TPUB_VERSION = '043587cf';

export interface NormalisedXpub {
  /** Key re-encoded with plain xpub/tpub version bytes. */
  xpub: string;
  network: NetworkName;
}

/** A master fingerprint as key origins write it: eight hex digits, either case. */
export function isFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}$/i.test(value);
}

export interface ParsedKeyExpression extends NormalisedXpub {
  /** From the key origin, e.g. [deadbeef/48'/0'/0'/2'] — if present. */
  fingerprint?: string;
  path?: string;
}

/**
 * Parses a descriptor-style key expression:
 *   [deadbeef/48'/0'/0'/2']Zpub…   (hardened marker ' or h, optional
 *   trailing derivation like /0/* or /<0;1>/* which is ignored)
 * A bare xpub/Zpub/… without origin info is accepted too.
 */
export function parseKeyExpression(input: string): ParsedKeyExpression {
  let text = input.trim();
  let fingerprint: string | undefined;
  let path: string | undefined;

  const origin = text.match(/^\[([0-9a-fA-F]{8})((?:\/\d+['hH]?)*)\]/);
  if (origin) {
    fingerprint = origin[1].toLowerCase();
    path = `m${origin[2].replace(/[hH]/g, "'")}`;
    text = text.slice(origin[0].length);
  } else if (text.startsWith('[')) {
    throw new Error("Key origin should look like [deadbeef/48'/0'/0'/2'] before the xpub.");
  }

  // Split off any trailing child path (e.g. /0/*, /<0;1>/*) after the key.
  const key = text.match(/^[1-9A-HJ-NP-Za-km-z]+/);
  if (!key) throw new Error('No extended public key found.');
  const suffix = text.slice(key[0].length).trim();
  if (suffix) {
    if (/['hH]/.test(suffix)) {
      throw new Error('Hardened steps after an xpub are not possible — check the key expression.');
    }
    if (!/^(\/(\d+|\*|<\d+;\d+>))+$/.test(suffix)) {
      throw new Error(`Could not understand the child path "${suffix}" after the xpub.`);
    }
    // The child path is informational: this wallet always derives the
    // standard <account>/branch/index (branch 0 receive, 1 change).
  }

  return { ...normaliseXpub(key[0]), fingerprint, path };
}

/**
 * Accepts any SLIP-132 flavoured extended public key (xpub, Zpub, Vpub, …)
 * and returns it normalised to xpub/tpub plus the network it belongs to.
 * Throws on anything that is not a valid extended public key.
 */
export function normaliseXpub(input: string): NormalisedXpub {
  const trimmed = input.trim();
  let data: Buffer;
  try {
    data = Buffer.from(bs58check.decode(trimmed));
  } catch {
    throw new Error('Not a valid extended public key (bad base58 or checksum).');
  }
  if (data.length !== 78) {
    throw new Error('Not a valid extended public key (wrong length).');
  }
  // NB: not data.subarray(0,4).toString('hex') — on Hermes, subarray() of a
  // polyfilled Buffer returns a plain Uint8Array (no @@species), whose
  // toString ignores the 'hex' argument.
  const version = data.toString('hex', 0, 4);
  const info = VERSIONS[version];
  if (!info) {
    throw new Error(`Unrecognised extended key version 0x${version}. Is this a private key?`);
  }
  const keyByte = data[45];
  if (keyByte !== 0x02 && keyByte !== 0x03) {
    throw new Error('This looks like an extended PRIVATE key. Only public keys (xpub/Zpub) can be imported.');
  }
  const target = info.network === 'mainnet' ? XPUB_VERSION : TPUB_VERSION;
  const out = Buffer.concat([Buffer.from(target, 'hex'), Buffer.from(data.subarray(4))]);
  return { xpub: bs58check.encode(out), network: info.network };
}
