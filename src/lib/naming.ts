/**
 * The one name a person gives this app, and what is derived from it.
 *
 * Other people see it in two places: as the cosigner name on a key this
 * phone contributes to a shared wallet, and as the member name on keys and
 * chat in a group. It never goes anywhere else. Keys made on this phone are
 * named after it too, so a wallet built elsewhere from this phone's key says
 * whose it is.
 */

import { MAX_NAME_CHARS } from './nostr/protocol';

/**
 * The most a person can type into any name field. Well under the protocol's
 * `MAX_NAME_CHARS`, so `member · key` — how a contributed key is named when a
 * phone holds several — still fits.
 */
export const NAME_INPUT_CHARS = 48;

/** A key's legacy per-key group name, kept so old records still read right. */
interface LegacyIdentity {
  name: string;
  displayName?: string;
}

/** What the people in a shared wallet call the owner of this phone. */
export function memberName(userName: string | undefined, identity?: LegacyIdentity, fallback = 'Member'): string {
  const own = userName?.trim();
  // Names saved before the inputs were capped: never longer than the group accepts.
  if (own) return own.slice(0, MAX_NAME_CHARS);
  const legacy = identity?.displayName?.trim();
  if (legacy) return legacy.slice(0, MAX_NAME_CHARS);
  return (identity?.name?.trim() || fallback).slice(0, MAX_NAME_CHARS);
}

/** "Rob" → "Rob's"; "James" → "James's"; a name already ending in 's → unchanged. */
export function possessive(name: string): string {
  const trimmed = name.trim();
  if (/['’]s$/i.test(trimmed)) return trimmed;
  return `${trimmed}'s`;
}

/**
 * The name a new phone key gets by default: "Rob's phone", then "Rob's
 * phone 2" and so on when that name is taken. Without a user name it falls
 * back to the old "My phone key".
 */
export function defaultPhoneKeyName(userName: string | undefined, existingNames: string[]): string {
  const own = userName?.trim();
  const base = own ? `${possessive(own)} phone` : 'My phone key';
  const taken = new Set(existingNames.map((n) => n.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** One sentence for every place the name is asked for or changed. */
export const NAME_PURPOSE =
  'The people you share a wallet with see this name next to your key in the wallet, and on your messages in a group. Nobody else does. Keys you make on this phone are named after it.';
