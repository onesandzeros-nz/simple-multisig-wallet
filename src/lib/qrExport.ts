import { UR, UREncoder } from '@ngraveio/bc-ur';
import { Buffer } from 'buffer';
import { encodeCbor } from './cbor';

/**
 * Animated QR export. A signed PSBT is far larger than one QR code can
 * hold, so it goes out as a BC-UR fountain-coded sequence — the same
 * `ur:crypto-psbt` (BCR-2020-006) that Sparrow, Keystone, SeedSigner and
 * Passport read. Small payloads still work: the sequence is a single
 * repeating frame.
 */
export const DEFAULT_FRAGMENT_BYTES = 160;

export function createPsbtUrEncoder(base64Psbt: string, fragmentBytes = DEFAULT_FRAGMENT_BYTES) {
  const raw = Buffer.from(base64Psbt.trim(), 'base64');
  if (raw.length === 0) throw new Error('Nothing to show.');
  // crypto-psbt is a CBOR byte string carrying the raw PSBT.
  const ur = new UR(encodeCbor(raw), 'crypto-psbt');
  return new UREncoder(ur, fragmentBytes);
}

/** Total frames in one pass — used to show "1 of N" while animating. */
export function urFrameCount(encoder: UREncoder): number {
  // fragmentsLength is the pure (non-fountain) part count.
  return Math.max(1, (encoder as any).fragmentsLength ?? 1);
}
