import {
  KeyPlanSlot,
  MultisigWallet,
  PolicyAnswers,
  SetupDraft,
  SetupExtraId,
  SetupPolicy,
  SignerKey,
  WalletSetup,
} from './types';
import { MAX_KEYS } from './tutorialPolicy';

/**
 * Pure transitions and queries behind the guided setup. Before a wallet
 * exists the guide works on a SetupDraft; afterwards on MultisigWallet.setup.
 * "Backed up" and "backup verified" are derived from the wallet's own
 * exportedAt / backupVerifiedAt so a backup made anywhere in the app counts.
 *
 * Every transition returns a fresh object (or the very same reference when
 * nothing changed) and takes `now` as a parameter, so the screens can issue
 * exactly one store write per user action and the tests stay deterministic.
 * Nothing here ever writes an `undefined`-valued property: the results are
 * persisted as JSON and must survive the round trip unchanged.
 */

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export type TutorialStep = 'welcome' | 'policy' | 'keys' | 'create' | 'backup' | 'verify' | 'checklist';

export const STEP_ORDER: TutorialStep[] = ['welcome', 'policy', 'keys', 'create', 'backup', 'verify', 'checklist'];

/** The six steps shown as progress dots — everything but the welcome. */
export const NUMBERED_STEPS: TutorialStep[] = STEP_ORDER.filter((s) => s !== 'welcome');

export const STEP_LABELS: Record<TutorialStep, string> = {
  welcome: 'Guided setup',
  policy: 'Policy',
  keys: 'Keys',
  create: 'Create',
  backup: 'Back up',
  verify: 'Check backup',
  checklist: 'Checklist',
};

/** 0 for the welcome, 1..6 for the numbered steps. */
export function stepNumber(step: TutorialStep): number {
  return NUMBERED_STEPS.indexOf(step) + 1;
}

export function stepTitle(step: TutorialStep): string {
  const k = stepNumber(step);
  return k === 0 ? STEP_LABELS.welcome : `Step ${k} of ${NUMBERED_STEPS.length} · ${STEP_LABELS[step]}`;
}

// ---------------------------------------------------------------------------
// Draft (before the wallet exists)
// ---------------------------------------------------------------------------

function validatePolicy(policy: SetupPolicy): void {
  const { m, n, slots } = policy;
  if (!Number.isInteger(m) || !Number.isInteger(n) || m < 1 || m > n) {
    throw new Error(`Threshold ${m} of ${n} is not possible.`);
  }
  if (n > MAX_KEYS) throw new Error(`A wallet can have at most ${MAX_KEYS} keys.`);
  if (slots.length !== n) throw new Error(`The key plan has ${slots.length} slots but the policy needs ${n}.`);
}

function withoutKeyId(slot: KeyPlanSlot): KeyPlanSlot {
  const { keyId: _drop, ...rest } = slot;
  return rest;
}

function sameFingerprint(a: SignerKey, b: SignerKey): boolean {
  return a.fingerprint.toLowerCase() === b.fingerprint.toLowerCase();
}

/** Starts a draft from an accepted policy. Throws unless 1 ≤ m ≤ n ≤ MAX_KEYS and the plan has n slots. */
export function newDraft(answers: PolicyAnswers, policy: SetupPolicy, now: number): SetupDraft {
  validatePolicy(policy);
  return {
    version: 1,
    startedAt: now,
    updatedAt: now,
    answers: { ...answers },
    policy: { ...policy, slots: policy.slots.map((s) => ({ ...s })) },
  };
}

/**
 * Replaces the policy of an existing draft. A key already gathered for
 * slot i stays there when the new slot i has the same kind; every other
 * key link is dropped (the key itself stays in the Keys tab).
 */
export function setDraftPolicy(draft: SetupDraft, answers: PolicyAnswers, policy: SetupPolicy): SetupDraft {
  validatePolicy(policy);
  const slots = policy.slots.map((s, i) => {
    const old = draft.policy.slots[i];
    const fresh = withoutKeyId(s);
    return old && old.kind === s.kind && old.keyId ? { ...fresh, keyId: old.keyId } : fresh;
  });
  return { ...draft, answers: { ...answers }, policy: { ...policy, slots } };
}

export interface ResolvedSlot {
  index: number;
  slot: KeyPlanSlot;
  key?: SignerKey;
}

