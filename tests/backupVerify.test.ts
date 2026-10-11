import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { keyExpression, walletConfigFile, walletDescriptor } from '../src/lib/bitcoin';
import { walletBackupFile } from '../src/lib/walletExport';
import { parseWalletImportText } from '../src/lib/walletImport';
import { MultisigWallet } from '../src/lib/types';
import {
  BackupVerdict,
  describeVerdict,
  normalisePath,
  shortXpub,
  verifyBackupText,
} from '../src/lib/backupVerify';
import { MNEMONICS, makeWallet, withVersionBytes } from './helpers';
import { generateSecretKey } from '../src/lib/nostr/crypto';
import { encodeInvite } from '../src/lib/nostr/protocol';

const [a, b, c, d, e] = MNEMONICS;
const w = makeWallet(2, [a, b, c]);

function expectMatch(v: BackupVerdict): Extract<BackupVerdict, { status: 'match' }> {
  assert.equal(v.status, 'match', `expected a match, got ${JSON.stringify(v)}`);
  return v as Extract<BackupVerdict, { status: 'match' }>;
}

function expectMismatch(v: BackupVerdict): Extract<BackupVerdict, { status: 'mismatch' }> {
  assert.equal(v.status, 'mismatch', `expected a mismatch, got ${JSON.stringify(v)}`);
  return v as Extract<BackupVerdict, { status: 'mismatch' }>;
}

describe('backup verification — helpers', () => {
  it('shortXpub keeps the first 8 and last 6 characters', () => {
    const x = w.cosigners[0].xpub;
    assert.equal(shortXpub(x), `${x.slice(0, 8)}…${x.slice(-6)}`);
    assert.equal(shortXpub('xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz').length, 15);
  });

  it('normalisePath trims, lowercases and turns h/H markers into apostrophes', () => {
    assert.equal(normalisePath("  m/48'/0'/0'/2' "), "m/48'/0'/0'/2'");
    assert.equal(normalisePath('m/48h/0h/0h/2h'), "m/48'/0'/0'/2'");
    assert.equal(normalisePath('M/48H/0H/0H/2H'), "m/48'/0'/0'/2'");
  });
});

describe('backup verification — matches', () => {
  it('accepts the .txt backup file', () => {
    const v = expectMatch(verifyBackupText(walletBackupFile(w), w));
    assert.equal(v.nameDiffers, false);
    assert.deepEqual(v.originWarnings, []);
    assert.equal(v.parsed.n, 3);
  });

  it('accepts the descriptor (the "Scan to restore" QR)', () => {
    const v = expectMatch(verifyBackupText(walletDescriptor(w), w));
    assert.equal(v.nameDiffers, false, 'a descriptor carries no name');
    assert.deepEqual(v.originWarnings, []);
  });

  it('accepts the config file, name intact when it is 20 characters or fewer', () => {
    assert.ok(w.name.length <= 20);
    const v = expectMatch(verifyBackupText(walletConfigFile(w), w));
    assert.equal(v.nameDiffers, false);
    assert.deepEqual(v.originWarnings, []);
  });

  it('accepts a Specter-style JSON export', () => {
    const json = JSON.stringify({ label: w.name, descriptor: walletDescriptor(w) });
    const v = expectMatch(verifyBackupText(json, w));
    assert.equal(v.nameDiffers, false);
    assert.deepEqual(v.originWarnings, []);
  });

  it('ignores cosigner order (sortedmulti)', () => {
    const reversed: MultisigWallet = { ...w, cosigners: [...w.cosigners].reverse() };
    const v = expectMatch(verifyBackupText(walletConfigFile(reversed), w));
    assert.deepEqual(v.originWarnings, []);
  });

  it('still matches, but flags the name, when the file shortened a long wallet name', () => {
    const longName = 'Family savings for the grandchildren';
    assert.ok(longName.length > 20);
    const named = makeWallet(2, [a, b, c], 'mainnet', longName);
    const v = expectMatch(verifyBackupText(walletConfigFile(named), named));
    assert.equal(v.nameDiffers, true);
    assert.equal(v.parsed.name, longName.slice(0, 20));
    const copy = describeVerdict(v, named);
    assert.equal(copy.tone, 'success');
    assert.ok(
      copy.lines.includes(
        `The backup calls it "${longName.slice(0, 20)}" — names are shortened and simplified in the file, which is fine.`
      ),
      copy.lines.join('\n')
    );
  });

  it('matches the wallet itself even when it is also in allWallets', () => {
    const v = verifyBackupText(walletDescriptor(w), w, [w]);
    assert.equal(v.status, 'match');
  });
});

