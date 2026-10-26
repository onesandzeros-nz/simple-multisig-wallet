import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { configFileName, walletConfigFile } from '../src/lib/bitcoin';
import { groupBackupFor } from '../src/lib/groupBackup';
import { generateSecretKey } from '../src/lib/nostr/crypto';
import { normaliseXpub } from '../src/lib/slip132';
import { Group, MultisigWallet, SignerKey } from '../src/lib/types';
import { walletBackupFile } from '../src/lib/walletExport';
import { makeWallet, MNEMONICS } from './helpers';

/**
 * Do Sparrow and Nunchuk still read our backup file? Neither can run here, so
 * these are line-for-line ports of the two parsers the file goes through, kept
 * deliberately literal — same splitting, same regexes, same failure points:
 *
 *  - Sparrow: com.sparrowwallet.sparrow.io.ColdcardMultisig#importWallet
 *    (sparrowwallet/sparrow master, read 2026-10-26)
 *  - Nunchuk: ParseConfig in src/utils/multisigconfig.hpp
 *    (nunchuk-io/libnunchuk main, read 2026-10-26)
 *
 * If either upstream changes, update the port here rather than the file.
 */

// ---------------------------------------------------------------------------
// Sparrow
// ---------------------------------------------------------------------------

/** Java's String.split(regex) with no limit drops trailing empty strings. */
function javaSplit(s: string, sep: string): string[] {
  const parts = s.split(sep);
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** com.sparrowwallet.drongo.protocol.ScriptType names valueOf accepts. */
const SPARROW_SCRIPT_TYPES = new Set(['P2PK', 'P2PKH', 'MULTISIG', 'P2SH', 'P2SH_P2WPKH', 'P2SH_P2WSH', 'P2WPKH', 'P2WSH', 'P2TR']);

interface SparrowKeystore {
  fingerprint: string;
  derivation: string;
  xpub: string;
}

interface SparrowWallet {
  name?: string;
  threshold: number;
  scriptType: string;
  keystores: SparrowKeystore[];
}

function sparrowColdcardImport(text: string): SparrowWallet {
  let name: string | undefined;
  let threshold = 0;
  let cosigners = 0;
  let scriptType = 'P2SH';
  let derivation: string | null = null;
  const keystores: SparrowKeystore[] = [];

  // Guava CharStreams.readLines: \n, \r and \r\n all end a line.
  for (let line of text.split(/\r\n|\r|\n/)) {
    line = line.trim();
    if (line.length === 0) continue;
    const keyValue = javaSplit(line, ':');
    if (keyValue.length !== 2) continue;
    const key = keyValue[0].trim();
    const value = keyValue[1].trim();
    switch (key) {
      case 'Name':
        name = value.trim();
        break;
      case 'Policy': {
        const policy = value.split(/\s+/);
        if (policy.length !== 3) throw new Error(`Could not determine the multisig policy from "${line}"`);
        threshold = parseInt(policy[0], 10);
        cosigners = parseInt(policy[2], 10);
        if (Number.isNaN(threshold) || Number.isNaN(cosigners)) throw new Error('NumberFormatException');
        break;
      }
      case 'Derivation':
      case '# derivation':
        derivation = value;
        break;
      case 'Format': {
        const named = value.replace('P2WSH-P2SH', 'P2SH_P2WSH');
        if (!SPARROW_SCRIPT_TYPES.has(named)) throw new Error(`No enum constant ScriptType.${named}`);
        scriptType = named;
        break;
      }
      default:
        if (key.length === 8 && /^[0-9a-fA-F]+$/.test(key)) {
          // new KeyDerivation(key, derivation, true): a null path cannot be parsed.
          if (derivation === null) throw new Error('NullPointerException: derivation');
          if (!/^m(\/\d+['hH]?)*$/.test(derivation)) throw new Error(`Invalid derivation ${derivation}`);
          // ExtendedKey.fromDescriptor(value): any SLIP-132 flavoured extended public key.
          normaliseXpub(value);
          keystores.push({ fingerprint: key, derivation, xpub: value });
        }
    }
  }

  if (threshold === 0) throw new Error('This file does not specify the multisig policy');
  if (cosigners !== keystores.length) {
    throw new Error(`This file specifies a policy of ${threshold} of ${cosigners}, but contains ${keystores.length} cosigner keys`);
  }
  // wallet.checkWallet(): a usable threshold over distinct keystores.
  if (threshold > keystores.length) throw new Error('Invalid wallet: threshold above keystores');
  if (new Set(keystores.map((k) => k.xpub)).size !== keystores.length) throw new Error('Invalid wallet: duplicate keystore');
  return { name, threshold, scriptType, keystores };
}

// ---------------------------------------------------------------------------
// Nunchuk
// ---------------------------------------------------------------------------

// The regexes as declared, used with std::regex_match: whole-line matches.
const NAME_REGEX = /^Name:(.+)$/;
const POLICY_REGEX = /^Policy: ([0-9]{1,2})(.+?)([0-9]{1,2})$/;
const FORMAT_REGEX = /^Format:(.+)$/;
const DERIVATION_REGEX = /^Derivation:(.+)$/;
const XFP_REGEX = /^([0-9a-fA-F]{8}):(.+)$/;

/** AddressTypeToConfigStr's inverse, as GetAddressTypeFromStr accepts it. */
const NUNCHUK_FORMATS: Record<string, string> = {
  P2SH: 'LEGACY',
  'P2WSH-P2SH': 'NESTED_SEGWIT',
  P2WSH: 'NATIVE_SEGWIT',
  P2TR: 'TAPROOT',
};

interface NunchukSigner {
  name: string;
  xpub: string;
  derivation: string;
  xfp: string;
}

interface NunchukWallet {
  name: string;
  addressType: string;
  walletType: 'MULTI_SIG' | 'SINGLE_SIG';
  m: number;
  n: number;
  signers: NunchukSigner[];
}

function nunchukParseConfig(chain: 'MAIN' | 'TESTNET', content: string): NunchukWallet {
  let name = '';
  let a = 'LEGACY';
  let w: NunchukWallet['walletType'] = 'MULTI_SIG';
  let m = 0;
  let n = 0;
  let derivation = '';
  const signers: NunchukSigner[] = [];

  // safeGetline: \n, \r\n and \r all end a line.
  for (const line of content.split(/\r\n|\r|\n/)) {
    if (line.startsWith('#')) continue;
    let sm: RegExpMatchArray | null;
    if ((sm = line.match(NAME_REGEX))) {
      name = sm[1].trim();
    } else if ((sm = line.match(POLICY_REGEX))) {
      m = parseInt(sm[1], 10);
      n = parseInt(sm[3], 10);
    } else if ((sm = line.match(FORMAT_REGEX))) {
      const format = sm[1].trim();
      if (!(format in NUNCHUK_FORMATS)) throw new Error('Invalid address type');
      a = NUNCHUK_FORMATS[format];
    } else if ((sm = line.match(DERIVATION_REGEX))) {
      derivation = sm[1].trim();
      if (!/^m(\/\d+['h]?)+$/.test(derivation)) throw new Error('Invalid derivation path');
    } else if ((sm = line.match(XFP_REGEX))) {
      if (derivation === '') throw new Error('Invalid derivation path');
      const xfp = sm[1];
      // SanitizeBIP32Input re-encodes any SLIP-132 prefix as xpub/tpub; IsValidXPub checks it.
      const sane = normaliseXpub(sm[2].trim());
      if (sane.network !== (chain === 'MAIN' ? 'mainnet' : 'testnet')) throw new Error('Invalid xpub');
      signers.push({ name: `ImportedKey-${derivation}`, xpub: sane.xpub, derivation, xfp });
    }
  }
  if (n <= 0) n = signers.length;
  if (m <= 0) m = n;
  if (name === '') name = `ImportedWallet-${m}of${n}`;
  if (n <= 0 || m <= 0 || m > n || n !== signers.length) throw new Error('Invalid parameters n, m');
  if (n === 1) w = 'SINGLE_SIG';
  return { name, addressType: a, walletType: w, m, n, signers };
}

// ---------------------------------------------------------------------------
// The files we write
// ---------------------------------------------------------------------------

function expectSame(wallet: MultisigWallet, file: string) {
  const chain = wallet.network === 'mainnet' ? 'MAIN' : 'TESTNET';
  const expectedName = configFileName(wallet.name).trim();

  const sparrow = sparrowColdcardImport(file);
  assert.equal(sparrow.threshold, wallet.m);
  assert.equal(sparrow.scriptType, 'P2WSH');
  assert.equal(sparrow.keystores.length, wallet.n);
  for (const [i, k] of sparrow.keystores.entries()) {
    assert.equal(k.fingerprint.toLowerCase(), wallet.cosigners[i].fingerprint);
    assert.equal(k.derivation, wallet.cosigners[i].path);
    assert.equal(k.xpub, wallet.cosigners[i].xpub);
  }

  const nunchuk = nunchukParseConfig(chain, file);
  assert.equal(nunchuk.m, wallet.m);
  assert.equal(nunchuk.n, wallet.n);
  assert.equal(nunchuk.addressType, 'NATIVE_SEGWIT');
  assert.equal(nunchuk.walletType, 'MULTI_SIG');
  for (const [i, s] of nunchuk.signers.entries()) {
    assert.equal(s.xfp.toLowerCase(), wallet.cosigners[i].fingerprint);
    assert.equal(s.derivation, wallet.cosigners[i].path);
    assert.equal(s.xpub, wallet.cosigners[i].xpub);
  }
  return { sparrow, nunchuk, expectedName };
}

describe('interoperability — the backup file in Sparrow and Nunchuk', () => {
  const wallet = makeWallet(2, MNEMONICS.slice(0, 3), 'mainnet', 'Family Savings');

  it('the oracles read the formats they were ported from', () => {
    // Sparrow's own export, as ColdcardMultisig#exportWallet writes it.
    const sparrowFile = [
      '# Coldcard Multisig setup file (created by Sparrow)',
      '#',
      'Name: Family Savings',
      'Policy: 2 of 3',
      `Derivation: ${wallet.cosigners[0].path}`,
      'Format: P2WSH',
      '',
      ...wallet.cosigners.map((c) => `${c.fingerprint.toUpperCase()}: ${c.xpub}`),
    ].join('\n');
    assert.equal(sparrowColdcardImport(sparrowFile).keystores.length, 3);
    // Nunchuk's own export, as GetMultisigConfig writes it.
    const nunchukFile = [
      '# Exported from Nunchuk',
      'Name: Family Savings',
      'Policy: 2 of 3',
      'Format: P2WSH',
      '',
      ...wallet.cosigners.flatMap((c) => [`Derivation: ${c.path}`, `${c.fingerprint}: ${c.xpub}`, '']),
    ].join('\n');
    assert.equal(nunchukParseConfig('MAIN', nunchukFile).signers.length, 3);
    // And they fail where the originals fail.
    assert.throws(() => sparrowColdcardImport('Name: x\nFormat: P2WSH'), /does not specify the multisig policy/);
    assert.throws(() => sparrowColdcardImport('Policy: 2 of 3\nFormat: P2WSH'), /contains 0 cosigner/);
    assert.throws(() => nunchukParseConfig('MAIN', `Policy: 2 of 3\n${wallet.cosigners[0].fingerprint}: ${wallet.cosigners[0].xpub}`), /derivation/);
    assert.throws(() => nunchukParseConfig('MAIN', 'Policy: 2 of 3\nFormat: P2WSH'), /Invalid parameters/);
  });

  it('reads a plain backup file as the same wallet', () => {
    const { sparrow, nunchuk, expectedName } = expectSame(wallet, walletBackupFile(wallet));
    assert.equal(sparrow.name, expectedName);
    assert.equal(nunchuk.name, expectedName);
  });

  it('reads the bare config file too (the NFC and share-sheet form)', () => {
    expectSame(wallet, walletConfigFile(wallet));
  });

  it('skips the descriptor and group comment lines', () => {
    const keys: SignerKey[] = [
      { id: 'key-0', name: 'Phone', type: 'local', fingerprint: wallet.cosigners[0].fingerprint, createdAt: 0 },
    ];
    const group: Group = {
      id: 'g1',
      name: 'Family',
      relays: ['wss://relay.example', 'wss://second.example'],
      identityKeyId: 'key-0',
      coordinatorPubkey: 'ab'.repeat(32),
      m: 2,
      n: 3,
      network: 'mainnet',
      rekey: true,
      contributedKeyIds: ['key-0'],
      coordinator: true,
      walletId: wallet.id,
      createdAt: 0,
    };
    const backup = groupBackupFor(group, generateSecretKey(), keys);
    assert.ok(backup);
    const file = walletBackupFile(wallet, backup);
    assert.match(file, /^# Group invite: multisig:join\?/m, 'the line is there to skip');
    const { sparrow } = expectSame(wallet, file);
    // The invite line has more than one colon, so Sparrow never sees it as a
    // key/value pair; the descriptor line's key is "# Descriptor", which is
    // neither a field name nor a fingerprint.
    assert.equal(sparrow.keystores.length, 3);
  });

  for (const [m, n] of [
    [1, 2],
    [2, 2],
    [3, 5],
  ] as const) {
    it(`reads a ${m}-of-${n} wallet`, () => {
      expectSame(makeWallet(m, MNEMONICS.slice(0, n), 'mainnet', `${m} of ${n}`), walletBackupFile(makeWallet(m, MNEMONICS.slice(0, n), 'mainnet', `${m} of ${n}`)));
    });
  }

  it('reads a testnet wallet on the testnet chain', () => {
    const t = makeWallet(2, MNEMONICS.slice(0, 3), 'testnet', 'Test');
    expectSame(t, walletBackupFile(t));
    // A testnet file on Nunchuk's mainnet chain is refused, as it should be.
    assert.throws(() => nunchukParseConfig('MAIN', walletBackupFile(t)), /Invalid xpub/);
  });

  it('survives awkward wallet names', () => {
    const names = [
      'Savings: house deposit',       // a colon: fine in the header comment, dropped from the Name line
      'derivation: m/1',              // Sparrow treats "# derivation" as a field
      'Policy: 1 of 1',               // looks like a field, but only in a comment
      'A very long wallet name indeed, well past twenty characters',
      'Épargne — famille 🔥',          // non-ASCII is dropped from the Name line
      '🔥🔥🔥',                       // nothing printable left: Nunchuk names it
    ];
    for (const name of names) {
      const w = makeWallet(2, MNEMONICS.slice(0, 3), 'mainnet', name);
      const { sparrow, nunchuk, expectedName } = expectSame(w, walletBackupFile(w));
      assert.equal(sparrow.name, expectedName || undefined, name);
      assert.equal(nunchuk.name, expectedName || 'ImportedWallet-2of3', name);
    }
  });

  it('survives Windows line endings', () => {
    const file = walletBackupFile(wallet).replace(/\n/g, '\r\n');
    expectSame(wallet, file);
  });
});
