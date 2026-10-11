import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ecc from '@bitcoinerlab/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import * as bs58check from 'bs58check';
import { Buffer } from 'buffer';
import {
  calcAuth,
  commandApdu,
  encodeHardenedPath,
  masterFingerprintFromPubkey,
  parseCardResponse,
  selectApdu,
  tapsignerFetchKey,
  tapsignerSign,
  TAPSIGNER_AID,
  verifyCardCertificate,
  FACTORY_ROOT_KEYS,
  xorBytes,
} from '../src/lib/tapsigner';
import { decodeCbor, encodeCbor } from '../src/lib/cbor';
import { describeNfcError } from '../src/lib/nfcErrors';
import { accountXpub, bip48Path, masterFingerprint, rootFromMnemonic } from '../src/lib/bitcoin';
import { normaliseXpub } from '../src/lib/slip132';
import { MNEMONICS } from './helpers';

describe('CKTap protocol pieces', () => {
  it('builds the applet select APDU', () => {
    const apdu = selectApdu();
    assert.deepEqual(Array.from(apdu.subarray(0, 5)), [0x00, 0xa4, 0x04, 0x00, TAPSIGNER_AID.length]);
    assert.equal(Buffer.from(apdu.subarray(5)).toString('hex'), 'f0436f696e6b697465434152447631');
  });

  it('wraps commands as CBOR in a single APDU and round-trips', () => {
    const apdu = commandApdu(new Map<string, any>([['cmd', 'status']]));
    assert.deepEqual(Array.from(apdu.subarray(0, 4)), [0x00, 0xcb, 0x00, 0x00]);
    const decoded = decodeCbor(Buffer.from(apdu.subarray(5)));
    assert.equal(decoded.get('cmd'), 'status');
  });

  it('encodes hardened derivation paths', () => {
    assert.deepEqual(encodeHardenedPath("m/48'/0'/0'/2'"), [
      0x80000030, 0x80000000, 0x80000000, 0x80000002,
    ]);
    assert.deepEqual(encodeHardenedPath('m/84h/1h/0h'), [0x80000054, 0x80000001, 0x80000000]);
    assert.throws(() => encodeHardenedPath('m/48/0'), /hardened/i);
  });

  it('xcvc auth: the card can recover the CVC from the app payload', () => {
    // Simulate both sides: the card holds card_priv, the app only card_pub.
    const cardPriv = Buffer.from(sha256(Buffer.from('card side key')));
    const cardPub = Buffer.from(ecc.pointFromScalar(cardPriv, true)!);
    const cardNonce = Buffer.from(sha256(Buffer.from('nonce'))).subarray(0, 16) as Buffer;
    const cvc = '123456';

    const auth = calcAuth('derive', Buffer.from(cardNonce), cardPub, cvc);

    // Card side: session key from its private key and the app's epubkey.
    const shared = ecc.pointMultiply(auth.epubkey, cardPriv, true)!;
    const cardSession = Buffer.from(sha256(Buffer.from(shared)));
    assert.deepEqual(cardSession, auth.sessionKey, 'ECDH must agree on both sides');

    const md = Buffer.from(sha256(Buffer.concat([Buffer.from(cardNonce), Buffer.from('derive', 'ascii')])));
    const recovered = Buffer.alloc(auth.xcvc.length);
    for (let i = 0; i < recovered.length; i++) recovered[i] = auth.xcvc[i] ^ cardSession[i] ^ md[i];
    assert.equal(recovered.toString('ascii'), cvc);
  });

  it('derives the master fingerprint from the master pubkey', () => {
    const root = rootFromMnemonic(MNEMONICS[0], 'mainnet');
    const fp = masterFingerprintFromPubkey(Buffer.from(root.publicKey));
    assert.equal(fp, masterFingerprint(MNEMONICS[0]));
    assert.equal(fp, '73c5da0a');
  });

  it('parses card responses and surfaces card errors', () => {
    const ok = Buffer.concat([encodeCbor(new Map<string, any>([['ver', '1.0.3']])), Buffer.from([0x90, 0x00])]);
    assert.equal(parseCardResponse(ok).get('ver'), '1.0.3');

    const badSw = Buffer.from([0x6d, 0x00]);
    assert.throws(() => parseCardResponse(badSw), /refused/i);

    const authErr = Buffer.concat([
      encodeCbor(new Map<string, any>([['error', 'bad auth'], ['code', 401]])),
      Buffer.from([0x90, 0x00]),
    ]);
    assert.throws(() => parseCardResponse(authErr), /Incorrect PIN/i);
  });
});

