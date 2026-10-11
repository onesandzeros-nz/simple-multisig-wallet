import { KeyPlanSlot, PolicyAnswers } from './types';

/** Largest wallet the guide will plan; more keys means more phrases to keep safe. */
export const MAX_KEYS = 9;

export interface PolicyAlternative {
  m: number;
  n: number;
  when: string;
}

export interface PolicyRecommendation {
  m: number;
  n: number;
  reasons: string[];
  warnings: string[];
  alternatives: PolicyAlternative[];
  slots: KeyPlanSlot[];
}

export interface PolicyTradeoffs {
  canLose: number;
  thiefNeeds: number;
  tone: 'success' | 'warning' | 'danger';
  lines: string[];
}

export interface SlotLabel {
  title: string;
  hint: string;
  icon: 'phone-portrait-outline' | 'people-outline' | 'hardware-chip-outline';
}

/** Every policy the guide talks about; the recommended one is removed per call. */
const ALTERNATIVES: PolicyAlternative[] = [
  { m: 2, n: 3, when: 'the usual choice for one person or a couple' },
  { m: 3, n: 5, when: 'four or more people, or two spare keys for serious savings' },
  { m: 2, n: 2, when: 'not recommended — if either key is lost the money is stuck' },
];

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/**
 * The recommender is deliberately coarse: it only ever answers 2-of-3 or
 * 3-of-5, so a recommendation never carries a caution. Anything else is an
 * override, explained live by `policyTradeoffs`.
 */
export function recommendPolicy(a: PolicyAnswers): PolicyRecommendation {
  const people =
    a.owners === 'me' ? 1 : a.owners === 'pair' ? 2 : clamp(Math.round(a.people), 3, MAX_KEYS);
  const big = a.owners === 'group' && (people >= 4 || a.stakes === 'serious');
  const n = big ? 5 : 3;
  const m = big ? 3 : 2;
  const slots = planKeys({ ...a, people }, n);

  const spare = n - m;
  const holders = Math.min(people, 5);
  const reasons: string[] = [
    `Any ${m} of the ${n} keys can spend, so you can lose ${spare === 1 ? 'one key' : `${spare} keys`} — a fire, a theft, a broken device — and still reach your money.`,
    `A thief needs ${m} keys kept in different places. One stolen phone or one stolen device is useless on its own.`,
    n === 3
      ? 'Three keys is the smallest set that gives you both of those.'
      : `Five keys lets ${holders} people each hold one${5 - holders > 0 ? ` and leaves ${5 - holders} spare` : ''}.`,
  ];
  if (a.owners === 'me' && a.hardwareDevices >= 1) {
    reasons.push(
      'Your hardware signer holds the key that matters; the phone key is for convenience and the third key is insurance.'
    );
  }
  if (a.owners === 'pair') {
    reasons.push(
      'With two people and three keys, whoever holds two can spend alone. Keep the third key somewhere neither of you carries around — a safe at home, or with a trusted relative.'
    );
  }

  const warnings: string[] = [];
  if (a.hardwareDevices === 0 && a.owners === 'me') {
    warnings.push(
      'Every key you have today would live on a phone. Get at least one hardware signer before putting real money here — until then keep the wallet small, or practise with test coins.'
    );
  }
  if (a.stakes === 'serious' && a.hardwareDevices === 0 && a.owners !== 'me') {
    warnings.push('Real savings deserve at least one key that never touches an internet-connected phone.');
  }
  if (a.owners === 'group' && people > 5) {
    warnings.push(
      `More than five keys gets hard to manage. Give keys to five of the ${people} people and let the rest watch the wallet.`
    );
  }

  const alternatives = ALTERNATIVES.filter((alt) => !(alt.m === m && alt.n === n)).map((alt) => ({
    ...alt,
  }));

  return { m, n, reasons, warnings, alternatives, slots };
}

/**
 * Exactly `n` slots: this phone first, then one per other person, then the
 * hardware signers the user already has, then signers still to acquire. The
 * plan never proposes a second key on this phone.
 */
