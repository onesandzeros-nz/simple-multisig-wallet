import ecc from '@bitcoinerlab/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import * as bs58check from 'bs58check';
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { decodeCbor, encodeCbor } from './cbor';

/**
 * Coinkite TAPSIGNER (CKTap) protocol — the pure, transport-agnostic part.
 * Reference: github.com/coinkite/coinkite-tap-proto docs/protocol.md
 *
 * Commands are CBOR maps wrapped in a single APDU (CLA=00 INS=CB).
 * Authenticated commands carry an ephemeral pubkey plus the CVC (the PIN
 * printed on the card) encrypted against an ECDH session key.
 */

export const TAPSIGNER_AID = Buffer.from('f0436f696e6b697465434152447631', 'hex'); // "\xf0CoinkiteCARDv1"

export type Transceive = (apdu: Uint8Array) => Promise<Uint8Array>;

export function selectApdu(): Uint8Array {
  return Uint8Array.from([0x00, 0xa4, 0x04, 0x00, TAPSIGNER_AID.length, ...TAPSIGNER_AID]);
}

export function commandApdu(cmd: Map<string, any>): Uint8Array {
  const body = encodeCbor(cmd);
  if (body.length > 255) throw new Error('Command too large for a short APDU.');
  return Uint8Array.from([0x00, 0xcb, 0x00, 0x00, body.length, ...body]);
}

/** Friendly text for the error codes in the CKTap protocol docs. */
function describeCardError(code: number | undefined, text: string, cmd?: string): string {
  const where = cmd ? ` during "${cmd}"` : '';
  switch (code) {
    case 401:
      return 'Incorrect PIN (the 6-digit code on the back of the card).';
    case 403:
      return `The card wants the PIN before it will do this${where}.`;
    case 404:
      return `The card did not recognise the "${cmd ?? 'command'}" command — is this a TAPSIGNER (not a SATSCARD)?`;
    case 405:
    case 406:
      return `The card is not ready for this${where}: ${text}. A brand-new TAPSIGNER must be set up in the Coinkite app first (it needs its key created before an xpub exists).`;
    case 425:
    case 429:
      return 'The card is rate-limiting after failed PINs — keep it on the phone and try again in a moment.';
    case 422:
      return `The card could not read the command${where} (${text}).`;
    default:
      return `Card error${where}: ${text}${code === undefined ? '' : ` (code ${code})`}`;
  }
}

/** Strips the ISO7816 status word, throws on non-9000, CBOR-decodes the rest. */
export function parseCardResponse(raw: Uint8Array, cmd?: string): Map<string, any> {
  if (raw.length < 2) throw new Error('Empty response from card.');
  const sw = (raw[raw.length - 2] << 8) | raw[raw.length - 1];
  if (sw !== 0x9000) {
    throw new Error(
      `Card refused the ${cmd ?? 'command'} (SW=0x${sw.toString(16).padStart(4, '0')}).`
    );
  }
  const body = Buffer.from(raw.subarray(0, raw.length - 2));
  if (body.length === 0) return new Map();
  const decoded = decodeCbor(body);
  if (!(decoded instanceof Map)) throw new Error('Unexpected response from card.');
  const error = decoded.get('error');
  if (error) {
    const code = decoded.get('code');
    // Full detail to the console; friendly text to the user.
    console.error(
      `[tapsigner] ${cmd ?? 'command'} failed: code=${code} error=${JSON.stringify(error)} ` +
        `keys=${JSON.stringify([...decoded.keys()])}`
    );
    throw new Error(describeCardError(typeof code === 'number' ? code : undefined, String(error), cmd));
  }
  return decoded;
}

/**
 * CVC encryption for authenticated commands:
 *   session_key = sha256(compressed ECDH point of eph_priv × card_pubkey)
 *   xcvc = cvc XOR (session_key XOR sha256(card_nonce + cmd))[0..len(cvc)]
 */