// A fake TAPSIGNER backed by a real BIP32 root: implements select/status/
// wait/derive/xpub with the genuine auth checks, driven through the same
// code path the NFC transport uses.
/** A 65-byte CKTap recoverable signature over SHA256(childPub), by signerPriv. */
function certSig(childPub: Buffer, signerPriv: Buffer): Buffer {
  const digest = Buffer.from(sha256(childPub));
  const { signature, recoveryId } = ecc.signRecoverable!(digest, signerPriv);
  return Buffer.concat([Buffer.from([27 + recoveryId]), Buffer.from(signature)]);
}

function makeFakeCard(mnemonic: string, opts: { cvc: string; authDelay?: number }) {
  const root = rootFromMnemonic(mnemonic, 'mainnet');
  const cardPriv = Buffer.from(sha256(Buffer.from('fake card identity')));
  const cardPub = Buffer.from(ecc.pointFromScalar(cardPriv, true)!);

  // A two-link factory certificate chain: card ← batch ← root. The test root
  // stands in for Coinkite's; genuine hardware chains to the real one.
  const batchPriv = Buffer.from(sha256(Buffer.from('fake batch key')));
  const batchPub = Buffer.from(ecc.pointFromScalar(batchPriv, true)!);
  const rootPriv = Buffer.from(sha256(Buffer.from('fake factory root')));
  const rootPub = Buffer.from(ecc.pointFromScalar(rootPriv, true)!);
  const certChain = [certSig(cardPub, batchPriv), certSig(batchPub, rootPriv)];

  let cardNonce = Buffer.from(sha256(Buffer.from('initial'))).subarray(0, 16) as Buffer;
  let currentPath = "m/84'/0'/0'";
  let authDelay = opts.authDelay ?? 0;

  /** Verifies the encrypted CVC and returns the session key, as a card does. */
  function checkAuth(cmdName: string, cmd: Map<string, any>): Buffer {
    const epubkey: Buffer = cmd.get('epubkey');
    const xcvc: Buffer = cmd.get('xcvc');
    const shared = ecc.pointMultiply(epubkey, cardPriv, true)!;
    const session = Buffer.from(sha256(Buffer.from(shared)));
    const md = Buffer.from(sha256(Buffer.concat([cardNonce, Buffer.from(cmdName, 'ascii')])));
    const recovered = Buffer.alloc(xcvc.length);
    for (let i = 0; i < xcvc.length; i++) recovered[i] = xcvc[i] ^ session[i] ^ md[i];
    if (recovered.toString('ascii') !== opts.cvc) {
      throw Object.assign(new Error('bad auth'), { code: 401 });
    }
    cardNonce = Buffer.from(sha256(cardNonce)).subarray(0, 16) as Buffer;
    return session;
  }

  const transceive = async (apdu: Uint8Array): Promise<Uint8Array> => {
    const bytes = Buffer.from(apdu);
    // applet select
    if (bytes[1] === 0xa4) return Uint8Array.from([0x90, 0x00]);
    const cmd = decodeCbor(bytes.subarray(5)) as Map<string, any>;
    const name = cmd.get('cmd');
    const reply = (m: Map<string, any>) =>
      Uint8Array.from(Buffer.concat([encodeCbor(m), Buffer.from([0x90, 0x00])]));
    try {
      if (name === 'certs') {
        // Unauthenticated; does not rotate the nonce.
        return reply(new Map<string, any>([['cert_chain', certChain.map((s) => Buffer.from(s))]]));
      }
      if (name === 'check') {
        // Prove ownership of cardPub by signing OPENDIME‖card_nonce‖user_nonce,
        // then rotate the nonce as a real card does.
        const userNonce: Buffer = cmd.get('nonce');
        const msg = Buffer.concat([Buffer.from('OPENDIME', 'ascii'), cardNonce, userNonce]);
        const authSig = ecc.sign(Buffer.from(sha256(msg)), cardPriv);
        cardNonce = Buffer.from(sha256(cardNonce)).subarray(0, 16) as Buffer;
        return reply(
          new Map<string, any>([
            ['auth_sig', Buffer.from(authSig)],
            ['card_nonce', Buffer.from(cardNonce)],
          ])
        );
      }
      if (name === 'status') {
        const status = new Map<string, any>([
          ['proto', 1],
          ['ver', '1.0.3'],
          ['tapsigner', true],
          // An initialised card reports its current derivation path.
          ['path', [0x80000054, 0x80000000, 0x80000000]],
          ['num_backups', 3],
          ['pubkey', cardPub],
          ['card_nonce', Buffer.from(cardNonce)],
        ]);
        if (authDelay > 0) status.set('auth_delay', authDelay);
        return reply(status);
      }
      if (name === 'wait') {
        authDelay = Math.max(0, authDelay - 1);
        return reply(new Map<string, any>([['success', true], ['auth_delay', authDelay]]));
      }
      if (authDelay > 0) throw Object.assign(new Error('rate limited'), { code: 429 });
      if (name === 'derive') {
        checkAuth('derive', cmd);
        const path: number[] = cmd.get('path');
        currentPath = `m/${path.map((p) => `${p - 0x80000000}'`).join('/')}`;
        return reply(
          new Map<string, any>([
            ['master_pubkey', Buffer.from(root.publicKey)],
            ['chain_code', Buffer.from(root.chainCode)],
            ['card_nonce', Buffer.from(cardNonce)],
          ])
        );
      }
      if (name === 'sign') {
        const session = checkAuth('sign', cmd);
        const subpath: number[] = cmd.get('subpath') ?? [];
        const node = root.derivePath(currentPath).derive(subpath[0]).derive(subpath[1]);
        // The protocol masks the digest with the session key in transit.
        const digest = xorBytes(cmd.get('digest'), session);
        const sig = ecc.sign(Uint8Array.from(digest), node.privateKey!);
        return reply(
          new Map<string, any>([
            ['sig', Buffer.from(sig)],
            ['pubkey', Buffer.from(node.publicKey)],
            ['card_nonce', Buffer.from(cardNonce)],
          ])
        );
      }
      if (name === 'xpub') {
        checkAuth('xpub', cmd);
        const xpub = root.derivePath(currentPath).neutered().toBase58();
        return reply(new Map<string, any>([['xpub', Buffer.from(bs58check.decode(xpub))]]));
      }
      throw Object.assign(new Error('unknown command'), { code: 404 });
    } catch (e: any) {
      return reply(new Map<string, any>([['error', e.message], ['code', e.code ?? 500]]));
    }
  };
  // Expose the stand-in factory root so the import flow can be told to trust it.
  return Object.assign(transceive, { trustedRoot: rootPub.toString('hex') });
}