export function planKeys(a: PolicyAnswers, n: number): KeyPlanSlot[] {
  const slots: KeyPlanSlot[] = [{ kind: 'this-phone', where: 'this-phone' }];
  if (a.owners !== 'me') {
    const last = Math.min(Math.round(a.people), n);
    for (let p = 2; p <= last; p++) {
      slots.push({ kind: 'other-phone', where: 'other-person', person: p });
    }
  }
  for (let hw = 0; hw < a.hardwareDevices && slots.length < n; hw++) {
    slots.push({ kind: 'hardware', where: hw === 0 ? 'home' : 'elsewhere' });
  }
  while (slots.length < n) {
    slots.push({ kind: 'hardware', where: 'elsewhere', toAcquire: true });
  }
  return slots;
}

/** Plain-language consequences of an m-of-n choice; drives the Adjust caption. */
export function policyTradeoffs(m: number, n: number): PolicyTradeoffs {
  if (n < 2 || m < 1 || m > n) {
    return {
      tone: 'danger',
      canLose: 0,
      thiefNeeds: m,
      lines: ['Pick at least two keys and a threshold between 1 and the number of keys.'],
    };
  }
  if (m === 1) {
    return {
      tone: 'danger',
      canLose: n - m,
      thiefNeeds: m,
      lines: [
        'Any single key can spend on its own — one stolen key and the money is gone. This is not really multisig.',
      ],
    };
  }
  if (m === n) {
    return {
      tone: 'danger',
      canLose: 0,
      thiefNeeds: m,
      lines: [`All ${n} keys are needed to spend. Lose any one of them and the money is gone for good.`],
    };
  }
  const canLose = n - m;
  const lines = [
    `You can lose ${canLose} key${canLose === 1 ? '' : 's'} and still spend; losing ${canLose + 1} loses the money for good.`,
    `A thief needs ${m} keys.`,
  ];
  let tone: PolicyTradeoffs['tone'] = 'success';
  if (canLose >= m) {
    lines.push(`Only ${m} of ${n} needed — easy to recover, but easier to steal than it looks.`);
    tone = 'warning';
  }
  if (n > 5) {
    lines.push(`${n} keys means ${n} recovery phrases to keep safe.`);
    tone = 'warning';
  }
  return { canLose, thiefNeeds: m, tone, lines };
}

/** Title, hint and icon for one planned slot (`index` is 0-based). */
export function slotLabels(slot: KeyPlanSlot, index: number): SlotLabel {
  const key = `Key ${index + 1}`;
  if (slot.kind === 'this-phone') {
    return {
      title: `${key} · This phone`,
      hint: 'Your everyday signer. Created in this app; write its 12 words on paper.',
      icon: 'phone-portrait-outline',
    };
  }
  if (slot.kind === 'other-phone') {
    return {
      title: `${key} · Person ${slot.person}'s key`,
      hint: 'They create a key on their own phone (this app) or hardware wallet and share its public key — Keys → key → Share public key or Show as QR. Import it here.',
      icon: 'people-outline',
    };
  }
  if (slot.toAcquire) {
    return {
      title: `${key} · A signer you don't have yet`,
      hint: 'A hardware wallet (Coldcard, TAPSIGNER, SeedSigner, Jade…) or a key made in this app on a second phone kept somewhere else. Never a second key on this phone.',
      icon: 'hardware-chip-outline',
    };
  }
  return {
    title: `${key} · Hardware signer`,
    hint:
      slot.where === 'home'
        ? 'Kept at home, offline. Import its public key by QR, file, NFC or TAPSIGNER tap.'
        : "Kept somewhere else — a relative's house or a bank box. Import its public key by QR, file, NFC or TAPSIGNER tap.",
    icon: 'hardware-chip-outline',
  };
}

/**
 * The message to send someone who is to hold a key on their own phone: what
 * to install, what to tap, and what to send back. Plain text for any
 * messaging app. Testnet gets its own step, because a key made in mainnet
 * mode cannot go into a testnet wallet.
 */
export function cosignerInstructions({ testnet }: { testnet: boolean }): string {
  const steps = [
    'Install Simple Multisig on your phone.',
    ...(testnet
      ? ['Open Settings and turn on Testnet mode first. This wallet uses test coins, so your key has to be made in testnet mode.']
      : []),
    'Open the Keys tab and tap "Create a key on this phone".',
    'Write the 12 words on paper and keep them safe. Never send them to anyone, including me.',
    'Open the key you just made and tap "Share public key", then send me what it shares.',
  ];
  return [
    "Hi, I'm setting up a shared bitcoin wallet in Simple Multisig and need a key from you. It takes a few minutes:",
    '',
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    '',
    'The public key lets the wallet be built and watched. It can never spend anything.',
  ].join('\n');
}
