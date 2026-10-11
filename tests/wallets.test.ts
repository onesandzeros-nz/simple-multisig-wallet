import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveAddress, walletConfigFile, walletDescriptor } from '../src/lib/bitcoin';
import { descriptorChecksum } from '../src/lib/descriptor';
import {
  parseWalletConfigFile,
  parseWalletDescriptor,
  parseWalletImportText,
  parseWalletJson,
  ParsedWallet,
} from '../src/lib/walletImport';
import { MultisigWallet } from '../src/lib/types';
import { exportBaseName, walletBackupFile } from '../src/lib/walletExport';
import { backupPdfHtml } from '../src/lib/walletExport';
import { MNEMONICS, makeWallet } from './helpers';
import { adoptAsGroupWallet, findSameWallet, sameWalletPolicy } from '../src/lib/walletMatch';
import {
  backupMissesGroup,
  groupBackupFor,
  groupFromBackupText,
  restoreMismatch,
} from '../src/lib/groupBackup';
import { generateSecretKey } from '../src/lib/nostr/crypto';
import { encodeInvite } from '../src/lib/nostr/protocol';
import { masterFingerprint } from '../src/lib/bitcoin';
import { Group, SignerKey } from '../src/lib/types';

function walletFromParsed(parsed: ParsedWallet): MultisigWallet {
  return {
    id: 'imported',
    kind: 'private',
    name: parsed.name ?? 'Imported wallet',
    m: parsed.m,
    n: parsed.n,
    network: parsed.network,
    scriptType: 'P2WSH',
    cosigners: parsed.cosigners,
    createdAt: 0,
  };
}

function firstAddresses(wallet: MultisigWallet): string[] {
  return [deriveAddress(wallet, 0, 0).address, deriveAddress(wallet, 0, 1).address, deriveAddress(wallet, 1, 0).address];
}

const CONFIGS: [number, number][] = [
  [2, 2],
  [2, 3],
  [3, 5],
  [1, 2],
];

describe('wallet creation', () => {
  for (const [m, n] of CONFIGS) {
    it(`creates a working ${m}-of-${n} mainnet wallet`, () => {
      const wallet = makeWallet(m, MNEMONICS.slice(0, n));
      assert.equal(wallet.cosigners.length, n);
      const addr = deriveAddress(wallet, 0, 0);
      assert.ok(addr.address.startsWith('bc1q'));
      assert.equal(addr.address.length, 62); // P2WSH bech32
      assert.equal(addr.derivations.length, n);
    });
  }

  it('creates a testnet wallet with tb1q addresses and tpub cosigners', () => {
    const wallet = makeWallet(2, MNEMONICS.slice(0, 3), 'testnet');
    assert.ok(deriveAddress(wallet, 0, 0).address.startsWith('tb1q'));
    for (const c of wallet.cosigners) {
      assert.ok(c.xpub.startsWith('tpub'));
      assert.equal(c.path, "m/48'/1'/0'/2'");
    }
  });

  it('derives identical addresses regardless of cosigner order (BIP67)', () => {
    const wallet = makeWallet(2, MNEMONICS.slice(0, 3));
    const reversed: MultisigWallet = { ...wallet, cosigners: [...wallet.cosigners].reverse() };
    assert.deepEqual(firstAddresses(wallet), firstAddresses(reversed));
  });

  it('receive and change branches produce distinct addresses', () => {
    const wallet = makeWallet(2, MNEMONICS.slice(0, 3));
    const seen = new Set<string>();
    for (const branch of [0, 1] as const) {
      for (let i = 0; i < 5; i++) seen.add(deriveAddress(wallet, branch, i).address);
    }
    assert.equal(seen.size, 10);
  });

  it('mainnet and testnet wallets from the same keys differ', () => {
    const main = makeWallet(2, MNEMONICS.slice(0, 2), 'mainnet');
    const test = makeWallet(2, MNEMONICS.slice(0, 2), 'testnet');
    assert.notEqual(deriveAddress(main, 0, 0).address, deriveAddress(test, 0, 0).address);
  });
});