/** The set of roots that makes this fake card's certificate chain verify. */
function rootsFor(transceive: { trustedRoot: string }): Set<string> {
  return new Set([transceive.trustedRoot]);
}

describe('TAPSIGNER import flow against a simulated card', () => {
  it('imports the BIP48 multisig key with the right fingerprint and path', async () => {
    const transceive = makeFakeCard(MNEMONICS[0], { cvc: '123456' });
    const key = await tapsignerFetchKey(transceive, '123456', bip48Path('mainnet'), rootsFor(transceive));
    assert.equal(key.path, bip48Path('mainnet'));
    assert.equal(key.fingerprint, '73c5da0a');
    assert.equal(key.xpub, accountXpub(MNEMONICS[0], 'mainnet'));
    assert.equal(normaliseXpub(key.xpub).network, 'mainnet');
  });

  it('waits out an auth_delay before authenticating', async () => {
    const transceive = makeFakeCard(MNEMONICS[1], { cvc: '654321', authDelay: 3 });
    const key = await tapsignerFetchKey(transceive, '654321', bip48Path('mainnet'), rootsFor(transceive));
    assert.equal(key.xpub, accountXpub(MNEMONICS[1], 'mainnet'));
  });

  it('rejects a wrong PIN with a friendly message', async () => {
    const transceive = makeFakeCard(MNEMONICS[0], { cvc: '123456' });
    await assert.rejects(
      () => tapsignerFetchKey(transceive, '999999', bip48Path('mainnet'), rootsFor(transceive)),
      /Incorrect PIN/i
    );
  });

  it('explains that a factory-fresh card must be set up first', async () => {
    const base = makeFakeCard(MNEMONICS[0], { cvc: '123456' });
    // Same card, but status omits `path` — i.e. no key created yet.
    const uninitialised = async (apdu: Uint8Array) => {
      const raw = Buffer.from(await base(apdu));
      if (apdu[1] === 0xa4) return Uint8Array.from(raw);
      const body = decodeCbor(raw.subarray(0, raw.length - 2));
      if (body instanceof Map && body.get('tapsigner')) {
        body.delete('path');
        return Uint8Array.from(Buffer.concat([encodeCbor(body), Buffer.from([0x90, 0x00])]));
      }
      return Uint8Array.from(raw);
    };
    await assert.rejects(() => tapsignerFetchKey(uninitialised, '123456'), /not been set up/i);
  });

  it('reports which command failed and maps documented error codes', async () => {
    // Card that rejects `derive` with 405 (wrong state).
    const base = makeFakeCard(MNEMONICS[0], { cvc: '123456' });
    const refuses = async (apdu: Uint8Array) => {
      if (apdu[1] !== 0xa4) {
        const cmd = decodeCbor(Buffer.from(apdu.subarray(5))) as Map<string, any>;
        if (cmd.get('cmd') === 'derive') {
          const err = encodeCbor(new Map<string, any>([['error', 'not ready'], ['code', 405]]));
          return Uint8Array.from(Buffer.concat([err, Buffer.from([0x90, 0x00])]));
        }
      }
      return base(apdu);
    };
    await assert.rejects(
      () => tapsignerFetchKey(refuses, '123456', bip48Path('mainnet'), rootsFor(base)),
      /derive.*not ready|not ready.*derive/is
    );
  });
});

