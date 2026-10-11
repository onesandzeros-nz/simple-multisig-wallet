import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { accountXpub, bip48Path, masterFingerprint } from '../src/lib/bitcoin';
import { MAX_KEYS } from '../src/lib/tutorialPolicy';
import {
  NUMBERED_STEPS,
  STEP_LABELS,
  STEP_ORDER,
  applicableExtras,
  assignKey,
  assignNewestKey,
  backupStatus,
  canFinish,
  clearSlot,
  completeSetup,
  confirmBackupStored,
  describeBackupState,
  describeSetupRow,
  draftNextStep,
  draftProgress,
  extraStatus,
  hasHardwareCosigner,
  keySelectionWarnings,
  keysStepDone,
  markDone,
  markInstructionsSent,
  markSkipped,
  newDraft,
  overrideNote,
  phraseChecklistItems,
  recordExport,
  resolveSlots,
  setDraftPolicy,
  setPhraseCheck,
  setupSummary,
  startSetup,
  stepNumber,
  stepTitle,
  testTxPlan,
  unmark,
  verifyStatus,
  walletNextStep,
} from '../src/lib/tutorial';
import { KeyPlanSlot, MultisigWallet, NetworkName, PolicyAnswers, SetupPolicy, SignerKey, WalletSetup } from '../src/lib/types';
import { MNEMONICS, makeWallet } from './helpers';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function localKey(id: string, mnemonic: string, name = id, createdAt = 0): SignerKey {
  return { id, name, type: 'local', fingerprint: masterFingerprint(mnemonic), createdAt };
}

function importedKey(
  id: string,
  mnemonic: string,
  name = id,
  network: NetworkName = 'mainnet',
  createdAt = 0
): SignerKey {
  return {
    id,
    name,
    type: 'imported',
    fingerprint: masterFingerprint(mnemonic),
    xpub: accountXpub(mnemonic, network),
    path: bip48Path(network),
    network,
    createdAt,
  };
}

const answers: PolicyAnswers = { owners: 'me', people: 1, hardwareDevices: 1, stakes: 'modest' };

const phone: KeyPlanSlot = { kind: 'this-phone', where: 'this-phone' };
const hwHome: KeyPlanSlot = { kind: 'hardware', where: 'home' };
const hwToAcquire: KeyPlanSlot = { kind: 'hardware', where: 'elsewhere', toAcquire: true };
const other2: KeyPlanSlot = { kind: 'other-phone', where: 'other-person', person: 2 };

function policy(m: number, n: number, slots: KeyPlanSlot[], recommended: [number, number] = [m, n]): SetupPolicy {
  return { m, n, recommendedM: recommended[0], recommendedN: recommended[1], slots: slots.map((s) => ({ ...s })) };
}

const POLICY_23 = policy(2, 3, [phone, hwHome, hwToAcquire]);

const K0 = localKey('k0', MNEMONICS[0]);
const K1 = importedKey('k1', MNEMONICS[1]);
const K2 = importedKey('k2', MNEMONICS[2]);
const ALL = [K0, K1, K2];

function filledDraft() {
  let d = newDraft(answers, POLICY_23, 100);
  d = assignKey(d, 0, K0, ALL);
  d = assignKey(d, 1, K1, ALL);
  d = assignKey(d, 2, K2, ALL);
  return d;
}

function freshSetup(now = 1000): WalletSetup {
  return startSetup(undefined, now);
}

function walletWith(patch: Partial<MultisigWallet>, m = 2, n = 3): MultisigWallet {
  return { ...makeWallet(m, MNEMONICS.slice(0, n)), ...patch };
}

/** A wallet whose cosigners key-0..key-2 resolve to these keys. */
const WALLET_KEYS = [localKey('key-0', MNEMONICS[0]), importedKey('key-1', MNEMONICS[1]), importedKey('key-2', MNEMONICS[2])];

const roundTrip = <T>(x: T): T => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

