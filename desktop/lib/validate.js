'use strict';

/**
 * Argument checks for everything the renderer sends over IPC. The renderer is
 * our own bundle, but it runs untrusted-by-design: a compromised page must not
 * be able to turn a storage call into a file write somewhere else, or a TCP
 * call into a port scan with odd types. Every handler validates before acting.
 */

function fail(what) {
  throw new TypeError(`desktop bridge: ${what}`);
}

function str(value, name, max = 1 << 20) {
  if (typeof value !== 'string') fail(`${name} must be a string`);
  if (value.length > max) fail(`${name} is too long`);
  return value;
}

function optStr(value, name, max) {
  return value === undefined || value === null ? undefined : str(value, name, max);
}

/** Storage keys: what expo-secure-store accepts, plus the dots AsyncStorage keys use. */
function key(value) {
  const k = str(value, 'key', 256);
  if (!/^[A-Za-z0-9._:-]+$/.test(k)) fail('key has characters outside [A-Za-z0-9._:-]');
  return k;
}

function keys(value) {
  if (!Array.isArray(value)) fail('keys must be an array');
  if (value.length > 10000) fail('too many keys');
  return value.map(key);
}

function int(value, name, min, max) {
  if (!Number.isInteger(value)) fail(`${name} must be an integer`);
  if (value < min || value > max) fail(`${name} is out of range`);
  return value;
}

function optInt(value, name, min, max) {
  return value === undefined || value === null ? undefined : int(value, name, min, max);
}

function bool(value, name) {
  if (typeof value !== 'boolean') fail(`${name} must be a boolean`);
  return value;
}

function obj(value, name) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${name} must be an object`);
  return value;
}

function host(value) {
  const h = str(value, 'host', 253).trim();
  // A DNS name, an IPv4 address or a bare IPv6 address. No URLs, no spaces.
  if (!/^[A-Za-z0-9.\-]+$/.test(h) && !/^[0-9A-Fa-f:.]+$/.test(h)) fail('host is not a host name or address');
  return h;
}

function httpUrl(value) {
  const raw = str(value, 'url', 8192);
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail('url is not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('url must be http or https');
  if (url.username || url.password) fail('url must not carry credentials');
  return url.toString();
}

function externalUrl(value) {
  const raw = str(value, 'url', 8192);
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail('url is not a URL');
  }
  if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) fail('only http, https and mailto links open outside the app');
  return url.toString();
}

function headers(value) {
  if (value === undefined || value === null) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(obj(value, 'headers'))) {
    if (!/^[A-Za-z0-9\-]+$/.test(k) || k.length > 128) fail('bad header name');
    out[k] = str(v, `header ${k}`, 8192);
  }
  return out;
}

/** A file name the user will see in the save dialog: no directories, nothing hidden. */
function fileName(value) {
  const n = str(value, 'suggestedName', 200).trim();
  if (!n || n.startsWith('.') || /[\\/:*?"<>|\u0000-\u001f]/.test(n)) fail('suggestedName is not a plain file name');
  return n;
}

function base64(value, name, max = 64 << 20) {
  const b = str(value, name, max);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b)) fail(`${name} is not base64`);
  return b;
}

module.exports = { fail, str, optStr, key, keys, int, optInt, bool, obj, host, httpUrl, externalUrl, headers, fileName, base64 };
