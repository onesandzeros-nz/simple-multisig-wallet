import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * The desktop shell's native dialogs (desktop/lib/dialogs.js) with Electron's
 * dialog module stood in: how an alert's parts reach the message box, how a
 * save lands on disk, and the "a dialog is open" bookkeeping the relock uses.
 */
const require = createRequire(import.meta.url);

function loadDialogs() {
  const shown: any[] = [];
  let savePath: string | null = null;
  const fakeElectron = {
    BrowserWindow: class {},
    dialog: {
      showMessageBox: async (_win: unknown, opts: any) => {
        shown.push(opts);
        return { response: opts.buttons.length - 1, checkboxChecked: false };
      },
      showSaveDialog: async (_win: unknown, opts: any) => {
        shown.push(opts);
        return savePath ? { canceled: false, filePath: savePath } : { canceled: true, filePath: undefined };
      },
    },
  };
  const electronPath = require.resolve('electron');
  const modulePath = require.resolve('../desktop/lib/dialogs.js');
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: fakeElectron } as any;
  delete require.cache[modulePath];
  const dialogs = require(modulePath);
  delete require.cache[electronPath];
  return { dialogs, shown, setSavePath: (p: string | null) => void (savePath = p) };
}

describe('desktop dialogs', () => {
  it('maps an alert onto a message box and returns the button pressed', async () => {
    const { dialogs, shown } = loadDialogs();
    const pressed = await dialogs.message({}, { type: 'warning', title: 'Delete key?', message: 'This cannot be undone.', buttons: ['Cancel', 'Delete'], defaultId: 0, cancelId: 0 });
    assert.equal(pressed, 1);
    assert.equal(shown[0].type, 'warning');
    assert.equal(shown[0].message, 'Delete key?');
    assert.equal(shown[0].detail, 'This cannot be undone.');
    assert.deepEqual(shown[0].buttons, ['Cancel', 'Delete']);
    assert.equal(shown[0].cancelId, 0);
    assert.equal(shown[0].noLink, true);
  });

  it('cuts over-long text instead of refusing the alert, and checks the rest', async () => {
    const { dialogs, shown } = loadDialogs();
    await dialogs.message({}, { title: 'T'.repeat(500), message: 'x'.repeat(10_000), buttons: ['OK'] });
    assert.equal(shown[0].message.length, 200);
    assert.equal(shown[0].detail.length, 4000);
    await assert.rejects(dialogs.message({}, { title: 'T', buttons: [] }), /buttons/);
    await assert.rejects(dialogs.message({}, { title: 'T', type: 'shout', buttons: ['OK'] }), /type/);
    await assert.rejects(dialogs.message({}, { title: 'T', buttons: ['OK'], defaultId: 3 }), /range/);
  });

  it('writes what the user chose to save, as text or bytes, privately', async () => {
    const { dialogs, shown, setSavePath } = loadDialogs();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-dialogs-'));
    setSavePath(path.join(dir, 'backup.txt'));
    assert.deepEqual(await dialogs.saveFile({}, { suggestedName: 'wallet-backup.txt', mime: 'text/plain', data: 'héllo', encoding: 'utf8' }), { saved: true, path: path.join(dir, 'backup.txt') });
    assert.equal(fs.readFileSync(path.join(dir, 'backup.txt'), 'utf8'), 'héllo');
    assert.equal(fs.statSync(path.join(dir, 'backup.txt')).mode & 0o077, 0);
    assert.equal(shown[0].defaultPath, 'wallet-backup.txt');
    assert.ok(shown[0].properties.includes('showOverwriteConfirmation'));
    setSavePath(path.join(dir, 'tx.psbt'));
    await dialogs.saveFile({}, { suggestedName: 'tx.psbt', mime: 'application/octet-stream', data: Buffer.from([0x70, 0x73, 0x62, 0x74, 0xff]).toString('base64'), encoding: 'base64' });
    assert.equal(fs.readFileSync(path.join(dir, 'tx.psbt')).toString('hex'), '70736274ff');
    setSavePath(null);
    assert.deepEqual(await dialogs.saveFile({}, { suggestedName: 'x.txt', data: 'x', encoding: 'utf8' }), { saved: false });
    await assert.rejects(dialogs.saveFile({}, { suggestedName: '../x.txt', data: 'x', encoding: 'utf8' }), /plain file name/);
    await assert.rejects(dialogs.saveFile({}, { suggestedName: 'x.txt', data: 'x', encoding: 'hex' }), /encoding/);
  });

  it('knows when a dialog, native or the page\'s own file chooser, is open', async () => {
    const { dialogs } = loadDialogs();
    assert.equal(dialogs.dialogsOpen(), false);
    const pending = dialogs.message({}, { title: 'T', buttons: ['OK'] });
    assert.equal(dialogs.dialogsOpen(), true);
    await pending;
    assert.equal(dialogs.dialogsOpen(), false);
    dialogs.noteExternalDialog(true);
    assert.equal(dialogs.dialogsOpen(), true);
    dialogs.noteExternalDialog(false);
    dialogs.noteExternalDialog(false); // never below zero
    assert.equal(dialogs.dialogsOpen(), false);
  });
});
