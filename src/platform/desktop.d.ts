/**
 * What desktop/preload.js puts on `window.desktop` when the app runs inside
 * the Electron shell. Absent on the phones and in a plain browser; everything
 * in src/platform checks `desktopBridge()` before using it. Each call is one
 * IPC round trip to desktop/lib/ipc.js, which validates every argument.
 */
export interface DesktopBridge {
  platform: 'darwin' | 'win32' | 'linux' | string;
  appVersion: string;
  isPackaged: boolean;
  /** AsyncStorage's stand-in: a JSON file in the app's data directory. */
  storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
    multiRemove(keys: string[]): Promise<void>;
    getAllKeys(): Promise<string[]>;
    clear(): Promise<void>;
  };
  /** SecureStore's stand-in: values encrypted by the OS keystore (Electron safeStorage). */
  secure: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    deleteItem(key: string): Promise<void>;
    info(): Promise<{ available: boolean; backend: string }>;
  };
  dialog: {
    /** A native message box; resolves with the index of the button pressed. */
    message(opts: {
      type?: 'none' | 'info' | 'error' | 'question' | 'warning';
      title: string;
      message?: string;
      buttons: string[];
      defaultId?: number;
      cancelId?: number;
    }): Promise<number>;
    /** "Save as…" then the write; the path is the user's choice alone. */
    saveFile(opts: {
      suggestedName: string;
      mime?: string;
      data: string;
      encoding: 'utf8' | 'base64';
    }): Promise<{ saved: boolean; path?: string }>;
  };
  pdf: {
    /** Renders HTML to a PDF (base64) in a hidden, script-less window. */
    fromHtml(html: string): Promise<string>;
  };
  clipboard: { writeText(text: string): Promise<void> };
  shell: { openExternal(url: string): Promise<void> };
  window: {
    /** Marks a file chooser the page opened, so its focus steal is not "left the app". */
    setDialogOpen(open: boolean): Promise<void>;
    /** Keeps the window out of screenshots and screen sharing (macOS and Windows). */
    setContentProtection(enabled: boolean): Promise<void>;
    /** Focus, minimise, screen lock and sleep, as the page's app state. */
    onStateChange(cb: (state: 'active' | 'background') => void): () => void;
  };
  /** HTTP from the main process: no same-origin policy, no cookies. */
  net: {
    fetch(request: {
      id: string;
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    }): Promise<{ status: number; statusText: string; headers: [string, string][]; body: string }>;
    abort(id: string): void;
  };
  /** Raw TCP/TLS for the Electrum client. */
  tcp: {
    connect(opts: { host: string; port: number; tls: boolean }): Promise<number>;
    write(id: number, data: string): Promise<void>;
    destroy(id: number): void;
    subscribe(id: number, cb: (event: DesktopTcpEvent) => void): () => void;
  };
}

export type DesktopTcpEvent =
  | { id: number; type: 'connect' }
  | { id: number; type: 'data'; chunk: string }
  | { id: number; type: 'error'; message: string }
  | { id: number; type: 'close' };

declare global {
  // eslint-disable-next-line no-var
  var desktop: DesktopBridge | undefined;
}
