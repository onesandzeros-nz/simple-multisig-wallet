import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as bitcoin from 'bitcoinjs-lib';
import {
  BIP139_VERSION,
  bip139ExportJson,
  bip139Group,
  birthHeight,
  buildBip139Export,
  estimateHeight,
  isBip139Object,
  networkFromBip139,
  readBip139,
} from '../src/lib/bip139';
import { accountXpub, deriveAddress, masterFingerprint, walletDescriptor } from '../src/lib/bitcoin';
import { parseInvite } from '../src/lib/nostr/protocol';
import { verifyBackupText } from '../src/lib/backupVerify';
import { groupBackupFor, groupFromBackupText } from '../src/lib/groupBackup';
import { generateSecretKey } from '../src/lib/nostr/crypto';
import { Group, MultisigWallet, PendingTx, SignerKey } from '../src/lib/types';
import { buildPsbt, GAP_LIMIT, MAX_PENDING_DRAFTS, parsePsbt, unsignedTxId, WalletSync } from '../src/lib/wallet';
import { draftsToRestore, parseWalletImportText, parseWalletJson } from '../src/lib/walletImport';
import { makeSnapshot, makeWallet, MNEMONICS } from './helpers';

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const CREATED = Date.UTC(2025, 0, 1);

function addresses(w: Pick<MultisigWallet, 'm' | 'n' | 'network' | 'cosigners' | 'scriptType'>): string[] {
  const full = { ...w, id: 'x', kind: 'private', name: 'x', createdAt: 0 } as MultisigWallet;
  return [deriveAddress(full, 0, 0).address, deriveAddress(full, 0, 5).address, deriveAddress(full, 1, 0).address];
}

/** A 2-of-3 with one phone key, one Ledger key and one key held elsewhere. */
function fixture(network: 'mainnet' | 'testnet' = 'mainnet') {
  const wallet: MultisigWallet = { ...makeWallet(2, MNEMONICS.slice(0, 3), network, 'Family Savings'), createdAt: CREATED };
  const keys: SignerKey[] = [
    {
      id: 'key-0',
      name: "Rob's phone",
      type: 'local',
      fingerprint: masterFingerprint(MNEMONICS[0]),
      createdAt: 0,
      lastHealthCheckAt: Date.UTC(2026, 5, 1),
    },
    {
      id: 'key-1',
      name: 'Ledger Nano',
      type: 'imported',
      source: 'ledger',
      fingerprint: masterFingerprint(MNEMONICS[1]),
      xpub: accountXpub(MNEMONICS[1], network),
      path: wallet.cosigners[1].path,
      network,
      createdAt: 0,
      lastHealthCheckAt: Date.UTC(2026, 6, 1),
    },
    // key-2 is not on this phone: the wallet's link to it dangles.
  ];
  const snapshot = makeSnapshot(wallet, [100_000, 50_000]);
  snapshot.utxos[0].blockHeight = 850_000;
  snapshot.utxos[1].confirmed = false;
  snapshot.nextReceiveIndex = 4;
  snapshot.nextChangeIndex = 2;
  const sync: WalletSync = {
    snapshot,
    history: [
      { txid: snapshot.utxos[0].txid, netSats: 100_000, feeSats: 1_000, confirmed: true, blockTime: 1_725_000_000 },
      { txid: 'ab'.repeat(32), netSats: -5_000, feeSats: 300, confirmed: false },
    ],
    addressTxCounts: {},
  };
  // Pay one of the wallet's own later addresses, so the draft works on either network.
  const built = buildPsbt(wallet, snapshot, deriveAddress(wallet, 0, 9).address, 40_000, 5, false);
  const pendingTxs: PendingTx[] = [
    { id: 'p1', walletId: wallet.id, base64: built.psbt.toBase64(), memo: '  Rent for May ', createdAt: 0, updatedAt: 0 },
    { id: 'p2', walletId: 'another-wallet', base64: built.psbt.toBase64(), createdAt: 0, updatedAt: 0 },
    { id: 'p3', walletId: wallet.id, base64: 'not a psbt', createdAt: 0, updatedAt: 0 },
  ];
  return { wallet, keys, sync, pendingTxs, built };
}