describe('backup verification — mismatches', () => {
  it('reports a different policy over the same keys', () => {
    const v = expectMismatch(verifyBackupText(walletBackupFile(makeWallet(3, [a, b, c])), w));
    assert.deepEqual(v.differences, [{ field: 'policy', expected: '2 of 3', found: '3 of 3' }]);
    assert.equal(v.unrelated, false);
    const copy = describeVerdict(v, w);
    assert.equal(copy.tone, 'danger');
    assert.equal(copy.title, "This backup doesn't match");
    assert.deepEqual(copy.lines, [
      'Policy: the backup says 3 of 3, this wallet is 2 of 3.',
      'Do not rely on this backup. Make a fresh one and check it again.',
    ]);
  });

  it('reports a different network for the testnet twin', () => {
    const twin = makeWallet(2, [a, b, c], 'testnet');
    const v = expectMismatch(verifyBackupText(walletDescriptor(twin), w));
    const network = v.differences.filter((x) => x.field === 'network');
    assert.deepEqual(network, [{ field: 'network', expected: 'mainnet', found: 'testnet' }]);
    assert.ok(!v.differences.some((x) => x.field === 'policy'), 'the policy is the same');
    assert.ok(describeVerdict(v, w).lines.includes('Network: the backup is testnet, this wallet is mainnet.'));
  });

  it('reports one missing and one unknown signer when a key was swapped', () => {
    const swapped = makeWallet(2, [a, b, d]);
    const v = expectMismatch(verifyBackupText(walletConfigFile(swapped), w));
    const missing = v.differences.filter((x) => x.field === 'missing-cosigner');
    const extra = v.differences.filter((x) => x.field === 'extra-cosigner');
    assert.equal(v.differences.length, 2);
    assert.deepEqual(missing, [
      { field: 'missing-cosigner', fingerprint: w.cosigners[2].fingerprint, xpubShort: shortXpub(w.cosigners[2].xpub) },
    ]);
    assert.deepEqual(extra, [
      {
        field: 'extra-cosigner',
        fingerprint: swapped.cosigners[2].fingerprint,
        xpubShort: shortXpub(swapped.cosigners[2].xpub),
      },
    ]);
    assert.equal(v.unrelated, false, 'two of three keys are shared');
    const copy = describeVerdict(v, w);
    assert.equal(copy.title, "This backup doesn't match");
    assert.deepEqual(copy.lines, [
      `Missing signer ${w.cosigners[2].fingerprint} (${shortXpub(w.cosigners[2].xpub)}).`,
      `Unknown signer ${swapped.cosigners[2].fingerprint} (${shortXpub(swapped.cosigners[2].xpub)}).`,
      'Do not rely on this backup. Make a fresh one and check it again.',
    ]);
  });

  it('calls a backup sharing no keys a different wallet', () => {
    const stranger = makeWallet(2, [d, e]);
    const v = expectMismatch(verifyBackupText(walletBackupFile(stranger), w));
    assert.equal(v.unrelated, true);
    assert.equal(v.differences.filter((x) => x.field === 'missing-cosigner').length, 3);
    assert.equal(v.differences.filter((x) => x.field === 'extra-cosigner').length, 2);
    assert.ok(v.differences.some((x) => x.field === 'policy' && x.found === '2 of 2'));
    const copy = describeVerdict(v, w);
    assert.equal(copy.tone, 'danger');
    assert.equal(copy.title, 'This is a different wallet');
    assert.equal(copy.lines.at(-1), 'Do not rely on this backup. Make a fresh one and check it again.');
  });
});

describe('backup verification — other wallets on this phone', () => {
  it('names the other wallet the backup belongs to', () => {
    const other: MultisigWallet = { ...makeWallet(2, [d, e], 'mainnet', 'Office vault'), id: 'other' };
    const v = verifyBackupText(walletBackupFile(other), w, [w, other]);
    assert.equal(v.status, 'other-wallet');
    if (v.status !== 'other-wallet') return;
    assert.equal(v.otherName, 'Office vault');
    assert.equal(v.parsed.n, 2);
    const copy = describeVerdict(v, w);
    assert.equal(copy.tone, 'warning');
    assert.equal(copy.title, 'This is a backup of a different wallet');
    assert.deepEqual(copy.lines, ['It matches "Office vault" on this phone. Find the backup you made for "Test wallet".']);
  });

  it('is a plain mismatch when allWallets is omitted', () => {
    const other = makeWallet(2, [d, e], 'mainnet', 'Office vault');
    assert.equal(verifyBackupText(walletBackupFile(other), w).status, 'mismatch');
  });
});

