#!/usr/bin/env node
'use strict';

/**
 * Starts Electron for a development run (`npm run desktop`, `npm run desktop:dev`).
 *
 * On Linux, Chromium's renderer sandbox needs either unprivileged user
 * namespaces or a setuid `chrome-sandbox` helper. The Electron in
 * node_modules has no setuid helper, and Ubuntu 24.04 and later restrict
 * user namespaces, so a bare start aborts before any of our code runs.
 * When that is the situation, Electron is started with --no-sandbox and a
 * line says so. The packaged .deb installs an AppArmor profile (or the
 * setuid helper) and needs nothing of the kind.
 *
 * Anything after the script name is passed on to Electron:
 *   npm run desktop -- --some-flag
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const electron = require('electron'); // the binary's path

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

function sandboxUnavailable() {
  if (process.platform !== 'linux') return false;
  try {
    const helper = fs.statSync(path.join(path.dirname(electron), 'chrome-sandbox'));
    if (helper.uid === 0 && (helper.mode & 0o4000) !== 0) return false; // setuid root: the sandbox works
  } catch {
    // no helper at all: it comes down to user namespaces
  }
  if (read('/proc/sys/kernel/unprivileged_userns_clone') === '0') return true;
  if (read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === '1') return true;
  return false;
}

const args = process.argv.slice(2);
const flags = [];
if (!args.includes('--no-sandbox') && sandboxUnavailable()) {
  flags.push('--no-sandbox');
  console.warn(
    '[desktop] This kernel restricts unprivileged user namespaces and the development Electron has no ' +
      'setuid sandbox helper, so Electron starts with --no-sandbox. The packaged .deb does not need this.'
  );
}

const child = spawn(electron, [...flags, path.join(__dirname, 'main.js'), ...args], {
  stdio: 'inherit',
  env: process.env,
});
child.on('error', (e) => {
  console.error(`[desktop] could not start Electron: ${e.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code === null ? 1 : code);
});
