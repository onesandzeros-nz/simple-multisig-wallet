import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountXpub,
  bip48Path,
  generateMnemonic,
  keyExpression,
  masterFingerprint,
  mnemonicFromDiceRolls,
  rootFromMnemonic,
  validateMnemonic,
} from '../src/lib/bitcoin';
import { normaliseXpub, parseKeyExpression } from '../src/lib/slip132';
import { parseKeyImportText } from '../src/lib/keyImport';
import { isFingerprint } from '../src/lib/slip132';
import { MNEMONICS, withVersionBytes } from './helpers';

const ABANDON = MNEMONICS[0];
const abandonXpub = accountXpub(ABANDON, 'mainnet');
const abandonTpub = accountXpub(ABANDON, 'testnet');

describe('local key creation', () => {
  it('generates a valid 12-word mnemonic', () => {
    const m = generateMnemonic();
    assert.equal(m.split(' ').length, 12);
    assert.ok(validateMnemonic(m));
  });

  it('generates distinct mnemonics', () => {
    const seen = new Set(Array.from({ length: 10 }, () => generateMnemonic()));
    assert.equal(seen.size, 10);
  });

  it('normalises case and whitespace when validating', () => {
    assert.ok(validateMnemonic(`  ${ABANDON.toUpperCase().replace(/ /g, '   ')}  `));
    assert.ok(!validateMnemonic('abandon abandon abandon'));
  });

  it('derives deterministic 12-word mnemonics from dice rolls', () => {
    const fifty = '123456'.repeat(9).slice(0, 50);
    const m1 = mnemonicFromDiceRolls(fifty);
    assert.equal(m1.split(' ').length, 12);
    assert.ok(validateMnemonic(m1));
    assert.equal(mnemonicFromDiceRolls(fifty), m1); // deterministic
    assert.notEqual(mnemonicFromDiceRolls('654321'.repeat(10)), m1); // different rolls, different key
  });

  it('rejects too few or invalid dice rolls', () => {
    assert.throws(() => mnemonicFromDiceRolls('123456'), /at least 50/i);
    assert.throws(() => mnemonicFromDiceRolls('17'.repeat(30)), /1–6/);
    assert.throws(() => mnemonicFromDiceRolls(''), /1–6/);
  });

  it('derives the known fingerprint for the BIP39 test vector', () => {
    assert.equal(masterFingerprint(ABANDON), '73c5da0a');
  });

  it('fingerprint is network independent', () => {
    for (const m of MNEMONICS) {
      assert.equal(
        masterFingerprint(m),
        Buffer.from(rootFromMnemonic(m, 'testnet').fingerprint).toString('hex')
      );
    }
  });

  it('derives deterministic BIP48 account xpubs per network', () => {
    assert.equal(accountXpub(ABANDON, 'mainnet'), abandonXpub);
    assert.ok(abandonXpub.startsWith('xpub'));
    assert.ok(abandonTpub.startsWith('tpub'));
    assert.notEqual(abandonXpub, abandonTpub);
    assert.equal(bip48Path('mainnet'), "m/48'/0'/0'/2'");
    assert.equal(bip48Path('testnet'), "m/48'/1'/0'/2'");
  });
});

describe('imported key normalisation (SLIP-132)', () => {
  const mainnetPrefixes: [string, string][] = [
    ['xpub', '0488b21e'],
    ['ypub', '049d7cb2'],
    ['zpub', '04b24746'],
    ['Ypub', '0295b43f'],
    ['Zpub', '02aa7ed3'],
  ];
  const testnetPrefixes: [string, string][] = [
    ['tpub', '043587cf'],
    ['upub', '044a5262'],
    ['vpub', '045f1cf6'],
    ['Upub', '024289ef'],
    ['Vpub', '02575483'],
  ];

  for (const [label, version] of mainnetPrefixes) {
    it(`accepts ${label} and normalises to xpub (mainnet)`, () => {
      const encoded = withVersionBytes(abandonXpub, version);
      assert.ok(encoded.startsWith(label));
      const result = normaliseXpub(encoded);
      assert.equal(result.network, 'mainnet');
      assert.equal(result.xpub, abandonXpub);
    });
  }

  for (const [label, version] of testnetPrefixes) {
    it(`accepts ${label} and normalises to tpub (testnet)`, () => {
      const encoded = withVersionBytes(abandonTpub, version);
      assert.ok(encoded.startsWith(label));
      const result = normaliseXpub(encoded);
      assert.equal(result.network, 'testnet');
      assert.equal(result.xpub, abandonTpub);
    });
  }

  it('rejects extended private keys', () => {
    const xprv = rootFromMnemonic(ABANDON, 'mainnet').derivePath(bip48Path('mainnet')).toBase58();
    assert.ok(xprv.startsWith('xprv'));
    assert.throws(() => normaliseXpub(xprv), /private/i);
  });

  it('rejects garbage, tampering and wrong lengths', () => {
    assert.throws(() => normaliseXpub('not a key'));
    assert.throws(() => normaliseXpub(abandonXpub.slice(0, -1) + (abandonXpub.endsWith('a') ? 'b' : 'a')));
    assert.throws(() => normaliseXpub(''));
  });
});

