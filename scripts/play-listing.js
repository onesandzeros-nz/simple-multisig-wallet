#!/usr/bin/env node
/**
 * Uploads the Google Play store listing — title and descriptions, icon,
 * feature graphic, screenshots — from store/play/, as the Play service
 * account, through the Google Play Developer API. The edit is committed with
 * changesNotSentForReview, so nothing goes to review until someone presses
 * the button in the Play Console; the console's App content forms (content
 * rating, data safety, privacy policy, declarations) have no API and stay
 * by hand.
 *
 *   node scripts/play-listing.js            # upload
 *   node scripts/play-listing.js --dry-run  # validate and show the plan
 *
 * The service account needs "Manage store presence" on the app, as well as
 * the release permissions EAS Submit uses.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PACKAGE = 'nz.onesandzeros.simplemultisig';
const LANGUAGE = 'en-GB';
const CONTACT_EMAIL = 'studio@onesandzeros.nz';
const CONTACT_WEBSITE = 'https://onesandzeros.nz';

const ROOT = path.join(__dirname, '..', 'store', 'play');
const KEY_PATH = path.join(__dirname, '..', 'secrets', 'play-service-account.json');
const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`;
const UPLOAD = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PACKAGE}`;

/** Play's image slots, the folder each comes from, and what Play accepts. */
const IMAGES = [
  { type: 'icon', file: 'icon.png', size: [512, 512] },
  { type: 'featureGraphic', file: 'feature.png', size: [1024, 500] },
  { type: 'phoneScreenshots', dir: 'phone', min: 2, max: 8 },
  { type: 'sevenInchScreenshots', dir: 'tablet7', min: 0, max: 8 },
  { type: 'tenInchScreenshots', dir: 'tablet10', min: 0, max: 8 },
];
const TEXT_LIMITS = { title: 30, short: 80, full: 4000 };

const dryRun = process.argv.includes('--dry-run');

function read(name) {
  return fs.readFileSync(path.join(ROOT, 'listing', LANGUAGE, `${name}.txt`), 'utf8').trim();
}

/** Width and height from a PNG or JPEG header, without an image library. */
function dimensions(file) {
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), mime: 'image/png' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) throw new Error(`${file}: malformed JPEG`);
      const marker = buf[i + 1];
      const length = buf.readUInt16BE(i + 2);
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), mime: 'image/jpeg' };
      }
      i += 2 + length;
    }
  }
  throw new Error(`${file}: not a PNG or JPEG`);
}

