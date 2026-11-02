import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * The desktop shell's main-process pieces that need no Electron: argument
 * validation, the JSON file store behind storage and the keystore, and the
 * guard that keeps app://bundle/ inside the bundle directory.
 */
const require = createRequire(import.meta.url);
const v = require('../desktop/lib/validate.js');
const { JsonFileStore } = require('../desktop/lib/storage.js');
const { resolveBundlePath } = require('../desktop/lib/bundlePath.js');

describe('desktop bridge argument validation', () => {
  it('accepts the keys the app uses and refuses paths', () => {
    assert.equal(v.key('sms.cache.v2.abc-123_x'), 'sms.cache.v2.abc-123_x');
    assert.equal(v.key('security.pin'), 'security.pin');
    assert.throws(() => v.key('../x'), /characters/);
    assert.throws(() => v.key(''), /characters/);
    assert.throws(() => v.key('a/b'), /characters/);
    assert.throws(() => v.key(42), /string/);
    assert.throws(() => v.keys(['ok', 'bad key']), /characters/);
  });

  it('only lets http(s) through the fetch bridge and nothing with credentials', () => {
    assert.equal(v.httpUrl('https://blockstream.info/api/blocks/tip/height'), 'https://blockstream.info/api/blocks/tip/height');
    assert.equal(v.httpUrl('http://umbrel.local:3006/api/tx'), 'http://umbrel.local:3006/api/tx');
    assert.throws(() => v.httpUrl('file:///etc/passwd'), /http/);
    assert.throws(() => v.httpUrl('app://bundle/index.html'), /http/);
    assert.throws(() => v.httpUrl('https://user:pw@host/'), /credentials/);
    assert.throws(() => v.httpUrl('not a url'), /URL/);
  });

  it('only opens http, https and mailto links outside the app', () => {
    assert.equal(v.externalUrl('https://mempool.space/tx/ab'), 'https://mempool.space/tx/ab');
    assert.throws(() => v.externalUrl('javascript:alert(1)'), /only http/);
    assert.throws(() => v.externalUrl('file:///etc/passwd'), /only http/);
  });

  it('checks TCP hosts and ports', () => {
    assert.equal(v.host('electrum.example.com'), 'electrum.example.com');
    assert.equal(v.host('192.168.1.10'), '192.168.1.10');
    assert.equal(v.host('fd00::1'), 'fd00::1');
    assert.throws(() => v.host('http://x'), /host/);
    assert.throws(() => v.host('a b'), /host/);
    assert.throws(() => v.int(0, 'port', 1, 65535), /range/);
    assert.throws(() => v.int(70000, 'port', 1, 65535), /range/);
    assert.throws(() => v.int('443', 'port', 1, 65535), /integer/);
  });

  it('keeps suggested file names plain', () => {
    assert.equal(v.fileName('wallet-backup.pdf'), 'wallet-backup.pdf');
    assert.throws(() => v.fileName('../evil.txt'), /plain file name/);
    assert.throws(() => v.fileName('a/b.txt'), /plain file name/);
    assert.throws(() => v.fileName('.hidden'), /plain file name/);
    assert.throws(() => v.fileName('C:\\x.txt'), /plain file name/);
  });

  it('checks base64 payloads', () => {
    assert.equal(v.base64('aGVsbG8=', 'data'), 'aGVsbG8=');
    assert.throws(() => v.base64('not base64!', 'data'), /base64/);
  });
});

describe('desktop JSON file store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-store-'));
  const file = path.join(dir, 'storage.json');

  it('round-trips values and survives a reload', async () => {
    const store = new JsonFileStore(file);
    assert.equal(store.get('a'), null);
    await Promise.all([store.set('a', '1'), store.set('b', '2'), store.set('a', '11')]);
    assert.equal(store.get('a'), '11');
    assert.deepEqual(store.keys().sort(), ['a', 'b']);
    await store.removeMany(['b', 'missing']);
    const again = new JsonFileStore(file);
    assert.equal(again.get('a'), '11');
    assert.equal(again.get('b'), null);
    assert.equal(fs.statSync(file).mode & 0o077, 0, 'file is private to the user');
    assert.deepEqual(fs.readdirSync(dir), ['storage.json'], 'no temp file left behind');
  });

  it('refuses to start from a corrupt file rather than wiping it', () => {
    const corrupt = path.join(dir, 'corrupt.json');
    fs.writeFileSync(corrupt, '{not json');
    assert.throws(() => new JsonFileStore(corrupt), /not valid JSON/);
    assert.equal(fs.readFileSync(corrupt, 'utf8'), '{not json');
  });

  it('clear empties the file', async () => {
    const store = new JsonFileStore(file);
    await store.clear();
    assert.deepEqual(new JsonFileStore(file).keys(), []);
  });
});

describe('app://bundle path guard', () => {
  const root = path.join(os.tmpdir(), 'bundle-root');

  it('maps the page and its assets inside the bundle', () => {
    assert.equal(resolveBundlePath(root, '/'), path.join(root, 'index.html'));
    assert.equal(resolveBundlePath(root, '/index.html'), path.join(root, 'index.html'));
    assert.equal(resolveBundlePath(root, '/_expo/static/js/web/index-abc.js'), path.join(root, '_expo/static/js/web/index-abc.js'));
    assert.equal(resolveBundlePath(root, '/assets/a%20b.png'), path.join(root, 'assets/a b.png'));
  });

  it('refuses everything that climbs out', () => {
    assert.equal(resolveBundlePath(root, '/../package.json'), null);
    assert.equal(resolveBundlePath(root, '/%2e%2e/package.json'), null);
    assert.equal(resolveBundlePath(root, '/a/../../x'), null);
    assert.equal(resolveBundlePath(root, '/%ff'), null);
    assert.equal(resolveBundlePath(root, '/a%00b'), null);
    assert.equal(resolveBundlePath(root, 5), null);
  });
});
