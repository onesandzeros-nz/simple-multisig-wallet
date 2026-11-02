import type { DesktopBridge } from './desktop';

/**
 * The desktop shell, when there is one. `window.desktop` is set by
 * desktop/preload.js inside the Electron app; on a phone, and in a plain
 * browser running `expo start --web`, there is nothing there and every
 * platform module falls back to what the platform itself offers.
 */
export function desktopBridge(): DesktopBridge | null {
  const bridge = typeof globalThis !== 'undefined' ? (globalThis as { desktop?: DesktopBridge }).desktop : undefined;
  return bridge && typeof bridge === 'object' ? bridge : null;
}

export function isDesktop(): boolean {
  return desktopBridge() !== null;
}

/**
 * Whether the page is being served by the desktop shell at all: its bundle
 * only ever loads from app://bundle/. Inside the shell a missing bridge is a
 * fault (a preload that failed), never a reason to fall back to the browser's
 * own storage; outside it (`expo start --web`) the fallbacks are expected.
 */
export function inDesktopShell(): boolean {
  return typeof location !== 'undefined' && location.protocol === 'app:';
}

/** The bridge, or an error when the shell should have provided one. */
export function requireBridgeInShell(what: string): DesktopBridge | null {
  const bridge = desktopBridge();
  if (!bridge && inDesktopShell()) {
    throw new Error(`The desktop shell did not attach its bridge, so ${what} is unavailable. Restart the app.`);
  }
  return bridge;
}

/**
 * An error from the other side of the bridge arrives as
 * "Error invoking remote method 'x': Error: the actual message"; the part
 * worth showing is the last one.
 */
export function bridgeError(e: unknown): Error {
  const raw = e instanceof Error ? e.message : String(e);
  const cleaned = raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(Type)?Error:\s*/, '');
  return new Error(cleaned || 'The desktop app could not complete that.');
}

let counter = 0;
/** A request id for calls the bridge may need to abort. */
export function bridgeRequestId(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter}`;
}