/** Each slot with the key it points at; a keyId whose key was deleted resolves to no key. */
export function resolveSlots(draft: SetupDraft, keys: SignerKey[]): ResolvedSlot[] {
  return draft.policy.slots.map((slot, index) => {
    const key = slot.keyId ? keys.find((k) => k.id === slot.keyId) : undefined;
    return key ? { index, slot, key } : { index, slot };
  });
}

function slotKeysOf(draft: SetupDraft, keys: SignerKey[]): SignerKey[] {
  return resolveSlots(draft, keys).flatMap((r) => (r.key ? [r.key] : []));
}

function requireSlot(draft: SetupDraft, slotIndex: number): void {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= draft.policy.slots.length) {
    throw new Error(`There is no key slot ${slotIndex + 1}.`);
  }
}

/**
 * Puts `key` into a slot. A key already sitting in another slot moves; a
 * different record with the same fingerprint (the phone's own key imported
 * back, say) is refused because each key can only go into the wallet once.
 */
export function assignKey(draft: SetupDraft, slotIndex: number, key: SignerKey, keys: SignerKey[]): SetupDraft {
  requireSlot(draft, slotIndex);
  const slots = draft.policy.slots.map((slot, i) => {
    if (i === slotIndex) return { ...withoutKeyId(slot), keyId: key.id };
    if (!slot.keyId) return slot;
    if (slot.keyId === key.id) return withoutKeyId(slot);
    const other = keys.find((k) => k.id === slot.keyId);
    if (other && sameFingerprint(other, key)) {
      throw new Error(`"${other.name}" is the same key — each key can only go into the wallet once.`);
    }
    return slot;
  });
  return { ...draft, policy: { ...draft.policy, slots } };
}

export function clearSlot(draft: SetupDraft, slotIndex: number): SetupDraft {
  requireSlot(draft, slotIndex);
  const slots = draft.policy.slots.map((slot, i) => (i === slotIndex ? withoutKeyId(slot) : slot));
  return { ...draft, policy: { ...draft.policy, slots } };
}

/**
 * Records that the instructions for another person's key were sent, so the
 * slot can show it is waiting on them. The stamp lives on the slot and goes
 * with it when the policy is re-planned.
 */
export function markInstructionsSent(draft: SetupDraft, slotIndex: number, now: number): SetupDraft {
  requireSlot(draft, slotIndex);
  const slots = draft.policy.slots.map((slot, i) => (i === slotIndex ? { ...slot, instructionsSentAt: now } : slot));
  return { ...draft, policy: { ...draft.policy, slots } };
}

/**
 * After the user comes back from CreateKey / ImportKey: the newest key not
 * yet in any slot, created at or after `since`, goes into the slot they
 * tapped. Returns the draft itself when there is no such key.
 */
export function assignNewestKey(draft: SetupDraft, keys: SignerKey[], slotIndex: number, since: number): SetupDraft {
  const assigned = new Set(draft.policy.slots.flatMap((s) => (s.keyId ? [s.keyId] : [])));
  let newest: SignerKey | undefined;
  for (const k of keys) {
    if (assigned.has(k.id) || k.createdAt < since) continue;
    if (!newest || k.createdAt >= newest.createdAt) newest = k;
  }
  return newest ? assignKey(draft, slotIndex, newest, keys) : draft;
}

export interface KeyIssues {
  blocking: string[];
  warnings: string[];
}

/**
 * Where-the-keys-live guidance for the keys the user has picked so far.
 * Blocking lines stop the guide (the wallet could not be built, or would
 * be on the wrong network for the mode chosen on the welcome step);
 * warnings only explain why the choice weakens the multisig.
 */
export function keySelectionWarnings(slotKeys: SignerKey[], m: number, n: number, testnet: boolean): KeyIssues {
  const blocking: string[] = [];
  const warnings: string[] = [];
  const expected = testnet ? 'testnet' : 'mainnet';
  const imported = slotKeys.filter((k) => k.type === 'imported');
  const local = slotKeys.filter((k) => k.type === 'local');

  if (new Set(imported.map((k) => k.network ?? 'mainnet')).size > 1) {
    blocking.push('You mixed mainnet and testnet keys — a wallet needs all keys on one network.');
  } else {
    for (const k of imported) {
      const network = k.network ?? 'mainnet';
      if (network === expected) continue;
      blocking.push(
        `"${k.name}" is a ${network} key but Testnet mode is ${testnet ? 'on' : 'off'}. ${
          testnet
            ? 'Turn Testnet off in Settings, or import a testnet key from the device.'
            : 'Turn Testnet on in Settings, or import a mainnet key from the device.'
        }`
      );
    }
  }

  for (let i = 0; i < slotKeys.length; i++) {
    for (let j = i + 1; j < slotKeys.length; j++) {
      const a = slotKeys[i];
      const b = slotKeys[j];
      if (sameFingerprint(a, b)) {
        blocking.push(`"${a.name}" and "${b.name}" are the same key — each key can only go into the wallet once.`);
      }
    }
  }

  const localCount = local.length;
  if (localCount >= m && m > 0) {
    warnings.push(
      `${localCount === n ? 'Every key is on this phone. ' : ''}${localCount} of these keys live on this one phone, and ${m} are enough to spend. If the phone is lost or hacked, so is the money — multisig only helps when the keys are on different devices.`
    );
  }
  for (const k of imported) {
    const l = local.find((lk) => sameFingerprint(lk, k));
    if (l) {
      warnings.push(`"${k.name}" looks like this phone's own key imported back (same fingerprint as "${l.name}").`);
    }
  }

  return { blocking, warnings };
}

