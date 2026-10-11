import { GroupEpoch } from '../types';

/**
 * How a group's epoch secrets are written into the keystore (REKEY-DESIGN.md).
 *
 * Kept out of store.tsx so it can be tested directly: the read path has to
 * cope with what earlier builds wrote, and getting that wrong would lock a
 * member out of their own group.
 */

const isSecret = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{64}$/i.test(x);

/**
 * Builds before rotation stored a bare hex secret. Read that back as epoch 0 —
 * it is exactly what the invite carried — rather than treating it as corrupt.
 * Anything unreadable yields an empty list, which the app reports as "you'll
 * need the invite again" instead of crashing.
 */
export function parseEpochs(raw: string | null): GroupEpoch[] {
  if (!raw) return [];
  if (isSecret(raw)) return [{ epoch: 0, secret: raw.toLowerCase() }];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<number>();
  return parsed
    .filter((e: any) => e && Number.isInteger(e.epoch) && e.epoch >= 0 && isSecret(e.secret))
    .map((e: any) => ({ epoch: e.epoch as number, secret: (e.secret as string).toLowerCase() }))
    .filter((e) => (seen.has(e.epoch) ? false : (seen.add(e.epoch), true)))
    .sort((a, b) => a.epoch - b.epoch);
}

export function serialiseEpochs(epochs: GroupEpoch[]): string {
  return JSON.stringify([...epochs].sort((a, b) => a.epoch - b.epoch));
}

/** Adds an epoch, keeping the first copy of any number already present. */
export function withEpoch(epochs: GroupEpoch[], next: GroupEpoch): GroupEpoch[] {
  if (epochs.some((e) => e.epoch === next.epoch)) return epochs;
  return [...epochs, next].sort((a, b) => a.epoch - b.epoch);
}
