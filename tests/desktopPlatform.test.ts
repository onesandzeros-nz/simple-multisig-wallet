import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { planAlert } from '../src/platform/alertPlan';
import { httpFetch } from '../src/lib/http.web';
import { rnSocketFactory, tcpAvailable } from '../src/lib/electrum/rnSocket.web';
import AsyncStorage from '../src/platform/asyncStorage.web';
import * as SecureStore from '../src/platform/secureStore.web';
import { ElectrumClient } from '../src/lib/electrum/client';
import type { DesktopBridge, DesktopTcpEvent } from '../src/platform/desktop';

/**
 * The web-bundle side of the desktop bridge, driven against a fake
 * `window.desktop`: what the app's AsyncStorage, SecureStore, fetch and
 * Electrum socket turn into inside the Electron shell.
 */
type Fake = DesktopBridge & { calls: any[][]; tcpHandlers: Map<number, (ev: DesktopTcpEvent) => void> };

function fakeBridge(overrides: Partial<DesktopBridge> = {}): Fake {
  const calls: any[][] = [];
  const storage = new Map<string, string>();
  const secure = new Map<string, string>();
  const tcpHandlers = new Map<number, (ev: DesktopTcpEvent) => void>();
  const bridge: Fake = {
    calls,
    tcpHandlers,
    platform: 'linux',
    appVersion: '0.0.0',
    isPackaged: false,
    storage: {
      getItem: async (k) => (calls.push(['storage.getItem', k]), storage.get(k) ?? null),
      setItem: async (k, v) => void storage.set(k, v),
      removeItem: async (k) => void storage.delete(k),
      multiRemove: async (ks) => ks.forEach((k) => storage.delete(k)),
      getAllKeys: async () => [...storage.keys()],
      clear: async () => storage.clear(),
    },
    secure: {
      getItem: async (k) => secure.get(k) ?? null,
      setItem: async (k, v) => void secure.set(k, v),
      deleteItem: async (k) => void secure.delete(k),
      info: async () => ({ available: true, backend: 'keychain' }),
    },
    dialog: {
      message: async (o) => (calls.push(['dialog.message', o]), 0),
      saveFile: async (o) => (calls.push(['dialog.saveFile', o]), { saved: true, path: '/tmp/x' }),
    },
    pdf: { fromHtml: async () => 'JVBERi0=' },
    clipboard: { writeText: async (t) => void calls.push(['clipboard', t]) },
    shell: { openExternal: async (u) => void calls.push(['openExternal', u]) },
    window: {
      setDialogOpen: async (on) => void calls.push(['dialogOpen', on]),
      setContentProtection: async (on) => void calls.push(['contentProtection', on]),
      onStateChange: () => () => {},
    },
    net: {
      fetch: async (r) => {
        calls.push(['net.fetch', r]);
        return { status: 200, statusText: 'OK', headers: [['content-type', 'application/json']], body: '{"height":1}' };
      },
      abort: (id) => void calls.push(['net.abort', id]),
    },
    tcp: {
      connect: async (o) => (calls.push(['tcp.connect', o]), 7),
      write: async (id, d) => void calls.push(['tcp.write', id, d]),
      destroy: (id) => void calls.push(['tcp.destroy', id]),
      subscribe: (id, cb) => {
        tcpHandlers.set(id, cb);
        return () => tcpHandlers.delete(id);
      },
    },
    ...overrides,
  };
  return bridge;
}

let bridge: Fake;
beforeEach(() => {
  bridge = fakeBridge();
  (globalThis as any).desktop = bridge;
});
afterEach(() => {
  delete (globalThis as any).desktop;
});

describe('alert → message box plan', () => {
  it('maps a plain alert to OK', () => {
    assert.deepEqual(planAlert([]), { labels: ['OK'], cancelId: undefined, defaultId: 0, destructive: false });
  });

  it('puts Enter on the doing button and Esc on the cancel one', () => {
    const plan = planAlert([{ text: 'Cancel', style: 'cancel' }, { text: 'Sign' }]);
    assert.deepEqual(plan, { labels: ['Cancel', 'Sign'], cancelId: 0, defaultId: 1, destructive: false });
  });

  it('defaults to cancel when a button is destructive', () => {
    const plan = planAlert([{ text: 'Cancel', style: 'cancel' }, { text: 'Delete key', style: 'destructive' }]);
    assert.equal(plan.defaultId, 0);
    assert.equal(plan.destructive, true);
  });

  it('keeps three buttons in order and names unlabelled ones', () => {
    const plan = planAlert([{ text: 'Later' }, { text: '', style: 'cancel' }, { text: 'Now' }]);
    assert.deepEqual(plan.labels, ['Later', 'Button 2', 'Now']);
    assert.equal(plan.cancelId, 1);
    assert.equal(plan.defaultId, 2);
  });
});

