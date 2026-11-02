import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

/**
 * The desktop shell's HTTP bridge (desktop/lib/netfetch.js) over a stand-in
 * for Electron's net.request: what it follows, what it refuses, what it
 * sends. Each route is a final answer or a redirect to another route.
 */
const require = createRequire(import.meta.url);
const { NetFetch, MAX_BODY_BYTES } = require('../desktop/lib/netfetch.js');

type Route =
  | { redirect: { status: number; to: string } }
  | { status: number; headers?: Record<string, string>; body?: string | string[]; hang?: boolean };

function fakeNet(routes: Record<string, Route>) {
  const requests: any[] = [];
  const net = {
    request(options: any) {
      const req = new EventEmitter() as any;
      Object.assign(req, {
        options,
        headers: {} as Record<string, string>,
        body: '',
        url: options.url,
        followed: 0,
        aborted: false,
        setHeader(k: string, v: string) {
          req.headers[k] = v;
        },
        write(d: string) {
          req.body += d;
        },
        abort() {
          req.aborted = true;
          req.emit('abort');
        },
        followRedirect() {
          req.followed += 1;
        },
        end() {
          setImmediate(() => step(req));
        },
      });
      requests.push(req);
      return req;
    },
  };
  function step(req: any) {
    if (req.aborted) return;
    const route = routes[req.url];
    if (!route) return req.emit('error', new Error(`net::ERR_NAME_NOT_RESOLVED ${req.url}`));
    if ('redirect' in route) {
      const before = req.followed;
      req.emit('redirect', route.redirect.status, 'GET', route.redirect.to, {});
      if (req.followed > before) {
        req.url = route.redirect.to;
        setImmediate(() => step(req));
      }
      return;
    }
    const res = new EventEmitter() as any;
    res.statusCode = route.status;
    res.statusMessage = 'OK';
    res.headers = route.headers ?? {};
    req.emit('response', res);
    if (route.hang) return;
    const chunks = Array.isArray(route.body) ? route.body : [route.body ?? ''];
    setImmediate(() => {
      for (const c of chunks) {
        if (req.aborted) return;
        res.emit('data', Buffer.from(c));
      }
      if (!req.aborted) res.emit('end');
    });
  }
  return { net, requests };
}

describe('desktop HTTP bridge', () => {
  it('sends GET without cookies or cache, and returns the answer', async () => {
    const { net, requests } = fakeNet({ 'https://a.test/api/tip': { status: 200, body: '42', headers: { 'content-type': 'text/plain' } } });
    const res = await new NetFetch(net).fetch({ id: '1', url: 'https://a.test/api/tip' });
    assert.deepEqual(res, { status: 200, statusText: 'OK', headers: [['content-type', 'text/plain']], body: '42' });
    assert.equal(requests[0].options.credentials, 'omit');
    assert.equal(requests[0].options.cache, 'no-store');
    assert.equal(requests[0].options.redirect, 'manual');
    assert.equal(requests[0].options.useSessionCookies, false);
  });

  it('follows a same-scheme redirect and stops after too many', async () => {
    const { net, requests } = fakeNet({
      'https://a.test/api/tip': { redirect: { status: 302, to: 'https://a.test/moved' } },
      'https://a.test/moved': { status: 200, body: 'ok' },
      'https://a.test/loop': { redirect: { status: 302, to: 'https://a.test/loop' } },
    });
    assert.equal((await new NetFetch(net).fetch({ id: '1', url: 'https://a.test/api/tip' })).body, 'ok');
    assert.equal(requests[0].followed, 1);
    await assert.rejects(new NetFetch(net).fetch({ id: '2', url: 'https://a.test/loop' }), /too many times/);
    assert.ok(requests[1].aborted);
  });

  it('refuses a redirect from https to plain http, or to a non-web address', async () => {
    const { net } = fakeNet({
      'https://a.test/d': { redirect: { status: 301, to: 'http://a.test/d' } },
      'https://a.test/f': { redirect: { status: 301, to: 'file:///etc/passwd' } },
      'http://a.test/u': { redirect: { status: 301, to: 'https://a.test/ok' } },
      'https://a.test/ok': { status: 200, body: 'upgraded' },
    });
    await assert.rejects(new NetFetch(net).fetch({ id: '1', url: 'https://a.test/d' }), /plain http/);
    await assert.rejects(new NetFetch(net).fetch({ id: '2', url: 'https://a.test/f' }), /not a web address/);
    assert.equal((await new NetFetch(net).fetch({ id: '3', url: 'http://a.test/u' })).body, 'upgraded');
  });

  it('sends a POST body for broadcasts and nothing else the app does not use', async () => {
    const { net, requests } = fakeNet({ 'https://a.test/tx': { status: 200, body: 'txid' } });
    const bridge = new NetFetch(net);
    await bridge.fetch({ id: '1', url: 'https://a.test/tx', method: 'POST', body: '0200', headers: { 'Content-Type': 'text/plain' } });
    assert.equal(requests[0].options.method, 'POST');
    assert.equal(requests[0].body, '0200');
    assert.deepEqual(requests[0].headers, { 'Content-Type': 'text/plain' });
    await assert.rejects(bridge.fetch({ id: '2', url: 'https://a.test/tx', method: 'DELETE' }), /only GET and POST/);
    await assert.rejects(bridge.fetch({ id: '3', url: 'https://a.test/tx', body: 'x' }), /only POST/);
    await assert.rejects(bridge.fetch({ id: '4', url: 'https://a.test/tx', headers: { Cookie: 'a=b' } }), /header/);
    await assert.rejects(bridge.fetch({ id: '5', url: 'file:///etc/passwd' }), /http/);
  });

  it('refuses oversized answers, declared or streamed', async () => {
    const { net } = fakeNet({
      'https://a.test/declared': { status: 200, headers: { 'content-length': String(MAX_BODY_BYTES + 1) } },
      'https://a.test/streamed': { status: 200, body: ['x'.repeat(MAX_BODY_BYTES), 'y'] },
    });
    await assert.rejects(new NetFetch(net).fetch({ id: '1', url: 'https://a.test/declared' }), /too large/);
    await assert.rejects(new NetFetch(net).fetch({ id: '2', url: 'https://a.test/streamed' }), /too large/);
  });

  it('aborts an in-flight request by id and reports network errors plainly', async () => {
    const { net, requests } = fakeNet({ 'https://a.test/slow': { status: 200, hang: true }, 'https://gone.test/': { status: 0 } });
    const bridge = new NetFetch(net);
    const pending = bridge.fetch({ id: 'r9', url: 'https://a.test/slow' });
    await new Promise((r) => setImmediate(r));
    bridge.abort('r9');
    await assert.rejects(pending, (e: Error) => e.name === 'AbortError');
    assert.ok(requests[0].aborted);
    assert.equal(bridge.inFlight.size, 0);
    bridge.abort('unknown');
    await assert.rejects(bridge.fetch({ id: 'x', url: 'https://nowhere.test/' }), /ERR_NAME_NOT_RESOLVED/);
  });
});
