import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';

/**
 * The desktop shell's TCP sessions (desktop/lib/tcp.js), which carry the
 * Electrum protocol, against a local server. The renderer is stood in for
 * by a fake webContents that records what it is sent.
 */
const require = createRequire(import.meta.url);
const { TcpSessions } = require('../desktop/lib/tcp.js');

type Ev = { id: number; type: string; chunk?: string; message?: string };

function sender(id: number) {
  const events: Ev[] = [];
  const waiters: Array<(ev: Ev) => void> = [];
  return {
    id,
    events,
    isDestroyed: () => false,
    send(_channel: string, ev: Ev) {
      events.push(ev);
      waiters.splice(0).forEach((w) => w(ev));
    },
    next(type: string): Promise<Ev> {
      const found = events.find((e) => e.type === type);
      if (found) return Promise.resolve(found);
      return new Promise((resolve) => {
        const check = (ev: Ev) => {
          if (ev.type === type) resolve(ev);
          else waiters.push(check);
        };
        waiters.push(check);
      });
    },
  };
}

describe('desktop TCP sessions', () => {
  let server: net.Server;
  let port = 0;
  before(async () => {
    server = net.createServer((sock) => sock.on('data', (d) => sock.write(`echo:${d}`)));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as net.AddressInfo).port;
  });
  after(() => server.close());

  it('connects, relays data as text and reports the close', async () => {
    const tcp = new TcpSessions();
    const page = sender(1);
    const id = tcp.connect(page, { host: '127.0.0.1', port, tls: false });
    await page.next('connect');
    const line = '{"jsonrpc":"2.0","id":1,"method":"server.version","params":["héllo","1.4"]}\n';
    tcp.write(page, id, line);
    const data = await page.next('data');
    assert.equal(data.chunk, `echo:${line}`);
    assert.throws(() => tcp.write(page, id, 'GET / HTTP/1.0\r\n\r\n'), /JSON-RPC/);
    assert.throws(() => tcp.write(page, id, '{"method":"server.version"}'), /newline/);
    assert.throws(() => tcp.write(page, id, '{"method":"Server Version!"}\n'), /method/);
    assert.throws(() => tcp.write(page, id, '{"method":"server.version","params":{"a":1}}\n'), /params/);
    tcp.destroy(page, id);
    const close = await page.next('close');
    assert.equal(close.id, id);
    assert.equal(tcp.sessions.size, 0);
  });

  it('keeps one window from touching another window\'s socket', async () => {
    const tcp = new TcpSessions();
    const owner = sender(1);
    const other = sender(2);
    const id = tcp.connect(owner, { host: '127.0.0.1', port, tls: false });
    await owner.next('connect');
    assert.throws(() => tcp.write(other, id, '{"method":"server.ping"}\n'), /No such connection/);
    tcp.destroy(other, id); // silently ignored
    assert.equal(tcp.sessions.size, 1);
    tcp.destroyAllFor(other.id);
    assert.equal(tcp.sessions.size, 1);
    tcp.destroyAllFor(owner.id);
    assert.equal(tcp.sessions.size, 0);
  });

  it('validates host, port and tls, and caps sockets per window', async () => {
    const tcp = new TcpSessions();
    const page = sender(1);
    assert.throws(() => tcp.connect(page, { host: 'http://x', port, tls: false }), /host/);
    assert.throws(() => tcp.connect(page, { host: '127.0.0.1', port: 0, tls: false }), /range/);
    assert.throws(() => tcp.connect(page, { host: '127.0.0.1', port, tls: 'yes' }), /boolean/);
    const ids: number[] = [];
    for (let i = 0; i < 16; i++) ids.push(tcp.connect(page, { host: '127.0.0.1', port, tls: false }));
    assert.throws(() => tcp.connect(page, { host: '127.0.0.1', port, tls: false }), /Too many/);
    tcp.destroyAllFor(page.id);
    assert.equal(tcp.sessions.size, 0);
  });

  it('reports a refused connection as error then close', async () => {
    const tcp = new TcpSessions();
    const page = sender(1);
    const closed = net.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const deadPort = (closed.address() as net.AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    tcp.connect(page, { host: '127.0.0.1', port: deadPort, tls: false });
    const err = await page.next('error');
    assert.match(err.message!, /ECONNREFUSED/);
    await page.next('close');
    assert.equal(tcp.sessions.size, 0);
  });

  it('a TLS connection to a plain server fails rather than talking in the clear', async () => {
    const tcp = new TcpSessions();
    const page = sender(1);
    tcp.connect(page, { host: '127.0.0.1', port, tls: true });
    const err = await page.next('error');
    assert.ok(err.message, 'an error is reported');
    await page.next('close');
    assert.ok(!page.events.some((e) => e.type === 'connect'), 'never reported as connected');
  });
});