describe('fetch through the desktop shell', () => {
  it('wraps the answer in a Response the Esplora client can read', async () => {
    const res = await httpFetch('https://blockstream.info/api/blocks/tip/height');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.deepEqual(await res.json(), { height: 1 });
    const [, request] = bridge.calls.find((c) => c[0] === 'net.fetch')!;
    assert.equal(request.url, 'https://blockstream.info/api/blocks/tip/height');
    assert.match(request.id, /\S/);
  });

  it('passes method and body for broadcasts', async () => {
    await httpFetch('https://mempool.space/api/tx', { method: 'POST', body: '0200' });
    const [, request] = bridge.calls.find((c) => c[0] === 'net.fetch')!;
    assert.equal(request.method, 'POST');
    assert.equal(request.body, '0200');
  });

  it('aborts on the bridge and throws AbortError when the signal fires', async () => {
    bridge.net.fetch = (r) =>
      new Promise((_, reject) => setTimeout(() => reject(new Error('aborted')), 20)).then(() => {
        throw new Error('unreachable');
      }) as any;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1);
    await assert.rejects(httpFetch('https://x.test/api', { signal: controller.signal }), (e: Error) => e.name === 'AbortError');
    assert.ok(bridge.calls.some((c) => c[0] === 'net.abort'));
  });

  it('strips the IPC wrapping from errors', async () => {
    bridge.net.fetch = async () => {
      throw new Error("Error invoking remote method 'net:fetch': Error: The response is too large.");
    };
    await assert.rejects(httpFetch('https://x.test/api'), /^Error: The response is too large\.$/);
  });

  it('uses the browser fetch without a shell', async () => {
    delete (globalThis as any).desktop;
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response('plain')) as any;
    try {
      assert.equal(await (await httpFetch('https://x.test/')).text(), 'plain');
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('Electrum socket through the desktop shell', () => {
  const tick = () => new Promise((r) => setImmediate(r));

  it('reports availability from the bridge', () => {
    assert.equal(tcpAvailable(), true);
    delete (globalThis as any).desktop;
    assert.equal(tcpAvailable(), false);
  });

  it('relays connect, data and close, and writes through the bridge', async () => {
    const socket = rnSocketFactory({ host: 'electrs.lan', port: 50002, tls: true });
    const seen: string[] = [];
    socket.on('connect', () => {
      seen.push('connect');
      socket.write('{"id":1}\n');
    });
    socket.on('data', (chunk) => seen.push(`data:${chunk}`));
    socket.on('close', () => seen.push('close'));
    await tick();
    assert.deepEqual(bridge.calls[0], ['tcp.connect', { host: 'electrs.lan', port: 50002, tls: true }]);
    const handler = bridge.tcpHandlers.get(7)!;
    handler({ id: 7, type: 'connect' });
    handler({ id: 7, type: 'data', chunk: '{"id":1,"result":"ok"}\n' });
    handler({ id: 7, type: 'close' });
    socket.destroy();
    handler({ id: 7, type: 'close' }); // nothing after destroy is relayed
    await tick();
    assert.deepEqual(seen, ['connect', 'data:{"id":1,"result":"ok"}\n', 'close']);
    assert.ok(bridge.calls.some((c) => c[0] === 'tcp.write' && c[1] === 7 && c[2] === '{"id":1}\n'));
    assert.ok(bridge.calls.some((c) => c[0] === 'tcp.destroy' && c[1] === 7));
  });

  it('turns a refused connection into error and close, and the client rejects', async () => {
    bridge.tcp.connect = async () => {
      throw new Error("Error invoking remote method 'tcp:connect': Error: Too many open connections.");
    };
    const client = new ElectrumClient({ host: 'h', port: 1 }, rnSocketFactory, 500);
    await assert.rejects(client.call('server.version'), /Too many open connections/);
  });

  it('is unavailable in a plain browser', () => {
    delete (globalThis as any).desktop;
    assert.throws(() => rnSocketFactory({ host: 'h', port: 1 }), /desktop app/);
  });
});

describe('storage through the desktop shell', () => {
  it('AsyncStorage reads and writes go to the shell', async () => {
    await AsyncStorage.setItem('sms.keys', '[]');
    assert.equal(await AsyncStorage.getItem('sms.keys'), '[]');
    await AsyncStorage.multiRemove(['sms.keys']);
    assert.equal(await AsyncStorage.getItem('sms.keys'), null);
    assert.deepEqual(await AsyncStorage.multiGet(['a']), [['a', null]]);
  });

  it('SecureStore reads and writes go to the shell and keep the key rule', async () => {
    assert.equal(await SecureStore.isAvailableAsync(), true);
    await SecureStore.setItemAsync('mnemonic.k1', 'abandon', { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    assert.equal(await SecureStore.getItemAsync('mnemonic.k1'), 'abandon');
    await SecureStore.deleteItemAsync('mnemonic.k1');
    assert.equal(await SecureStore.getItemAsync('mnemonic.k1'), null);
    await assert.rejects(SecureStore.getItemAsync('bad key'), /Invalid key/);
  });
});