describe('backup verification — unreadable input', () => {
  it('passes the parser message through for garbage text', () => {
    const garbage = 'this is not a backup at all';
    let expected = '';
    try {
      parseWalletImportText(garbage);
    } catch (err) {
      expected = (err as Error).message;
    }
    assert.ok(expected, 'the importer must reject garbage');
    const v = verifyBackupText(garbage, w);
    assert.deepEqual(v, { status: 'unreadable', message: expected });
    const copy = describeVerdict(v, w);
    assert.equal(copy.tone, 'danger');
    assert.equal(copy.title, "Couldn't read that backup");
    assert.deepEqual(copy.lines, [expected]);
  });

  it('rejects a descriptor with a corrupted checksum', () => {
    const desc = walletDescriptor(w);
    const tampered = desc.slice(0, -1) + (desc.endsWith('q') ? 'p' : 'q');
    const v = verifyBackupText(tampered, w);
    assert.equal(v.status, 'unreadable');
    if (v.status === 'unreadable') assert.match(v.message, /checksum/i);
  });

  it('says so when there is nothing to check', () => {
    assert.deepEqual(verifyBackupText('', w), { status: 'unreadable', message: 'Nothing to check.' });
    assert.deepEqual(verifyBackupText('  \n\t ', w), { status: 'unreadable', message: 'Nothing to check.' });
  });
});

describe('backup verification — things that are not a wallet backup', () => {
  it('recognises a cosigner QR (key expression) as a single key', () => {
    const v = verifyBackupText(keyExpression(w.cosigners[0]), w);
    assert.deepEqual(v, { status: 'not-a-backup', kind: 'single-key' });
    const copy = describeVerdict(v, w);
    assert.equal(copy.tone, 'warning');
    assert.equal(copy.title, "That's one key, not the wallet");
    assert.deepEqual(copy.lines, ['You scanned a cosigner QR. Scan the large "Scan to restore" QR at the top of the page.']);
  });

  it('recognises a bare Zpub as a single key', () => {
    const zpub = withVersionBytes(w.cosigners[1].xpub, '02aa7ed3');
    assert.ok(zpub.startsWith('Zpub'));
    assert.deepEqual(verifyBackupText(zpub, w), { status: 'not-a-backup', kind: 'single-key' });
  });

  it('recognises the PDF file itself', () => {
    const v = verifyBackupText('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<< /Type /Catalog >>', w);
    assert.deepEqual(v, { status: 'not-a-backup', kind: 'pdf' });
    const copy = describeVerdict(v, w);
    assert.equal(copy.tone, 'warning');
    assert.equal(copy.title, "That's the PDF file itself");
    assert.deepEqual(copy.lines, [
      'Open the printed page and scan the large "Scan to restore" QR code instead, or open the .txt backup file.',
    ]);
  });
});

describe('backup verification — key origin warnings', () => {
  const config = walletConfigFile(w);
  const first = w.cosigners[0];

  it('warns when a fingerprint differs but the keys are intact', () => {
    const line = `${first.fingerprint.toUpperCase()}: `;
    assert.ok(config.includes(line));
    const altered = config.replace(line, 'DEADBEEF: ');
    const v = expectMatch(verifyBackupText(altered, w));
    assert.deepEqual(v.originWarnings, [
      `Fingerprint for ${first.name} reads deadbeef in the backup but ${first.fingerprint} here — a hardware signer may not recognise its key after a restore.`,
    ]);
    assert.equal(describeVerdict(v, w).tone, 'success', 'origin differences never fail the check');
  });

  it('does not mind h hardened markers in the path', () => {
    const line = `Derivation: ${first.path}`;
    assert.ok(config.includes(line));
    const hMarked = config.split(line).join("Derivation: m/48h/0h/0h/2h");
    const v = expectMatch(verifyBackupText(hMarked, w));
    assert.deepEqual(v.originWarnings, []);
  });

  it('warns when a derivation path differs', () => {
    const line = `Derivation: ${first.path}`;
    const changed = config.replace(line, "Derivation: m/48'/0'/1'/2'");
    const v = expectMatch(verifyBackupText(changed, w));
    assert.deepEqual(v.originWarnings, [
      `Derivation path for ${first.name} differs (m/48'/0'/1'/2' in the backup, ${first.path} here).`,
    ]);
  });
});

