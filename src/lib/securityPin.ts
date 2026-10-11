import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';

/**
 * Security mode PIN — pure helpers, no storage. The record lives in the
 * keystore (see securityMode.ts); the pin itself is never written anywhere.
 *
 * A 6-digit PIN has only a million values, so the hash is not what protects
 * it: the wipe after MAX_ATTEMPTS wrong entries is. Hashing just keeps the
 * digits themselves out of the keystore.
 */

export const PIN_LENGTH = 6;
/** Wrong PINs in a row before every key and wallet is erased. */
export const MAX_ATTEMPTS = 3;
/** How long the app may sit in the background before it locks again. */
export const RELOCK_AFTER_MS = 30_000;

export interface PinRecord {
  salt: string;
  hash: string;
}

export function isValidPin(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);
}

function digest(pin: string, salt: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(`${salt}:${pin}`)));
}

export function makePinRecord(pin: string, salt = bytesToHex(randomBytes(16))): PinRecord {
  if (!isValidPin(pin)) throw new Error(`PIN must be ${PIN_LENGTH} digits`);
  return { salt, hash: digest(pin, salt) };
}

export function pinMatches(pin: string, record: PinRecord): boolean {
  return digest(pin, record.salt) === record.hash;
}

export type MessageOutcome =
  /** Not a PIN — an ordinary chat message. */
  | { kind: 'chat' }
  /** The PIN: unlock, and the message is never stored. */
  | { kind: 'unlock' }
  /** A 6-digit number that is not the PIN. `attempts` is the new streak. */
  | { kind: 'wrong'; attempts: number; wipe: boolean }
  /** PIN-shaped, with no record to check it against: not sent, not stored, not counted. */
  | { kind: 'withheld' };

/**
 * What sending `text` in a decoy chat means. Only PIN-shaped messages count
 * as attempts; the streak carries across ordinary messages and only the
 * right PIN (or a wipe) clears it.
 *
 * Without a record — not read yet, or unreadable — a PIN-shaped message is
 * withheld rather than treated as chat. It may be the real PIN, and a chat
 * message is written to disk in plain text.
 */
export function classifyMessage(text: string, record: PinRecord | null, failedSoFar: number): MessageOutcome {
  const trimmed = text.trim();
  if (!isValidPin(trimmed)) return { kind: 'chat' };
  if (!record) return { kind: 'withheld' };
  if (pinMatches(trimmed, record)) return { kind: 'unlock' };
  const attempts = failedSoFar + 1;
  return { kind: 'wrong', attempts, wipe: attempts >= MAX_ATTEMPTS };
}
