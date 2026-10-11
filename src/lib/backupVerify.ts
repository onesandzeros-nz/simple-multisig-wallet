import { ParsedWallet, parseWalletImportText } from './walletImport';
import { parseKeyExpression } from './slip132';
import { findSameWallet, sameWalletPolicy } from './walletMatch';
import { groupFromBackupText } from './groupBackup';
import { Cosigner, MultisigWallet } from './types';

/**
 * Backup verification: does a scanned / opened / pasted backup describe the
 * wallet on this phone? Pure comparison only — nothing here imports a wallet
 * or writes anything; the screen stamps `backupVerifiedAt` on a match.
 */

export interface BackupDifference {
  field: 'policy' | 'network' | 'missing-cosigner' | 'extra-cosigner';
  expected?: string;
  found?: string;
  fingerprint?: string;
  xpubShort?: string;
}

/**
 * What a matching backup says about the wallet's group:
 *  - matches:    it carries this group's invite
 *  - differs:    it carries some other group's invite
 *  - missing:    this is a group wallet whose backup should carry it, and does not
 *  - rejoinable: it carries a group, and this wallet has none on this phone yet
 */
export type GroupCheck = 'matches' | 'differs' | 'missing' | 'rejoinable';

/**
 * The wallet's group on this phone, for checking a backup against: its invite
 * secret, and whether its backups should carry it (a group from before
 * rotation stays out of backups).
 */
export interface GroupOnPhone {
  secret: string;
  expected: boolean;
}

export type BackupVerdict =
  | {
      status: 'match';
      parsed: ParsedWallet;
      nameDiffers: boolean;
      originWarnings: string[];
      group: GroupCheck | null;
    }
  | { status: 'mismatch'; parsed: ParsedWallet; differences: BackupDifference[]; unrelated: boolean }
  | { status: 'other-wallet'; parsed: ParsedWallet; otherName: string }
  | { status: 'not-a-backup'; kind: 'pdf' | 'single-key' }
  /** The "Rejoin the group" QR on its own. `matches` is null when this wallet has no group here. */
  | { status: 'group-invite'; matches: boolean | null }
  | { status: 'unreadable'; message: string };

export interface VerdictCopy {
  tone: 'success' | 'warning' | 'danger';
  title: string;
  lines: string[];
}

/** `xpub6CUG…abc123` — enough to tell keys apart on a phone screen. */
export function shortXpub(x: string): string {
  return `${x.slice(0, 8)}…${x.slice(-6)}`;
}

