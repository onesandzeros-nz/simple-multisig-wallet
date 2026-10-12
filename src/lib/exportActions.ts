import * as FileSystem from 'expo-file-system/legacy';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import QRCode from 'qrcode';
import { keyExpression, walletConfigFile, walletDescriptor } from './bitcoin';
import { writeTextToTag } from './nfc';
import { loadGroupSecret } from './store';
import { Group, MultisigWallet, SignerKey } from './types';
import { backupPdfHtml, exportBaseName, walletBackupFile } from './walletExport';
import { GroupBackup, groupBackupFor } from './groupBackup';

/** Renders a QR as an inline SVG string for the printable backup. */
async function qrSvg(data: string): Promise<string> {
  return QRCode.toString(data, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
}

async function shareFile(uri: string, mimeType: string, title: string, uti = mimeType): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('This device has no way to share files.');
  }
  await Sharing.shareAsync(uri, { mimeType, dialogTitle: title, UTI: uti });
}

/**
 * Writes the transaction as a binary .psbt file — the form Sparrow, Coldcard,
 * Nunchuk and Electrum open — and hands it to the share sheet. A text share
 * has no file behind it, so on Android "save to Files" or Drive refuses it.
 */
export async function exportPsbtFile(base64: string, baseName: string): Promise<void> {
  const uri = `${FileSystem.cacheDirectory}${baseName}.psbt`;
  await FileSystem.writeAsStringAsync(uri, base64.trim(), { encoding: FileSystem.EncodingType.Base64 });
  await shareFile(uri, 'application/octet-stream', `${baseName}.psbt`, 'public.data');
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
 * Exports a backup — the file or the PDF — carrying the wallet's group when it
 * has one. Returns whether it did, for `recordExport` once the share sheet has
 * been through.
 */
export async function exportBackup(
  which: 'file' | 'pdf',
  wallet: MultisigWallet,
  groups: Group[],
  keys: SignerKey[]
): Promise<boolean> {
  const group = await loadGroupBackup(wallet, groups, keys);
  if (which === 'file') await exportWalletFile(wallet, group);
  else await exportWalletPdf(wallet, group);
  return !!group;
}

/** Writes the Sparrow/Coldcard-compatible text file and opens the share sheet. */
export async function exportWalletFile(wallet: MultisigWallet, group?: GroupBackup | null): Promise<void> {
  const uri = `${FileSystem.cacheDirectory}${exportBaseName(wallet)}.txt`;
  await FileSystem.writeAsStringAsync(uri, walletBackupFile(wallet, group));
  await shareFile(uri, 'text/plain', `${wallet.name} backup`);
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

/** Builds the printable QR backup as a PDF and opens the share sheet. */
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
  const { uri } = await Print.printToFileAsync({ html });

  // Give the file a meaningful name — printToFileAsync uses a random one.
  const named = `${FileSystem.cacheDirectory}${exportBaseName(wallet)}-backup.pdf`;
  try {
    await FileSystem.moveAsync({ from: uri, to: named });
    await shareFile(named, 'application/pdf', `${wallet.name} backup`);
  } catch {
    await shareFile(uri, 'application/pdf', `${wallet.name} backup`);
  }
}
