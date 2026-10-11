import * as bs58check from 'bs58check';
import { Buffer } from 'buffer';
import { decodeCbor, encodeCbor, Tagged } from './cbor';

/**
 * Converts a BC-UR crypto-output payload (BCR-2020-010) — what Sparrow,
 * Keystone, Passport etc. put in their descriptor QR codes — back into a
 * text output descriptor our importer understands.
 *
 * Registry tags: 401 wsh, 407 sortedmulti, 406 multi,
 * 303 crypto-hdkey, 304 crypto-keypath, 305 coin-info.
 */

const XPUB_VERSION = '0488b21e';
const TPUB_VERSION = '043587cf';

function pathFromComponents(components: any[]): string {
  const steps: string[] = [];
  for (let i = 0; i < components.length; i += 2) {
    const index = components[i];
    const hardened = components[i + 1] === true;
    if (typeof index !== 'number') throw new Error('Unsupported key path in this QR (wildcard origins).');
    steps.push(`${index}${hardened ? "'" : ''}`);
  }
  return steps.join('/');
}

function hdkeyToKeyExpression(tagged: any): string {
  // A crypto-hdkey is tagged inside a descriptor, but bare when it is the
  // whole UR payload.
  const map =
    tagged instanceof Tagged && tagged.tag === 303 ? tagged.value : tagged instanceof Map ? tagged : null;
  if (!(map instanceof Map)) {
    throw new Error('This QR contains a key type this app cannot read.');
  }
  const keyData: Buffer = map.get(3);
  const chainCode: Buffer = map.get(4);
  if (!Buffer.isBuffer(keyData) || keyData.length !== 33 || !Buffer.isBuffer(chainCode) || chainCode.length !== 32) {
    throw new Error('This QR contains a raw public key instead of an xpub — export the wallet descriptor instead.');
  }

  // Network from coin-info (defaults to mainnet).
  let version = XPUB_VERSION;
  const useInfo = map.get(5);
  if (useInfo instanceof Tagged && useInfo.value instanceof Map && useInfo.value.get(2) === 1) {
    version = TPUB_VERSION;
  }

  // Origin: master fingerprint + derivation path.
  let originPrefix = '';
  let depth = 0;
  let childNumber = 0;
  const origin = map.get(6);
  if (origin instanceof Tagged && origin.value instanceof Map) {
    const components: any[] = origin.value.get(1) ?? [];
    const sourceFp: number | undefined = origin.value.get(2);
    depth = origin.value.get(3) ?? components.length / 2;
    if (components.length >= 2) {
      const lastIndex = components[components.length - 2];
      const lastHardened = components[components.length - 1] === true;
      childNumber = (lastIndex >>> 0) + (lastHardened ? 0x80000000 : 0);
    }
    if (sourceFp !== undefined && components.length > 0) {
      const fpHex = (sourceFp >>> 0).toString(16).padStart(8, '0');
      originPrefix = `[${fpHex}/${pathFromComponents(components)}]`;
    }
  }

  const parentFp: number = map.get(8) ?? 0;
  const serialized = Buffer.alloc(78);
  Buffer.from(version, 'hex').copy(serialized, 0);
  serialized[4] = depth;
  serialized.writeUInt32BE(parentFp >>> 0, 5);
  serialized.writeUInt32BE(childNumber >>> 0, 9);
  chainCode.copy(serialized, 13);
  keyData.copy(serialized, 45);

  return `${originPrefix}${bs58check.encode(serialized)}`;
}

/**
 * A crypto-output either describes a whole multisig wallet or wraps a single
 * account key. Wallet exports give the first, key exports (Jade, Keystone,
 * Passport) give the second — so return whichever this is: a descriptor, or a
 * key expression the key importer understands.
 */
export function cryptoOutputToText(payload: Buffer): string {
  const decoded = decodeCbor(payload);
  if (!(decoded instanceof Tagged)) throw new Error('This QR does not contain a descriptor.');
  // The script-type wrapper only says how the key would be spent; for a
  // single key the origin and xpub are all the importer needs.
  if (decoded.value instanceof Tagged && decoded.value.tag === 303) {
    return hdkeyToKeyExpression(decoded.value);
  }
  return cryptoOutputToDescriptor(payload);
}

/** A bare crypto-hdkey payload: one account key with its origin. */
export function cryptoHdkeyToKeyExpression(payload: Buffer): string {
  return hdkeyToKeyExpression(decodeCbor(payload));
}

/**
 * A crypto-account holds one master fingerprint and several descriptors, one
 * per script type. Prefer the native-segwit one, since that is what these
 * wallets use.
 */
export function cryptoAccountToText(payload: Buffer): string {
  const decoded = decodeCbor(payload);
  const map = decoded instanceof Tagged ? decoded.value : decoded;
  if (!(map instanceof Map)) throw new Error('This QR does not contain an account.');
  const descriptors: any[] = map.get(2) ?? [];
  if (!Array.isArray(descriptors) || descriptors.length === 0) {
    throw new Error('That account QR contains no keys.');
  }
  // 401 is wsh — the script type this app builds wallets with.
  const preferred = descriptors.find((d) => d instanceof Tagged && d.tag === 401) ?? descriptors[0];
  return cryptoOutputToText(encodeCbor(preferred));
}

export function cryptoOutputToDescriptor(payload: Buffer): string {
  const decoded = decodeCbor(payload);

  if (!(decoded instanceof Tagged)) throw new Error('This QR does not contain an output descriptor.');
  if (decoded.tag === 400 || decoded.tag === 404 || decoded.tag === 403) {
    throw new Error('This descriptor is not native-segwit multisig (P2WSH) — only wsh(sortedmulti(…)) wallets are supported.');
  }
  if (decoded.tag !== 401) throw new Error(`Unsupported descriptor QR (tag ${decoded.tag}).`);

  const inner = decoded.value;
  if (!(inner instanceof Tagged) || (inner.tag !== 407 && inner.tag !== 406)) {
    throw new Error('Only multisig (sortedmulti) descriptors are supported.');
  }
  if (inner.tag === 406) {
    throw new Error('This wallet uses unsorted multi(…) keys, which this app does not support — use sortedmulti.');
  }
  const body = inner.value;
  if (!(body instanceof Map)) throw new Error('Malformed multisig data in this QR.');
  const threshold: number = body.get(1);
  const keys: any[] = body.get(2);
  if (typeof threshold !== 'number' || !Array.isArray(keys)) {
    throw new Error('Malformed multisig data in this QR.');
  }

  const parts = keys.map(hdkeyToKeyExpression);
  return `wsh(sortedmulti(${threshold},${parts.join(',')}))`;
}
