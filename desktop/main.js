'use strict';

/**
 * Simple Multisig on the desktop: Electron around the Expo web export.
 *
 * The page is the same React Native code the phones run, bundled for the
 * web by `npx expo export --platform web` into dist/ and served here from
 * app://bundle/. What a phone has natively — the keystore, storage, TCP for
 * Electrum, dialogs, file saving, printing — the main process provides over
 * a narrow bridge (preload.js, lib/ipc.js). The renderer is sandboxed and
 * isolated, loads nothing from the network except Nostr relays, and cannot
 * navigate away or open windows.
 */
const path = require('node:path');
const { app, BrowserWindow, Menu, dialog, powerMonitor, screen, session, shell } = require('electron');

const pkg = require('../package.json');
const { JsonFileStore } = require('./lib/storage');
const { SecureStore } = require('./lib/secure');
const { TcpSessions } = require('./lib/tcp');
const { NetFetch } = require('./lib/netfetch');
const { registerIpc } = require('./lib/ipc');
const { buildMenu, editContextMenu } = require('./lib/menu');
const { dialogsOpen } = require('./lib/dialogs');
const { isWalletDevice } = require('./lib/hwDevices');
const protocol = require('./lib/protocol');

const DIST_DIR = path.join(__dirname, '..', 'dist');
const PRELOAD = path.join(__dirname, 'preload.js');
const WINDOW_ICON = path.join(__dirname, 'build', 'icon.png');

// `npm run desktop:dev` points a development run at the Metro dev server
// for live reload. A packaged app ignores the variable: nothing but the
// bundle may ever be loaded with the bridge attached.
const DEV_URL = app.isPackaged ? null : devUrl(process.env.ELECTRON_DEV_URL);

function devUrl(raw) {
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('ELECTRON_DEV_URL must be a plain http URL on this machine.');
  }
  return url.toString();
}

/** Where the page lives: the bundle's origin, or the dev server's. */
function isAppUrl(url) {
  if (typeof url !== 'string') return false;
  if (url.startsWith(`${protocol.ORIGIN}/`)) return true;
  return DEV_URL !== null && url.startsWith(new URL(DEV_URL).origin + '/');
}

// One name for the data directory whatever the product is called. The
// environment variable gives the smoke test (or a portable install) its own.
app.setName('Simple Multisig');
app.setPath('userData', process.env.SIMPLE_MULTISIG_USER_DATA || path.join(app.getPath('appData'), 'simple-multisig'));

protocol.registerScheme();

let mainWindow = null;
let storage = null;
let secure = null;
const tcp = new TcpSessions();
const netFetch = new NetFetch();

// A second copy would race the first for the storage files.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (storage) {
      createWindow();
    }
  });
  app.whenReady().then(start);
}

