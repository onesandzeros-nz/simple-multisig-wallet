import * as Picker from 'expo-document-picker/build/index';
import { desktopBridge } from './bridge';

/**
 * What `expo-document-picker` resolves to in the web bundle (metro.config.js):
 * the real module, with the desktop shell told while the file chooser is up.
 * The chooser takes the focus from the window, which would otherwise count
 * as leaving the app and, in security mode, relock it mid-import.
 */
export * from 'expo-document-picker/build/index';

export async function getDocumentAsync(
  options?: Parameters<typeof Picker.getDocumentAsync>[0]
): ReturnType<typeof Picker.getDocumentAsync> {
  const bridge = desktopBridge();
  await bridge?.window.setDialogOpen(true).catch(() => {});
  try {
    return await Picker.getDocumentAsync(options);
  } finally {
    await bridge?.window.setDialogOpen(false).catch(() => {});
  }
}