describe('TAPSIGNER signing', () => {
  const path = bip48Path('mainnet');
  const digest = Buffer.from(sha256(Buffer.from('a transaction to sign')));

  /** The key the wallet expects for a given card and subpath. */
  function expectedPubkey(mnemonic: string, subpath: [number, number]): Buffer {
    const node = rootFromMnemonic(mnemonic, 'mainnet')
      .derivePath(path)
      .derive(subpath[0])
      .derive(subpath[1]);
    return Buffer.from(node.publicKey);
  }

  it('signs with the key the wallet asked for', async () => {
    const transceive = makeFakeCard(MNEMONICS[0], { cvc: '123456' });
    const pubkey = expectedPubkey(MNEMONICS[0], [0, 4]);
    const [result] = await tapsignerSign(
      transceive,
      '123456',
      [{ digest, subpath: [0, 4], pubkey }],
      path,
      masterFingerprint(MNEMONICS[0])
    );
    assert.equal(result.signature.length, 64);
    assert.ok(result.pubkey.equals(pubkey));
    assert.ok(ecc.verify(digest, result.pubkey, result.signature));
  });

  it('refuses a card holding a different key', async () => {
    // Right PIN, wrong card: caught before any signature is produced.
    const transceive = makeFakeCard(MNEMONICS[1], { cvc: '123456' });
    await assert.rejects(
      () =>
        tapsignerSign(
          transceive,
          '123456',
          [{ digest, subpath: [0, 4], pubkey: expectedPubkey(MNEMONICS[0], [0, 4]) }],
          path,
          masterFingerprint(MNEMONICS[0])
        ),
      /different card/i
    );
  });

  it('refuses a signature made with an unexpected key', async () => {
    // Same card, but the wallet expects the key from another subpath — what a
    // derivation-path mismatch looks like from here.
    const transceive = makeFakeCard(MNEMONICS[0], { cvc: '123456' });
    await assert.rejects(
      () =>
        tapsignerSign(
          transceive,
          '123456',
          [{ digest, subpath: [0, 4], pubkey: expectedPubkey(MNEMONICS[0], [1, 9]) }],
          path
        ),
      /different key/i
    );
  });

  it('names the command that was in flight when the card dropped out', async () => {
    const card = makeFakeCard(MNEMONICS[0], { cvc: '123456' });
    const flaky = async (apdu: Uint8Array) => {
      // Applet select is not a CBOR command, so pass it straight through.
      if (apdu[1] === 0xa4) return card(apdu);
      const cmd = decodeCbor(Buffer.from(apdu).subarray(5));
      if (cmd instanceof Map && cmd.get('cmd') === 'sign') throw new Error('Tag was lost');
      return card(apdu);
    };
    await assert.rejects(
      () => tapsignerSign(flaky, '123456', [{ digest, subpath: [0, 4] }], path),
      /Tag was lost.*interrupted during "sign"/
    );
  });

  it('signs without an expected key, for callers that cannot supply one', async () => {
    const transceive = makeFakeCard(MNEMONICS[0], { cvc: '123456' });
    const [result] = await tapsignerSign(transceive, '123456', [{ digest, subpath: [0, 4] }], path);
    assert.ok(ecc.verify(digest, result.pubkey, result.signature));
  });
});