export function calcAuth(
  cmd: string,
  cardNonce: Buffer,
  cardPubkey: Buffer,
  cvc: string,
  ephemeralPrivkey?: Buffer
): { epubkey: Buffer; xcvc: Buffer; sessionKey: Buffer } {
  let priv = ephemeralPrivkey;
  if (!priv) {
    do {
      const rnd = new Uint8Array(32);
      crypto.getRandomValues(rnd);
      priv = Buffer.from(rnd);
    } while (!ecc.isPrivate(priv));
  }
  if (!ecc.isPrivate(priv)) throw new Error('Invalid ephemeral key.');
  const epubkey = Buffer.from(ecc.pointFromScalar(priv, true)!);
  const sharedPoint = ecc.pointMultiply(cardPubkey, priv, true);
  if (!sharedPoint) throw new Error('ECDH failed — bad card public key.');
  const sessionKey = Buffer.from(sha256(Buffer.from(sharedPoint)));

  const cvcBytes = Buffer.from(cvc, 'ascii');
  if (cvcBytes.length < 6 || cvcBytes.length > 32) {
    throw new Error('The PIN (CVC) should be 6 to 32 characters.');
  }
  const md = Buffer.from(sha256(Buffer.concat([cardNonce, Buffer.from(cmd, 'ascii')])));
  const xcvc = Buffer.alloc(cvcBytes.length);
  for (let i = 0; i < cvcBytes.length; i++) xcvc[i] = cvcBytes[i] ^ sessionKey[i] ^ md[i];
  return { epubkey, xcvc, sessionKey };
}

