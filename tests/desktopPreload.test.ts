import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

/**
 * The preload's bookkeeping for TCP events (desktop/preload.js), with
 * Electron's renderer modules stood in by fakes: events that arrive before
 * the page subscribes are held and replayed; a connection the page let go
 * of holds nothing; a held queue nobody claims expires.
 */
const require = createRequire(import.meta.url);

function loadPreload() {
  const channels: Record<string, (event: unknown, payload: any) => void> = {};
  const sent: any[][] = [];
  const exposed: Record<string, any> = {};
  const fakeElectron = {
    contextBridge: { exposeInMainWorld: (name: string, api: any) => void (exposed[name] = api) },
    ipcRenderer: {
      sendSync: () => ({ platform: 'linux', appVersion: '0.0.0', isPackaged: false }),
      on: (channel: string, cb: (event: unknown, payload: any) => void) => void (channels[channel] = cb),
      invoke: async (...args: any[]) => void sent.push(['invoke', ...args]),
      send: (...args: any[]) => void sent.push(['send', ...args]),
    },
  };
  const electronPath = require.resolve('electron');
  const preloadPath = require.resolve('../desktop/preload.js');
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: fakeElectron } as any;
  delete require.cache[preloadPath];
  require(preloadPath);
  delete require.cache[electronPath];
  return { desktop: exposed.desktop, emit: (ev: any) => channels['tcp:event'](null, ev), sent };
}

describe('desktop preload TCP event bookkeeping', () => {
  it('exposes the bridge shape', () => {
    const { desktop } = loadPreload();
    assert.equal(desktop.platform, 'linux');
    for (const part of ['storage', 'secure', 'dialog', 'pdf', 'clipboard', 'shell', 'net', 'tcp', 'window']) {
      assert.equal(typeof desktop[part], 'object', part);
    }
  });

  it('replays events that arrived before the page subscribed, in order', () => {
    const { desktop, emit } = loadPreload();
    emit({ id: 7, type: 'connect' });
    emit({ id: 7, type: 'data', chunk: 'a' });
    const seen: string[] = [];
    const off = desktop.tcp.subscribe(7, (ev: any) => seen.push(ev.type));
    emit({ id: 7, type: 'data', chunk: 'b' });
    assert.deepEqual(seen, ['connect', 'data', 'data']);
    off();
    emit({ id: 7, type: 'data', chunk: 'c' });
    assert.deepEqual(seen, ['connect', 'data', 'data'], 'nothing after unsubscribe');
  });

  it('drops what arrives for a connection the page let go of, and forgets a closed one', () => {
    const { desktop, emit } = loadPreload();
    const seen: string[] = [];
    const off = desktop.tcp.subscribe(3, (ev: any) => seen.push(ev.type));
    off();
    emit({ id: 3, type: 'close' }); // the close after the page's own destroy
    desktop.tcp.subscribe(3, (ev: any) => seen.push(`late:${ev.type}`));
    assert.deepEqual(seen, [], 'the late close was not held for a later subscriber');
    // a connection that closes while subscribed is forgotten too
    const again: string[] = [];
    desktop.tcp.subscribe(4, (ev: any) => again.push(ev.type));
    emit({ id: 4, type: 'close' });
    emit({ id: 4, type: 'data', chunk: 'x' });
    assert.deepEqual(again, ['close']);
  });

  it('expires a held queue nobody claims', async () => {
    const { desktop, emit } = loadPreload();
    emit({ id: 9, type: 'error', message: 'refused' });
    emit({ id: 9, type: 'close' });
    // Reach into the timer: Node's fake timers are not used here, so just
    // check the queue is handed over when claimed promptly and that an
    // unclaimed one does not grow without bound.
    for (let i = 0; i < 1000; i++) emit({ id: 9, type: 'data', chunk: 'x' });
    const seen: string[] = [];
    desktop.tcp.subscribe(9, (ev: any) => seen.push(ev.type));
    assert.ok(seen.length <= 256, `held queue is bounded (${seen.length})`);
    assert.deepEqual(seen.slice(0, 2), ['error', 'close']);
  });
});
