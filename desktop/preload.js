'use strict';

/**
 * The renderer's view of the desktop: `window.desktop`. The page is sandboxed
 * and isolated; this is the only way through to the main process, and each
 * entry maps to exactly one IPC channel. Shapes are documented in
 * src/platform/desktop.d.ts.
 */
const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('app:info') || { platform: 'unknown', appVersion: '', isPackaged: false };

// TCP events can arrive before the renderer has subscribed to a freshly
// opened connection (the connect call's answer is still in flight), so
// events for a connection nobody listens to yet are held, within reason
// and not for long. A connection the page subscribed to and then let go of
// holds nothing: whatever still arrives for it is dropped.
const listeners = new Map();
const held = new Map();
const subscribed = new Set();
const MAX_HELD = 256;
const HELD_TTL_MS = 10_000;
ipcRenderer.on('tcp:event', (_event, ev) => {
  const cb = listeners.get(ev.id);
  if (cb) {
    cb(ev);
    if (ev.type === 'close') {
      listeners.delete(ev.id);
      subscribed.delete(ev.id);
    }
    return;
  }
  if (subscribed.has(ev.id)) {
    if (ev.type === 'close') subscribed.delete(ev.id);
    return;
  }
  let queue = held.get(ev.id);
  if (!queue) {
    queue = { events: [], timer: setTimeout(() => held.delete(ev.id), HELD_TTL_MS) };
    held.set(ev.id, queue);
  }
  if (queue.events.length < MAX_HELD) queue.events.push(ev);
});

// Focus, minimise, screen lock and sleep, as the page's app state.
const stateListeners = new Set();
ipcRenderer.on('window:state', (_event, state) => {
  for (const cb of stateListeners) cb(state);
});

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('desktop', {
  platform: info.platform,
  appVersion: info.appVersion,
  isPackaged: info.isPackaged,
  storage: {
    getItem: (key) => invoke('storage:get', key),
    setItem: (key, value) => invoke('storage:set', key, value),
    removeItem: (key) => invoke('storage:remove', key),
    multiRemove: (keys) => invoke('storage:multiRemove', keys),
    getAllKeys: () => invoke('storage:keys'),
    clear: () => invoke('storage:clear'),
  },
  secure: {
    getItem: (key) => invoke('secure:get', key),
    setItem: (key, value) => invoke('secure:set', key, value),
    deleteItem: (key) => invoke('secure:remove', key),
    info: () => invoke('secure:info'),
  },
  dialog: {
    message: (opts) => invoke('dialog:message', opts),
    saveFile: (opts) => invoke('dialog:saveFile', opts),
  },
  pdf: {
    fromHtml: (html) => invoke('pdf:fromHtml', html),
  },
  clipboard: {
    writeText: (text) => invoke('clipboard:writeText', text),
  },
  window: {
    setDialogOpen: (open) => invoke('window:dialogOpen', open),
    setContentProtection: (enabled) => invoke('window:contentProtection', enabled),
    onStateChange: (cb) => {
      stateListeners.add(cb);
      return () => stateListeners.delete(cb);
    },
  },
  shell: {
    openExternal: (url) => invoke('shell:openExternal', url),
  },
  net: {
    fetch: (request) => invoke('net:fetch', request),
    abort: (id) => ipcRenderer.send('net:abort', id),
  },
  tcp: {
    connect: (opts) => invoke('tcp:connect', opts),
    write: (id, data) => invoke('tcp:write', id, data),
    destroy: (id) => ipcRenderer.send('tcp:destroy', id),
    subscribe: (id, cb) => {
      listeners.set(id, cb);
      subscribed.add(id);
      const queue = held.get(id);
      if (queue) {
        clearTimeout(queue.timer);
        held.delete(id);
        for (const ev of queue.events) cb(ev);
      }
      return () => {
        if (listeners.get(id) === cb) listeners.delete(id);
      };
    },
  },
});
