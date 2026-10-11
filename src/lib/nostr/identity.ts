import { bech32 } from 'bech32';
import { sha256 } from '@noble/hashes/sha256';
import { Buffer } from 'buffer';
import { rootFromMnemonic } from '../bitcoin';
import { getPublicKey } from './crypto';

/**
 * Nostr identity derived from a phone key's seed, per NIP-06:
 *   m/44'/1237'/<account>'/0/0
 *
 * Account 0 is the standard NIP-06 identity — the same npub any Nostr
 * client derives from this seed, i.e. the user's public social identity.
 * We deliberately DO NOT use it for wallet coordination. Each group gets
 * its own account index derived from the group secret, so:
 *   - a relay cannot link two groups to the same person,
 *   - coordination is never tied to the user's public Nostr identity,
 *   - the identity is still deterministic, so it survives a reinstall
 *     and is identical on every device holding the same seed.
 *
 * The group secret used here is ALWAYS the epoch-0 secret from the invite,
 * never the rotated one (REKEY-DESIGN.md). Two things depend on that:
 *   - `Group.coordinatorPubkey` is pinned from the invite and is the only
 *     thing stopping an invite-holder pushing a malicious wallet. If
 *     identities re-derived per epoch, every pubkey would change at a
 *     rotation and that pin would be void across the boundary.
 *   - a member who reinstalls derives the same pubkey from seed + invite, so
 *     the coordinator still recognises them and can seal them back in.
 */
export const NOSTR_PURPOSE_PATH = "m/44'/1237'/0'/0/0";

/** Account index for a group: 31 bits derived from its epoch-0 secret. */
export function groupAccountIndex(rootSecretHex: string): number {
  const digest = sha256(
    Buffer.concat([Buffer.from(rootSecretHex, 'hex'), Buffer.from('simple-multisig/nostr-account', 'utf8')])
  );
  // Mask to 31 bits so the index is always valid for hardened derivation,
  // and skip 0 so a group can never collide with the public NIP-06 identity.
  const index = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) & 0x7fffffff;
  return index === 0 ? 1 : index;
}

export function nostrSecretFromMnemonic(mnemonic: string, account = 0): string {
  const root = rootFromMnemonic(mnemonic, 'mainnet');
  const node = root.derivePath(`m/44'/1237'/${account}'/0/0`);
  if (!node.privateKey) throw new Error('Could not derive a Nostr key from this seed.');
  return Buffer.from(node.privateKey).toString('hex');
}

/**
 * The identity this device uses inside one specific group. `rootSecretHex` is
 * the epoch-0 (invite) secret and must stay so for the life of the group —
 * passing a rotated secret here would silently break the coordinator pin.
 */
export function nostrSecretForGroup(mnemonic: string, rootSecretHex: string): string {
  return nostrSecretFromMnemonic(mnemonic, groupAccountIndex(rootSecretHex));
}

/**
 * Whether this seed is the group's coordinator: only the coordinator's seed
 * derives the pubkey its invite pins. A coordinator restoring from a backup
 * is recognised this way, which makes no new trust decision — the pin stays
 * exactly where it was (RECOVERY-DESIGN.md).
 */
export function isCoordinatorSeed(mnemonic: string, rootSecretHex: string, coordinatorPubkey?: string): boolean {
  return !!coordinatorPubkey && getPublicKey(nostrSecretForGroup(mnemonic, rootSecretHex)) === coordinatorPubkey;
}

function toBech32(prefix: string, hex: string): string {
  return bech32.encode(prefix, bech32.toWords(Buffer.from(hex, 'hex')), 200);
}

export function npubFromSecret(secretHex: string): string {
  return toBech32('npub', getPublicKey(secretHex));
}

export function npubFromPubkey(pubkeyHex: string): string {
  return toBech32('npub', pubkeyHex);
}

export function nsecFromSecret(secretHex: string): string {
  return toBech32('nsec', secretHex);
}

/** Short, human-friendly form: npub1abcd…wxyz */
export function shortNpub(pubkeyHex: string): string {
  const npub = npubFromPubkey(pubkeyHex);
  return `${npub.slice(0, 10)}…${npub.slice(-4)}`;
}
