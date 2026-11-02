#!/usr/bin/env node
/**
 * Smoke test of the packaged desktop app, driven through Playwright's
 * Electron driver (`npm run desktop:smoke`). It needs a build in
 * dist-desktop/ — the unpacked directory electron-builder leaves next to
 * the installers — or SMS_SMOKE_EXECUTABLE pointing at the binary to test.
 * An AppImage can be tested that way with APPIMAGE_EXTRACT_AND_RUN=1 in the
 * environment, which makes it run without FUSE.
 *
 * It opens the app with a fresh data directory, checks the Wallets and
 * Settings screens, creates a software key through the interface, closes
 * the window and checks what the two data files hold (the key's name in
 * storage.json; its recovery phrase in secure.json only as ciphertext),
 * reopens the same data, and cancels a key deletion through a native dialog.
 * Screenshots of each step go to dist-desktop/smoke/.
 *
 * SMS_SMOKE_NO_SANDBOX=1 starts the app with --no-sandbox, which an
 * unpacked build needs on a kernel that restricts unprivileged user
 * namespaces (Ubuntu 24.04 and later) because its chrome-sandbox helper is
 * not setuid. A .deb install does not need it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist-desktop');
const SHOTS = path.join(OUT, 'smoke');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const KEY_NAME = 'Smoke test key';
const USER_NAME = 'Smoke';

function defaultExecutable() {
  if (process.platform === 'win32') return path.join(OUT, 'win-unpacked', 'simple-multisig.exe');
  if (process.platform === 'darwin') {
    const dir = fs.readdirSync(OUT).find((d) => d.startsWith('mac') && fs.existsSync(path.join(OUT, d, 'SMS.app')));
    const macos = path.join(OUT, dir || 'mac', 'SMS.app', 'Contents', 'MacOS');
    const exe = fs.existsSync(macos) ? fs.readdirSync(macos)[0] : 'simple-multisig';
    return path.join(macos, exe);
  }
  return path.join(OUT, 'linux-unpacked', 'simple-multisig');
}

const executable = process.env.SMS_SMOKE_EXECUTABLE || defaultExecutable();
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-smoke-'));
const log = (...a) => console.log(`[smoke ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let shots = 0;
let steps = 0;
const problems = [];

/** Starts the app on the test data directory, with native message boxes answered by a stub. */
async function launch() {
  // Playwright adds --no-sandbox on Linux by itself unless told to keep the
  // sandbox, so the choice has to be made here, not only in `args`.
  const noSandbox = process.env.SMS_SMOKE_NO_SANDBOX === '1';
  const app = await electron.launch({
    executablePath: executable,
    args: noSandbox ? ['--no-sandbox'] : [],
    chromiumSandbox: !noSandbox,
    env: { ...process.env, SIMPLE_MULTISIG_USER_DATA: userData },
    timeout: 60000,
  });
  const page = await app.firstWindow({ timeout: 60000 });
  page.on('pageerror', (e) => problems.push(`uncaught in page: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text().slice(0, 300)}`);
  });
  // Every alert is recorded and answered with its cancel button, or its
  // default one when there is no cancel (a plain "OK").
  await app.evaluate(({ dialog }) => {
    global.__smokeDialogs = [];
    dialog.showMessageBox = async (_win, o) => {
      const response = o.cancelId ?? o.defaultId ?? 0;
      global.__smokeDialogs.push({ title: o.message, buttons: o.buttons, defaultId: o.defaultId, cancelId: o.cancelId, response });
      return { response, checkboxChecked: false };
    };
  });
  await page.getByText('How multisig works', { exact: true }).waitFor({ timeout: 60000 });
  return { app, page };
}

/** Closes the window as a user would and waits for the process to end. */
async function quit(app) {
  const exited = new Promise((resolve) => app.process().once('exit', (code, signal) => resolve({ code, signal })));
  await app
    .evaluate(({ BrowserWindow, app: electronApp }) => {
      for (const w of BrowserWindow.getAllWindows()) w.close();
      if (process.platform === 'darwin') electronApp.quit();
    })
    .catch(() => {}); // the connection may drop as the process quits
  const result = await Promise.race([exited, sleep(20000).then(() => null)]);
  if (!result) {
    app.process().kill('SIGKILL');
    throw new Error('the app did not exit within 20 s of its window closing');
  }
  return result;
}

