import QRCode from 'qrcode';
import { saveBinaryFile, savePdfFromHtml, saveTextFile } from '../platform/files';
import { APP_VERSION } from '../version';
import { bip139ExportJson } from './bip139';
import { keyExpression, walletConfigFile, walletDescriptor } from './bitcoin';
import { writeTextToTag } from './nfc';
import { loadGroupSecret } from './store';
import { BackupKind } from './tutorial';
import { Group, MultisigWallet, PendingTx, SignerKey } from './types';
import { loadCached } from './walletCache';
import { backupPdfHtml, exportBaseName, walletBackupFile } from './walletExport';
import { GroupBackup, groupBackupFor } from './groupBackup';

/** Renders a QR as an inline SVG string for the printable backup. */
async function qrSvg(data: string): Promise<string> {
  return QRCode.toString(data, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
}

/**
 * Writes the transaction as a binary .psbt file — the form Sparrow, Coldcard,
 * Nunchuk and Electrum open — and hands it to the share sheet. A text share
 * has no file behind it, so on Android "save to Files" or Drive refuses it.
 */
export async function exportPsbtFile(base64: string, baseName: string): Promise<void> {
  await saveBinaryFile(`${baseName}.psbt`, base64.trim(), 'application/octet-stream', `${baseName}.psbt`, 'public.data');
}

/**
 * The group section for a wallet's backup, read from the keystore — null for a
 * private wallet or a group from before rotation. Pass it to the exports below
 * and to `recordExport`.
 */
export async function loadGroupBackup(
  wallet: MultisigWallet,
  groups: Group[],
  keys: SignerKey[]
): Promise<GroupBackup | null> {
  const group = groups.find((g) => g.walletId === wallet.id);
  if (!group) return null;
  return groupBackupFor(group, await loadGroupSecret(group.id), keys);
}

/**
 * Exports a backup — the text file, the PDF or the BIP-139 export — carrying
 * the wallet's group when it has one. Returns whether it did, for
 * `recordExport` once the share sheet has been through. `pendingTxs` only
 * matter to the BIP-139 export, which carries the wallet's drafts.
 */
export async function exportBackup(
  which: BackupKind,
  wallet: MultisigWallet,
  groups: Group[],
  keys: SignerKey[],
  pendingTxs: PendingTx[] = []
): Promise<boolean> {
  const group = await loadGroupBackup(wallet, groups, keys);
  if (which === 'file') await exportWalletFile(wallet, group);
  else if (which === 'pdf') await exportWalletPdf(wallet, group);
  else await exportWalletBip139(wallet, group, keys, pendingTxs);
  return !!group;
}

/**
 * Writes the BIP-139 wallet metadata export and opens the share sheet. The
 * coins and history come from the cache the wallet screen keeps — nothing is
 * fetched, so this works offline and says what the phone last saw.
 */
export async function exportWalletBip139(
  wallet: MultisigWallet,
  group: GroupBackup | null,
  keys: SignerKey[],
  pendingTxs: PendingTx[]
): Promise<void> {
  const sync = await loadCached(wallet.id);
  const json = bip139ExportJson({
    wallet,
    keys,
    group,
    pendingTxs,
    sync: sync ?? null,
    now: Date.now(),
    exporter: `Simple Multisig ${APP_VERSION}`,
  });
  await saveTextFile(`${exportBaseName(wallet)}-bip139.json`, json, 'application/json', `${wallet.name} BIP-139 export`, 'public.json');
}

/** Writes the Sparrow/Coldcard-compatible text file and opens the share sheet. */
export async function exportWalletFile(wallet: MultisigWallet, group?: GroupBackup | null): Promise<void> {
  await saveTextFile(`${exportBaseName(wallet)}.txt`, walletBackupFile(wallet, group), 'text/plain', `${wallet.name} backup`);
}

/**
 * Hands the wallet setup to a Coldcard over NFC. The card needs this before
 * it will recognise addresses as its own or sign for the wallet.
 */
export async function exportWalletToCard(wallet: MultisigWallet): Promise<void> {
  await writeTextToTag(
    walletConfigFile(wallet),
    'Hold the phone against the Coldcard to import the wallet.'
  );
}

/** Builds the printable QR backup as a PDF and opens the share sheet (or, on the desktop, "Save as…"). */
export async function exportWalletPdf(wallet: MultisigWallet, group?: GroupBackup | null): Promise<void> {
  const [descriptorQr, groupQr, ...cosignerQrs] = await Promise.all([
    qrSvg(walletDescriptor(wallet)),
    group ? qrSvg(group.invite) : Promise.resolve(undefined),
    ...wallet.cosigners.map((c) => qrSvg(keyExpression(c))),
  ]);
  const html = backupPdfHtml(
    wallet,
    { descriptor: descriptorQr, cosigners: cosignerQrs as string[], group: groupQr },
    new Date().toLocaleString(),
    group
  );
  await savePdfFromHtml(`${exportBaseName(wallet)}-backup.pdf`, html, `${wallet.name} backup`);
}
