import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BackendConfig,
  DEFAULT_BACKEND_SETTINGS,
  DEFAULT_PUBLIC_SERVER_ID,
  PUBLIC_SERVERS,
  backendLabel,
  effectiveBackend,
  isPublicBackend,
  looksPrivateHost,
  migrateBackendSettings,
  publicServerById,
  sameBackend,
  setBackend,
  txExplorerUrl,
} from '../src/lib/chain';

const OWN: BackendConfig = { kind: 'electrum', host: 'umbrel.local', port: 50002, tls: true };

describe('public servers', () => {
  it('defaults to blockstream.info', () => {
    assert.equal(DEFAULT_PUBLIC_SERVER_ID, 'blockstream');
    assert.deepEqual(effectiveBackend(DEFAULT_BACKEND_SETTINGS), {
      kind: 'esplora',
      url: 'https://blockstream.info',
    });
  });

  it('has unique ids and falls back to the default for an unknown one', () => {
    const ids = PUBLIC_SERVERS.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(publicServerById('nope').id, DEFAULT_PUBLIC_SERVER_ID);
    assert.equal(publicServerById('mempool').name, 'mempool.space');
  });

  it('recognises a public server however its URL is written', () => {
    assert.ok(isPublicBackend({ kind: 'esplora', url: 'https://Mempool.space/' }));
    assert.ok(isPublicBackend({ kind: 'esplora', url: null }), 'null means the default server');
    assert.ok(
      !isPublicBackend({ kind: 'electrum', host: 'electrum.blockstream.info', port: 50002, tls: true }),
      'no public Electrum servers: the app cannot verify their hostname'
    );
    assert.ok(!isPublicBackend(OWN));
    assert.ok(!isPublicBackend({ kind: 'electrum', host: 'electrum.blockstream.info', port: 50001, tls: false }));
    assert.ok(!sameBackend(OWN, { kind: 'esplora', url: 'https://umbrel.local' }));
  });

  it('offers public servers over HTTPS only, and tells a private host from the open internet', () => {
    // HTTPS goes through fetch, which verifies the hostname; TLS Electrum does
    // not (SECURITY-AUDIT.md, H4), so Electrum is for a server you run yourself.
    assert.ok(PUBLIC_SERVERS.every((p) => p.backend.kind === 'esplora' && p.backend.url?.startsWith('https://')));
    assert.equal(publicServerById('blockstream-electrum').id, DEFAULT_PUBLIC_SERVER_ID, 'an old Electrum pick falls back');
    const private_ = [
      '10.0.0.5', '192.168.1.2', '172.20.0.1', '100.100.1.1', '169.254.1.1', '127.0.0.1', 'localhost',
      'umbrel', 'umbrel.local', 'node.lan', 'pi.home.arpa', 'my.ts.net', 'abc.onion', 'fd00::1', '[fe80::1]', '::1',
    ];
    for (const h of private_) assert.ok(looksPrivateHost(h), h);
    const open = ['electrum.blockstream.info', '8.8.8.8', '172.32.0.1', '100.128.0.1', 'example.com', '2001:db8::1'];
    for (const h of open) assert.ok(!looksPrivateHost(h), h);
  });

  it('labels public servers by name and own servers by address', () => {
    assert.equal(backendLabel({ kind: 'esplora', url: 'https://blockstream.info' }), 'blockstream.info');
    assert.equal(backendLabel(OWN), 'umbrel.local:50002 (TLS)');
    assert.equal(backendLabel({ kind: 'esplora', url: 'http://10.0.0.2:3006' }), 'http://10.0.0.2:3006');
  });
});

describe('own server vs public', () => {
  it('uses the own server only when it is both configured and selected', () => {
    assert.deepEqual(
      effectiveBackend({ publicServerId: 'mempool', ownBackend: OWN, useOwnServer: true }),
      OWN
    );
    assert.equal(
      effectiveBackend({ publicServerId: 'mempool', ownBackend: OWN, useOwnServer: false }).kind,
      'esplora'
    );
    assert.deepEqual(
      effectiveBackend({ publicServerId: 'mempool', ownBackend: null, useOwnServer: true }),
      publicServerById('mempool').backend,
      'selected but not configured: the public pick keeps serving'
    );
  });
});

describe('settings migration', () => {
  it('keeps new-format settings as they are', () => {
    const s = migrateBackendSettings({ publicServerId: 'emzy', ownBackend: OWN, useOwnServer: true });
    assert.deepEqual(s, { publicServerId: 'emzy', ownBackend: OWN, useOwnServer: true });
  });

  it('moves an untouched default onto the new default public server', () => {
    assert.deepEqual(migrateBackendSettings({}), DEFAULT_BACKEND_SETTINGS);
    assert.deepEqual(migrateBackendSettings({ backend: { kind: 'esplora', url: null } }), DEFAULT_BACKEND_SETTINGS);
    assert.deepEqual(migrateBackendSettings({ esploraUrl: null }), DEFAULT_BACKEND_SETTINGS);
  });

  it('turns a public URL into that public pick', () => {
    const s = migrateBackendSettings({ backend: { kind: 'esplora', url: 'https://mempool.space' } });
    assert.deepEqual(s, { ...DEFAULT_BACKEND_SETTINGS, publicServerId: 'mempool' });
  });

  it('keeps a private server in use', () => {
    for (const parsed of [
      { backend: OWN },
      { esploraUrl: 'http://umbrel.local:3006' },
    ]) {
      const s = migrateBackendSettings(parsed);
      assert.equal(s.useOwnServer, true);
      assert.ok(s.ownBackend);
      assert.equal(s.publicServerId, DEFAULT_PUBLIC_SERVER_ID);
    }
    assert.deepEqual(migrateBackendSettings({ esploraUrl: 'http://umbrel.local:3006' }).ownBackend, {
      kind: 'esplora',
      url: 'http://umbrel.local:3006',
    });
  });
});

describe('explorer links', () => {
  it('appends a well-formed txid and refuses anything else', () => {
    setBackend({ kind: 'esplora', url: null });
    const txid = 'a'.repeat(64);
    assert.equal(txExplorerUrl('mainnet', txid), `https://blockstream.info/tx/${txid}`);
    // Server-supplied junk never ends up inside the URL path.
    assert.equal(txExplorerUrl('mainnet', 'https://evil.example/x'), 'https://blockstream.info');
    assert.equal(txExplorerUrl('mainnet', '../../tx'), 'https://blockstream.info');
  });
});