/** Trim, lowercase, and turn h/H hardened markers into ' so paths compare by meaning. */
export function normalisePath(p: string): string {
  return p.trim().toLowerCase().replace(/h/g, "'");
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Warnings for a backup that matches the wallet's keys but carries different
 * key-origin data. Addresses are unaffected (they come from the xpubs), but a
 * hardware signer matches PSBT inputs to its own key by fingerprint and path.
 */
function originWarnings(wallet: MultisigWallet, parsed: ParsedWallet): string[] {
  const warnings: string[] = [];
  for (const c of wallet.cosigners) {
    const p = parsed.cosigners.find((x) => x.xpub === c.xpub);
    if (!p) continue;
    if (p.fingerprint.toLowerCase() !== c.fingerprint.toLowerCase()) {
      warnings.push(
        `Fingerprint for ${c.name} reads ${p.fingerprint} in the backup but ${c.fingerprint} here — a hardware signer may not recognise its key after a restore.`
      );
    }
    if (normalisePath(p.path) !== normalisePath(c.path)) {
      warnings.push(`Derivation path for ${c.name} differs (${p.path} in the backup, ${c.path} here).`);
    }
  }
  return warnings;
}

function cosignerDifference(field: 'missing-cosigner' | 'extra-cosigner', c: Cosigner): BackupDifference {
  return { field, fingerprint: c.fingerprint, xpubShort: shortXpub(c.xpub) };
}

function checkGroup(text: string, group: GroupOnPhone | null): GroupCheck | null {
  const carried = groupFromBackupText(text);
  if (!group) return carried ? 'rejoinable' : null;
  if (carried) return carried.invite.secret === group.secret ? 'matches' : 'differs';
  return group.expected ? 'missing' : null;
}

/**
 * Compares backup text (descriptor, config file, JSON export, or a scanned
 * "Scan to restore" QR) with `wallet`. `allWallets` lets a backup of another
 * wallet on this phone be named rather than reported as a bare mismatch.
 * `group` is the wallet's group on this phone, if it has one.
 */
export function verifyBackupText(
  text: string,
  wallet: MultisigWallet,
  allWallets: MultisigWallet[] = [],
  group: GroupOnPhone | null = null
): BackupVerdict {
  const t = text.trim();
  if (!t) return { status: 'unreadable', message: 'Nothing to check.' };
  if (t.startsWith('%PDF')) return { status: 'not-a-backup', kind: 'pdf' };

  // The printed backup's group QR: part of the backup, but not the wallet.
  if (/^multisig:join\?/i.test(t)) {
    const carried = groupFromBackupText(t);
    if (!carried) return { status: 'unreadable', message: 'That group code is damaged.' };
    return { status: 'group-invite', matches: group ? carried.invite.secret === group.secret : null };
  }

  // A cosigner QR from the PDF, or a bare Zpub: one key, not a wallet.
  if (!/^(\{|wsh\()/i.test(t) && !/^policy\s*:/im.test(t)) {
    let singleKey = false;
    try {
      parseKeyExpression(t);
      singleKey = true;
    } catch {
      // not a key expression — fall through to the wallet parsers
    }
    if (singleKey) return { status: 'not-a-backup', kind: 'single-key' };
  }

  let parsed: ParsedWallet;
  try {
    parsed = parseWalletImportText(t);
  } catch (e) {
    return { status: 'unreadable', message: errorMessage(e) };
  }

  if (sameWalletPolicy(wallet, parsed)) {
    return {
      status: 'match',
      parsed,
      nameDiffers: parsed.name !== undefined && parsed.name !== wallet.name,
      originWarnings: originWarnings(wallet, parsed),
      group: checkGroup(t, group),
    };
  }

  const other = findSameWallet(
    allWallets.filter((w) => w.id !== wallet.id),
    parsed
  );
  if (other) return { status: 'other-wallet', parsed, otherName: other.name };

  const differences: BackupDifference[] = [];
  if (wallet.m !== parsed.m || wallet.n !== parsed.n) {
    differences.push({ field: 'policy', expected: `${wallet.m} of ${wallet.n}`, found: `${parsed.m} of ${parsed.n}` });
  }
  if (wallet.network !== parsed.network) {
    differences.push({ field: 'network', expected: wallet.network, found: parsed.network });
  }
  const walletXpubs = new Set(wallet.cosigners.map((c) => c.xpub));
  const parsedXpubs = new Set(parsed.cosigners.map((c) => c.xpub));
  for (const c of wallet.cosigners) {
    if (!parsedXpubs.has(c.xpub)) differences.push(cosignerDifference('missing-cosigner', c));
  }
  for (const c of parsed.cosigners) {
    if (!walletXpubs.has(c.xpub)) differences.push(cosignerDifference('extra-cosigner', c));
  }
  const unrelated = wallet.cosigners.every((c) => !parsedXpubs.has(c.xpub));
  return { status: 'mismatch', parsed, differences, unrelated };
}

function describeDifference(d: BackupDifference): string {
  switch (d.field) {
    case 'policy':
      return `Policy: the backup says ${d.found}, this wallet is ${d.expected}.`;
    case 'network':
      return `Network: the backup is ${d.found}, this wallet is ${d.expected}.`;
    case 'missing-cosigner':
      return `Missing signer ${d.fingerprint} (${d.xpubShort}).`;
    case 'extra-cosigner':
      return `Unknown signer ${d.fingerprint} (${d.xpubShort}).`;
  }
}

/** Screen copy for a verdict: tone for the card border/icon, a title and body lines. */
export function describeVerdict(v: BackupVerdict, wallet: MultisigWallet): VerdictCopy {
  switch (v.status) {
    case 'match': {
      const lines = [
        `This backup describes exactly this wallet — ${wallet.m} of ${wallet.n}, ${wallet.network}, ${wallet.n} signers. Restoring from it would give the same addresses.`,
        'Nothing was imported — no second copy of the wallet was created.',
      ];
      if (v.nameDiffers) {
        lines.push(
          `The backup calls it "${v.parsed.name}" — names are shortened and simplified in the file, which is fine.`
        );
      }
      if (v.group === 'matches') lines.push("It also carries this wallet's group, so the group can be rejoined from it.");
      if (v.group === 'rejoinable') {
        lines.push("It also carries the wallet's group. Rejoin it from Manage → Join this wallet's group.");
      }
      if (v.group === 'missing') {
        lines.push("It doesn't include the group, so the group can't be rejoined from it. Save a new backup.");
      }
      if (v.group === 'differs') {
        lines.push("The group code in it belongs to a different group than this wallet's. Save a new backup.");
      }
      const groupTrouble = v.group === 'missing' || v.group === 'differs';
      return { tone: groupTrouble ? 'warning' : 'success', title: 'Backup verified', lines };
    }
    case 'mismatch':
      return {
        tone: 'danger',
        title: v.unrelated ? 'This is a different wallet' : "This backup doesn't match",
        lines: [
          ...v.differences.map(describeDifference),
          'Do not rely on this backup. Make a fresh one and check it again.',
        ],
      };
    case 'other-wallet':
      return {
        tone: 'warning',
        title: 'This is a backup of a different wallet',
        lines: [`It matches "${v.otherName}" on this phone. Find the backup you made for "${wallet.name}".`],
      };
    case 'not-a-backup':
      return v.kind === 'pdf'
        ? {
            tone: 'warning',
            title: "That's the PDF file itself",
            lines: ['Open the printed page and scan the large "Scan to restore" QR code instead, or open the .txt backup file.'],
          }
        : {
            tone: 'warning',
            title: "That's one key, not the wallet",
            lines: ['You scanned a cosigner QR. Scan the large "Scan to restore" QR at the top of the page.'],
          };
    case 'group-invite':
      if (v.matches === true) {
        return {
          tone: 'success',
          title: "That's this wallet's group code",
          lines: [
            "Scan it to rejoin the group after restoring the wallet. It isn't the wallet backup itself — check that with the large \"Scan to restore\" QR.",
          ],
        };
      }
      if (v.matches === false) {
        return {
          tone: 'danger',
          title: "That's a different group's code",
          lines: ["It belongs to another group, not this wallet's. Find the backup you made for this wallet."],
        };
      }
      return {
        tone: 'warning',
        title: "That's a group code, not the wallet",
        lines: [
          "This wallet has no group on this phone. To rejoin its group, use Manage → Join this wallet's group. To check the wallet backup, scan the large \"Scan to restore\" QR.",
        ],
      };
    case 'unreadable':
      return { tone: 'danger', title: "Couldn't read that backup", lines: [v.message] };
  }
}
