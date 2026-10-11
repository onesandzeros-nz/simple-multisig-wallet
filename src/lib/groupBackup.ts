import { encodeInvite, Invite, parseInvite } from './nostr/protocol';
import { Group, MultisigWallet, SignerKey } from './types';

/**
 * The group section of a wallet backup (RECOVERY-DESIGN.md): enough to rejoin
 * the wallet's group after a lost phone, together with the recovery phrase of
 * the key this device's group identity comes from.
 *
 * Only the invite — the epoch-0 secret. Once the group has rotated that opens
 * nothing but the handshake, which is what REKEY-DESIGN.md demoted it to. The
 * rotated secrets never go in a backup: they would make it a key to every
 * later chat and PSBT, and a restored phone gets them back anyway.
 */
export interface GroupBackup {
  /** The group's invite link: its epoch-0 secret, relays, policy and pinned coordinator. */
  invite: string;
  /** Master fingerprint of the phone key this device's group identity is derived from. */
  identityFingerprint?: string;
}

/**
 * What a wallet's backup should carry about its group, or null for nothing:
 * no group, or a group from before rotation — its invite is still the key to
 * everything it ever sent, so it stays out of backups.
 */
export function groupBackupFor(
  group: Group | undefined,
  secret: string | null,
  keys: SignerKey[]
): GroupBackup | null {
  if (!group || !secret || group.rekey !== true || !group.coordinatorPubkey) return null;
  return {
    invite: encodeInvite({
      secret,
      relays: group.relays,
      name: group.name,
      coordinatorPubkey: group.coordinatorPubkey,
      m: group.m,
      n: group.n,
      network: group.network,
      rekey: true,
    }),
    identityFingerprint: keys.find((k) => k.id === group.identityKeyId)?.fingerprint,
  };
}

/**
 * Comment lines for the backup file. Sparrow, Coldcard, Specter and our own
 * config parser all skip `#` lines, so the file stays a plain wallet file.
 */
export function groupBackupLines(g: GroupBackup): string[] {
  return [
    "# The group invite below opens only the group's handshake. Rejoining also needs the",
    '# recovery phrase of the identity key named after it.',
    `# Group invite: ${g.invite}`,
    ...(g.identityFingerprint ? [`# Group identity: ${g.identityFingerprint}`] : []),
  ];
}

export interface BackupGroup {
  invite: Invite;
  /** The invite link as written, to hand to the join screen. */
  text: string;
  identityFingerprint?: string;
}

/**
 * The group a backup carries: the comment lines of a backup file, or a bare
 * invite — the "Rejoin the group" QR on the printed backup. Null when there
 * is none, or it is damaged.
 */
export function groupFromBackupText(input: string): BackupGroup | null {
  const t = input.trim();
  if (/^multisig:join\?/i.test(t)) {
    try {
      return { invite: parseInvite(t), text: t };
    } catch {
      return null;
    }
  }
  let inviteText: string | undefined;
  let identityFingerprint: string | undefined;
  for (const raw of t.split(/\r?\n/)) {
    const line = raw.trim();
    const invite = line.match(/^#\s*Group invite:\s*(multisig:join\?\S+)$/i);
    if (invite) inviteText = invite[1];
    const identity = line.match(/^#\s*Group identity:\s*([0-9a-f]{8})$/i);
    if (identity) identityFingerprint = identity[1].toLowerCase();
  }
  if (!inviteText) return null;
  try {
    return { invite: parseInvite(inviteText), text: inviteText, identityFingerprint };
  } catch {
    return null;
  }
}

/**
 * A group wallet whose latest backup predates backups carrying the group, or
 * left it out. A wallet never backed up is not this — the ordinary backup nag
 * covers it.
 */
export function backupMissesGroup(
  wallet: Pick<MultisigWallet, 'exportedAt' | 'backupIncludesGroup'>,
  group: Pick<Group, 'rekey' | 'coordinatorPubkey'> | undefined
): boolean {
  return group?.rekey === true && !!group.coordinatorPubkey && !!wallet.exportedAt && !wallet.backupIncludesGroup;
}

/** Why a group cannot be this wallet's group, or null when it can. */
export function restoreMismatch(
  invite: Pick<Invite, 'm' | 'n' | 'network'>,
  wallet: Pick<MultisigWallet, 'm' | 'n' | 'network'>
): string | null {
  if (invite.network !== wallet.network) {
    return `That group is on ${invite.network}, but this wallet is on ${wallet.network}.`;
  }
  if (invite.m !== wallet.m || invite.n !== wallet.n) {
    return `That group is ${invite.m} of ${invite.n}, but this wallet is ${wallet.m} of ${wallet.n}.`;
  }
  return null;
}
