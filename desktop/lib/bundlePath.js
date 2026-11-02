'use strict';

const path = require('node:path');

/**
 * Maps a request path on app://bundle/ to a file inside the bundle
 * directory, or null when the path would reach outside it. Pure, so it
 * can be tested without Electron.
 */
function resolveBundlePath(root, pathname) {
  if (typeof pathname !== 'string') return null;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded === '' || decoded === '/') decoded = '/index.html';
  if (decoded.includes('\0')) return null;
  const base = path.resolve(root);
  const file = path.resolve(base, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  const relative = path.relative(base, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return file;
}

module.exports = { resolveBundlePath };