/** Masks a value with the session key, byte for byte. */
export function xorBytes(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

/** "m/48'/0'/0'/2'" → [0x80000030, 0x80000000, 0x80000000, 0x80000002] */
export function encodeHardenedPath(path: string): number[] {
  const steps = path.replace(/^m\/?/, '').split('/').filter(Boolean);
  return steps.map((step) => {
    if (!/^\d+['h]$/.test(step)) {
      throw new Error('TAPSIGNER only supports fully hardened paths (e.g. m/48h/0h/0h/2h).');
    }
    return (parseInt(step, 10) + 0x80000000) >>> 0;
  });
}

export function masterFingerprintFromPubkey(masterPubkey: Buffer): string {
  return Buffer.from(bitcoin.crypto.hash160(masterPubkey).subarray(0, 4)).toString('hex');
}

// ---------------------------------------------------------------------------
// Card authenticity (CKTap certificate chain)
// ---------------------------------------------------------------------------

/**
 * Coinkite factory root public key(s) a genuine card's certificate chain must
 * terminate at. Only the production root is trusted: Coinkite's "TESTING ONLY"
 * root is deliberately excluded because its private key ships with the card
 * emulator, so honouring it would let a counterfeit forge a passing chain.
 */
export const FACTORY_ROOT_KEYS = new Set<string>([
  '03028a0e89e70d0ec0d932053a89ab1da7d9182bdc6d2f03e706ee99517d05d9e1',
]);

/**
 * Recover the parent public key one link up a CKTap certificate chain. Each
 * signature is 65 bytes: a header carrying the recovery id, then 64 bytes of
 * R‖S over SHA256(child pubkey). Mirrors the reference `CT_sig_to_pubkey`.
 */
function recoverCertParent(childPubkey: Buffer, sig: Buffer): Buffer {
  if (!Buffer.isBuffer(sig) || sig.length !== 65) {
    throw new Error('The card sent a malformed certificate signature.');
  }
  const recid = ((sig[0] - 27) & 0x03) as 0 | 1 | 2 | 3;
  const compact = sig.subarray(1, 65);
  const digest = Buffer.from(sha256(childPubkey));
  const recovered = ecc.recover(digest, compact, recid, true);
  if (!recovered) throw new Error('The card certificate chain could not be verified.');
  return Buffer.from(recovered);
}

/**
 * Prove a tapped card is a genuine Coinkite card, from the responses to the
 * `check` (with our nonce) and `certs` commands. Throws if the card cannot
 * prove ownership of the key it presented, or if its certificate chain does
 * not lead to a Coinkite factory root. `roots` is injectable for tests.
 */
export function verifyCardCertificate(opts: {
  /** The card's public key, from `status`. */
  cardPubkey: Buffer;
  /** The card nonce in effect when `check` was sent. */
  cardNonce: Buffer;
  /** The 16-byte nonce we sent to `check`. */
  userNonce: Buffer;
  /** 64-byte signature returned by `check`. */
  authSig: Buffer;
  /** `cert_chain` from `certs`: 65-byte recoverable signatures, leaf first. */
  certChain: Buffer[];
  roots?: Set<string>;
}): void {
  const { cardPubkey, cardNonce, userNonce, authSig, certChain } = opts;
  const roots = opts.roots ?? FACTORY_ROOT_KEYS;

  if (!Buffer.isBuffer(cardPubkey) || cardPubkey.length !== 33) {
    throw new Error('The card did not present a usable public key.');
  }
  if (!Buffer.isBuffer(cardNonce) || cardNonce.length !== 16 || userNonce.length !== 16) {
    throw new Error('Bad nonce while checking the card certificate.');
  }
  if (!Buffer.isBuffer(authSig) || authSig.length !== 64) {
    throw new Error('This card did not prove it owns its key — it may be counterfeit.');
  }
  if (!Array.isArray(certChain) || certChain.length < 2) {
    throw new Error('This card did not return a certificate chain — it may be counterfeit.');
  }

  // 1. The card must sign our fresh nonce with the key it presented — proving
  //    it holds the matching private key, not just a copied public one.
  const msg = Buffer.concat([Buffer.from('OPENDIME', 'ascii'), cardNonce, userNonce]);
  const digest = Buffer.from(sha256(msg));
  if (!ecc.verify(digest, cardPubkey, authSig)) {
    throw new Error('This card could not prove it owns its key — it may be counterfeit.');
  }

  // 2. That key must be certified by Coinkite: walk the chain to a factory root.
  let pubkey = cardPubkey;
  for (const sig of certChain) pubkey = recoverCertParent(pubkey, sig);
  if (!roots.has(pubkey.toString('hex'))) {
    throw new Error(
      'This card is not certified by Coinkite and may be a counterfeit — its key was not imported.'
    );
  }
}

export interface TapsignerKey {
  xpub: string;
  fingerprint: string;
  path: string;
  cardVersion: string;
}

/** One input to be signed: its sighash, and where the key sits below the account. */
export interface SignRequest {
  /** 32-byte BIP143 sighash. */
  digest: Buffer;
  /** Two non-hardened steps below the account path, e.g. [0, 4]. */
  subpath: [number, number];
  /** The key the wallet expects, so a card signing with another is caught here. */
  pubkey?: Buffer;
}

export interface CardSignature {
  /** 64-byte compact signature (R||S), low-S as the card guarantees. */
  signature: Buffer;
  /** The public key the card signed with, 33 bytes compressed. */
  pubkey: Buffer;
}

/**
 * One command round trip. A dropped tag surfaces as a transceive failure with
 * no clue which step it interrupted, so the command name is added here.
 */
async function sendCommand(transceive: Transceive, cmd: Map<string, any>): Promise<Map<string, any>> {
  const name = String(cmd.get('cmd'));
  let raw: Uint8Array;
  try {
    raw = await transceive(commandApdu(cmd));
  } catch (e: any) {
    throw new Error(`${e?.message ?? e} (interrupted during "${name}")`);
  }
  return parseCardResponse(raw, name);
}

/**
 * Signs digests with the key at `account/subpath`. TAPSIGNER accepts at most
 * two non-hardened steps below whatever path the card is currently set to,
 * which is exactly the branch/index pair a wallet needs.
 */
export async function tapsignerSign(
  transceive: Transceive,
  cvc: string,
  requests: SignRequest[],
  path = "m/48'/0'/0'/2'",
  /** Master fingerprint of the key we mean to sign with, when known. */
  expectFingerprint?: string
): Promise<CardSignature[]> {
  const send = (cmd: Map<string, any>) => sendCommand(transceive, cmd);

  parseCardResponse(await transceive(selectApdu()), 'applet select');
  const status = await send(new Map<string, any>([['cmd', 'status']]));
  if (!status.get('tapsigner')) {
    throw new Error('This card is not a TAPSIGNER.');
  }
  const cardPubkey: Buffer = status.get('pubkey');
  let cardNonce: Buffer = status.get('card_nonce');
  if (!Buffer.isBuffer(cardPubkey) || !Buffer.isBuffer(cardNonce)) {
    throw new Error('Unexpected status response from card.');
  }

  let delay: number = status.get('auth_delay') ?? 0;
  while (delay > 0) {
    const waited = await send(new Map<string, any>([['cmd', 'wait']]));
    delay = waited.get('auth_delay') ?? 0;
  }

  // Point the card at the account the wallet was built from.
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const deriveAuth = calcAuth('derive', cardNonce, cardPubkey, cvc);
  const derived = await send(
    new Map<string, any>([
      ['cmd', 'derive'],
      ['path', encodeHardenedPath(path)],
      ['nonce', Buffer.from(nonceBytes)],
      ['epubkey', deriveAuth.epubkey],
      ['xcvc', deriveAuth.xcvc],
    ])
  );
  cardNonce = derived.get('card_nonce');
  if (!Buffer.isBuffer(cardNonce)) throw new Error('Unexpected derive response from card.');

  // Fail before asking for signatures if this is the wrong card entirely.
  const masterPubkey = derived.get('master_pubkey');
  if (expectFingerprint && Buffer.isBuffer(masterPubkey)) {
    const actual = masterFingerprintFromPubkey(masterPubkey);
    if (actual !== expectFingerprint.toLowerCase()) {
      throw new Error(
        `That is a different card. It holds key ${actual}, but this signature needs ${expectFingerprint.toLowerCase()}.`
      );
    }
  }

  const out: CardSignature[] = [];
  for (const request of requests) {
    if (request.digest.length !== 32) throw new Error('A signing digest must be 32 bytes.');
    if (request.subpath.some((step) => step < 0 || step >= 0x80000000)) {
      throw new Error('TAPSIGNER can only sign under non-hardened steps.');
    }
    const auth = calcAuth('sign', cardNonce, cardPubkey, cvc);
    const response = await send(
      new Map<string, any>([
        ['cmd', 'sign'],
        ['slot', 0],
        // The digest travels masked by the session key, unlike every other
        // field. Send it in the clear and the card signs the wrong 32 bytes.
        ['digest', xorBytes(request.digest, auth.sessionKey)],
        ['subpath', [...request.subpath]],
        ['epubkey', auth.epubkey],
        ['xcvc', auth.xcvc],
      ])
    );
    const signature: Buffer = response.get('sig');
    const pubkey: Buffer = response.get('pubkey');
    cardNonce = response.get('card_nonce');
    if (!Buffer.isBuffer(signature) || signature.length !== 64) {
      throw new Error('The card did not return a usable signature.');
    }
    if (!Buffer.isBuffer(pubkey) || pubkey.length !== 33) {
      throw new Error('The card did not say which key it signed with.');
    }
    if (!Buffer.isBuffer(cardNonce)) throw new Error('Card did not return a new nonce.');

    // The card names the key it used. Checking it here turns a mismatch into
    // "wrong card" or "wrong path" instead of an opaque failure later, when
    // the signature is verified against the key the wallet expected.
    if (!ecc.verify(request.digest, pubkey, signature)) {
      throw new Error('The card returned a signature that does not match what it was asked to sign.');
    }
    if (request.pubkey && !request.pubkey.equals(pubkey)) {
      throw new Error(
        `This card holds a different key from the one this input needs. It signed with ` +
          `${pubkey.toString('hex').slice(0, 16)}… where the wallet expects ` +
          `${request.pubkey.toString('hex').slice(0, 16)}… at ${path}/${request.subpath.join('/')}. ` +
          `Check you tapped the right card, and that this key was imported at that derivation path.`
      );
    }
    out.push({ signature, pubkey });
  }
  return out;
}

/**
 * Full import flow against a connected card: select → status → derive at the
 * BIP48 P2WSH path → read the xpub. `transceive` sends one APDU and returns
 * the card's reply.
 */
export async function tapsignerFetchKey(
  transceive: Transceive,
  cvc: string,
  path = "m/48'/0'/0'/2'",
  /** Factory roots to trust; defaults to Coinkite's. Injectable for tests. */
  trustedRoots?: Set<string>
): Promise<TapsignerKey> {
  const send = (cmd: Map<string, any>) => sendCommand(transceive, cmd);

  parseCardResponse(await transceive(selectApdu()), 'applet select');

  const status = await send(new Map<string, any>([['cmd', 'status']]));
  // A factory-fresh TAPSIGNER has no key yet — say so plainly rather than
  // letting 'derive' fail with a vague card error later.
  if (status.get('path') === null || status.get('path') === undefined) {
    if (status.get('tapsigner')) {
      throw new Error(
        'This TAPSIGNER has not been set up yet — create its key in the Coinkite app first, then import it here.'
      );
    }
  }
  if (!status.get('tapsigner')) {
    throw new Error('This card is not a TAPSIGNER (SATSCARD and others cannot be used for multisig keys).');
  }
  const cardPubkey: Buffer = status.get('pubkey');
  let cardNonce: Buffer = status.get('card_nonce');
  if (!Buffer.isBuffer(cardPubkey) || !Buffer.isBuffer(cardNonce)) {
    throw new Error('Unexpected status response from card.');
  }

  // Before trusting anything the card says about its key, prove it is a genuine
  // Coinkite card: it must sign a fresh nonce with the key it presented, and
  // that key must carry a certificate chain up to a Coinkite factory root.
  // Neither 'certs' nor 'check' needs the CVC, so this runs before 'derive'.
  {
    const certsResp = await send(new Map<string, any>([['cmd', 'certs']]));
    const certChain: Buffer[] = (certsResp.get('cert_chain') ?? []).map((s: any) => Buffer.from(s));
    // 'certs' does not normally rotate the nonce, but honour it if it did.
    if (Buffer.isBuffer(certsResp.get('card_nonce'))) cardNonce = certsResp.get('card_nonce');

    const userNonce = new Uint8Array(16);
    crypto.getRandomValues(userNonce);
    const nonceAtCheck = cardNonce;
    const check = await send(
      new Map<string, any>([
        ['cmd', 'check'],
        ['nonce', Buffer.from(userNonce)],
      ])
    );
    verifyCardCertificate({
      cardPubkey,
      cardNonce: nonceAtCheck,
      userNonce: Buffer.from(userNonce),
      authSig: check.get('auth_sig'),
      certChain,
      roots: trustedRoots,
    });
    // 'check' issues a fresh nonce; carry it forward to the authed commands.
    cardNonce = check.get('card_nonce');
    if (!Buffer.isBuffer(cardNonce)) throw new Error('Unexpected check response from card.');
  }

  // Respect the anti-brute-force delay: each 'wait' burns one second.
  let delay: number = status.get('auth_delay') ?? 0;
  while (delay > 0) {
    const waited = await send(new Map<string, any>([['cmd', 'wait']]));
    delay = waited.get('auth_delay') ?? 0;
  }

  // Point the card's derivation at the multisig account path.
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = Buffer.from(nonceBytes);
  const deriveAuth = calcAuth('derive', cardNonce, cardPubkey, cvc);
  const derived = await send(
    new Map<string, any>([
      ['cmd', 'derive'],
      ['path', encodeHardenedPath(path)],
      ['nonce', nonce],
      ['epubkey', deriveAuth.epubkey],
      ['xcvc', deriveAuth.xcvc],
    ])
  );
  const masterPubkey: Buffer = derived.get('master_pubkey');
  cardNonce = derived.get('card_nonce');
  if (!Buffer.isBuffer(masterPubkey) || !Buffer.isBuffer(cardNonce)) {
    throw new Error('Unexpected derive response from card.');
  }

  // Read the xpub at the newly-set path (raw 78-byte BIP32 serialisation).
  const xpubAuth = calcAuth('xpub', cardNonce, cardPubkey, cvc);
  const xpubResp = await send(
    new Map<string, any>([
      ['cmd', 'xpub'],
      ['master', false],
      ['epubkey', xpubAuth.epubkey],
      ['xcvc', xpubAuth.xcvc],
    ])
  );
  const xpubBytes: Buffer = xpubResp.get('xpub');
  if (!Buffer.isBuffer(xpubBytes) || xpubBytes.length !== 78) {
    throw new Error('Unexpected xpub response from card.');
  }

  return {
    xpub: bs58check.encode(xpubBytes),
    fingerprint: masterFingerprintFromPubkey(masterPubkey),
    path,
    cardVersion: String(status.get('ver') ?? 'unknown'),
  };
}
