'use strict';

const net = require('node:net');
const tls = require('node:tls');
const { StringDecoder } = require('node:string_decoder');
const v = require('./validate');

/**
 * Raw TCP for the Electrum client, which react-native-tcp-socket provides on
 * a phone. Each socket belongs to the window that opened it and reports back
 * as `tcp:event` messages: connect, data (utf-8 text), error, close. TLS
 * connections verify the certificate chain and the host name — Node's
 * defaults — which is stricter than the phone library manages.
 */
const MAX_SOCKETS_PER_WINDOW = 16;
const CONNECT_TIMEOUT_MS = 20_000;
const MAX_WRITE_BYTES = 1 << 20;

/**
 * Only the Electrum protocol goes down the socket: JSON-RPC requests, one
 * per line. A page that somehow ran someone else's script could otherwise
 * use the bridge to talk to anything on the network.
 */
function checkElectrumLines(text) {
  if (!text.endsWith('\n')) v.fail('data must be newline-terminated JSON-RPC');
  for (const line of text.split('\n')) {
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      v.fail('data is not JSON-RPC');
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) v.fail('data is not a JSON-RPC request');
    if (typeof msg.method !== 'string' || !/^[a-z0-9_.]{1,64}$/.test(msg.method)) v.fail('bad JSON-RPC method');
    if (msg.params !== undefined && !Array.isArray(msg.params)) v.fail('bad JSON-RPC params');
    if (msg.id !== undefined && typeof msg.id !== 'number' && typeof msg.id !== 'string') v.fail('bad JSON-RPC id');
  }
}

class TcpSessions {
  constructor() {
    this.sessions = new Map(); // id -> { socket, owner: webContents.id }
    this.nextId = 1;
  }

  countFor(ownerId) {
    let n = 0;
    for (const s of this.sessions.values()) if (s.owner === ownerId) n++;
    return n;
  }

  /** Opens the connection; events flow to `sender` as they happen. */
  connect(sender, opts) {
    const o = v.obj(opts, 'options');
    const host = v.host(o.host);
    const port = v.int(o.port, 'port', 1, 65535);
    const useTls = v.bool(o.tls, 'tls');
    if (this.countFor(sender.id) >= MAX_SOCKETS_PER_WINDOW) {
      throw new Error('Too many open connections.');
    }

    const id = this.nextId++;
    // SNI carries the host name; an address (a LAN electrs at 192.168.x.y)
    // has none to send, and Node refuses one. The certificate is still
    // checked against whichever was given.
    const servername = net.isIP(host) ? undefined : host;
    const socket = useTls
      ? tls.connect({ host, port, servername, rejectUnauthorized: true })
      : net.connect({ host, port });
    socket.setNoDelay(true);
    const decoder = new StringDecoder('utf8');
    const session = { socket, owner: sender.id };
    this.sessions.set(id, session);

    const send = (event) => {
      if (!sender.isDestroyed()) sender.send('tcp:event', { id, ...event });
    };
    let connected = false;
    const timer = setTimeout(() => {
      if (!connected) socket.destroy(new Error(`Connecting to ${host}:${port} timed out.`));
    }, CONNECT_TIMEOUT_MS);

    socket.once(useTls ? 'secureConnect' : 'connect', () => {
      connected = true;
      clearTimeout(timer);
      send({ type: 'connect' });
    });
    socket.on('data', (chunk) => {
      const textChunk = decoder.write(chunk);
      if (textChunk) send({ type: 'data', chunk: textChunk });
    });
    socket.on('error', (err) => send({ type: 'error', message: describe(err) }));
    socket.on('close', () => {
      clearTimeout(timer);
      this.sessions.delete(id);
      const tail = decoder.end();
      if (tail) send({ type: 'data', chunk: tail });
      send({ type: 'close' });
    });
    return id;
  }

  write(sender, id, data) {
    const session = this.owned(sender, id);
    const text = v.str(data, 'data', MAX_WRITE_BYTES);
    checkElectrumLines(text);
    if (session.socket.destroyed) throw new Error('The connection is closed.');
    session.socket.write(text, 'utf8');
  }

  destroy(sender, id) {
    const session = this.sessions.get(id);
    if (!session || session.owner !== sender.id) return;
    session.socket.destroy();
    this.sessions.delete(id);
  }

  /** Closes everything a window opened — on reload, navigation or close. */
  destroyAllFor(ownerId) {
    for (const [id, session] of this.sessions) {
      if (session.owner === ownerId) {
        session.socket.destroy();
        this.sessions.delete(id);
      }
    }
  }

  owned(sender, id) {
    v.int(id, 'id', 1, Number.MAX_SAFE_INTEGER);
    const session = this.sessions.get(id);
    if (!session || session.owner !== sender.id) throw new Error('No such connection.');
    return session;
  }
}

function describe(err) {
  const code = err && err.code ? ` (${err.code})` : '';
  return `${(err && err.message) || 'Connection failed'}${code}`;
}

module.exports = { TcpSessions };