function listImages(slot) {
  if (slot.file) {
    const file = path.join(ROOT, 'images', slot.file);
    return fs.existsSync(file) ? [file] : [];
  }
  const dir = path.join(ROOT, 'images', slot.dir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(png|jpe?g)$/i.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

/** Everything checked before a byte is sent, so a bad asset fails here with a reason. */
function plan() {
  const problems = [];
  const text = { title: read('title'), short: read('short'), full: read('full') };
  for (const [name, limit] of Object.entries(TEXT_LIMITS)) {
    if (text[name].length === 0) problems.push(`${name}.txt is empty`);
    if (text[name].length > limit) problems.push(`${name}.txt is ${text[name].length} characters; Play allows ${limit}`);
  }
  const images = [];
  for (const slot of IMAGES) {
    const files = listImages(slot);
    if (slot.min && files.length < slot.min) problems.push(`${slot.type}: ${files.length} image(s), Play needs at least ${slot.min}`);
    if (slot.max && files.length > slot.max) problems.push(`${slot.type}: ${files.length} images, Play takes at most ${slot.max}`);
    if (slot.file && files.length === 0) problems.push(`${slot.type}: store/play/images/${slot.file} is missing`);
    for (const file of files) {
      const d = dimensions(file);
      const name = path.relative(ROOT, file);
      if (slot.size && (d.width !== slot.size[0] || d.height !== slot.size[1])) {
        problems.push(`${name} is ${d.width}x${d.height}; Play wants ${slot.size[0]}x${slot.size[1]}`);
      }
      if (slot.dir) {
        const [lo, hi] = [320, 3840];
        if (d.width < lo || d.height < lo || d.width > hi || d.height > hi) {
          problems.push(`${name} is ${d.width}x${d.height}; each side must be between ${lo} and ${hi} pixels`);
        }
        const ratio = Math.max(d.width, d.height) / Math.min(d.width, d.height);
        if (Math.abs(ratio - 16 / 9) > 0.02) {
          console.warn(`note: ${name} is ${d.width}x${d.height}, not 16:9 or 9:16 — Play accepts it but will not feature it`);
        }
      }
      if (fs.statSync(file).size > 8 * 1024 * 1024) problems.push(`${name} is over 8 MB`);
      images.push({ type: slot.type, file, mime: d.mime, width: d.width, height: d.height });
    }
  }
  return { text, images, problems };
}

async function accessToken(key) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: key.token_uri,
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), key.private_key).toString('base64url');
  const res = await fetch(key.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
  });
  if (!res.ok) throw new Error(`token: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function call(token, method, url, body, mime) {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': mime ?? 'application/json' } : {}),
    },
    body: body && !mime ? JSON.stringify(body) : body,
  });
  const text = await res.text();
  if (!res.ok) {
    const hint = res.status === 403 ? ' — does the service account have "Manage store presence" on this app in the Play Console?' : '';
    throw new Error(`${method} ${url.replace(API, '').replace(UPLOAD, '')}: ${res.status} ${text}${hint}`);
  }
  return text ? JSON.parse(text) : {};
}

async function main() {
  const { text, images, problems } = plan();
  console.log(`Listing (${LANGUAGE}): "${text.title}" — short ${text.short.length}, full ${text.full.length} characters`);
  for (const img of images) console.log(`  ${img.type}: ${path.relative(ROOT, img.file)} (${img.width}x${img.height})`);
  if (problems.length > 0) {
    console.error('\nNot uploaded:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  if (dryRun) {
    console.log('\nDry run: nothing sent.');
    return;
  }
  const key = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
  const token = await accessToken(key);
  const edit = await call(token, 'POST', `${API}/edits`, {});
  console.log(`\nEdit ${edit.id} opened as ${key.client_email}`);
  await call(token, 'PATCH', `${API}/edits/${edit.id}/details`, {
    defaultLanguage: LANGUAGE,
    contactEmail: CONTACT_EMAIL,
    contactWebsite: CONTACT_WEBSITE,
  });
  await call(token, 'PUT', `${API}/edits/${edit.id}/listings/${LANGUAGE}`, {
    language: LANGUAGE,
    title: text.title,
    shortDescription: text.short,
    fullDescription: text.full,
  });
  console.log('Text set.');
  for (const slot of IMAGES) {
    const files = images.filter((i) => i.type === slot.type);
    if (files.length === 0) continue;
    // Replace the slot wholesale, so the folder is the truth.
    await call(token, 'DELETE', `${API}/edits/${edit.id}/listings/${LANGUAGE}/${slot.type}`);
    for (const img of files) {
      await call(token, 'POST', `${UPLOAD}/edits/${edit.id}/listings/${LANGUAGE}/${slot.type}?uploadType=media`, fs.readFileSync(img.file), img.mime);
      console.log(`Uploaded ${slot.type}: ${path.basename(img.file)}`);
    }
  }
  // A published app's changes would go to review on commit, so hold them
  // back; an app still in draft is not reviewed at all, and Play refuses
  // the flag for it.
  try {
    await call(token, 'POST', `${API}/edits/${edit.id}:commit?changesNotSentForReview=true`, {});
    console.log('Committed, held back from review. The App content forms are still yours to fill in the Play Console.');
  } catch (e) {
    if (!/changesNotSentForReview must not be set/.test(e.message)) throw e;
    await call(token, 'POST', `${API}/edits/${edit.id}:commit`, {});
    console.log('Committed to the draft listing. The App content forms are still yours to fill in the Play Console.');
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
