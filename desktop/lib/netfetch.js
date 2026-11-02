'use strict';

const v = require('./validate');

/**
 * HTTP for the block explorer APIs, done from the main process. A phone's
 * fetch has no same-origin policy; a page served from app:// does, and a
 * self-hosted mempool or Esplora instance rarely sends CORS headers. The
 * request goes through Electron's net module — Chromium's stack, with its
 * TLS verification and proxy settings — sending no cookies and caching
 * nothing. Redirects are followed one at a time so that an https server can
 * never send the request on to plain http. Only what the app itself sends is
 * accepted: GET and POST, a text body, two headers at most.
 */
const MAX_BODY_BYTES = 32 << 20;
const MAX_IN_FLIGHT = 64;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 90_000;
const METHODS = new Set(['GET', 'POST']);
const HEADERS = new Set(['accept', 'content-type']);

function electronNet() {
  return require('electron').net;
}

function abortError() {
  const e = new Error('The request was cancelled.');
  e.name = 'AbortError';
  return e;
}

function describe(err) {
  return new Error((err && err.message) || 'The request failed.');
}

function flattenHeaders(headers) {
  const out = [];
  for (const [name, value] of Object.entries(headers || {})) {
    out.push([name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value)]);
  }
  return out;
}

class NetFetch {
  constructor(net = electronNet()) {
    this.net = net;
    this.inFlight = new Map(); // id -> abort()
  }

  async fetch(request) {
    const r = v.obj(request, 'request');
    const id = v.str(r.id, 'id', 64);
    const url = v.httpUrl(r.url);
    const method = (v.optStr(r.method, 'method', 16) || 'GET').toUpperCase();
    if (!METHODS.has(method)) v.fail('only GET and POST requests are sent');
    const headers = v.headers(r.headers) || {};
    for (const name of Object.keys(headers)) {
      if (!HEADERS.has(name.toLowerCase())) v.fail(`the ${name} header is not sent`);
    }
    const body = v.optStr(r.body, 'body', MAX_BODY_BYTES);
    if (body !== undefined && method !== 'POST') v.fail('only POST carries a body');
    if (this.inFlight.size >= MAX_IN_FLIGHT) throw new Error('Too many requests in flight.');

    return await new Promise((resolve, reject) => {
      let settled = false;
      let currentUrl = url;
      let hops = 0;
      const req = this.net.request({
        url,
        method,
        redirect: 'manual',
        credentials: 'omit',
        useSessionCookies: false,
        cache: 'no-store',
      });
      const finish = (fn) => (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.inFlight.delete(id);
        fn(value);
      };
      const done = finish(resolve);
      const fail = finish(reject);
      const abortWith = (err) => {
        fail(err);
        try {
          req.abort();
        } catch {
          // already gone
        }
      };
      const timer = setTimeout(() => abortWith(new Error('The server did not answer in time.')), TIMEOUT_MS);
      this.inFlight.set(id, () => abortWith(abortError()));

      req.on('redirect', (_statusCode, _nextMethod, redirectUrl) => {
        let next;
        try {
          next = new URL(redirectUrl);
        } catch {
          return abortWith(new Error('The server redirected somewhere unreadable.'));
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          return abortWith(new Error('The server redirected to something that is not a web address.'));
        }
        if (currentUrl.startsWith('https:') && next.protocol === 'http:') {
          return abortWith(new Error('The server redirected from https to plain http, which is not followed.'));
        }
        if (hops >= MAX_REDIRECTS) return abortWith(new Error('The server redirected too many times.'));
        hops += 1;
        currentUrl = next.toString();
        req.followRedirect();
      });
      req.on('response', (res) => {
        const declared = Number((res.headers && res.headers['content-length']) || 0);
        if (declared > MAX_BODY_BYTES) return abortWith(new Error('The response is too large.'));
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) return abortWith(new Error('The response is too large.'));
          chunks.push(chunk);
        });
        res.on('end', () =>
          done({
            status: res.statusCode,
            statusText: res.statusMessage || '',
            headers: flattenHeaders(res.headers),
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
        res.on('error', (e) => fail(describe(e)));
        res.on('aborted', () => fail(new Error('The connection was dropped.')));
      });
      req.on('error', (e) => fail(describe(e)));
      req.on('abort', () => fail(abortError()));
      for (const [name, value] of Object.entries(headers)) req.setHeader(name, value);
      if (body !== undefined) req.write(body, 'utf8');
      req.end();
    });
  }

  abort(id) {
    const cancel = this.inFlight.get(v.str(id, 'id', 64));
    if (cancel) cancel();
  }
}

module.exports = { NetFetch, MAX_BODY_BYTES, MAX_REDIRECTS };