async function shot(page, name) {
  shots += 1;
  const file = path.join(SHOTS, `${String(shots).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  log(`screenshot ${path.relative(ROOT, file)}`);
}

async function step(name, fn) {
  steps += 1;
  log(`step ${steps}: ${name}`);
  await fn();
}

async function openTab(page, name) {
  const tab = page.getByRole('tab', { name: new RegExp(`\\b${name}\\b`) });
  if ((await tab.count()) > 0) await tab.first().click();
  else await page.getByText(name, { exact: true }).last().click();
}

const visibleText = (page, text) => page.getByText(text, { exact: true }).filter({ visible: true });

/** The sentence the About card shows for each keystore (src/platform/keystoreInfo.ts). */
function keystoreSentence({ backend, available }) {
  if (backend === 'keychain') return 'Keys are encrypted by the macOS Keychain';
  if (backend === 'dpapi') return 'Keys are encrypted by Windows (DPAPI)';
  if (backend === 'gnome_libsecret') return 'Keys are encrypted with a secret held by GNOME Keyring';
  if (backend.startsWith('kwallet')) return 'Keys are encrypted with a secret held by KWallet';
  if (backend === 'basic_text') return 'only obfuscated, not encrypted';
  return available ? 'Keys are encrypted by this computer’s keystore' : 'no keystore available';
}

let app = null;
try {
  assert.ok(fs.existsSync(executable), `no app to test at ${executable} — build one first (npm run desktop:build:linux)`);
  fs.mkdirSync(SHOTS, { recursive: true });
  log(`testing ${executable}`);
  log(`data directory ${userData}`);
  let page;
  let words = [];
  let keystore;

  await step('the app opens on the Wallets screen', async () => {
    ({ app, page } = await launch());
    // The bundle's <title> is SMS; React Navigation then names the document
    // after the screen on the web, and the window follows the document.
    const title = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
    assert.ok(title === 'SMS' || title === 'Wallets', `window title is "${title}"`);
    await shot(page, 'wallets');
  });

  await step('Settings shows the version and where keys are kept', async () => {
    await openTab(page, 'Settings');
    await visibleText(page, `v${VERSION}`).waitFor({ timeout: 15000 });
    keystore = await page.evaluate(() => window.desktop.secure.info());
    log(`keystore backend: ${keystore.backend} (available: ${keystore.available})`);
    const expected = keystoreSentence(keystore);
    await page.getByText(expected).first().waitFor({ timeout: 15000 });
    const about = await page.evaluate(() => document.body.innerText);
    assert.ok(about.includes('Keys never leave') === false, 'the phone wording is showing instead of the desktop keystore sentence');
    if (keystore.backend !== 'basic_text') assert.ok(about.includes('Keys are encrypted'), 'About card does not say "Keys are encrypted"');
    await shot(page, 'settings');
  });

  await step('a software key is created through the interface', async () => {
    await openTab(page, 'Keys');
    await visibleText(page, 'Create a key on this phone').click();
    // First run: the app asks for the user's name before the first key. (The
    // Settings tab, still mounted underneath, has an input with the same
    // placeholder; only the visible one counts.)
    const name = page.getByPlaceholder('e.g. Rob').filter({ visible: true });
    await name.waitFor({ timeout: 15000 });
    await name.fill(USER_NAME);
    await visibleText(page, 'Continue').click();
    await visibleText(page, "Use the phone's secure random").click();
    await visibleText(page, 'Recovery phrase').waitFor({ timeout: 15000 });
    words = await page.evaluate(() => {
      const found = [];
      for (const el of document.querySelectorAll('div')) {
        if (el.children.length !== 2) continue;
        const n = Number(el.children[0].textContent);
        const w = (el.children[1].textContent || '').trim();
        if (Number.isInteger(n) && n >= 1 && n <= 24 && /^[a-z]{3,8}$/.test(w)) found[n - 1] = w;
      }
      return found.filter(Boolean);
    });
    assert.equal(words.length, 12, `expected 12 recovery words on screen, saw ${words.length}`);
    await page.getByPlaceholder("e.g. Rob's phone").filter({ visible: true }).fill(KEY_NAME);
    await visibleText(page, 'I have written down the 12 words').click();
    await shot(page, 'new-key');
    await visibleText(page, 'Save key').click();
    await visibleText(page, KEY_NAME).waitFor({ timeout: 15000 });
    await shot(page, 'keys');
  });

  let keyId;
  await step('closing the window ends the process and the data files are right', async () => {
    const { code } = await quit(app);
    app = null;
    assert.equal(code, 0, `exit code ${code}`);
    const storage = JSON.parse(fs.readFileSync(path.join(userData, 'storage.json'), 'utf8'));
    const keys = JSON.parse(storage['sms.keys.v1'] || '[]');
    const key = keys.find((k) => k.name === KEY_NAME);
    assert.ok(key, 'storage.json does not list the key');
    keyId = key.id;
    const secureRaw = fs.readFileSync(path.join(userData, 'secure.json'), 'utf8');
    const secure = JSON.parse(secureRaw);
    const stored = secure[`mnemonic.${keyId}`];
    assert.ok(typeof stored === 'string' && /^[A-Za-z0-9+/]+=*$/.test(stored), 'secure.json holds no base64 entry for the key');
    const phrase = words.join(' ');
    for (const [file, text] of [['secure.json', secureRaw], ['storage.json', JSON.stringify(storage)]]) {
      assert.ok(!text.includes(phrase), `${file} contains the recovery phrase in plaintext`);
      for (const w of words.filter((x) => x.length >= 5)) assert.ok(!text.includes(w), `${file} contains the word "${w}"`);
    }
    log(`storage.json names the key (${keyId}); secure.json holds ${stored.length} base64 chars of ciphertext`);
  });

  await step('the key is still there after a relaunch', async () => {
    ({ app, page } = await launch());
    await openTab(page, 'Keys');
    await visibleText(page, KEY_NAME).waitFor({ timeout: 15000 });
    await shot(page, 'relaunch');
  });

  await step('cancelling "Delete key" in the native dialog keeps the key', async () => {
    await visibleText(page, KEY_NAME).first().click();
    await visibleText(page, 'Delete key').click();
    let dialogs = [];
    for (let i = 0; i < 50 && dialogs.length === 0; i++) {
      await sleep(200);
      dialogs = await app.evaluate(() => global.__smokeDialogs);
    }
    assert.equal(dialogs.length, 1, 'no native dialog was shown');
    assert.equal(dialogs[0].title, 'Delete this key?');
    assert.deepEqual(dialogs[0].buttons, ['Cancel', 'Delete']);
    assert.equal(dialogs[0].response, dialogs[0].cancelId, 'the stub did not press Cancel');
    await sleep(500);
    await visibleText(page, 'Delete key').waitFor({ timeout: 5000 });
    const keys = JSON.parse((await page.evaluate(() => window.desktop.storage.getItem('sms.keys.v1'))) || '[]');
    assert.ok(keys.some((k) => k.id === keyId), 'the key was deleted despite Cancel');
    await shot(page, 'delete-cancelled');
    const { code } = await quit(app);
    app = null;
    assert.equal(code, 0, `exit code ${code}`);
  });

  if (problems.length) log(`page reported:\n  ${problems.join('\n  ')}`);
  fs.rmSync(userData, { recursive: true, force: true });
  console.log(`PASS desktop smoke: ${steps} steps, ${shots} screenshots in ${path.relative(ROOT, SHOTS)}/, ${executable}`);
} catch (e) {
  console.error(`FAIL desktop smoke at step ${steps}: ${e && e.stack ? e.stack : e}`);
  if (problems.length) console.error(`page reported:\n  ${problems.join('\n  ')}`);
  console.error(`data directory kept for inspection: ${userData}`);
  if (app) {
    try {
      app.process().kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  process.exit(1);
}
