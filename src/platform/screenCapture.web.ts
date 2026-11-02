import { useEffect } from 'react';
import { desktopBridge } from './bridge';

/**
 * What `expo-screen-capture` resolves to in the web bundle (metro.config.js).
 * The screens that show a recovery phrase ask not to be captured; on the
 * desktop that becomes Electron's content protection, which keeps the
 * window out of screenshots and screen sharing on macOS and Windows (Linux
 * has no such thing). Keys work as in expo-screen-capture: the window is
 * protected while any key is held. The real web module would throw.
 */
const DEFAULT_KEY = 'default';
const holders = new Set<string>();

async function apply(): Promise<void> {
  const bridge = desktopBridge();
  if (!bridge) return;
  await bridge.window.setContentProtection(holders.size > 0).catch(() => {});
}

export function usePreventScreenCapture(key: string = DEFAULT_KEY): void {
  useEffect(() => {
    holders.add(key);
    void apply();
    return () => {
      holders.delete(key);
      void apply();
    };
  }, [key]);
}

export async function preventScreenCaptureAsync(key: string = DEFAULT_KEY): Promise<void> {
  holders.add(key);
  await apply();
}

export async function allowScreenCaptureAsync(key: string = DEFAULT_KEY): Promise<void> {
  holders.delete(key);
  await apply();
}

export async function isAvailableAsync(): Promise<boolean> {
  const bridge = desktopBridge();
  return !!bridge && (bridge.platform === 'darwin' || bridge.platform === 'win32');
}