/** Every slot resolves to a key on this phone and nothing blocks the build. */
export function keysStepDone(draft: SetupDraft, keys: SignerKey[], testnet: boolean): boolean {
  const resolved = resolveSlots(draft, keys);
  if (!resolved.every((r) => r.key)) return false;
  const slotKeys = resolved.flatMap((r) => (r.key ? [r.key] : []));
  return keySelectionWarnings(slotKeys, draft.policy.m, draft.policy.n, testnet).blocking.length === 0;
}

export function draftNextStep(draft: SetupDraft, keys: SignerKey[], testnet: boolean): 'keys' | 'create' {
  return keysStepDone(draft, keys, testnet) ? 'create' : 'keys';
}

export function draftProgress(draft: SetupDraft, keys: SignerKey[]): { filled: number; total: number } {
  return { filled: slotKeysOf(draft, keys).length, total: draft.policy.slots.length };
}

// ---------------------------------------------------------------------------
// Setup (once the wallet exists)
// ---------------------------------------------------------------------------

/** The checklist a wallet carries. From a draft it keeps the plan; adopted later, it has none. */
export function startSetup(draft: SetupDraft | undefined, now: number): WalletSetup {
  const setup: WalletSetup = {
    version: 1,
    startedAt: draft?.startedAt ?? now,
    done: {},
    skipped: {},
    phraseChecks: {},
  };
  if (draft) setup.policy = { ...draft.policy, slots: draft.policy.slots.map((s) => ({ ...s })) };
  return setup;
}

export type BackupStatus = 'todo' | 'exported' | 'done';

/** Done means a backup was exported and the user confirmed it is stored away from the phone. */
export function backupStatus(wallet: Pick<MultisigWallet, 'exportedAt' | 'setup'>): BackupStatus {
  if (!wallet.exportedAt) return 'todo';
  return wallet.setup?.backupConfirmedAt ? 'done' : 'exported';
}

/** Records the "stored somewhere safe" tick. A no-op until a backup was actually exported. */
export function confirmBackupStored(
  setup: WalletSetup,
  wallet: Pick<MultisigWallet, 'exportedAt'>,
  now: number
): WalletSetup {
  if (!wallet.exportedAt) return setup;
  return { ...setup, backupConfirmedAt: now };
}

export type VerifyStatus = 'todo' | 'done' | 'stale';

/** Stale: a backup was exported after the last one was checked. */
export function verifyStatus(wallet: Pick<MultisigWallet, 'exportedAt' | 'backupVerifiedAt'>): VerifyStatus {
  if (!wallet.backupVerifiedAt) return 'todo';
  if (wallet.exportedAt && wallet.exportedAt > wallet.backupVerifiedAt) return 'stale';
  return 'done';
}

export type ItemStatus = 'todo' | 'done' | 'skipped' | 'stale';

function without<K extends string, V>(record: Partial<Record<K, V>>, id: K): Partial<Record<K, V>> {
  const { [id]: _drop, ...rest } = record;
  return rest as Partial<Record<K, V>>;
}

/** Ticks an extra. Same reference when already done; a skip is forgotten. */
export function markDone(setup: WalletSetup, id: SetupExtraId, now: number): WalletSetup {
  if (setup.done[id]) return setup;
  return { ...setup, done: { ...setup.done, [id]: now }, skipped: without(setup.skipped, id) };
}

/** Skips an extra. Same reference when already skipped or done. */
export function markSkipped(setup: WalletSetup, id: SetupExtraId, now: number): WalletSetup {
  if (setup.done[id] || setup.skipped[id]) return setup;
  return { ...setup, skipped: { ...setup.skipped, [id]: now } };
}

