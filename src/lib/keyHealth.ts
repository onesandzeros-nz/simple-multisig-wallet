import { SignerKey } from './types';

/**
 * Key health checks: a periodic nudge to prove a key still works before an
 * emergency does — the written phrase for a phone key, the device itself for
 * a hardware key. The clock runs from when the key was added, and passing a
 * check restarts it.
 */

export const DEFAULT_HEALTH_CHECK_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

export const HEALTH_CHECK_OPTIONS: readonly { days: number; label: string }[] = [
  { days: 0, label: 'Off' },
  { days: 90, label: '3 months' },
  { days: 180, label: '6 months' },
  { days: 365, label: '1 year' },
  { days: 730, label: '2 years' },
];

type HealthFields = Pick<SignerKey, 'createdAt' | 'healthCheckDays' | 'lastHealthCheckAt'>;

export function healthCheckDays(key: HealthFields): number {
  const d = key.healthCheckDays;
  return d === undefined || !Number.isFinite(d) || d < 0 ? DEFAULT_HEALTH_CHECK_DAYS : d;
}

/** When the next check falls due; null when reminders are off. */
export function healthCheckDueAt(key: HealthFields): number | null {
  const days = healthCheckDays(key);
  if (days === 0) return null;
  return Math.max(key.createdAt, key.lastHealthCheckAt ?? 0) + days * DAY_MS;
}

export function healthCheckDue(key: HealthFields, now: number): boolean {
  const at = healthCheckDueAt(key);
  return at !== null && now >= at;
}

export function keysDueForCheck<K extends HealthFields>(keys: K[], now: number): K[] {
  return keys.filter((k) => healthCheckDue(k, now));
}

/** The patch that records a passed check. */
export function recordHealthCheck(now: number): Pick<SignerKey, 'lastHealthCheckAt'> {
  return { lastHealthCheckAt: now };
}

export function setHealthCheckDays(days: number): Pick<SignerKey, 'healthCheckDays'> {
  if (!Number.isInteger(days) || days < 0) throw new Error('The reminder interval must be a whole number of days.');
  return { healthCheckDays: days };
}

const d = (at: number) => new Date(at).toLocaleDateString();

export function describeHealthCheck(key: HealthFields, now: number): string {
  const dueAt = healthCheckDueAt(key);
  if (dueAt === null) return 'Reminders are off.';
  const last = key.lastHealthCheckAt;
  if (now >= dueAt) {
    return last ? `Check due — last checked ${d(last)}.` : `Check due — never checked since it was added on ${d(key.createdAt)}.`;
  }
  return last ? `Checked ${d(last)} · next due ${d(dueAt)}.` : `Never checked · due ${d(dueAt)}.`;
}

/** What passing the check involves for this kind of key. */
export function healthCheckHint(key: Pick<SignerKey, 'type' | 'source'>): string {
  if (key.type === 'local') {
    return 'Type the words from your written backup. This proves the paper copy is still right — the phone is not consulted until you press Verify.';
  }
  if (key.source === 'tapsigner') return 'Tap the card again. This proves it still holds this key and its PIN still works.';
  if (key.source === 'ledger' || key.source === 'trezor' || key.source === 'bitbox02') {
    return 'Plug the device in and read the public key from it again. This proves it still holds this key and still unlocks.';
  }
  return 'Read the public key from the device again — QR, file, NFC or paste. This proves the device still holds this key.';
}

/** Word lists are compared loosely: case, extra spaces and line breaks do not matter. */
export function normaliseMnemonic(text: string): string {
  return text.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

export function mnemonicMatches(entered: string, stored: string): boolean {
  const e = normaliseMnemonic(entered);
  return e.length > 0 && e === normaliseMnemonic(stored);
}
