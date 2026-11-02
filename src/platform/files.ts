import type { DocumentPickerAsset } from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

/**
 * Files in and out of the app on a phone: a picked document is read from
 * its URI, and an export is written to the cache and handed to the share
 * sheet. files.web.ts, which the web bundle gets instead, does the same
 * through the desktop shell's save dialog.
 */

/** The contents of a document the user picked, as text or base64. */
export async function readPickedDocument(asset: DocumentPickerAsset, encoding: 'utf8' | 'base64' = 'utf8'): Promise<string> {
  return FileSystem.readAsStringAsync(
    asset.uri,
    encoding === 'base64' ? { encoding: FileSystem.EncodingType.Base64 } : undefined
  );
}

async function shareFile(uri: string, mimeType: string, title: string, uti = mimeType): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('This device has no way to share files.');
  }
  await Sharing.shareAsync(uri, { mimeType, dialogTitle: title, UTI: uti });
}

/** Writes text to a file named `name` and opens the share sheet for it. */
export async function saveTextFile(name: string, text: string, mime: string, title: string, uti?: string): Promise<void> {
  const uri = `${FileSystem.cacheDirectory}${name}`;
  await FileSystem.writeAsStringAsync(uri, text);
  await shareFile(uri, mime, title, uti);
}

/** Writes bytes (given as base64) to a file named `name` and opens the share sheet for it. */
export async function saveBinaryFile(name: string, base64: string, mime: string, title: string, uti?: string): Promise<void> {
  const uri = `${FileSystem.cacheDirectory}${name}`;
  await FileSystem.writeAsStringAsync(uri, base64, { encoding: FileSystem.EncodingType.Base64 });
  await shareFile(uri, mime, title, uti);
}

/** Renders HTML to a PDF named `name` and opens the share sheet for it. */
export async function savePdfFromHtml(name: string, html: string, title: string): Promise<void> {
  const { uri } = await Print.printToFileAsync({ html });
  // Give the file a meaningful name — printToFileAsync uses a random one.
  const named = `${FileSystem.cacheDirectory}${name}`;
  try {
    await FileSystem.moveAsync({ from: uri, to: named });
    await shareFile(named, 'application/pdf', title);
  } catch {
    await shareFile(uri, 'application/pdf', title);
  }
}