describe('descriptor key expressions', () => {
  it('parses [fingerprint/path]xpub with apostrophe hardened markers', () => {
    const parsed = parseKeyExpression(`[73C5DA0A/48'/0'/0'/2']${abandonXpub}`);
    assert.equal(parsed.xpub, abandonXpub);
    assert.equal(parsed.fingerprint, '73c5da0a');
    assert.equal(parsed.path, "m/48'/0'/0'/2'");
  });

  it('parses h and H hardened markers', () => {
    for (const marker of ['h', 'H']) {
      const parsed = parseKeyExpression(`[deadbeef/48${marker}/0${marker}/0${marker}/2${marker}]${abandonXpub}`);
      assert.equal(parsed.path, "m/48'/0'/0'/2'");
    }
  });

  it('accepts trailing child paths and wildcards', () => {
    for (const suffix of ['/*', '/0/*', '/1/*', '/<0;1>/*']) {
      const parsed = parseKeyExpression(`[deadbeef/48'/0'/0'/2']${abandonXpub}${suffix}`);
      assert.equal(parsed.xpub, abandonXpub);
    }
  });

  it('accepts SLIP-132 keys inside expressions', () => {
    const zpub = withVersionBytes(abandonXpub, '02aa7ed3');
    const parsed = parseKeyExpression(`[deadbeef/48'/0'/0'/2']${zpub}/0/*`);
    assert.equal(parsed.xpub, abandonXpub);
    assert.equal(parsed.network, 'mainnet');
  });

  it('bare xpub parses with no origin info', () => {
    const parsed = parseKeyExpression(abandonXpub);
    assert.equal(parsed.xpub, abandonXpub);
    assert.equal(parsed.fingerprint, undefined);
    assert.equal(parsed.path, undefined);
  });

  it('shared keys use the Sparrow key-expression format and round-trip', () => {
    const shared = keyExpression({
      fingerprint: '73C5DA0A',
      path: bip48Path('mainnet'),
      xpub: abandonXpub,
    });
    assert.equal(shared, `[73c5da0a/48h/0h/0h/2h]${abandonXpub}`);
    const parsed = parseKeyExpression(shared);
    assert.equal(parsed.xpub, abandonXpub);
    assert.equal(parsed.fingerprint, '73c5da0a');
    assert.equal(parsed.path, "m/48'/0'/0'/2'");
  });

  it('rejects malformed origins and impossible suffixes', () => {
    assert.throws(() => parseKeyExpression(`[73C5/48']${abandonXpub}`), /origin/i);
    assert.throws(() => parseKeyExpression(`[deadbeef/48']${abandonXpub}/0'/*`), /hardened/i);
    assert.throws(() => parseKeyExpression(`[deadbeef/48']${abandonXpub}/foo/*`), /child path/i);
    assert.throws(() => parseKeyExpression('[deadbeef/48\']'), /key found/i);
  });
});