describe('wallet export', () => {
  it('emits a wsh(sortedmulti()) descriptor with a valid checksum', () => {
    const wallet = makeWallet(2, MNEMONICS.slice(0, 3));
    const desc = walletDescriptor(wallet);
    const [body, checksum] = desc.split('#');
    assert.match(body, /^wsh\(sortedmulti\(2,/);
    assert.equal(descriptorChecksum(body), checksum);
  });

  it('emits a config file with the policy and every fingerprint', () => {
    const wallet = makeWallet(3, MNEMONICS.slice(0, 5));
    const config = walletConfigFile(wallet);
    assert.match(config, /Policy: 3 of 5/);
    assert.match(config, /Format: P2WSH/);
    for (const c of wallet.cosigners) {
      assert.ok(config.includes(c.fingerprint.toUpperCase()));
      assert.ok(config.includes(c.xpub));
    }
  });
});

describe('wallet import — descriptors', () => {
  for (const [m, n] of CONFIGS) {
    it(`round-trips a ${m}-of-${n} wallet through its descriptor`, () => {
      const original = makeWallet(m, MNEMONICS.slice(0, n));
      const parsed = parseWalletDescriptor(walletDescriptor(original));
      assert.equal(parsed.m, m);
      assert.equal(parsed.n, n);
      assert.equal(parsed.network, 'mainnet');
      assert.deepEqual(firstAddresses(walletFromParsed(parsed)), firstAddresses(original));
    });
  }

  it('round-trips a testnet wallet', () => {
    const original = makeWallet(2, MNEMONICS.slice(0, 3), 'testnet');
    const parsed = parseWalletDescriptor(walletDescriptor(original));
    assert.equal(parsed.network, 'testnet');
    assert.deepEqual(firstAddresses(walletFromParsed(parsed)), firstAddresses(original));
  });

  it('accepts single-branch descriptors and descriptors without checksum', () => {
    const original = makeWallet(2, MNEMONICS.slice(0, 3));
    const receiveOnly = walletDescriptor(original, 0);
    const parsed = parseWalletDescriptor(receiveOnly.split('#')[0]);
    assert.deepEqual(firstAddresses(walletFromParsed(parsed)), firstAddresses(original));
  });

  it('accepts externally-formatted descriptors with h markers', () => {
    const original = makeWallet(2, MNEMONICS.slice(0, 2));
    const body = walletDescriptor(original).split('#')[0];
    const parsed = parseWalletDescriptor(body); // already h-formatted by our exporter
    assert.equal(parsed.cosigners[0].path, "m/48'/0'/0'/2'");
  });

  it('rejects a corrupted checksum', () => {
    const desc = walletDescriptor(makeWallet(2, MNEMONICS.slice(0, 2)));
    const tampered = desc.slice(0, -1) + (desc.endsWith('q') ? 'p' : 'q');
    assert.throws(() => parseWalletDescriptor(tampered), /checksum/i);
  });

  it('rejects unsupported script types', () => {
    assert.throws(() => parseWalletDescriptor('wpkh(xpub123)'), /sortedmulti/);
    assert.throws(() => parseWalletDescriptor('sh(wsh(multi(2,a,b)))'), /sortedmulti/);
  });

  it('rejects impossible thresholds and duplicate keys', () => {
    const wallet = makeWallet(2, MNEMONICS.slice(0, 2));
    const body = walletDescriptor(wallet).split('#')[0];
    assert.throws(() => parseWalletDescriptor(body.replace('sortedmulti(2,', 'sortedmulti(5,')), /not possible/i);
    const dupe = makeWallet(2, [MNEMONICS[0], MNEMONICS[0]]);
    assert.throws(() => parseWalletDescriptor(walletDescriptor(dupe).split('#')[0]), /more than once/i);
  });
});

describe('wallet import — config files', () => {
  for (const [m, n] of CONFIGS) {
    it(`round-trips a ${m}-of-${n} wallet through its config file`, () => {
      const original = makeWallet(m, MNEMONICS.slice(0, n), 'mainnet', `Vault ${m}/${n}`);
      const parsed = parseWalletConfigFile(walletConfigFile(original));
      assert.equal(parsed.m, m);
      assert.equal(parsed.n, n);
      assert.equal(parsed.name, `Vault ${m}/${n}`);
      assert.deepEqual(firstAddresses(walletFromParsed(parsed)), firstAddresses(original));
    });
  }

  it('parses a hand-written Coldcard-style file with comments', () => {
    const w = makeWallet(2, MNEMONICS.slice(0, 2));
    const [a, b] = w.cosigners;
    const text = [
      '# Coldcard multisig setup file',
      'Name: Office vault',
      'Policy: 2 of 2',
      'Format: P2WSH',
      '',
      `Derivation: m/48'/0'/0'/2'`,
      `${a.fingerprint.toUpperCase()}: ${a.xpub}`,
      `${b.fingerprint.toUpperCase()}: ${b.xpub}`,
    ].join('\n');
    const parsed = parseWalletConfigFile(text);
    assert.equal(parsed.name, 'Office vault');
    assert.deepEqual(firstAddresses(walletFromParsed(parsed)), firstAddresses(w));
  });

  it('rejects non-P2WSH formats and missing policies', () => {
    const w = makeWallet(2, MNEMONICS.slice(0, 2));
    const config = walletConfigFile(w);
    assert.throws(() => parseWalletConfigFile(config.replace('Format: P2WSH', 'Format: P2SH')), /P2WSH/);
    assert.throws(() => parseWalletConfigFile(config.replace(/Policy.*\n/, '')), /Policy/);
  });

  it('parses Specter-style JSON with a descriptor and label', () => {
    const original = makeWallet(2, MNEMONICS.slice(0, 3));
    const json = JSON.stringify({ label: 'Vault from Specter', descriptor: walletDescriptor(original) });
    const parsed = parseWalletJson(json);
    assert.equal(parsed.name, 'Vault from Specter');
    assert.deepEqual(firstAddresses(walletFromParsed(parsed)), firstAddresses(original));
  });

  it('parses an Electrum multisig wallet file', () => {
    const original = makeWallet(2, MNEMONICS.slice(0, 3));
    const json = JSON.stringify({
      wallet_type: '2of3',
      'x1/': {
        xpub: original.cosigners[0].xpub,
        derivation: "m/48'/0'/0'/2'",
        root_fingerprint: original.cosigners[0].fingerprint,
      },
      'x2/': {
        xpub: original.cosigners[1].xpub,
        derivation: "m/48h/0h/0h/2h",
        root_fingerprint: original.cosigners[1].fingerprint.toUpperCase(),
      },
      'x3/': {
        xpub: original.cosigners[2].xpub,
        derivation: "m/48'/0'/0'/2'",
        root_fingerprint: original.cosigners[2].fingerprint,
      },
    });
    const parsed = parseWalletJson(json);
    assert.equal(parsed.m, 2);
    assert.equal(parsed.n, 3);
    assert.deepEqual(firstAddresses(walletFromParsed(parsed)), firstAddresses(original));
  });

  it('rejects unusable JSON', () => {
    assert.throws(() => parseWalletJson('not json'), /valid JSON/i);
    assert.throws(() => parseWalletJson('{"foo": 1}'), /unrecognised/i);
    assert.throws(() => parseWalletJson('{"wallet_type": "2of3"}'), /missing cosigner/i);
  });

  it('parseWalletImportText auto-detects every format', () => {
    const original = makeWallet(2, MNEMONICS.slice(0, 2));
    const viaDescriptor = parseWalletImportText(walletDescriptor(original));
    const viaConfig = parseWalletImportText(walletConfigFile(original));
    const viaJson = parseWalletImportText(JSON.stringify({ descriptor: walletDescriptor(original) }));
    for (const parsed of [viaDescriptor, viaConfig, viaJson]) {
      assert.deepEqual(firstAddresses(walletFromParsed(parsed)), firstAddresses(original));
    }
    assert.throws(() => parseWalletImportText('   '), /nothing to import/i);
  });

  it('rejects mixed-network cosigners', () => {
    const main = makeWallet(2, MNEMONICS.slice(0, 2), 'mainnet');
    const test = makeWallet(2, MNEMONICS.slice(0, 2), 'testnet');
    const text = [
      'Name: Broken',
      'Policy: 2 of 2',
      'Format: P2WSH',
      `Derivation: m/48'/0'/0'/2'`,
      `${main.cosigners[0].fingerprint.toUpperCase()}: ${main.cosigners[0].xpub}`,
      `${test.cosigners[1].fingerprint.toUpperCase()}: ${test.cosigners[1].xpub}`,
    ].join('\n');
    assert.throws(() => parseWalletConfigFile(text), /mainnet and testnet/i);
  });
});

describe('wallet backups', () => {
  const wallet = makeWallet(2, MNEMONICS.slice(0, 3), 'mainnet', 'Family Savings!');

  it('produces a file that imports straight back in', () => {
    const file = walletBackupFile(wallet);
    // The config half must survive a round trip through our own parser.
    const parsed = parseWalletImportText(file);
    assert.equal(parsed.m, 2);
    assert.equal(parsed.n, 3);
    assert.deepEqual(firstAddresses(walletFromParsed(parsed)), firstAddresses(wallet));
    // The descriptor is carried too, for readers that prefer it.
    assert.match(file, /# Descriptor: wsh\(sortedmulti\(2,/);
    assert.match(file, /Public keys only/);
  });

  it('names files safely from the wallet name', () => {
    assert.equal(exportBaseName(wallet), 'Family-Savings-2of3');
    assert.equal(exportBaseName({ ...wallet, name: '  ../etc/passwd  ' }), 'etcpasswd-2of3');
    assert.equal(exportBaseName({ ...wallet, name: '🔥🔥' }), 'multisig-2of3');
  });

  it('builds a printable backup carrying the descriptor and every cosigner', () => {
    const html = backupPdfHtml(
      wallet,
      { descriptor: '<svg id="d"/>', cosigners: wallet.cosigners.map((_, i) => `<svg id="c${i}"/>`) },
      '1 January 2026'
    );
    assert.match(html, /Family Savings!/);
    assert.match(html, /2 of 3 multisig/);
    assert.match(html, /<svg id="d"\/>/);
    for (const c of wallet.cosigners) {
      assert.ok(html.includes(c.xpub), 'every cosigner xpub must be printed');
      assert.ok(html.includes(c.fingerprint));
    }
    // The descriptor is printed as text, HTML-escaped — its multipath
    // component <0;1> must not be able to open a tag.
    assert.match(html, /wsh\(sortedmulti\(2,/, 'descriptor printed as text too');
    assert.match(html, /&lt;0;1&gt;/, 'multipath escaped rather than injected');
    assert.match(html, /cannot spend/i, 'must state it holds no secrets');
  });

  it('escapes wallet names so they cannot break the page', () => {
    const evil = makeWallet(2, MNEMONICS.slice(0, 2), 'mainnet', '<script>alert(1)</script>');
    const html = backupPdfHtml(evil, { descriptor: '', cosigners: ['', ''] }, 'now');
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.match(html, /&lt;script&gt;/);
  });
});

describe('group wallet dedupe', () => {
  const [a, b, c] = MNEMONICS;

  it('matches by network, policy and the set of xpubs, ignoring order and names', () => {
    const w = makeWallet(2, [a, b, c]);
    const shuffled = { ...makeWallet(2, [c, a, b], 'mainnet', 'Other name'), cosigners: makeWallet(2, [c, a, b]).cosigners.map((x) => ({ ...x, name: 'x', keyId: undefined })) };
    assert.ok(sameWalletPolicy(w, shuffled));
    assert.ok(!sameWalletPolicy(w, makeWallet(3, [a, b, c])), 'different quorum');
    assert.ok(!sameWalletPolicy(w, makeWallet(2, [a, b, MNEMONICS[3]])), 'different key');
    assert.ok(!sameWalletPolicy(w, makeWallet(2, [a, b, c], 'testnet')), 'different network');
    assert.ok(!sameWalletPolicy(w, makeWallet(2, [a, b])), 'different size');
  });

  it('finds the existing record for a freshly built group wallet', () => {
    const restored = { ...makeWallet(2, [a, b, c], 'mainnet', 'Family savings'), id: 'restored' };
    const unrelated = { ...makeWallet(2, [a, b, MNEMONICS[3]]), id: 'other' };
    const built = makeWallet(2, [b, c, a]);
    assert.equal(findSameWallet([unrelated, restored], built)?.id, 'restored');
    assert.equal(findSameWallet([unrelated], built), undefined);
  });

  it('turns the existing wallet into the group wallet, keeping its name and adding proven key links', () => {
    const restored: MultisigWallet = {
      ...makeWallet(2, [a, b, c], 'mainnet', 'Family savings'),
      id: 'restored',
      cosigners: makeWallet(2, [a, b, c]).cosigners.map((x, i) => ({
        ...x,
        name: `Backup signer ${i + 1}`,
        keyId: i === 0 ? 'my-key' : undefined,
      })),
    };
    // The group build proved we hold the second key; it knows nothing about the first.
    const built = {
      cosigners: makeWallet(2, [c, b, a]).cosigners.map((x, i) => ({
        ...x,
        name: `Member ${i + 1}`,
        keyId: i === 1 ? 'key-from-group' : undefined,
      })),
    };
    const patch = adoptAsGroupWallet(restored, built);
    assert.equal(patch.kind, 'group');
    assert.equal(patch.name, undefined, 'the user’s own wallet name is left alone');
    const cs = patch.cosigners!;
    assert.deepEqual(cs.map((x) => x.xpub), restored.cosigners.map((x) => x.xpub), 'cosigner order unchanged');
    assert.equal(cs[0].keyId, 'my-key', 'an existing link survives');
    assert.equal(cs[0].name, 'Backup signer 1');
    assert.equal(cs[1].keyId, 'key-from-group', 'a link proven by the group is taken');
    assert.equal(cs[1].name, 'Member 2', 'along with the name the group knows it by');
    assert.equal(cs[2].keyId, undefined);
    assert.equal(cs[2].name, 'Backup signer 3');
  });
});

describe('group backups', () => {
  const wallet = makeWallet(2, MNEMONICS.slice(0, 3), 'mainnet', 'Family');
  const secret = generateSecretKey();
  const keys: SignerKey[] = [
    { id: 'key-0', name: 'Phone', type: 'local', fingerprint: masterFingerprint(MNEMONICS[0]), createdAt: 0 },
  ];
  const group: Group = {
    id: 'g1',
    name: 'Family',
    relays: ['wss://relay.example'],
    identityKeyId: 'key-0',
    coordinatorPubkey: 'ab'.repeat(32),
    m: 2,
    n: 3,
    network: 'mainnet',
    rekey: true,
    currentEpoch: 1,
    contributedKeyIds: ['key-0'],
    coordinator: false,
    walletId: wallet.id,
    createdAt: 0,
  };

  it('carries the invite and identity key, and stays a plain wallet file', () => {
    const backup = groupBackupFor(group, secret, keys);
    assert.ok(backup);
    const file = walletBackupFile(wallet, backup);
    assert.match(file, /^# Group invite: multisig:join\?/m);
    assert.match(file, new RegExp(`^# Group identity: ${keys[0].fingerprint}$`, 'm'));

    // Sparrow, Coldcard and our own parser skip comment lines: still the same wallet.
    for (const parsed of [parseWalletConfigFile(file), parseWalletImportText(file)]) {
      assert.deepEqual(firstAddresses(walletFromParsed(parsed)), firstAddresses(wallet));
    }

    const carried = groupFromBackupText(file);
    assert.ok(carried);
    assert.equal(carried.invite.secret, secret);
    assert.equal(carried.invite.coordinatorPubkey, group.coordinatorPubkey);
    assert.equal(carried.invite.rekey, true);
    assert.deepEqual([carried.invite.m, carried.invite.n, carried.invite.network], [2, 3, 'mainnet']);
    assert.equal(carried.identityFingerprint, keys[0].fingerprint);
  });

  it('carries nothing for a private wallet or a group from before rotation', () => {
    assert.equal(groupBackupFor(undefined, secret, keys), null);
    // A legacy group's invite is still the key to everything it ever sent.
    assert.equal(groupBackupFor({ ...group, rekey: undefined }, secret, keys), null);
    assert.equal(groupBackupFor({ ...group, coordinatorPubkey: undefined }, secret, keys), null);
    assert.equal(groupBackupFor(group, null, keys), null);
    const plain = walletBackupFile(wallet);
    assert.doesNotMatch(plain, /Group invite/);
    assert.equal(groupFromBackupText(plain), null);
  });

  it('reads a bare invite, and ignores damaged or absent ones', () => {
    const invite = encodeInvite({ secret, relays: [], name: 'Family', m: 2, n: 3, network: 'mainnet', rekey: true });
    assert.equal(groupFromBackupText(`  ${invite}\n`)?.invite.secret, secret);
    assert.equal(groupFromBackupText(walletDescriptor(wallet)), null);
    assert.equal(groupFromBackupText('# Group invite: multisig:join?v=1&s=AAAA'), null);
    assert.equal(groupFromBackupText('multisig:join?v=1'), null);
  });

  it('prints the group code on the PDF, separate from the wallet QR', () => {
    const backup = groupBackupFor(group, secret, keys)!;
    const html = backupPdfHtml(
      wallet,
      { descriptor: '<svg id="d"/>', cosigners: wallet.cosigners.map(() => ''), group: '<svg id="g"/>' },
      'now',
      backup
    );
    assert.match(html, /Rejoin the group/);
    assert.match(html, /<svg id="g"\/>/);
    assert.ok(html.includes(keys[0].fingerprint), 'names the identity key');
    assert.doesNotMatch(backupPdfHtml(wallet, { descriptor: '', cosigners: [] }, 'now'), /Rejoin the group/);
  });

  it('asks for a new backup when a group wallet\'s backup lacks the group', () => {
    assert.equal(backupMissesGroup({ exportedAt: 1 }, group), true);
    assert.equal(backupMissesGroup({ exportedAt: 1, backupIncludesGroup: true }, group), false);
    // Never backed up: the ordinary backup nag covers it.
    assert.equal(backupMissesGroup({}, group), false);
    assert.equal(backupMissesGroup({ exportedAt: 1 }, undefined), false);
    assert.equal(backupMissesGroup({ exportedAt: 1 }, { ...group, rekey: undefined }), false);
  });

  it('only restores a group onto a wallet with the same policy and network', () => {
    assert.equal(restoreMismatch({ m: 2, n: 3, network: 'mainnet' }, wallet), null);
    assert.match(restoreMismatch({ m: 2, n: 2, network: 'mainnet' }, wallet) ?? '', /2 of 2/);
    assert.match(restoreMismatch({ m: 2, n: 3, network: 'testnet' }, wallet) ?? '', /testnet/);
  });
});