/** Back to "to do". */
export function unmark(setup: WalletSetup, id: SetupExtraId): WalletSetup {
  if (!setup.done[id] && !setup.skipped[id]) return setup;
  return { ...setup, done: without(setup.done, id), skipped: without(setup.skipped, id) };
}

export function setPhraseCheck(setup: WalletSetup, keyId: string, on: boolean, now: number): WalletSetup {
  const has = Object.prototype.hasOwnProperty.call(setup.phraseChecks, keyId);
  if (on) return has ? setup : { ...setup, phraseChecks: { ...setup.phraseChecks, [keyId]: now } };
  if (!has) return setup;
  const { [keyId]: _drop, ...rest } = setup.phraseChecks;
  return { ...setup, phraseChecks: rest };
}

/**
 * The wallet patch an export deserves. A file or PDF is a backup; sending
 * the wallet to a Coldcard over NFC only loads it onto a signer, so it
 * ticks the "hardware" extra and never stamps exportedAt.
 */
export function recordExport(
  wallet: MultisigWallet,
  which: 'file' | 'pdf' | 'nfc',
  now: number,
  includesGroup = false
): Partial<MultisigWallet> {
  if (which !== 'nfc') {
    // Whether the backup carried the group is only written when it says
    // something: a private wallet's record stays as it was.
    if (includesGroup) return { exportedAt: now, backupIncludesGroup: true };
    return wallet.backupIncludesGroup ? { exportedAt: now, backupIncludesGroup: false } : { exportedAt: now };
  }
  if (!wallet.setup) return {};
  const next = markDone(wallet.setup, 'hardware', now);
  return next === wallet.setup ? {} : { setup: next };
}

/** Some cosigner is an imported key that is not a TAPSIGNER — a device that needs the wallet config. */
export function hasHardwareCosigner(wallet: MultisigWallet, keys: SignerKey[]): boolean {
  return wallet.cosigners.some((c) => {
    if (!c.keyId) return false;
    const key = keys.find((k) => k.id === c.keyId);
    return !!key && key.type === 'imported' && key.source !== 'tapsigner';
  });
}

export interface PhraseItem {
  keyId: string;
  label: string;
  kind: 'local' | 'external';
}

/** One tick per cosigner whose key is on this phone: its seed backup lives apart from the wallet backup. */
export function phraseChecklistItems(wallet: MultisigWallet, keys: SignerKey[]): PhraseItem[] {
  const items: PhraseItem[] = [];
  for (const c of wallet.cosigners) {
    if (!c.keyId) continue;
    const key = keys.find((k) => k.id === c.keyId);
    if (!key) continue;
    items.push(
      key.type === 'local'
        ? {
            keyId: key.id,
            kind: 'local',
            label: `The 12 words for "${key.name}" are written on paper, away from this phone and away from the backup`,
          }
        : {
            keyId: key.id,
            kind: 'external',
            label: `The seed backup for "${key.name}" is kept by whoever holds that signer, away from the wallet backup`,
          }
    );
  }
  return items;
}

/** The recommended extras that make sense for this wallet, in checklist order. */
export function applicableExtras(ctx: { hasHardwareKeys: boolean; hasLinkedKeys: boolean }): SetupExtraId[] {
  return ['verify', ...(ctx.hasLinkedKeys ? (['phrases'] as const) : []), 'address', ...(ctx.hasHardwareKeys ? (['hardware'] as const) : []), 'testtx'];
}

export function extraStatus(wallet: MultisigWallet, id: SetupExtraId, keys: SignerKey[]): ItemStatus {
  const setup = wallet.setup;
  const skipped = !!setup?.skipped[id];
  if (id === 'verify') {
    const v = verifyStatus(wallet);
    if (v === 'done') return 'done';
    // A skip holds until a newer backup is made — that copy is unchecked again.
    const skippedAt = setup?.skipped.verify;
    if (skippedAt !== undefined && (!wallet.exportedAt || skippedAt >= wallet.exportedAt)) return 'skipped';
    return v;
  }
  if (id === 'phrases') {
    const items = phraseChecklistItems(wallet, keys);
    const checks = setup?.phraseChecks ?? {};
    if (items.length > 0 && items.every((it) => checks[it.keyId])) return 'done';
    return skipped ? 'skipped' : 'todo';
  }
  if (setup?.done[id]) return 'done';
  return skipped ? 'skipped' : 'todo';
}