describe('describeVerdict', () => {
  it('uses one tone per outcome', () => {
    const tones = [
      verifyBackupText(walletBackupFile(w), w),
      verifyBackupText(walletBackupFile(makeWallet(3, [a, b, c])), w),
      verifyBackupText(walletBackupFile({ ...makeWallet(2, [d, e], 'mainnet', 'Other'), id: 'o' }), w, [
        w,
        { ...makeWallet(2, [d, e], 'mainnet', 'Other'), id: 'o' },
      ]),
      verifyBackupText('%PDF-1.7', w),
      verifyBackupText(keyExpression(w.cosigners[0]), w),
      verifyBackupText('nonsense text', w),
    ].map((v) => describeVerdict(v, w).tone);
    assert.deepEqual(tones, ['success', 'danger', 'warning', 'warning', 'warning', 'danger']);
  });

  it('spells out a verified backup', () => {
    const copy = describeVerdict(verifyBackupText(walletBackupFile(w), w), w);
    assert.equal(copy.title, 'Backup verified');
    assert.deepEqual(copy.lines, [
      'This backup describes exactly this wallet — 2 of 3, mainnet, 3 signers. Restoring from it would give the same addresses.',
      'Nothing was imported — no second copy of the wallet was created.',
    ]);
    assert.ok(copy.lines.some((l) => l.includes('no second copy of the wallet was created')));
  });

  it('survives a JSON round trip (verdicts are plain data)', () => {
    for (const v of [
      verifyBackupText(walletBackupFile(w), w),
      verifyBackupText(walletBackupFile(makeWallet(2, [a, b, d])), w),
      verifyBackupText('', w),
    ]) {
      assert.deepEqual(JSON.parse(JSON.stringify(v)), v);
    }
  });
});

describe('backup verification — the group', () => {
  const secret = generateSecretKey();
  const invite = (s: string) =>
    encodeInvite({ secret: s, relays: [], name: 'G', coordinatorPubkey: 'ab'.repeat(32), m: 2, n: 3, network: 'mainnet', rekey: true });
  const file = (s: string) => walletBackupFile(w, { invite: invite(s), identityFingerprint: 'deadbeef' });
  const onPhone = { secret, expected: true };

  it('recognises the group code on its own, and never as the wallet backup', () => {
    const v = verifyBackupText(invite(secret), w, [], onPhone);
    assert.deepEqual(v, { status: 'group-invite', matches: true });
    assert.equal(describeVerdict(v, w).tone, 'success');
    assert.deepEqual(verifyBackupText(invite(generateSecretKey()), w, [], onPhone), {
      status: 'group-invite',
      matches: false,
    });
    const noGroup = verifyBackupText(invite(secret), w, [], null);
    assert.deepEqual(noGroup, { status: 'group-invite', matches: null });
    assert.match(describeVerdict(noGroup, w).lines.join(' '), /Join this wallet's group/);
    assert.equal(verifyBackupText('multisig:join?v=1', w).status, 'unreadable');
  });

  it("checks a backup file's group against the wallet's", () => {
    assert.equal(expectMatch(verifyBackupText(file(secret), w, [], onPhone)).group, 'matches');

    const differs = expectMatch(verifyBackupText(file(generateSecretKey()), w, [], onPhone));
    assert.equal(differs.group, 'differs');
    assert.equal(describeVerdict(differs, w).tone, 'warning');

    const missing = expectMatch(verifyBackupText(walletBackupFile(w), w, [], onPhone));
    assert.equal(missing.group, 'missing');
    assert.match(describeVerdict(missing, w).lines.join(' '), /doesn't include the group/);

    // A group from before rotation is never put in a backup, so its absence is fine.
    assert.equal(expectMatch(verifyBackupText(walletBackupFile(w), w, [], { secret, expected: false })).group, null);
    // Restored wallet, group not rejoined yet.
    assert.equal(expectMatch(verifyBackupText(file(secret), w, [], null)).group, 'rejoinable');
    assert.equal(expectMatch(verifyBackupText(walletBackupFile(w), w)).group, null);
  });
});