describe('card certificate verification', () => {
  function scenario() {
    const cardPriv = Buffer.from(sha256(Buffer.from('cert card')));
    const cardPub = Buffer.from(ecc.pointFromScalar(cardPriv, true)!);
    const batchPriv = Buffer.from(sha256(Buffer.from('cert batch')));
    const batchPub = Buffer.from(ecc.pointFromScalar(batchPriv, true)!);
    const rootPriv = Buffer.from(sha256(Buffer.from('cert root')));
    const rootPub = Buffer.from(ecc.pointFromScalar(rootPriv, true)!);
    const certChain = [certSig(cardPub, batchPriv), certSig(batchPub, rootPriv)];
    const cardNonce = Buffer.from(sha256(Buffer.from('cn'))).subarray(0, 16) as Buffer;
    const userNonce = Buffer.from(sha256(Buffer.from('un'))).subarray(0, 16) as Buffer;
    const msg = Buffer.concat([Buffer.from('OPENDIME', 'ascii'), cardNonce, userNonce]);
    const authSig = Buffer.from(ecc.sign(Buffer.from(sha256(msg)), cardPriv));
    const roots = new Set([rootPub.toString('hex')]);
    return { cardPub, certChain, cardNonce, userNonce, authSig, roots, batchPub };
  }

  it('accepts a card whose chain leads to a trusted root', () => {
    const s = scenario();
    verifyCardCertificate({
      cardPubkey: s.cardPub,
      cardNonce: s.cardNonce,
      userNonce: s.userNonce,
      authSig: s.authSig,
      certChain: s.certChain,
      roots: s.roots,
    });
  });

  it('rejects a chain that does not reach a trusted root (counterfeit)', () => {
    const s = scenario();
    // Default (production) roots do not include our test root.
    assert.throws(
      () =>
        verifyCardCertificate({
          cardPubkey: s.cardPub,
          cardNonce: s.cardNonce,
          userNonce: s.userNonce,
          authSig: s.authSig,
          certChain: s.certChain,
        }),
      /not certified by Coinkite/i
    );
  });

  it('rejects a card that cannot prove it owns its key', () => {
    const s = scenario();
    const tampered = Buffer.from(s.authSig);
    tampered[10] ^= 0xff;
    assert.throws(
      () =>
        verifyCardCertificate({
          cardPubkey: s.cardPub,
          cardNonce: s.cardNonce,
          userNonce: s.userNonce,
          authSig: tampered,
          certChain: s.certChain,
          roots: s.roots,
        }),
      /could not prove it owns its key/i
    );
  });

  it('rejects a substituted card key kept under a real-looking chain', () => {
    // Attacker presents their own card key but the chain still certifies the
    // genuine key — recovery then walks to the wrong (untrusted) root.
    const s = scenario();
    const attackerPriv = Buffer.from(sha256(Buffer.from('attacker card')));
    const attackerPub = Buffer.from(ecc.pointFromScalar(attackerPriv, true)!);
    const msg = Buffer.concat([Buffer.from('OPENDIME', 'ascii'), s.cardNonce, s.userNonce]);
    const attackerAuth = Buffer.from(ecc.sign(Buffer.from(sha256(msg)), attackerPriv));
    assert.throws(
      () =>
        verifyCardCertificate({
          cardPubkey: attackerPub,
          cardNonce: s.cardNonce,
          userNonce: s.userNonce,
          authSig: attackerAuth,
          certChain: s.certChain, // certifies the real card key, not the attacker's
          roots: s.roots,
        }),
      /not certified by Coinkite/i
    );
  });

  it('rejects a truncated certificate chain', () => {
    const s = scenario();
    assert.throws(
      () =>
        verifyCardCertificate({
          cardPubkey: s.cardPub,
          cardNonce: s.cardNonce,
          userNonce: s.userNonce,
          authSig: s.authSig,
          certChain: [s.certChain[0]],
          roots: s.roots,
        }),
      /certificate chain/i
    );
  });

  it('trusts the production factory root but not the emulator test root', () => {
    assert.ok(
      FACTORY_ROOT_KEYS.has('03028a0e89e70d0ec0d932053a89ab1da7d9182bdc6d2f03e706ee99517d05d9e1')
    );
    assert.ok(
      !FACTORY_ROOT_KEYS.has('027722ef208e681bac05f1b4b3cc478d6bf353ac9a09ff0c843430138f65c27bab')
    );
  });
});

describe('NFC error translation', () => {
  it('turns the library\'s empty typed errors into readable text', () => {
    class TagConnectionLost extends Error {}
    class UserCancel extends Error {}
    class RadioDisabled extends Error {}
    // These are thrown with no message at all — the original blank alert.
    assert.match(describeNfcError(new TagConnectionLost()), /Lost contact/i);
    assert.match(describeNfcError(new UserCancel()), /cancelled/i);
    assert.match(describeNfcError(new RadioDisabled()), /NFC is switched off/i);
  });

  it('falls back sensibly for strings and unknown errors', () => {
    assert.match(describeNfcError('Tag was lost'), /Lost contact/i);
    assert.match(describeNfcError(new Error('boom')), /boom/);
    assert.match(describeNfcError({}), /unknown reason|NFC error/i);
  });
});
