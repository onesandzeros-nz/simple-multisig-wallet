'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { protocol } = require('electron');
const { resolveBundlePath } = require('./bundlePath');

/**
 * The exported web app is served from `app://bundle/…` rather than `file://`:
 * a registered scheme is a real origin, so the bundle's absolute `/_expo/…`
 * and `/assets/…` paths resolve, web storage works, and the page counts as
 * a secure context (crypto.subtle, randomUUID, the camera). Files are read
 * from the bundle directory — inside app.asar once packaged — and nothing
 * outside it is ever served.
 */
const SCHEME = 'app';
const HOST = 'bundle';
const ORIGIN = `${SCHEME}://${HOST}`;
const INDEX_URL = `${ORIGIN}/index.html`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

/**
 * What the page may load and talk to. Scripts only from the bundle
 * ('wasm-unsafe-eval' lets the QR decoder's WebAssembly compile); styles may
 * be inline because react-native-web writes element styles; images and fonts
 * from the bundle or data URLs; the camera preview is a blob/mediastream;
 * network only to Nostr relays over WebSocket — HTTP to block explorers goes
 * through the main process, not the page.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob: mediastream:",
  "connect-src 'self' data: blob: ws: wss:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

function text(status, body) {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/** Serves `distDir` (the `npx expo export --platform web` output) on the scheme. */
function serveBundle(distDir) {
  const root = path.resolve(distDir);
  protocol.handle(SCHEME, (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return text(400, 'bad request');
    }
    if (url.host !== HOST) return text(404, 'not found');
    if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'method not allowed');

    // Resolve inside the bundle and refuse anything that climbs out of it.
    const file = resolveBundlePath(root, url.pathname);
    if (file === null) return text(400, 'bad request');

    let data;
    try {
      // Synchronous on purpose: fs is what Electron patches to read app.asar,
      // and the largest file (the bundle itself) is a few megabytes, once.
      data = fs.readFileSync(file);
    } catch (e) {
      return text(e && e.code === 'ENOENT' ? 404 : 500, e && e.code === 'ENOENT' ? 'not found' : 'cannot read');
    }

    const ext = path.extname(file).toLowerCase();
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': String(data.byteLength),
      'x-content-type-options': 'nosniff',
    };
    if (ext === '.html') headers['content-security-policy'] = CSP;
    return new Response(request.method === 'HEAD' ? null : data, { status: 200, headers });
  });
}

module.exports = { SCHEME, HOST, ORIGIN, INDEX_URL, CSP, MIME, registerScheme, serveBundle };
