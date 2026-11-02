'use strict';

const { app, clipboard, ipcMain, shell } = require('electron');
const v = require('./validate');
const dialogs = require('./dialogs');

/**
 * The main-process end of `window.desktop`. Every handler first checks that
 * the message comes from the app's own window — not a stray web contents —
 * and then validates its arguments before touching anything.
 */
function registerIpc({ appVersion, storage, secure, tcp, netFetch, isTrustedSender, getWindow }) {
  const guard = (fn) => (event, ...args) => {
    if (!isTrustedSender(event.sender)) throw new Error('desktop bridge: untrusted sender');
    return fn(event, ...args);
  };
  const handle = (channel, fn) => ipcMain.handle(channel, guard(fn));
  // Fire-and-forget messages have no caller to reject to; a bad one is logged.
  const on = (channel, fn) =>
    ipcMain.on(channel, (event, ...args) => {
      try {
        guard(fn)(event, ...args);
      } catch (e) {
        console.warn(`[ipc ${channel}] ${(e && e.message) || e}`);
      }
    });

  ipcMain.on('app:info', (event) => {
    event.returnValue = isTrustedSender(event.sender)
      ? { platform: process.platform, appVersion, isPackaged: app.isPackaged }
      : null;
  });

  handle('storage:get', (_e, key) => storage.get(v.key(key)));
  handle('storage:set', (_e, key, value) => storage.set(v.key(key), v.str(value, 'value', 64 << 20)));
  handle('storage:remove', (_e, key) => storage.remove(v.key(key)));
  handle('storage:multiRemove', (_e, keys) => storage.removeMany(v.keys(keys)));
  handle('storage:keys', () => storage.keys());
  handle('storage:clear', () => storage.clear());

  handle('secure:get', (_e, key) => secure.get(v.key(key)));
  handle('secure:set', (_e, key, value) => secure.set(v.key(key), v.str(value, 'value', 1 << 20)));
  handle('secure:remove', (_e, key) => secure.remove(v.key(key)));
  handle('secure:info', () => secure.info());

  handle('dialog:message', (_e, opts) => dialogs.message(getWindow(), opts));
  handle('dialog:saveFile', (_e, opts) => dialogs.saveFile(getWindow(), opts));
  handle('pdf:fromHtml', (_e, html) => dialogs.pdfFromHtml(html));

  // A file chooser the page opens itself (importing a file) takes the focus
  // like a native dialog does, and must not count as leaving the app.
  handle('window:dialogOpen', (_e, open) => dialogs.noteExternalDialog(v.bool(open, 'open')));

  handle('window:contentProtection', (_e, enabled) => {
    const win = getWindow();
    if (win) win.setContentProtection(v.bool(enabled, 'enabled'));
  });

  handle('clipboard:writeText', (_e, text) => {
    clipboard.writeText(v.str(text, 'text', 1 << 20));
  });
  handle('shell:openExternal', (_e, url) => shell.openExternal(v.externalUrl(url)));

  handle('net:fetch', (_e, request) => netFetch.fetch(request));
  on('net:abort', (_e, id) => netFetch.abort(id));

  handle('tcp:connect', (event, opts) => tcp.connect(event.sender, opts));
  handle('tcp:write', (event, id, data) => tcp.write(event.sender, id, data));
  on('tcp:destroy', (event, id) => tcp.destroy(event.sender, id));
}

module.exports = { registerIpc };