function start() {
  SecureStore.prepare();
  try {
    const dir = app.getPath('userData');
    storage = new JsonFileStore(path.join(dir, 'storage.json'));
    secure = new SecureStore(path.join(dir, 'secure.json'));
  } catch (e) {
    dialog.showErrorBox('Simple Multisig cannot start', String(e && e.message ? e.message : e));
    app.exit(1);
    return;
  }

  protocol.serveBundle(DIST_DIR);
  harden(session.defaultSession);
  registerIpc({
    appVersion: pkg.version,
    storage,
    secure,
    tcp,
    netFetch,
    isTrustedSender: (sender) =>
      mainWindow !== null && !mainWindow.isDestroyed() && sender.id === mainWindow.webContents.id && isAppUrl(sender.getURL()),
    getWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
  });
  Menu.setApplicationMenu(buildMenu({ isDev: !app.isPackaged }));
  createWindow();

  // The phone relocks after a while in the background. A desktop window is
  // "in the background" when it loses focus, is minimised, or the machine
  // locks or sleeps; the page hears about it as an app-state change.
  const tell = (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('window:state', state);
  };
  powerMonitor.on('lock-screen', () => tell('background'));
  powerMonitor.on('suspend', () => tell('background'));
  powerMonitor.on('unlock-screen', () => mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused() && tell('active'));
  powerMonitor.on('resume', () => mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused() && tell('active'));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

/**
 * The page may use the camera (QR scanning), write to the clipboard and
 * reach hardware wallets; nothing else. The user agent drops the app's and
 * Electron's names so the block explorer and the relays see a browser, not
 * a wallet.
 */
function harden(ses) {
  const agent = ses
    .getUserAgent()
    .replace(/ Electron\/\S+/, '')
    .replace(/ \S+\/\S+( Chrome\/)/, '$1');
  ses.setUserAgent(agent);
  app.userAgentFallback = agent;

  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const origin = details && details.requestingUrl ? details.requestingUrl : '';
    if (!isAppUrl(origin)) return callback(false);
    if (permission === 'media') {
      const types = (details && details.mediaTypes) || [];
      return callback(types.every((t) => t === 'video'));
    }
    callback(permission === 'clipboard-sanitized-write');
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    if (!isAppUrl(requestingOrigin + '/') && !isAppUrl(requestingOrigin)) return false;
    if (permission === 'media') return !details || details.mediaType !== 'audio';
    // WebHID and WebUSB for hardware wallets; which devices is decided below.
    return permission === 'clipboard-sanitized-write' || permission === 'hid' || permission === 'usb';
  });
  // Hardware wallets, and only those, are the page's without a chooser: they
  // are listed as soon as they are plugged in, as on the phone.
  ses.setDevicePermissionHandler((details) => {
    if (details.deviceType !== 'hid' && details.deviceType !== 'usb') return false;
    if (!isAppUrl(`${details.origin}/`)) return false;
    return isWalletDevice(details.device);
  });
  // Should the page ever ask with requestDevice, answer with a wallet (or
  // nothing) rather than showing a chooser of everything plugged in.
  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    const pick = (details.deviceList || []).find(isWalletDevice);
    callback(pick ? pick.deviceId : '');
  });
  ses.on('select-usb-device', (event, details, callback) => {
    event.preventDefault();
    const pick = (details.deviceList || []).find(isWalletDevice);
    callback(pick ? pick.deviceId : undefined);
  });
  ses.on('select-serial-port', (event, _details, callback) => {
    event.preventDefault();
    callback('');
  });
}

function createWindow() {
  // A phone-shaped window, no taller than the screen allows.
  const work = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: 430,
    height: Math.max(600, Math.min(900, work.height - 60)),
    minWidth: 360,
    minHeight: 600,
    show: false,
    title: 'SMS',
    backgroundColor: '#282828',
    autoHideMenuBar: true,
    icon: process.platform === 'linux' ? WINDOW_ICON : undefined,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  mainWindow = win;
  // The id is read now: once the window has closed its contents are gone too.
  const contentsId = win.webContents.id;
  win.once('ready-to-show', () => win.show());
  // React Navigation renames the document per screen; the window keeps the
  // launcher's name, as on a phone, so the title gives nothing away.
  win.on('page-title-updated', (event) => event.preventDefault());
  win.on('closed', () => {
    tcp.destroyAllFor(contentsId);
    if (mainWindow === win) mainWindow = null;
  });
  win.webContents.on('did-start-navigation', (details) => {
    // A reload or navigation drops every socket the old page opened.
    if (details.isMainFrame && !details.isSameDocument) tcp.destroyAllFor(contentsId);
  });
  const tell = (state) => () => {
    if (!win.isDestroyed()) win.webContents.send('window:state', state);
  };
  win.on('blur', () => {
    if (!dialogsOpen()) tell('background')();
  });
  win.on('minimize', tell('background'));
  win.on('hide', tell('background'));
  win.on('focus', tell('active'));
  win.on('restore', tell('active'));
  win.webContents.on('context-menu', (_event, params) => {
    const menu = editContextMenu(params);
    if (menu) menu.popup({ window: win });
  });
  win.loadURL(DEV_URL || protocol.INDEX_URL);
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    // Explorer links and the like open in the system browser.
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
});

// A write still on its way to disk finishes before the process goes.
let flushed = false;
app.on('before-quit', (event) => {
  if (flushed || !storage) return;
  event.preventDefault();
  Promise.allSettled([storage.whenIdle(), secure.whenIdle()]).then(() => {
    flushed = true;
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