describe('key file imports (JSON)', () => {
  const abandonZpub = withVersionBytes(abandonXpub, '02aa7ed3');

  it('parses a Coldcard generic wallet export (bip48_2 section)', () => {
    const file = JSON.stringify({
      chain: 'BTC',
      xfp: '73C5DA0A',
      xpub: 'xpub-master-ignored',
      bip48_2: { name: 'p2wsh', xfp: '11223344', deriv: "m/48'/0'/0'/2'", xpub: abandonXpub, _pub: abandonZpub },
    });
    const parsed = parseKeyImportText(file);
    assert.equal(parsed.xpub, abandonXpub);
    assert.equal(parsed.fingerprint, '73c5da0a'); // master xfp, not the section's
    assert.equal(parsed.path, "m/48'/0'/0'/2'");
    assert.equal(parsed.network, 'mainnet');
  });

  it('parses a Coldcard multisig xpub export', () => {
    const file = JSON.stringify({ xfp: '73C5DA0A', p2wsh_deriv: 'm/48h/0h/0h/2h', p2wsh: abandonZpub });
    const parsed = parseKeyImportText(file);
    assert.equal(parsed.xpub, abandonXpub);
    assert.equal(parsed.fingerprint, '73c5da0a');
    assert.equal(parsed.path, "m/48'/0'/0'/2'");
  });

  it('parses a simple {xpub, xfp, deriv} object', () => {
    const parsed = parseKeyImportText(
      JSON.stringify({ xpub: abandonXpub, xfp: '73C5DA0A', deriv: "m/48'/0'/0'/2'", label: 'My Coldcard' })
    );
    assert.equal(parsed.xpub, abandonXpub);
    assert.equal(parsed.name, 'My Coldcard');
  });

  it('still accepts plain key expressions through the same entry point', () => {
    const parsed = parseKeyImportText(`[73c5da0a/48h/0h/0h/2h]${abandonZpub}/0/*`);
    assert.equal(parsed.xpub, abandonXpub);
    assert.equal(parsed.fingerprint, '73c5da0a');
  });

  it('keeps a fingerprint only when it is one, under any of its names', () => {
    const file = (xfp: unknown, field = 'xfp') => JSON.stringify({ xpub: abandonXpub, [field]: xfp });
    assert.equal(parseKeyImportText(file('73C5DA0A')).fingerprint, '73c5da0a');
    assert.equal(parseKeyImportText(file('73c5da0a', 'fingerprint')).fingerprint, '73c5da0a');
    assert.equal(parseKeyImportText(file('73c5da0a', 'root_fingerprint')).fingerprint, '73c5da0a');
    assert.equal(parseKeyImportText(file(undefined)).fingerprint, undefined);
    const bad = ['73c5da0', '73c5da0a1', 'not hex!', '[73c5da0a]', ' 73c5da0a', 12345678, '', { xfp: '73c5da0a' }];
    for (const b of bad) {
      assert.equal(parseKeyImportText(file(b)).fingerprint, undefined, `dropped, not saved: ${JSON.stringify(b)}`);
    }
    // A Coldcard file whose master fingerprint is damaged does not fall back
    // to the section's — that is the derived node's, not the master's.
    const generic = JSON.stringify({
      xfp: 'oops',
      bip48_2: { xfp: '11223344', deriv: "m/48'/0'/0'/2'", _pub: abandonZpub },
    });
    assert.equal(parseKeyImportText(generic).fingerprint, undefined);
    const xpubExport = JSON.stringify({ xfp: 'oops', p2wsh_deriv: 'm/48h/0h/0h/2h', p2wsh: abandonZpub });
    assert.equal(parseKeyImportText(xpubExport).fingerprint, undefined);
    assert.equal(parseKeyImportText(xpubExport).xpub, abandonXpub, 'the key itself is still imported');
  });

  it('judges a fingerprint by one rule', () => {
    assert.equal(isFingerprint('73C5DA0A'), true);
    assert.equal(isFingerprint('73c5da0a'), true);
    assert.equal(isFingerprint('73c5da0'), false);
    assert.equal(isFingerprint('g3c5da0a'), false);
    assert.equal(isFingerprint(0x73c5da0a), false);
    assert.equal(isFingerprint(undefined), false);
  });

  it('rejects unusable files', () => {
    assert.throws(() => parseKeyImportText('{broken'), /valid JSON/i);
    assert.throws(() => parseKeyImportText('{"foo": 1}'), /unrecognised/i);
    assert.throws(() => parseKeyImportText('   '), /nothing to import/i);
  });
});
