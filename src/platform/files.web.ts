import type { DocumentPickerAsset } from 'expo-document-picker';
import { bridgeError, desktopBridge } from './bridge';

/**
 * Files in and out of the app in the web bundle. A picked document comes
 * from the browser as a File; an export goes through the desktop shell's
 * "Save as…" dialog, or in a plain browser becomes a download. Cancelling
 * the dialog is not an error — the share sheet on a phone can be dismissed
 * the same way.
 */

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** The contents of a document the user picked, as text or base64. */
export async function readPickedDocument(asset: DocumentPickerAsset, encoding: 'utf8' | 'base64' = 'utf8'): Promise<string> {
  const blob: Blob = asset.file ?? (await (await fetch(asset.uri)).blob());
  if (encoding === 'utf8') return blob.text();
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function save(name: string, data: string, encoding: 'utf8' | 'base64', mime: string): Promise<void> {
  const bridge = desktopBridge();
  if (bridge) {
    await bridge.dialog.saveFile({ suggestedName: name, mime, data, encoding }).catch((e) => {
      throw bridgeError(e);
    });
    return;
  }
  const blob =
    encoding === 'utf8'
      ? new Blob([data], { type: mime })
      : new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: mime });
  download(name, blob);
}

export async function saveTextFile(name: string, text: string, mime: string, _title: string, _uti?: string): Promise<void> {
  await save(name, text, 'utf8', mime);
}

export async function saveBinaryFile(name: string, base64: string, mime: string, _title: string, _uti?: string): Promise<void> {
  await save(name, base64, 'base64', mime);
}

export async function savePdfFromHtml(name: string, html: string, _title: string): Promise<void> {
  const bridge = desktopBridge();
  if (bridge) {
    const pdf = await bridge.pdf.fromHtml(html).catch((e) => {
      throw bridgeError(e);
    });
    await save(name, pdf, 'base64', 'application/pdf');
    return;
  }
  // A browser has no PDF renderer to hand us a file: print the page instead.
  const win = window.open('', '_blank');
  if (!win) throw new Error('The browser blocked the print window.');
  win.document.write(html);
  win.document.close();
  win.focus();
  win.print();
}
