import { Alert, AlertButton, AlertOptions, AppState, AppStateStatus, Share, ShareContent, ShareOptions } from 'react-native';
import { Asset } from 'expo-asset';
import { prepareZXingModule } from 'barcode-detector';
import { bridgeError, desktopBridge } from './bridge';
import { planAlert } from './alertPlan';

/**
 * Platform setup for the web bundle, which is what the desktop app runs.
 * react-native-web leaves `Alert.alert` empty and `Share.share` needs an API
 * Chromium does not give Electron, so both are pointed at the desktop
 * shell's native dialogs (or, in a plain browser, at window.confirm and
 * the clipboard). The camera's QR decoder is told where its WebAssembly is.
 */
export function setupPlatform(): void {
  patchAlert();
  patchShare();
  patchAppState();
  bundleBarcodeDecoder();
}

function text(title: string, message?: string): string {
  return [title, message].filter((s) => s && s.trim()).join('\n\n');
}

function patchAlert(): void {
  Alert.alert = (title: string, message?: string, buttons?: AlertButton[], options?: AlertOptions): void => {
    void showAlert(title, message, buttons ?? [], options ?? {});
  };
}

async function showAlert(title: string, message: string | undefined, buttons: AlertButton[], _options: AlertOptions): Promise<void> {
  const list: AlertButton[] = buttons.length ? buttons : [{ text: 'OK' }];
  const plan = planAlert(list);
  const bridge = desktopBridge();
  let index: number;
  if (bridge) {
    try {
      index = await bridge.dialog.message({
        type: plan.destructive ? 'warning' : 'none',
        title,
        message,
        buttons: plan.labels,
        defaultId: plan.defaultId,
        cancelId: plan.cancelId,
      });
    } catch (e) {
      // The flow behind the alert must still settle: take the cancel button,
      // or the only button when the alert was just information.
      console.warn(`[alert] ${bridgeError(e).message}`);
      index = plan.cancelId ?? (plan.labels.length === 1 ? 0 : -1);
      if (index < 0) return;
      list[index]?.onPress?.();
      return;
    }
  } else if (plan.labels.length === 1) {
    window.alert(text(title, message));
    index = 0;
  } else {
    // A browser confirm has two answers: OK is the default button, Cancel is
    // the cancel one (or the first button when none is marked).
    const cancel = plan.cancelId ?? 0;
    const ok = window.confirm(`${text(title, message)}\n\nOK = ${plan.labels[plan.defaultId]}\nCancel = ${plan.labels[cancel]}`);
    index = ok ? plan.defaultId : cancel;
  }
  list[index]?.onPress?.();
}

function patchShare(): void {
  Share.share = async (content: ShareContent, options: ShareOptions = {}) => {
    const body = ('message' in content && content.message) || ('url' in content && content.url) || '';
    if (!body) throw new Error('Nothing to share.');
    const title = content.title || options.dialogTitle || 'Share';
    const bridge = desktopBridge();
    if (!bridge) {
      if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ title: content.title, text: body });
      } else {
        await navigator.clipboard.writeText(body);
        window.alert('Copied to the clipboard.');
      }
      return { action: Share.sharedAction };
    }
    const preview = body.length > 400 ? `${body.slice(0, 400)}…` : body;
    let choice: number;
    try {
      choice = await bridge.dialog.message({
        type: 'none',
        title,
        message: preview,
        buttons: ['Copy to clipboard', 'Save as file…', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
      });
      if (choice === 2) return { action: Share.dismissedAction };
      if (choice === 0) {
        await bridge.clipboard.writeText(body);
        return { action: Share.sharedAction, activityType: 'clipboard' };
      }
      const name = `${title.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'shared'}.txt`;
      const result = await bridge.dialog.saveFile({ suggestedName: name, mime: 'text/plain', data: body, encoding: 'utf8' });
      return result.saved ? { action: Share.sharedAction, activityType: 'file' } : { action: Share.dismissedAction };
    } catch (e) {
      throw bridgeError(e);
    }
  };
}

/**
 * The phone relocks after a while in the background. react-native-web only
 * reports the page hidden (minimised), so the desktop shell adds focus
 * loss, screen lock and sleep: they arrive here and reach every app-state
 * listener as `background`, and `active` when the window has the focus back.
 */
function patchAppState(): void {
  const bridge = desktopBridge();
  if (!bridge) return;
  const handlers = new Set<(state: AppStateStatus) => void>();
  let current: AppStateStatus = 'active';
  bridge.window.onStateChange((state) => {
    const next: AppStateStatus = state === 'active' ? 'active' : 'background';
    if (next === current) return;
    current = next;
    for (const handler of handlers) handler(next);
  });
  const original = AppState.addEventListener.bind(AppState);
  AppState.addEventListener = ((type: string, handler: (state: AppStateStatus) => void) => {
    const subscription = original(type as any, handler as any);
    if (type !== 'change') return subscription;
    handlers.add(handler);
    return {
      remove: () => {
        subscription.remove();
        handlers.delete(handler);
      },
    };
  }) as typeof AppState.addEventListener;
}

/**
 * expo-camera decodes barcodes on the web with the browser's BarcodeDetector
 * or, where there is none (Chromium on Linux and Windows), the
 * `barcode-detector` polyfill, whose WebAssembly it would fetch from a CDN.
 * The desktop app must work with no CDN, so the module bundled with this
 * build is pointed at instead. The polyfill is imported statically so it
 * ships in the main bundle: the page's content security policy allows no
 * script evaluation, which Metro's split-bundle loader would need.
 */
function bundleBarcodeDecoder(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const asset = Asset.fromModule(require('zxing-wasm/reader/zxing_reader.wasm'));
    const wasmUri = asset.uri;
    if (!wasmUri) return;
    prepareZXingModule({
      overrides: {
        locateFile: (file: string, prefix: string) => (file.endsWith('.wasm') ? wasmUri : prefix + file),
      },
    });
  } catch (e) {
    console.warn(`[camera] the bundled QR decoder could not be set up: ${(e as Error)?.message ?? e}`);
  }
}