function applicableFor(wallet: MultisigWallet, keys: SignerKey[]): SetupExtraId[] {
  return applicableExtras({
    hasHardwareKeys: hasHardwareCosigner(wallet, keys),
    hasLinkedKeys: phraseChecklistItems(wallet, keys).length > 0,
  });
}

/** Where the guide resumes for a wallet that exists. */
export function walletNextStep(wallet: MultisigWallet, keys: SignerKey[]): 'backup' | 'verify' | 'checklist' {
  if (backupStatus(wallet) !== 'done') return 'backup';
  const verify = extraStatus(wallet, 'verify', keys);
  if (verify === 'todo' || verify === 'stale') return 'verify';
  return 'checklist';
}

export function canFinish(wallet: MultisigWallet): boolean {
  return backupStatus(wallet) === 'done';
}

/** Finish pressed. Idempotent; refuses until the wallet is backed up. */
export function completeSetup(wallet: MultisigWallet, now: number): WalletSetup {
  if (!wallet.setup || !canFinish(wallet)) throw new Error('Back up the wallet before finishing.');
  if (wallet.setup.completedAt) return wallet.setup;
  return { ...wallet.setup, completedAt: now };
}

export interface SetupSummary {
  backupDone: boolean;
  recommendedDone: number;
  recommendedTotal: number;
  nextStep: 'backup' | 'verify' | 'checklist';
}

export function setupSummary(wallet: MultisigWallet, keys: SignerKey[]): SetupSummary {
  const extras = applicableFor(wallet, keys);
  return {
    backupDone: backupStatus(wallet) === 'done',
    recommendedDone: extras.filter((id) => extraStatus(wallet, id, keys) === 'done').length,
    recommendedTotal: extras.length,
    nextStep: walletNextStep(wallet, keys),
  };
}

/** Subtitle of the "Setup checklist" row on Manage. */
export function describeSetupRow(wallet: MultisigWallet, keys: SignerKey[]): string {
  if (!wallet.setup) return 'Check your backup and where your keys live';
  const s = setupSummary(wallet, keys);
  const progress = `${s.recommendedDone} of ${s.recommendedTotal} recommended steps done`;
  if (wallet.setup.completedAt) return `Finished · ${progress}`;
  if (!s.backupDone) return backupStatus(wallet) === 'exported' ? 'Confirm where your backup is kept' : 'Backup still needed';
  return progress;
}

const d = (at: number) => new Date(at).toLocaleDateString();

/**
 * Subtitle of the "Save backup file" row: when it was backed up and whether
 * that backup was checked. `missesGroup`: a group wallet whose backup does not
 * carry the group (groupBackup.ts, backupMissesGroup).
 */
export function describeBackupState(
  wallet: Pick<MultisigWallet, 'exportedAt' | 'backupVerifiedAt'>,
  missesGroup = false
): string {
  const { exportedAt, backupVerifiedAt } = wallet;
  if (exportedAt && missesGroup) return `Last backed up ${d(exportedAt)} · doesn't include the group — save a new one`;
  if (exportedAt && backupVerifiedAt) {
    const checked = `Last backed up ${d(exportedAt)} · checked ${d(backupVerifiedAt)}`;
    return verifyStatus(wallet) === 'stale' ? `${checked} (older backup — check again)` : checked;
  }
  if (exportedAt) return `Last backed up ${d(exportedAt)}`;
  if (backupVerifiedAt) return `Checked ${d(backupVerifiedAt)} · never backed up from this phone`;
  return 'Text file Sparrow, Coldcard and Specter accept';
}

/** The checklist's reminder that the user went against the recommendation; null when they didn't. */
export function overrideNote(setup: WalletSetup): string | null {
  const p = setup.policy;
  if (!p || (p.m === p.recommendedM && p.n === p.recommendedN)) return null;
  return `You chose ${p.m} of ${p.n} against the recommended ${p.recommendedM} of ${p.recommendedN}.`;
}

/**
 * Which cosigner indices sign each test send so that every key signs once:
 * ceil(n/m) rounds of m consecutive indices, wrapping around.
 */
export function testTxPlan(m: number, n: number): number[][] {
  if (!Number.isInteger(m) || !Number.isInteger(n) || m < 1 || n < 1 || m > n) return [];
  const rounds = Math.ceil(n / m);
  const plan: number[][] = [];
  for (let r = 0; r < rounds; r++) {
    const round: number[] = [];
    for (let j = 0; j < m; j++) round.push((r * m + j) % n);
    plan.push(round);
  }
  return plan;
}