function groupFixture(wallet: MultisigWallet, keys: SignerKey[]) {
  const secret = generateSecretKey();
  const group: Group = {
    id: 'g1',
    name: 'Family',
    relays: ['wss://relay.example'],
    identityKeyId: 'key-0',
    coordinatorPubkey: 'ab'.repeat(32),
    m: wallet.m,
    n: wallet.n,
    network: wallet.network,
    rekey: true,
    currentEpoch: 1,
    contributedKeyIds: ['key-0'],
    coordinator: false,
    walletId: wallet.id,
    createdAt: 0,
  };
  const backup = groupBackupFor(group, secret, keys);
  assert.ok(backup);
  return { secret, group, backup };
}

describe('BIP-139 export — wallet object', () => {
  const { wallet, keys, sync, pendingTxs, built } = fixture();
  const EXPORTER = 'Simple Multisig 0.1.3';
  const exported = buildBip139Export({ wallet, keys, sync, pendingTxs, now: NOW, exporter: EXPORTER }) as any;

  it('carries the mandatory fields and one bip380 account', () => {
    assert.equal(exported.version, BIP139_VERSION);
    assert.match(exported.version, /^BIP139-\d+$/);
    assert.equal(exported.network, 'bitcoin');
    assert.equal(exported.name, 'Family Savings');
    assert.equal(exported.date, Math.floor(NOW / 1000));
    assert.equal(exported.exporter, EXPORTER);
    assert.equal(exported.accounts.length, 1);
    const account = exported.accounts[0];
    assert.equal(account.type, 'bip380');
    assert.equal(account.descriptor, walletDescriptor(wallet));
    assert.match(account.descriptor, /<0;1>\/\*.*#[a-z0-9]{8}$/, 'multipath descriptor with checksum');
    assert.equal(account.name, 'Family Savings');
    assert.equal(account.status, 'active');
    assert.equal(account.gap_limit, GAP_LIMIT);
  });

  it('describes each key by fingerprint, and each held key once as a signer', () => {
    const { keys: keyObjects } = exported.accounts[0];
    for (const c of wallet.cosigners) {
      const k = keyObjects[c.fingerprint.toLowerCase()];
      assert.ok(k, `key object for ${c.fingerprint}`);
      assert.equal(k.key, c.fingerprint.toLowerCase());
      assert.equal(k.role, 'main');
    }
    assert.equal(keyObjects[wallet.cosigners[0].fingerprint].alias, "Rob's phone", 'the live key name, not the cosigner name');
    assert.equal(keyObjects[wallet.cosigners[0].fingerprint].key_type, 'internal');
    assert.equal(keyObjects[wallet.cosigners[1].fingerprint].alias, 'Ledger Nano');
    assert.equal(keyObjects[wallet.cosigners[1].fingerprint].key_type, 'internal');
    assert.equal(keyObjects[wallet.cosigners[2].fingerprint].alias, 'Signer 3');
    assert.equal('key_type' in keyObjects[wallet.cosigners[2].fingerprint], false, "a private wallet's unlinked key could be anyone's");

    assert.equal(exported.signers.length, 2, 'nothing is known about the third holder');
    const phone = exported.signers.find((s: any) => s.fingerprints[0] === wallet.cosigners[0].fingerprint);
    assert.deepEqual(phone, { fingerprints: [wallet.cosigners[0].fingerprint], key_status: 'active', key_storage: 'hot' });
    const ledger = exported.signers.find((s: any) => s.fingerprints[0] === wallet.cosigners[1].fingerprint);
    assert.deepEqual(ledger, {
      fingerprints: [wallet.cosigners[1].fingerprint],
      key_status: 'active',
      key_storage: 'cold',
      devices: [{ vendor: 'Ledger', transports: ['usb'], last_health_check: Math.floor(Date.UTC(2026, 6, 1) / 1000) }],
    });
  });

  it("calls the other members' keys external in a group wallet", () => {
    const groupWallet = { ...wallet, kind: 'group' as const };
    const out = buildBip139Export({ wallet: groupWallet, keys, now: NOW, exporter: 't' }) as any;
    const k = out.accounts[0].keys;
    assert.equal(k[wallet.cosigners[0].fingerprint].key_type, 'internal');
    assert.equal(k[wallet.cosigners[2].fingerprint].key_type, 'external');
  });

  it('labels every cosigner xpub and each draft with a memo, following BIP-329', () => {
    const labels = exported.accounts[0].labels;
    for (const c of wallet.cosigners) {
      assert.ok(labels.some((l: any) => l.type === 'xpub' && l.ref === c.xpub), `label for ${c.fingerprint}`);
    }
    const txid = unsignedTxId(built.psbt);
    assert.deepEqual(labels.find((l: any) => l.type === 'tx'), { type: 'tx', ref: txid, label: 'Rent for May' });
  });

  it('carries the coins as the registry describes them', () => {
    const coins = exported.accounts[0].coins;
    assert.equal(coins.length, 2);
    const [confirmed, pending] = coins;
    const u = sync.snapshot.utxos[0];
    assert.equal(confirmed.outpoint, `${u.txid}:${u.vout}`);
    assert.equal(confirmed.amount, 100_000);
    assert.equal(confirmed.script, bitcoin.address.toOutputScript(u.address, bitcoin.networks.bitcoin).toString('hex'));
    assert.equal(confirmed.block_height, 850_000);
    assert.equal(confirmed.is_change, false);
    assert.equal(confirmed.derivation_index, 0);
    assert.equal(confirmed.spend_status, 'unspent');
    assert.equal(pending.spend_status, 'unconfirmed');
    assert.equal('block_height' in pending, false, 'no height for a mempool coin');
    assert.equal(pending.derivation_index, 1);
  });

  it('keeps transactions and PSBTs at wallet level, referenced from the account', () => {
    const txids = Object.keys(exported.transactions);
    assert.deepEqual(txids.sort(), sync.history.map((h) => h.txid).sort());
    assert.deepEqual([...exported.accounts[0].transactions].sort(), txids.sort());
    assert.deepEqual(exported.transactions[sync.history[0].txid], { fee: 1_000, block_time: 1_725_000_000 });
    assert.deepEqual(exported.transactions['ab'.repeat(32)], { fee: 300 }, 'no block time while unconfirmed');

    const txid = unsignedTxId(built.psbt);
    assert.deepEqual(Object.keys(exported.psbts), [txid], "only this wallet's drafts, and only the ones that parse");
    assert.equal(unsignedTxId(parsePsbt(exported.psbts[txid], 'mainnet')), txid);
    assert.deepEqual(exported.accounts[0].psbts, [txid]);
  });

  it('records the address indexes the phone has handed out', () => {
    assert.equal(exported.accounts[0].receive_index, 4);
    assert.equal(exported.accounts[0].change_index, 1);
    const unsynced = buildBip139Export({ wallet, keys, now: NOW, exporter: 't' }) as any;
    for (const field of ['receive_index', 'change_index', 'birth_block', 'coins', 'transactions', 'psbts', 'labels']) {
      assert.equal(field in unsynced.accounts[0], field === 'labels', `${field} without a sync`);
    }
    assert.equal('transactions' in unsynced, false);
    assert.equal('psbts' in unsynced, false);
    assert.equal('signers' in unsynced, true);
  });

  it('leaves out what it does not know rather than writing null', () => {
    const json = bip139ExportJson({ wallet, keys, sync, pendingTxs, now: NOW, exporter: EXPORTER });
    assert.doesNotMatch(json, /null/);
    assert.deepEqual(JSON.parse(json), exported, 'the object is exactly what the file carries');
  });

  it('writes the group invite under this app\'s proprietary namespace, under the same rule as the text file', () => {
    const { secret, group, backup } = groupFixture(wallet, keys);
    const withGroup = buildBip139Export({ wallet, keys, group: backup, now: NOW, exporter: 't' }) as any;
    assert.deepEqual(withGroup.proprietary, {
      simplemultisig: { group: { invite: backup.invite, identity_fingerprint: wallet.cosigners[0].fingerprint } },
    });
    assert.equal(parseInvite(backup.invite).secret, secret, 'the epoch-0 secret rides in the invite, as in the text file');
    assert.equal('proprietary' in exported, false, 'a private wallet has none');
    // A legacy group never goes in.
    assert.equal(groupBackupFor({ ...group, rekey: undefined }, secret, keys), null);
  });

  it('never carries a mnemonic or private key', () => {
    const { backup } = groupFixture(wallet, keys);
    const json = bip139ExportJson({ wallet, keys, group: backup, sync, pendingTxs, now: NOW, exporter: 't' });
    for (const m of MNEMONICS) assert.equal(json.includes(m), false);
    assert.doesNotMatch(json, /xprv|tprv/);
    assert.equal(json.includes('abandon abandon'), false);
  });

  it('names the test network this app scans', () => {
    const t = fixture('testnet');
    const out = buildBip139Export({ wallet: t.wallet, keys: t.keys, now: NOW, exporter: 't' }) as any;
    assert.equal(out.network, 'testnet3');
    assert.match(out.accounts[0].descriptor, /tpub/);
  });
});

describe('BIP-139 export — birth height', () => {
  const { wallet, keys, sync } = fixture();

  it('estimates from genesis, never from the tip', () => {
    // 2025-01-01: the chain stood near 877,000; the estimate must be below.
    const h = estimateHeight(Math.floor(CREATED / 1000), 'mainnet');
    assert.ok(h > 800_000 && h < 877_000, `${h}`);
    assert.equal(estimateHeight(1_231_006_505, 'mainnet'), 0);
    assert.equal(estimateHeight(0, 'mainnet'), 0, 'clamped');
  });

  it('is unknown until the wallet has been synced', () => {
    assert.equal(birthHeight(wallet, null), undefined);
    assert.equal(birthHeight(wallet, undefined), undefined);
  });

  it('is at or before everything the wallet has seen', () => {
    const fromCreation = estimateHeight(Math.floor(CREATED / 1000), 'mainnet');
    const fromFirstTx = estimateHeight(1_725_000_000, 'mainnet');
    assert.ok(fromFirstTx < fromCreation);
    assert.equal(birthHeight(wallet, sync), fromFirstTx, 'the first transaction predates the record');

    const old: WalletSync = { ...sync, snapshot: { ...sync.snapshot, utxos: [{ ...sync.snapshot.utxos[0], blockHeight: 500_000 }] } };
    assert.equal(birthHeight(wallet, old), 500_000, 'an old coin pulls it further back');

    const fresh = { ...wallet, createdAt: NOW };
    const empty: WalletSync = { snapshot: { ...sync.snapshot, utxos: [] }, history: [], addressTxCounts: {} };
    assert.equal(birthHeight(fresh, empty), estimateHeight(Math.floor(NOW / 1000), 'mainnet'));
    assert.equal(birthHeight({ ...wallet, createdAt: 0 }, empty), undefined, 'nothing to go on');
  });
});

describe('BIP-139 import — this app\'s own export', () => {
  const { wallet, keys, sync, pendingTxs } = fixture();

  it('round-trips through parseWalletImportText with the names from the file', () => {
    const json = bip139ExportJson({ wallet, keys, sync, pendingTxs, now: NOW, exporter: 't' });
    const parsed = parseWalletImportText(json);
    assert.equal(parsed.m, 2);
    assert.equal(parsed.n, 3);
    assert.equal(parsed.network, 'mainnet');
    assert.equal(parsed.name, 'Family Savings');
    assert.deepEqual(addresses({ ...wallet, cosigners: parsed.cosigners }), addresses(wallet));
    assert.deepEqual(
      parsed.cosigners.map((c) => c.name),
      ["Rob's phone", 'Ledger Nano', 'Signer 3']
    );
    for (const [i, c] of parsed.cosigners.entries()) {
      assert.equal(c.fingerprint, wallet.cosigners[i].fingerprint);
      assert.equal(c.path, wallet.cosigners[i].path);
    }
    assert.equal(parsed.warnings, undefined);
  });

  it('round-trips a testnet wallet', () => {
    const t = fixture('testnet');
    const parsed = parseWalletImportText(bip139ExportJson({ wallet: t.wallet, keys: [], now: NOW, exporter: 't' }));
    assert.equal(parsed.network, 'testnet');
    assert.deepEqual(addresses({ ...t.wallet, cosigners: parsed.cosigners }), addresses(t.wallet));
  });

  it('verifies as a backup of the wallet, group included', () => {
    const { secret, backup } = groupFixture(wallet, keys);
    const json = bip139ExportJson({ wallet, keys, group: backup, sync, now: NOW, exporter: 't' });
    const v = verifyBackupText(json, wallet, [], { secret, expected: true });
    assert.equal(v.status, 'match');
    if (v.status === 'match') {
      assert.equal(v.nameDiffers, false);
      assert.deepEqual(v.originWarnings, []);
      assert.equal(v.group, 'matches');
    }
    const other = verifyBackupText(json, wallet, [], { secret: generateSecretKey(), expected: true });
    assert.equal(other.status === 'match' && other.group, 'differs');
    const plain = bip139ExportJson({ wallet, keys, now: NOW, exporter: 't' });
    const missing = verifyBackupText(plain, wallet, [], { secret, expected: true });
    assert.equal(missing.status === 'match' && missing.group, 'missing');
  });

  it('hands the group invite to the restore flow', () => {
    const { secret, backup } = groupFixture(wallet, keys);
    const json = bip139ExportJson({ wallet, keys, group: backup, now: NOW, exporter: 't' });
    const carried = groupFromBackupText(json);
    assert.ok(carried);
    assert.equal(carried.invite.secret, secret);
    assert.equal(carried.text, backup.invite);
    assert.equal(carried.identityFingerprint, wallet.cosigners[0].fingerprint);
    assert.equal(groupFromBackupText(bip139ExportJson({ wallet, keys, now: NOW, exporter: 't' })), null);
    assert.equal(groupFromBackupText('{"version":"BIP139-1","network":"bitcoin","accounts":[],"proprietary":{"simplemultisig":{"group":{"invite":"multisig:join?v=1"}}}}'), null, 'a damaged invite is nothing');
    assert.equal(bip139Group({ label: 'x', descriptor: 'wsh(...)' }), null);
  });
});

describe('BIP-139 import — drafts', () => {
  const { wallet, keys, sync, pendingTxs, built } = fixture();
  const restored: MultisigWallet = { ...wallet, id: 'restored-id' };
  let counter = 0;
  const newId = () => `id-${++counter}`;

  it('carries the drafts and their memos back out of the export', () => {
    const json = bip139ExportJson({ wallet, keys, sync, pendingTxs, now: NOW, exporter: 't' });
    const parsed = parseWalletImportText(json);
    assert.equal(parsed.drafts?.length, 1);
    assert.equal(parsed.drafts![0].memo, 'Rent for May');
    const { drafts, skipped } = draftsToRestore(parsed, restored, 123, newId);
    assert.equal(skipped, 0);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].walletId, 'restored-id', 'belongs to the new record');
    assert.equal(drafts[0].memo, 'Rent for May');
    assert.equal(drafts[0].createdAt, 123);
    assert.equal(unsignedTxId(parsePsbt(drafts[0].base64, 'mainnet')), unsignedTxId(built.psbt));
    assert.equal(parseWalletImportText(bip139ExportJson({ wallet, keys, now: NOW, exporter: 't' })).drafts, undefined);
  });

  it('resolves drafts by the account\'s references, or takes them all when there is one account', () => {
    const txid = unsignedTxId(built.psbt);
    const base = { version: 'BIP139-1', network: 'bitcoin', psbts: { [txid.toUpperCase()]: built.psbt.toBase64() } };
    const account = { type: 'bip380', descriptor: walletDescriptor(wallet) };
    assert.equal(parseWalletJson(JSON.stringify({ ...base, accounts: [account] })).drafts?.length, 1, 'one account, no references');
    assert.equal(parseWalletJson(JSON.stringify({ ...base, accounts: [{ ...account, psbts: [] }] })).drafts, undefined, 'says it has none');
    assert.equal(parseWalletJson(JSON.stringify({ ...base, accounts: [{ ...account, psbts: [txid] }] })).drafts?.length, 1, 'referenced, case-insensitively');
    assert.equal(parseWalletJson(JSON.stringify({ ...base, accounts: [{ ...account, psbts: ['ff'.repeat(32)] }] })).drafts, undefined, 'a dangling reference');
    const other = makeWallet(2, MNEMONICS.slice(2, 4), 'mainnet', 'Other');
    const two = parseWalletJson(JSON.stringify({ ...base, accounts: [account, { type: 'bip380', descriptor: walletDescriptor(other) }] }));
    assert.equal(two.drafts, undefined, "two accounts and no references: nobody's");
    assert.throws(() => parseWalletJson(JSON.stringify({ ...base, psbts: [], accounts: [account] })), /"psbts" is not an object/);
    assert.throws(() => parseWalletJson(JSON.stringify({ ...base, accounts: [{ ...account, psbts: [1] }] })), /not an array of transaction ids/);
  });

  it('keeps only drafts that parse, spend this wallet\'s coins, and appear once', () => {
    const other = makeWallet(2, MNEMONICS.slice(2, 4), 'mainnet', 'Other');
    const theirs = buildPsbt(other, makeSnapshot(other, [70_000]), deriveAddress(other, 0, 1).address, 20_000, 5, false);
    const parsed = {
      drafts: [
        { base64: built.psbt.toBase64(), memo: 'ours' },
        { base64: built.psbt.toBase64() }, // the same draft again
        { base64: theirs.psbt.toBase64(), memo: 'spends coins this wallet does not hold' },
        { base64: 'cHNidP8BAFICAAAAAQ==' },
        { base64: '' },
      ],
    };
    const { drafts, skipped } = draftsToRestore(parsed, restored, 1, newId);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].memo, 'ours');
    assert.equal(skipped, 3);
    assert.deepEqual(draftsToRestore({}, restored, 1, newId), { drafts: [], skipped: 0 });
  });

  it('stops at the draft limit, like a draft from a relay or a QR', () => {
    const many = Array.from({ length: MAX_PENDING_DRAFTS + 3 }, (_, i) => {
      const snapshot = makeSnapshot(wallet, [100_000 + i]);
      snapshot.utxos[0].txid = (i + 1).toString(16).padStart(2, '0').repeat(32);
      return { base64: buildPsbt(wallet, snapshot, deriveAddress(wallet, 0, 2).address, 30_000, 5, false).psbt.toBase64() };
    });
    const { drafts, skipped } = draftsToRestore({ drafts: many }, restored, 1, newId);
    assert.equal(drafts.length, MAX_PENDING_DRAFTS);
    assert.equal(skipped, 3);
  });
});

