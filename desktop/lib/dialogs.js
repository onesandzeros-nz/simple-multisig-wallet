'use strict';

const fs = require('node:fs');
const { BrowserWindow, dialog } = require('electron');
const v = require('./validate');

const MESSAGE_TYPES = new Set(['none', 'info', 'error', 'question', 'warning']);
const MAX_PDF_HTML = 1_500_000;

// A native dialog takes the focus; the window's blur then means "answering
// a question", not "went elsewhere", and must not start the relock clock.
let open = 0;
let external = 0;
function dialogsOpen() {
  return open > 0 || external > 0;
}
function noteExternalDialog(isOpen) {
  external = Math.max(0, external + (isOpen ? 1 : -1));
}
async function withOpen(fn) {
  open += 1;
  try {
    return await fn();
  } finally {
    open -= 1;
  }
}

/** A native message box, modal to the app window. Resolves with the button index. */
async function message(win, opts) {
  const o = v.obj(opts, 'options');
  const type = v.optStr(o.type, 'type', 16) || 'none';
  if (!MESSAGE_TYPES.has(type)) v.fail('bad message type');
  if (!Array.isArray(o.buttons) || o.buttons.length < 1 || o.buttons.length > 6) v.fail('buttons must be 1-6 labels');
  const buttons = o.buttons.map((b, i) => v.str(b, `button ${i}`, 60));
  // Long texts are cut rather than refused: an alert that never shows loses
  // the buttons' actions with it.
  const title = v.str(o.title, 'title', 10_000).slice(0, 200);
  const detail = (v.optStr(o.message, 'message', 1 << 20) || '').slice(0, 4000);
  const defaultId = v.optInt(o.defaultId, 'defaultId', 0, buttons.length - 1);
  const cancelId = v.optInt(o.cancelId, 'cancelId', 0, buttons.length - 1);
  const result = await withOpen(() =>
    dialog.showMessageBox(win, {
      type,
      title,
      message: title,
      detail,
      buttons,
      defaultId,
      cancelId,
      noLink: true,
      normalizeAccessKeys: true,
    })
  );
  return result.response;
}

const FILTERS = {
  'application/pdf': { name: 'PDF', extensions: ['pdf'] },
  'application/json': { name: 'JSON', extensions: ['json'] },
  'text/plain': { name: 'Text', extensions: ['txt'] },
  'application/octet-stream': { name: 'PSBT', extensions: ['psbt'] },
};

/** "Save as…", then the write. The path only ever comes from the dialog. */
async function saveFile(win, opts) {
  const o = v.obj(opts, 'options');
  const suggestedName = v.fileName(o.suggestedName);
  const encoding = v.str(o.encoding, 'encoding', 8);
  if (encoding !== 'utf8' && encoding !== 'base64') v.fail('encoding must be utf8 or base64');
  const data = encoding === 'base64' ? Buffer.from(v.base64(o.data, 'data'), 'base64') : v.str(o.data, 'data', 64 << 20);
  const mime = v.optStr(o.mime, 'mime', 100);
  const filters = [];
  if (mime && FILTERS[mime]) filters.push(FILTERS[mime]);
  filters.push({ name: 'All files', extensions: ['*'] });

  const { canceled, filePath } = await withOpen(() =>
    dialog.showSaveDialog(win, {
      defaultPath: suggestedName,
      filters,
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    })
  );
  if (canceled || !filePath) return { saved: false };
  await fs.promises.writeFile(filePath, data, { mode: 0o600 });
  return { saved: true, path: filePath };
}

/**
 * Renders HTML in a hidden window and prints it to PDF — the printable
 * backup. The window runs no scripts and has no bridge; the HTML is the
 * app's own template with the wallet's names in it.
 */
async function pdfFromHtml(html) {
  const source = v.str(html, 'html', MAX_PDF_HTML);
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 1100,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      webSecurity: true,
      devTools: false,
    },
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(source)}`);
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
    return pdf.toString('base64');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

module.exports = { message, saveFile, pdfFromHtml, dialogsOpen, noteExternalDialog };