describe('tutorial steps', () => {
  it('orders and numbers the steps', () => {
    assert.deepEqual(STEP_ORDER, ['welcome', 'policy', 'keys', 'create', 'backup', 'verify', 'checklist']);
    assert.deepEqual(NUMBERED_STEPS, STEP_ORDER.slice(1));
    assert.equal(stepNumber('welcome'), 0);
    assert.equal(stepNumber('policy'), 1);
    assert.equal(stepNumber('checklist'), 6);
  });

  it('titles the header', () => {
    assert.equal(stepTitle('welcome'), 'Guided setup');
    assert.equal(stepTitle('policy'), 'Step 1 of 6 · Policy');
    assert.equal(stepTitle('backup'), 'Step 4 of 6 · Back up');
    assert.equal(stepTitle('verify'), 'Step 5 of 6 · Check backup');
    assert.equal(stepTitle('checklist'), 'Step 6 of 6 · Checklist');
    assert.deepEqual(Object.values(STEP_LABELS), [
      'Guided setup',
      'Policy',
      'Keys',
      'Create',
      'Back up',
      'Check backup',
      'Checklist',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------

describe('setup draft', () => {
  it('creates a draft from an accepted policy', () => {
    const d = newDraft(answers, POLICY_23, 42);
    assert.equal(d.version, 1);
    assert.equal(d.startedAt, 42);
    assert.equal(d.updatedAt, 42);
    assert.deepEqual(d.answers, answers);
    assert.deepEqual(d.policy, POLICY_23);
    assert.notEqual(d.policy.slots, POLICY_23.slots);
    assert.equal(draftNextStep(d, ALL, false), 'keys');
    assert.deepEqual(draftProgress(d, ALL), { filled: 0, total: 3 });
  });

  it('validates the policy', () => {
    assert.throws(() => newDraft(answers, policy(4, 3, [phone, hwHome, hwToAcquire]), 0));
    assert.throws(() => newDraft(answers, policy(0, 3, [phone, hwHome, hwToAcquire]), 0));
    const tooMany = Array.from({ length: MAX_KEYS + 1 }, (_, i) => (i === 0 ? phone : hwToAcquire));
    assert.throws(() => newDraft(answers, policy(2, MAX_KEYS + 1, tooMany), 0));
    assert.throws(() => newDraft(answers, policy(2, 3, [phone, hwHome]), 0));
    assert.doesNotThrow(() => newDraft(answers, policy(2, 3, [phone, hwHome, hwToAcquire]), 0));
  });

  it('keeps gathered keys only where the new plan has the same kind in the same position', () => {
    const d = filledDraft();
    // Old plan: [this-phone k0, hardware k1, hardware k2]. Slot 1 changes kind, slot 2 stays hardware.
    const next = setDraftPolicy(d, { ...answers, owners: 'pair', people: 2 }, policy(2, 3, [phone, other2, hwHome]));
    assert.equal(next.policy.slots[0].keyId, 'k0');
    assert.equal(next.policy.slots[1].keyId, undefined);
    assert.equal('keyId' in next.policy.slots[1], false);
    assert.equal(next.policy.slots[2].keyId, 'k2');
    // A shorter plan simply drops the keys beyond it; keyIds on the incoming plan are ignored.
    const shorter = setDraftPolicy(d, answers, policy(2, 2, [phone, { ...hwHome, keyId: 'stray' }]));
    assert.equal(shorter.policy.slots[0].keyId, 'k0');
    assert.equal(shorter.policy.slots[1].keyId, 'k1');
    assert.equal(next.answers.owners, 'pair');
    assert.equal(next.startedAt, d.startedAt);
    // The old draft is untouched.
    assert.equal(d.policy.slots[2].keyId, 'k2');
  });

  it('assigns, moves and clears keys', () => {
    let d = newDraft(answers, POLICY_23, 0);
    d = assignKey(d, 1, K1, ALL);
    assert.equal(d.policy.slots[1].keyId, 'k1');
    assert.deepEqual(draftProgress(d, ALL), { filled: 1, total: 3 });

    d = assignKey(d, 2, K1, ALL);
    assert.equal(d.policy.slots[1].keyId, undefined);
    assert.equal(d.policy.slots[2].keyId, 'k1');

    d = clearSlot(d, 2);
    assert.equal(d.policy.slots[2].keyId, undefined);
    assert.equal('keyId' in d.policy.slots[2], false);
    assert.deepEqual(draftProgress(d, ALL), { filled: 0, total: 3 });

    assert.throws(() => assignKey(d, 3, K1, ALL));
    assert.throws(() => clearSlot(d, -1));
  });

  it('refuses a second record of the same key', () => {
    const own = localKey('own', MNEMONICS[0], 'My phone');
    const back = importedKey('back', MNEMONICS[0], 'Coldcard');
    const keys = [own, back];
    const d = assignKey(newDraft(answers, POLICY_23, 0), 0, own, keys);
    assert.throws(
      () => assignKey(d, 1, back, keys),
      (e: Error) => e.message === '"My phone" is the same key — each key can only go into the wallet once.'
    );
    // Re-assigning the very same record just moves it.
    assert.equal(assignKey(d, 1, own, keys).policy.slots[1].keyId, 'own');
  });

  it('stamps a slot when instructions went out to its person', () => {
    const d = newDraft({ ...answers, owners: 'pair', people: 2 }, policy(2, 3, [phone, other2, hwHome]), 0);
    const sent = markInstructionsSent(d, 1, 42);
    assert.equal(sent.policy.slots[1].instructionsSentAt, 42);
    assert.equal('instructionsSentAt' in sent.policy.slots[0], false);
    assert.equal('instructionsSentAt' in sent.policy.slots[2], false);
    // The old draft is untouched.
    assert.equal('instructionsSentAt' in d.policy.slots[1], false);
    // Sending again moves the stamp; the key arriving leaves it be.
    assert.equal(markInstructionsSent(sent, 1, 43).policy.slots[1].instructionsSentAt, 43);
    assert.equal(assignKey(sent, 1, K1, ALL).policy.slots[1].instructionsSentAt, 42);
    // A re-planned policy starts its slots afresh.
    const replanned = setDraftPolicy(sent, answers, POLICY_23);
    assert.equal('instructionsSentAt' in replanned.policy.slots[1], false);
    assert.throws(() => markInstructionsSent(d, 3, 1));
    assert.throws(() => markInstructionsSent(d, -1, 1));
  });

  it('resolves slots and reports deleted keys', () => {
    const d = filledDraft();
    const resolved = resolveSlots(d, [K0, K2]);
    assert.equal(resolved.length, 3);
    assert.equal(resolved[0].index, 0);
    assert.equal(resolved[0].key, K0);
    assert.equal(resolved[1].key, undefined);
    assert.equal(resolved[1].slot.keyId, 'k1');
    assert.equal(resolved[2].key, K2);
    assert.deepEqual(draftProgress(d, [K0, K2]), { filled: 2, total: 3 });
  });

  it('auto-assigns the newest key created since the user left', () => {
    const d = newDraft(answers, POLICY_23, 0);
    const older = localKey('older', MNEMONICS[3], 'older', 50);
    const a = importedKey('a', MNEMONICS[1], 'a', 'mainnet', 100);
    const b = importedKey('b', MNEMONICS[2], 'b', 'mainnet', 200);
    const keys = [older, a, b];

    const next = assignNewestKey(d, keys, 1, 100);
    assert.equal(next.policy.slots[1].keyId, 'b');

    // Already-assigned keys are skipped.
    const then = assignNewestKey(next, keys, 2, 100);
    assert.equal(then.policy.slots[2].keyId, 'a');

    // Only keys created at or after `since` count.
    assert.equal(assignNewestKey(d, [older], 1, 100), d);
    assert.equal(assignNewestKey(d, [], 1, 0), d);
  });

  it('auto-assignment propagates a duplicate-key refusal', () => {
    const own = localKey('own', MNEMONICS[0], 'My phone', 0);
    const back = importedKey('back', MNEMONICS[0], 'Coldcard', 'mainnet', 500);
    const d = assignKey(newDraft(answers, POLICY_23, 0), 0, own, [own]);
    assert.throws(() => assignNewestKey(d, [own, back], 1, 400), /is the same key/);
  });

  it('finishes the keys step only when every slot resolves and nothing blocks', () => {
    let d = newDraft(answers, POLICY_23, 0);
    assert.equal(keysStepDone(d, ALL, false), false);
    d = assignKey(d, 0, K0, ALL);
    d = assignKey(d, 1, K1, ALL);
    assert.equal(keysStepDone(d, ALL, false), false);
    d = assignKey(d, 2, K2, ALL);
    assert.equal(keysStepDone(d, ALL, false), true);
    assert.equal(draftNextStep(d, ALL, false), 'create');
    // A key that no longer exists on the phone.
    assert.equal(keysStepDone(d, [K0, K1], false), false);
    // Mainnet keys with Testnet mode on block the build.
    assert.equal(keysStepDone(d, ALL, true), false);
    assert.equal(draftNextStep(d, ALL, true), 'keys');
  });
});

// ---------------------------------------------------------------------------
// Key selection warnings
// ---------------------------------------------------------------------------

describe('keySelectionWarnings', () => {
  const MIXED = 'You mixed mainnet and testnet keys — a wallet needs all keys on one network.';

  it('blocks mixed networks with the builder’s message', () => {
    const t = importedKey('t', MNEMONICS[2], 't', 'testnet');
    const { blocking } = keySelectionWarnings([K0, K1, t], 2, 3, false);
    assert.deepEqual(blocking, [MIXED]);
  });

  it('blocks an imported key on the other network from the Testnet switch', () => {
    const on = keySelectionWarnings([K0, K1], 2, 3, true);
    assert.equal(on.blocking.length, 1);
    assert.equal(
      on.blocking[0],
      '"k1" is a mainnet key but Testnet mode is on. Turn Testnet off in Settings, or import a testnet key from the device.'
    );
    assert.ok(on.blocking[0].includes('Testnet mode is on'));

    const t = importedKey('t', MNEMONICS[2], 't', 'testnet');
    const off = keySelectionWarnings([K0, t], 2, 3, false);
    assert.deepEqual(off.blocking, [
      '"t" is a testnet key but Testnet mode is off. Turn Testnet on in Settings, or import a mainnet key from the device.',
    ]);

    // Local keys adapt to either network.
    assert.deepEqual(keySelectionWarnings([K0, localKey('l', MNEMONICS[3])], 2, 3, true).blocking, []);
    assert.deepEqual(keySelectionWarnings([K0, t], 2, 3, true).blocking, []);
  });

  it('treats a missing network on an imported key as mainnet', () => {
    const { network: _n, ...legacy } = K1;
    assert.equal(keySelectionWarnings([legacy], 2, 3, true).blocking.length, 1);
    assert.equal(keySelectionWarnings([legacy], 2, 3, false).blocking.length, 0);
  });

  it('warns when enough keys live on this phone to spend', () => {
    const l0 = localKey('l0', MNEMONICS[0]);
    const l1 = localKey('l1', MNEMONICS[1]);
    const l2 = localKey('l2', MNEMONICS[2]);

    const two = keySelectionWarnings([l0, l1, K2], 2, 3, false);
    assert.equal(two.blocking.length, 0);
    assert.equal(two.warnings.length, 1);
    assert.ok(two.warnings[0].includes('2 of these keys live on this one phone'));
    assert.ok(!two.warnings[0].startsWith('Every key is on this phone.'));

    const three = keySelectionWarnings([l0, l1, l2], 2, 3, false);
    assert.ok(three.warnings[0].startsWith('Every key is on this phone. '));
    assert.ok(three.warnings[0].includes('3 of these keys live on this one phone, and 2 are enough to spend.'));

    // One local key with m = 2 is fine.
    assert.deepEqual(keySelectionWarnings([l0, K1, K2], 2, 3, false).warnings, []);
    // Nothing chosen yet, nothing to say.
    assert.deepEqual(keySelectionWarnings([], 2, 3, false), { blocking: [], warnings: [] });
  });

  it('spots this phone’s own key imported back and blocks the duplicate', () => {
    const own = localKey('own', MNEMONICS[0], 'My phone');
    const back = importedKey('back', MNEMONICS[0], 'Coldcard');
    const { blocking, warnings } = keySelectionWarnings([own, back], 2, 3, false);
    assert.deepEqual(warnings, [
      '"Coldcard" looks like this phone\'s own key imported back (same fingerprint as "My phone").',
    ]);
    assert.deepEqual(blocking, ['"My phone" and "Coldcard" are the same key — each key can only go into the wallet once.']);
  });

  it('blocks two distinct imported records of one key', () => {
    const a = importedKey('a', MNEMONICS[1], 'Sparrow');
    const b = importedKey('b', MNEMONICS[1], 'Coldcard');
    const { blocking, warnings } = keySelectionWarnings([K0, a, b], 2, 3, false);
    assert.deepEqual(blocking, ['"Sparrow" and "Coldcard" are the same key — each key can only go into the wallet once.']);
    assert.deepEqual(warnings, []);
  });
});

// ---------------------------------------------------------------------------
// Setup: backup and verification
// ---------------------------------------------------------------------------

describe('wallet setup', () => {
  it('starts from a draft or from nothing', () => {
    const d = filledDraft();
    const fromDraft = startSetup(d, 999);
    assert.equal(fromDraft.version, 1);
    assert.equal(fromDraft.startedAt, 100);
    assert.deepEqual(fromDraft.policy, d.policy);
    assert.notEqual(fromDraft.policy, d.policy);
    assert.deepEqual(fromDraft.done, {});
    assert.deepEqual(fromDraft.skipped, {});
    assert.deepEqual(fromDraft.phraseChecks, {});
    assert.equal(fromDraft.completedAt, undefined);

    const adopted = startSetup(undefined, 999);
    assert.equal(adopted.startedAt, 999);
    assert.equal(adopted.policy, undefined);
    assert.equal('policy' in adopted, false);
  });

  it('derives the backup status from exportedAt and the confirmation', () => {
    const setup = freshSetup();
    assert.equal(backupStatus({ setup }), 'todo');
    assert.equal(backupStatus({ exportedAt: 5, setup }), 'exported');
    assert.equal(backupStatus({ exportedAt: 5 }), 'exported');
    const confirmed = confirmBackupStored(setup, { exportedAt: 5 }, 6);
    assert.equal(confirmed.backupConfirmedAt, 6);
    assert.notEqual(confirmed, setup);
    assert.equal(backupStatus({ exportedAt: 5, setup: confirmed }), 'done');
  });

  it('cannot confirm a backup that was never exported', () => {
    const setup = freshSetup();
    assert.equal(confirmBackupStored(setup, {}, 6), setup);
    assert.equal(confirmBackupStored(setup, { exportedAt: undefined }, 6), setup);
  });

  it('tracks verification and staleness', () => {
    assert.equal(verifyStatus({}), 'todo');
    assert.equal(verifyStatus({ exportedAt: 10 }), 'todo');
    assert.equal(verifyStatus({ exportedAt: 10, backupVerifiedAt: 20 }), 'done');
    assert.equal(verifyStatus({ exportedAt: 30, backupVerifiedAt: 20 }), 'stale');
    assert.equal(verifyStatus({ backupVerifiedAt: 20 }), 'done');
  });

  it('ranks the verify extra done > stale > skipped > todo', () => {
    const skipped = markSkipped(freshSetup(), 'verify', 1);
    assert.equal(extraStatus(walletWith({ setup: freshSetup() }), 'verify', []), 'todo');
    assert.equal(extraStatus(walletWith({ setup: skipped }), 'verify', []), 'skipped');
    assert.equal(extraStatus(walletWith({ setup: skipped, exportedAt: 30, backupVerifiedAt: 20 }), 'verify', []), 'stale');
    assert.equal(extraStatus(walletWith({ setup: skipped, exportedAt: 10, backupVerifiedAt: 20 }), 'verify', []), 'done');
    // A skip only holds for the backup it was made against: skipping after
    // the newer export counts, skipping before it does not.
    const skippedLater = markSkipped(freshSetup(), 'verify', 40);
    assert.equal(extraStatus(walletWith({ setup: skippedLater, exportedAt: 30, backupVerifiedAt: 20 }), 'verify', []), 'skipped');
    assert.equal(extraStatus(walletWith({ setup: skipped, exportedAt: 30 }), 'verify', []), 'todo');
    assert.equal(extraStatus(walletWith({ setup: skippedLater, exportedAt: 30 }), 'verify', []), 'skipped');
    // Works for a wallet that never opened the guide.
    assert.equal(extraStatus(walletWith({ exportedAt: 10, backupVerifiedAt: 20 }), 'verify', []), 'done');
  });
});

// ---------------------------------------------------------------------------
// Setup: extras
// ---------------------------------------------------------------------------

describe('setup extras', () => {
  it('marks done idempotently and forgets a skip', () => {
    const s0 = freshSetup();
    const skipped = markSkipped(s0, 'address', 1);
    assert.equal(skipped.skipped.address, 1);
    const done = markDone(skipped, 'address', 2);
    assert.equal(done.done.address, 2);
    assert.equal(done.skipped.address, undefined);
    assert.equal('address' in done.skipped, false);
    assert.equal(markDone(done, 'address', 3), done);
    assert.equal(done.done.address, 2);
  });

  it('refuses to skip something done or already skipped', () => {
    const done = markDone(freshSetup(), 'testtx', 1);
    assert.equal(markSkipped(done, 'testtx', 2), done);
    const skipped = markSkipped(freshSetup(), 'testtx', 1);
    assert.equal(markSkipped(skipped, 'testtx', 2), skipped);
    assert.equal(skipped.skipped.testtx, 1);
  });

  it('unmarks back to todo', () => {
    const done = markDone(freshSetup(), 'hardware', 1);
    const back = unmark(done, 'hardware');
    assert.deepEqual(back.done, {});
    assert.deepEqual(back.skipped, {});
    assert.equal(unmark(back, 'hardware'), back);
    const skipped = markSkipped(freshSetup(), 'hardware', 1);
    assert.deepEqual(unmark(skipped, 'hardware').skipped, {});
  });

  it('ticks and unticks phrase checks', () => {
    const s0 = freshSetup();
    const on = setPhraseCheck(s0, 'key-0', true, 5);
    assert.deepEqual(on.phraseChecks, { 'key-0': 5 });
    assert.equal(setPhraseCheck(on, 'key-0', true, 6), on);
    const off = setPhraseCheck(on, 'key-0', false, 7);
    assert.deepEqual(off.phraseChecks, {});
    assert.equal(setPhraseCheck(off, 'key-0', false, 8), off);
    // Other keys are left alone.
    const two = setPhraseCheck(on, 'key-1', true, 9);
    assert.deepEqual(setPhraseCheck(two, 'key-0', false, 10).phraseChecks, { 'key-1': 9 });
  });

  it('lists phrase items for cosigners whose keys are on this phone', () => {
    const wallet = makeWallet(2, MNEMONICS.slice(0, 3));
    const items = phraseChecklistItems(wallet, WALLET_KEYS);
    assert.equal(items.length, 3);
    assert.deepEqual(items[0], {
      keyId: 'key-0',
      kind: 'local',
      label: 'The 12 words for "key-0" are written on paper, away from this phone and away from the backup',
    });
    assert.deepEqual(items[1], {
      keyId: 'key-1',
      kind: 'external',
      label: 'The seed backup for "key-1" is kept by whoever holds that signer, away from the wallet backup',
    });
    // Uses the key's current name, not the cosigner's.
    const renamed = [localKey('key-0', MNEMONICS[0], 'Phone key')];
    assert.ok(phraseChecklistItems(wallet, renamed)[0].label.includes('"Phone key"'));
    // Unlinked or deleted keys produce nothing.
    assert.deepEqual(phraseChecklistItems(wallet, []), []);
    const unlinked = { ...wallet, cosigners: wallet.cosigners.map((c) => ({ ...c, keyId: undefined })) };
    assert.deepEqual(phraseChecklistItems(unlinked, WALLET_KEYS), []);
  });

  it('completes the phrases extra only when every item is ticked', () => {
    const wallet = walletWith({ setup: freshSetup() });
    assert.equal(extraStatus(wallet, 'phrases', WALLET_KEYS), 'todo');
    let setup = setPhraseCheck(wallet.setup!, 'key-0', true, 1);
    setup = setPhraseCheck(setup, 'key-1', true, 1);
    assert.equal(extraStatus({ ...wallet, setup }, 'phrases', WALLET_KEYS), 'todo');
    setup = setPhraseCheck(setup, 'key-2', true, 1);
    assert.equal(extraStatus({ ...wallet, setup }, 'phrases', WALLET_KEYS), 'done');
    const skipped = markSkipped(wallet.setup!, 'phrases', 1);
    assert.equal(extraStatus({ ...wallet, setup: skipped }, 'phrases', WALLET_KEYS), 'skipped');
    // Nothing to tick means it cannot be done.
    assert.equal(extraStatus({ ...wallet, setup }, 'phrases', []), 'todo');
  });

  it('records exports as backups, and NFC sends as loading the signer', () => {
    const plain = walletWith({ backupVerifiedAt: 7 });
    assert.deepEqual(recordExport(plain, 'file', 100), { exportedAt: 100 });
    assert.deepEqual(recordExport(plain, 'pdf', 100), { exportedAt: 100 });
    assert.deepEqual(recordExport(plain, 'nfc', 100), {});
    const alreadyLoaded = walletWith({ setup: markDone(freshSetup(), 'hardware', 1) });
    assert.deepEqual(recordExport(alreadyLoaded, 'nfc', 100), {}, 'nothing to write once the signer is loaded');

    const guided = walletWith({ setup: freshSetup() });
    const patch = recordExport(guided, 'nfc', 100);
    assert.deepEqual(Object.keys(patch), ['setup']);
    assert.equal(patch.setup?.done.hardware, 100);
    assert.equal(patch.exportedAt, undefined);
    assert.equal('exportedAt' in patch, false);
    const filePatch = recordExport(guided, 'file', 100);
    assert.equal('setup' in filePatch, false);
  });

  it('records whether a backup carried the group, only when that says something', () => {
    const plain = walletWith({});
    assert.deepEqual(recordExport(plain, 'file', 100, true), { exportedAt: 100, backupIncludesGroup: true });
    // A later backup without the group must not leave the old flag standing.
    const carried = walletWith({ backupIncludesGroup: true });
    assert.deepEqual(recordExport(carried, 'pdf', 100), { exportedAt: 100, backupIncludesGroup: false });
    assert.deepEqual(recordExport(carried, 'nfc', 100), {});
  });

  it('picks the applicable extras', () => {
    assert.deepEqual(applicableExtras({ hasHardwareKeys: false, hasLinkedKeys: false }), ['verify', 'address', 'testtx']);
    assert.deepEqual(applicableExtras({ hasHardwareKeys: true, hasLinkedKeys: false }), [
      'verify',
      'address',
      'hardware',
      'testtx',
    ]);
    assert.deepEqual(applicableExtras({ hasHardwareKeys: false, hasLinkedKeys: true }), [
      'verify',
      'phrases',
      'address',
      'testtx',
    ]);
    assert.deepEqual(applicableExtras({ hasHardwareKeys: true, hasLinkedKeys: true }), [
      'verify',
      'phrases',
      'address',
      'hardware',
      'testtx',
    ]);
  });

  it('detects a hardware cosigner', () => {
    const wallet = makeWallet(2, MNEMONICS.slice(0, 3));
    const locals = [0, 1, 2].map((i) => localKey(`key-${i}`, MNEMONICS[i]));
    assert.equal(hasHardwareCosigner(wallet, locals), false);
    const tapsigners = locals.map((k, i) => ({ ...importedKey(k.id, MNEMONICS[i]), source: 'tapsigner' as const }));
    assert.equal(hasHardwareCosigner(wallet, tapsigners), false);
    assert.equal(hasHardwareCosigner(wallet, WALLET_KEYS), true);
    assert.equal(hasHardwareCosigner(wallet, []), false);
  });

  it('reports the other extras as done > skipped > todo', () => {
    const wallet = walletWith({ setup: freshSetup() });
    for (const id of ['address', 'hardware', 'testtx'] as const) {
      assert.equal(extraStatus(wallet, id, []), 'todo');
      assert.equal(extraStatus({ ...wallet, setup: markSkipped(wallet.setup!, id, 1) }, id, []), 'skipped');
      assert.equal(extraStatus({ ...wallet, setup: markDone(wallet.setup!, id, 1) }, id, []), 'done');
    }
    assert.equal(extraStatus(walletWith({}), 'address', []), 'todo');
  });
});

// ---------------------------------------------------------------------------
// Setup: resume, finish, summaries
// ---------------------------------------------------------------------------

describe('setup progress', () => {
  const backedUp = (): MultisigWallet => {
    const setup = confirmBackupStored(freshSetup(), { exportedAt: 10 }, 11);
    return walletWith({ exportedAt: 10, setup });
  };

  it('resumes at backup, then verify, then the checklist', () => {
    assert.equal(walletNextStep(walletWith({ setup: freshSetup() }), []), 'backup');
    assert.equal(walletNextStep(walletWith({ exportedAt: 10, setup: freshSetup() }), []), 'backup');
    const w = backedUp();
    assert.equal(walletNextStep(w, []), 'verify');
    assert.equal(walletNextStep({ ...w, backupVerifiedAt: 12 }, []), 'checklist');
    // A skip made after the export counts; one made before it is stale.
    assert.equal(walletNextStep({ ...w, setup: markSkipped(w.setup!, 'verify', w.exportedAt! + 1) }, []), 'checklist');
    assert.equal(walletNextStep({ ...w, setup: markSkipped(w.setup!, 'verify', w.exportedAt! - 1) }, []), 'verify');
    assert.equal(walletNextStep({ ...w, exportedAt: 20, backupVerifiedAt: 12 }, []), 'verify');
  });

  it('finishes only once backed up, and only once', () => {
    const unfinished = walletWith({ exportedAt: 10, setup: freshSetup() });
    assert.equal(canFinish(unfinished), false);
    assert.throws(() => completeSetup(unfinished, 1), /Back up the wallet before finishing\./);
    assert.throws(() => completeSetup(walletWith({}), 1), /Back up the wallet before finishing\./);

    const w = backedUp();
    assert.equal(canFinish(w), true);
    const finished = completeSetup(w, 50);
    assert.equal(finished.completedAt, 50);
    assert.equal(completeSetup({ ...w, setup: finished }, 60), finished);
  });

  it('summarises progress', () => {
    const w = backedUp();
    const s = setupSummary(w, WALLET_KEYS);
    assert.deepEqual(s, { backupDone: true, recommendedDone: 0, recommendedTotal: 5, nextStep: 'verify' });

    let setup = markDone(w.setup!, 'address', 1);
    setup = markSkipped(setup, 'testtx', 1);
    const later = { ...w, setup, backupVerifiedAt: 12 };
    assert.deepEqual(setupSummary(later, WALLET_KEYS), {
      backupDone: true,
      recommendedDone: 2,
      recommendedTotal: 5,
      nextStep: 'checklist',
    });
    // Local-only wallet without linked keys: three extras.
    assert.equal(setupSummary(w, []).recommendedTotal, 3);
    assert.equal(setupSummary(walletWith({ setup: freshSetup() }), []).backupDone, false);
  });

  it('describes the Manage row', () => {
    assert.equal(describeSetupRow(walletWith({}), WALLET_KEYS), 'Check your backup and where your keys live');
    assert.equal(describeSetupRow(walletWith({ setup: freshSetup() }), WALLET_KEYS), 'Backup still needed');
    assert.equal(describeSetupRow(walletWith({ exportedAt: 1, setup: freshSetup() }), WALLET_KEYS), 'Confirm where your backup is kept');
    const w = backedUp();
    assert.equal(describeSetupRow(w, WALLET_KEYS), '0 of 5 recommended steps done');
    const verified = { ...w, backupVerifiedAt: 12 };
    assert.equal(describeSetupRow(verified, WALLET_KEYS), '1 of 5 recommended steps done');
    const finished = { ...verified, setup: completeSetup(verified, 50) };
    assert.equal(describeSetupRow(finished, WALLET_KEYS), 'Finished · 1 of 5 recommended steps done');
  });

  it('describes the backup state', () => {
    const d = (at: number) => new Date(at).toLocaleDateString();
    const t1 = Date.UTC(2026, 0, 5, 12);
    const t2 = Date.UTC(2026, 1, 9, 12);
    assert.equal(describeBackupState({}), 'Text file Sparrow, Coldcard and Specter accept');
    assert.equal(describeBackupState({ exportedAt: t1 }), `Last backed up ${d(t1)}`);
    assert.equal(describeBackupState({ exportedAt: t1, backupVerifiedAt: t2 }), `Last backed up ${d(t1)} · checked ${d(t2)}`);
    assert.equal(
      describeBackupState({ exportedAt: t2, backupVerifiedAt: t1 }),
      `Last backed up ${d(t2)} · checked ${d(t1)} (older backup — check again)`
    );
    assert.equal(describeBackupState({ backupVerifiedAt: t1 }), `Checked ${d(t1)} · never backed up from this phone`);
    assert.equal(
      describeBackupState({ exportedAt: t1, backupVerifiedAt: t2 }, true),
      `Last backed up ${d(t1)} · doesn't include the group — save a new one`
    );
  });

  it('notes an override against the recommendation', () => {
    assert.equal(overrideNote(freshSetup()), null);
    assert.equal(overrideNote(startSetup(newDraft(answers, POLICY_23, 0), 0)), null);
    const overridden = policy(2, 3, [phone, hwHome, hwToAcquire], [3, 5]);
    assert.equal(
      overrideNote(startSetup(newDraft(answers, overridden, 0), 0)),
      'You chose 2 of 3 against the recommended 3 of 5.'
    );
    const thresholdOnly = policy(1, 3, [phone, hwHome, hwToAcquire], [2, 3]);
    assert.equal(
      overrideNote(startSetup(newDraft(answers, thresholdOnly, 0), 0)),
      'You chose 1 of 3 against the recommended 2 of 3.'
    );
  });
});

// ---------------------------------------------------------------------------
// Test transaction plan
// ---------------------------------------------------------------------------

describe('testTxPlan', () => {
  it('plans the documented rounds', () => {
    assert.deepEqual(testTxPlan(2, 3), [
      [0, 1],
      [2, 0],
    ]);
    assert.equal(testTxPlan(3, 5).length, 2);
    assert.deepEqual(testTxPlan(3, 5), [
      [0, 1, 2],
      [3, 4, 0],
    ]);
    assert.deepEqual(testTxPlan(1, 2), [[0], [1]]);
    assert.deepEqual(testTxPlan(2, 2), [[0, 1]]);
  });

  it('covers every key with m distinct signers per round', () => {
    for (let n = 2; n <= MAX_KEYS; n++) {
      for (let m = 1; m <= n; m++) {
        const plan = testTxPlan(m, n);
        assert.equal(plan.length, Math.ceil(n / m), `${m} of ${n} rounds`);
        const seen = new Set<number>();
        for (const round of plan) {
          assert.equal(round.length, m);
          assert.equal(new Set(round).size, m, `${m} of ${n} distinct`);
          for (const i of round) {
            assert.ok(i >= 0 && i < n);
            seen.add(i);
          }
        }
        assert.equal(seen.size, n, `${m} of ${n} covers all keys`);
      }
    }
  });

  it('returns nothing for impossible policies', () => {
    assert.deepEqual(testTxPlan(0, 3), []);
    assert.deepEqual(testTxPlan(4, 3), []);
    assert.deepEqual(testTxPlan(2, 0), []);
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('JSON round trip', () => {
  it('leaves every transition result unchanged', () => {
    const d0 = newDraft(answers, POLICY_23, 1);
    const d1 = assignKey(d0, 0, K0, ALL);
    const d2 = assignKey(d1, 1, K1, ALL);
    const d3 = assignKey(d2, 2, K1, ALL);
    const d4 = clearSlot(d3, 2);
    const d5 = setDraftPolicy(d4, { ...answers, owners: 'pair', people: 2 }, policy(2, 3, [phone, other2, hwHome]));
    const d6 = assignNewestKey(d5, [K0, importedKey('new', MNEMONICS[3], 'new', 'mainnet', 5)], 1, 5);
    const d7 = markInstructionsSent(d5, 1, 9);

    const s0 = startSetup(d6, 2);
    const s1 = startSetup(undefined, 2);
    const s2 = confirmBackupStored(s0, { exportedAt: 3 }, 4);
    const s3 = markSkipped(s2, 'verify', 5);
    const s4 = markDone(s3, 'verify', 6);
    const s5 = unmark(s4, 'verify');
    const s6 = setPhraseCheck(s5, 'key-0', true, 7);
    const s7 = setPhraseCheck(s6, 'key-0', false, 8);
    const w = walletWith({ exportedAt: 3, setup: s2 });
    const s8 = completeSetup(w, 9);
    const p0 = recordExport(w, 'file', 10);
    const p1 = recordExport(w, 'nfc', 11);
    const p2 = recordExport(walletWith({}), 'nfc', 12);

    for (const x of [d0, d1, d2, d3, d4, d5, d6, d7, s0, s1, s2, s3, s4, s5, s6, s7, s8, p0, p1, p2]) {
      assert.deepEqual(roundTrip(x), x);
    }
  });
});