describe('BIP-139 import — files from elsewhere', () => {
  const { wallet } = fixture();
  const other = makeWallet(2, MNEMONICS.slice(2, 4), 'mainnet', 'Other');
  const descriptor = walletDescriptor(wallet);

  it('recognises an export by its version, and a draft-era one by its shape', () => {
    assert.equal(isBip139Object({ version: 'BIP139-1', network: 'bitcoin', accounts: [] }), true);
    assert.equal(isBip139Object({ version: 'BIP139-7', network: 'bitcoin' }), true);
    assert.equal(isBip139Object({ version: 0, network: 'signet', accounts: [] }), true);
    assert.equal(isBip139Object({ label: 'x', descriptor: 'wsh(...)' }), false, 'Specter');
    assert.equal(isBip139Object({ wallet_type: '2of3', 'x1/': {} }), false, 'Electrum');
    assert.equal(isBip139Object([]), false);
    assert.equal(isBip139Object(null), false);
    assert.equal(isBip139Object('BIP139-1'), false);
  });

  it('reads the minimal export: version, network and one account', () => {
    const parsed = parseWalletJson(JSON.stringify({ version: 'BIP139-1', network: 'bitcoin', accounts: [{ type: 'bip380', descriptor }] }));
    assert.deepEqual(addresses({ ...wallet, cosigners: parsed.cosigners }), addresses(wallet));
    assert.equal(parsed.name, undefined);
    assert.deepEqual(parsed.cosigners.map((c) => c.name), ['Cosigner 1', 'Cosigner 2', 'Cosigner 3']);
    assert.equal(parsed.warnings, undefined);
  });

  it('takes names from the account, the wallet, the keys and the labels', () => {
    const fp = wallet.cosigners[1].fingerprint;
    const file = {
      version: 'BIP139-1',
      network: 'bitcoin',
      name: 'Wallet name',
      accounts: [
        {
          type: 'bip380',
          descriptor,
          keys: { [fp.toUpperCase()]: { key: fp.toUpperCase(), alias: 'Alice' } },
          labels: [
            { type: 'xpub', ref: wallet.cosigners[0].xpub, label: 'Bob' },
            { type: 'addr', ref: 'bc1q...', label: 'ignored' },
          ],
        },
      ],
    };
    const parsed = parseWalletJson(JSON.stringify(file));
    assert.equal(parsed.name, 'Wallet name', 'the wallet name when the account has none');
    assert.deepEqual(parsed.cosigners.map((c) => c.name), ['Bob', 'Alice', 'Cosigner 3']);
    const named = parseWalletJson(JSON.stringify({ ...file, accounts: [{ ...file.accounts[0], name: 'Account name' }] }));
    assert.equal(named.name, 'Account name', 'the account name first');
  });

  it('imports the first supported account of several, and says so', () => {
    const file = {
      version: 'BIP139-1',
      network: 'bitcoin',
      accounts: [
        { type: 'bip388', descriptor: 'wsh(sortedmulti(2,@0/**,@1/**))' },
        { type: 'bip380', descriptor: walletDescriptor(other), name: 'Second' },
        { type: 'bip380', descriptor },
      ],
    };
    const parsed = parseWalletJson(JSON.stringify(file));
    assert.deepEqual(addresses({ ...other, cosigners: parsed.cosigners }), addresses(other));
    assert.equal(parsed.name, 'Second');
    assert.equal(parsed.warnings?.length, 1);
    assert.match(parsed.warnings![0], /3 accounts/);
    assert.match(parsed.warnings![0], /account 2 \("Second"\)/);
  });

  it('reads a multi_bip380 account from whichever of its descriptors this app supports', () => {
    const file = {
      version: 'BIP139-1',
      network: 'bitcoin',
      accounts: [{ type: 'multi_bip380', descriptor: ['pkh(xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8)', descriptor] }],
    };
    const parsed = parseWalletJson(JSON.stringify(file));
    assert.deepEqual(addresses({ ...wallet, cosigners: parsed.cosigners }), addresses(wallet));
  });

  it('ignores fields and enum values it does not know', () => {
    const file = {
      version: 'BIP139-1',
      network: 'bitcoin',
      future_field: { anything: true },
      accounts: [{ type: 'bip380', descriptor, status: 'frozen-solid', hidden: 'maybe', coins: [{ outpoint: 'aa:0', spend_status: 'teleported' }], extra: 1 }],
      signers: [{ fingerprints: ['deadbeef'], key_storage: 'lukewarm', devices: [{ transports: ['carrier-pigeon'] }] }],
      transactions: { aa: { hex: 'not checked' } },
    };
    const parsed = parseWalletJson(JSON.stringify(file));
    assert.equal(parsed.n, 3);
    assert.equal(parsed.warnings, undefined);
  });

  it('maps the networks, warning where this app only approximates', () => {
    assert.deepEqual(networkFromBip139('bitcoin'), { network: 'mainnet' });
    assert.deepEqual(networkFromBip139('testnet3'), { network: 'testnet' });
    for (const name of ['testnet4', 'signet', 'mutinynet']) {
      const r = networkFromBip139(name);
      assert.equal(r.network, 'testnet');
      assert.match(r.warning ?? '', new RegExp(name));
    }
    assert.throws(() => networkFromBip139('regtest'), /regtest/);
    assert.throws(() => networkFromBip139('liquid'), /Unknown network "liquid"/);

    const t = fixture('testnet');
    const signet = parseWalletJson(
      JSON.stringify({ version: 'BIP139-1', network: 'signet', accounts: [{ type: 'bip380', descriptor: walletDescriptor(t.wallet) }] })
    );
    assert.equal(signet.network, 'testnet');
    assert.match(signet.warnings![0], /signet/);
  });

  it('refuses a file whose keys contradict its network', () => {
    const t = fixture('testnet');
    assert.throws(
      () => parseWalletJson(JSON.stringify({ version: 'BIP139-1', network: 'bitcoin', accounts: [{ type: 'bip380', descriptor: walletDescriptor(t.wallet) }] })),
      /testnet keys.*bitcoin/
    );
  });

  it('insists on the mandatory fields, as the BIP asks of importers', () => {
    const ok = { version: 'BIP139-1', network: 'bitcoin', accounts: [{ type: 'bip380', descriptor }] };
    const bad = (patch: Record<string, unknown>) => JSON.stringify({ ...ok, ...patch });
    assert.throws(() => parseWalletJson(bad({ accounts: [] })), /no accounts/);
    assert.throws(() => parseWalletJson(bad({ accounts: 'nope' })), /no accounts/);
    assert.throws(() => parseWalletJson(bad({ network: undefined })), /no "network"/);
    assert.throws(() => parseWalletJson(bad({ accounts: [{ descriptor }] })), /Account 1 has no "type"/);
    assert.throws(() => parseWalletJson(bad({ accounts: [{ type: 'bip380' }] })), /Account 1 has no "descriptor"/);
    assert.throws(() => parseWalletJson(bad({ accounts: [{ type: 'bip380', descriptor, keys: { aa: { alias: 'x' } } }] })), /has no "key" field/);
    assert.throws(() => parseWalletJson(bad({ accounts: [{ type: 'bip380', descriptor, coins: [{ amount: 1 }] }] })), /no "outpoint"/);
    assert.throws(() => parseWalletJson(bad({ signers: [{ fingerprints: [] }] })), /no fingerprints/);
    assert.throws(() => parseWalletJson(bad({ signers: {} })), /"signers" is not an array/);
  });

  it('explains when no account is a wallet this app supports', () => {
    assert.throws(
      () => parseWalletJson(JSON.stringify({ version: 'BIP139-1', network: 'bitcoin', accounts: [{ type: 'bip380', descriptor: 'wpkh(xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8/0/*)' }] })),
      /The account in this BIP-139 export is a wsh\(sortedmulti/
    );
    assert.throws(
      () => parseWalletJson(JSON.stringify({ version: 'BIP139-1', network: 'bitcoin', accounts: [{ type: 'bip388', descriptor: 'x' }, { type: 'bip392', descriptor: 'y' }] })),
      /None of the 2 accounts/
    );
  });

  it('reads a draft-era export with a warning about its version', () => {
    const read = readBip139({ version: 0, network: 'bitcoin', accounts: [{ type: 'bip380', descriptor }] });
    assert.equal(read.warnings.length, 1);
    assert.match(read.warnings[0], /version is 0/);
    const parsed = parseWalletJson(JSON.stringify({ network: 'bitcoin', accounts: [{ type: 'bip380', descriptor }] }));
    assert.match(parsed.warnings![0], /version is undefined/);
  });

  it('still reads the other JSON formats', () => {
    const specter = parseWalletJson(JSON.stringify({ label: 'Spec', descriptor }));
    assert.equal(specter.name, 'Spec');
    assert.throws(() => parseWalletJson('{"foo": 1}'), /BIP-139 export, a descriptor or an Electrum/);
  });
});
